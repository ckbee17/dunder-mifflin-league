"""
bot.py — Dunder Mifflin Infinity: always-on polymarket.us trader (Railway).

MODES (env BOT_MODE):
  paper (default) — a real local simulator. Uses live public prices, fills proposed
                    bets at the ask into a local ledger, marks them with live BBO, and
                    SETTLES them via the real settlement endpoint (true win/loss).
                    Places NOTHING on the exchange. Cannot spend real money.
  live            — same scan + same decisions, but places real orders and reads your
                    real account. Win/loss come from the real settlement endpoint.

One shared path: scan → decide → (paper: book locally | live: place) → settle → publish.
Loud logging on every failure, heartbeat auto-pause, health + /live.json server.
"""
import os, sys, json, time, threading, logging, datetime, http.server, socketserver
import strategy, pm_us

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

MODE       = os.environ.get("BOT_MODE", "paper").lower()
DEPOSITED  = float(os.environ.get("DEPOSITED_USD", "550"))
POLL       = int(os.environ.get("POLL_SECONDS", "300"))
PORT       = int(os.environ.get("PORT", "8080"))
LEDGER     = os.environ.get("LEDGER_PATH", "ledger.json")
LIVE_JSON  = os.environ.get("LIVE_JSON_PATH", "live.json")
STALE_SECS = int(os.environ.get("STALE_SECONDS", "1800"))
MAX_BBO    = int(os.environ.get("MAX_BBO_CHECKS", "40"))     # cap per-market depth calls per cycle
GH_TOKEN   = os.environ.get("GH_TOKEN"); GH_REPO = os.environ.get("GH_REPO", "ckbee17/dunder-mifflin-league")
GH_PATH    = os.environ.get("GH_PATH", "live.json")

STATE = {"live": {}, "last_ok": 0, "paused": False, "note": "starting"}

def load_ledger():
    try:
        d = json.load(open(LEDGER))
    except Exception:
        d = {}
    d.setdefault("deposited", DEPOSITED)
    d.setdefault("cash", DEPOSITED)          # paper cash; unused in live
    d.setdefault("positions", {})            # paper positions: slug -> {side,contracts,price,cost}
    d.setdefault("wins", 0); d.setdefault("losses", 0)
    d.setdefault("counted", [])              # slugs already settled+counted (live)
    return d

def save_ledger(d):
    try: json.dump(d, open(LEDGER, "w"), indent=2)
    except Exception as e: log.warning("ledger save failed: %s", e)

def won(side, yes_won): return (side == "YES" and yes_won) or (side == "NO" and not yes_won)

# ------------------------- market scan (shared) ---------------------------
def scan_markets():
    cands = pm_us.list_candidates()
    # cheap pre-filter: a side within a slightly-wide band + near-term, to limit BBO calls
    keep = []
    for m in cands:
        p = m["yes_price"]; fav = max(p, 1 - p)
        if 0.90 <= fav <= 0.985 and strategy._hours_to_end(m["end_time"]) <= strategy.CFG["max_hours_out"] * 1.5:
            keep.append(m)
    keep.sort(key=lambda m: strategy._hours_to_end(m["end_time"]))
    meta = {}
    for m in keep[:MAX_BBO]:
        try:
            b = pm_us.bbo(m["slug"])
            m["best_bid"], m["best_ask"], m["liquidity"] = b["best_bid"], b["best_ask"], b["liquidity"]
            meta[m["slug"]] = {"tick": m["tick"], "min_qty": m["min_qty"]}
        except Exception as e:
            log.warning("bbo failed %s: %s", m["slug"], e); m["liquidity"] = 0
    return keep[:MAX_BBO], meta

# --------------------------- settle (shared) ------------------------------
def settle_paper(led):
    for slug in list(led["positions"].keys()):
        s = pm_us.settlement(slug)
        if s.get("settled"):
            pos = led["positions"].pop(slug)
            w = won(pos["side"], s["yes_won"])
            led["cash"] += pos["contracts"] * (1.0 if w else 0.0)
            led["wins" if w else "losses"] += 1
            log.info("PAPER settle %s: %s -> %s", slug, pos["side"], "WIN" if w else "LOSS")

def settle_live(led, positions):
    """Count W/L for real positions that have settled since we last saw them."""
    live_slugs = {p["slug"] for p in positions}
    for slug in list(led.get("seen", {})):
        if slug not in live_slugs and slug not in led["counted"]:
            s = pm_us.settlement(slug)
            if s.get("settled"):
                side = led["seen"][slug].get("side", "YES")
                led["wins" if won(side, s["yes_won"]) else "losses"] += 1
                led["counted"].append(slug)
                log.info("LIVE settle %s -> %s", slug, "WIN" if won(side, s["yes_won"]) else "LOSS")
    led["seen"] = {p["slug"]: p for p in positions}

# ------------------------------ account view ------------------------------
def paper_account(led, price_by_slug):
    open_pos = []
    val = 0.0
    for slug, p in led["positions"].items():
        px = price_by_slug.get(slug, p["price"])
        cur = px if p["side"] == "YES" else 1 - px
        v = p["contracts"] * cur
        val += v
        open_pos.append({"slug": slug, "side": p["side"], "contracts": p["contracts"],
                         "dollars": p["cost"], "value": round(v, 2)})
    return {"balance": round(led["cash"] + val, 2), "deposited": led["deposited"], "cash": led["cash"],
            "wins": led["wins"], "losses": led["losses"], "settled": led["wins"] + led["losses"],
            "open_positions": open_pos}

# ------------------------------- one cycle --------------------------------
def cycle(led):
    markets, meta = scan_markets()
    price_by_slug = {m["slug"]: m["yes_price"] for m in markets}

    if MODE == "live":
        settle_live(led, pm_us.get_account(led["deposited"])["open_positions"])
        acct = pm_us.get_account(led["deposited"])
        acct.update(wins=led["wins"], losses=led["losses"], settled=led["wins"] + led["losses"])
    else:
        settle_paper(led)
        acct = paper_account(led, price_by_slug)

    plan = strategy.decide(acct, markets)
    log.info("[%s] plan: halt=%s orders=%d notes=%s", MODE, plan["halt"], len(plan["orders"]), plan["notes"])

    if plan["halt"]:
        STATE["paused"] = True; STATE["note"] = plan["halt"]; log.warning("PAUSED: %s", plan["halt"])
    else:
        STATE["paused"] = False
        for o in plan["orders"]:
            m = meta.get(o["slug"], {"tick": 0.01, "min_qty": 1})
            o["price"] = round(o["price"] / m["tick"]) * m["tick"]
            if o["contracts"] < m["min_qty"]:
                log.info("skip %s: below min qty %s", o["slug"], m["min_qty"]); continue
            if MODE == "live":
                res = pm_us.place_order(o)
                if not res["ok"]: log.warning("order failed %s: %s", o["slug"], res["error"])
            else:
                cost = round(o["contracts"] * o["price"], 2)
                if cost <= led["cash"]:
                    led["positions"][o["slug"]] = {"side": o["side"], "contracts": o["contracts"],
                                                   "price": o["price"], "cost": cost}
                    led["cash"] -= cost
                    log.info("PAPER fill: %s %s x%d @ %.2f ($%.2f)", o["side"], o["slug"], o["contracts"], o["price"], cost)
        if MODE != "live":
            acct = paper_account(led, price_by_slug)

    save_ledger(led)
    publish(acct, led)
    STATE["last_ok"] = time.time()

# --------------------------- publish live.json ----------------------------
def publish(acct, led):
    data = {"balance": round(acct["balance"], 2), "deposited": round(led["deposited"], 2),
            "pnl": round(acct["balance"] - led["deposited"], 2), "wins": led["wins"], "losses": led["losses"],
            "bets": led["wins"] + led["losses"], "positions": acct.get("open_positions", []),
            "mode": MODE, "paused": STATE["paused"],
            "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    STATE["live"] = data
    try: json.dump(data, open(LIVE_JSON, "w"), indent=2)
    except Exception as e: log.warning("live.json write failed: %s", e)
    if GH_TOKEN: _gh_publish(data)

def _gh_publish(data):
    import base64, urllib.request
    api = f"https://api.github.com/repos/{GH_REPO}/contents/{GH_PATH}"
    hdr = {"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json"}
    try:
        sha = None
        try:
            with urllib.request.urlopen(urllib.request.Request(api, headers=hdr), timeout=20) as r:
                sha = json.load(r).get("sha")
        except Exception: pass
        payload = {"message": f"infinity {data['updated']}", "content": base64.b64encode(json.dumps(data, indent=2).encode()).decode()}
        if sha: payload["sha"] = sha
        urllib.request.urlopen(urllib.request.Request(api, method="PUT", headers=hdr, data=json.dumps(payload).encode()), timeout=20)
    except Exception as e:
        log.warning("github publish failed: %s", e)

# -------------------------------- loops -----------------------------------
def trade_loop():
    log.warning("BOOT mode=%s deposited=$%.2f poll=%ss (paper places NOTHING)", MODE, DEPOSITED, POLL)
    led = load_ledger()
    while True:
        try:
            cycle(led)
        except Exception as e:
            log.warning("CYCLE ERROR (loud): %s", e)
        if STATE["last_ok"] and time.time() - STATE["last_ok"] > STALE_SECS:
            STATE["paused"] = True; STATE["note"] = f"stale >{STALE_SECS}s — auto-paused"
            log.warning("HEARTBEAT STALE — auto-paused")
        time.sleep(POLL)

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/live.json"):
            b = json.dumps(STATE["live"]).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b)
        else:
            ok = (time.time() - STATE["last_ok"] < STALE_SECS) if STATE["last_ok"] else True
            self.send_response(200 if ok else 503); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"ok": ok, "mode": MODE, "paused": STATE["paused"], "note": STATE["note"]}).encode())

def serve():
    with socketserver.TCPServer(("", PORT), H) as s:
        log.info("health + /live.json on :%d", PORT); s.serve_forever()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        pm_us.test_connection(); sys.exit(0)
    threading.Thread(target=serve, daemon=True).start()
    trade_loop()
