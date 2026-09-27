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
from urllib.parse import urlparse, parse_qs
import strategy, pm_us

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

MODE       = os.environ.get("BOT_MODE", "paper").lower()
CONTROL_TOKEN = os.environ.get("CONTROL_TOKEN", "")          # secret for the pause page; set in Railway
DEPOSITED  = float(os.environ.get("DEPOSITED_USD", "550"))
POLL       = int(os.environ.get("POLL_SECONDS", "300"))
PORT       = int(os.environ.get("PORT", "8080"))
LEDGER     = os.environ.get("LEDGER_PATH", "ledger.json")
LIVE_JSON  = os.environ.get("LIVE_JSON_PATH", "live.json")
STALE_SECS = int(os.environ.get("STALE_SECONDS", "1800"))
MAX_BBO    = int(os.environ.get("MAX_BBO_CHECKS", "40"))     # cap per-market depth calls per cycle
GH_TOKEN   = os.environ.get("GH_TOKEN"); GH_REPO = os.environ.get("GH_REPO", "ckbee17/dunder-mifflin-league")
GH_PATH    = os.environ.get("GH_PATH", "live.json")

STATE = {"live": {}, "last_ok": 0, "paused": False, "manual_paused": False, "note": "starting"}

def restore_pause_on_boot(led):
    """Make an emergency pause survive restarts/redeploys by reading the last published state."""
    if "manual_paused" in led:
        STATE["manual_paused"] = bool(led["manual_paused"]); return
    try:
        import urllib.request
        url = f"https://raw.githubusercontent.com/{GH_REPO}/main/{GH_PATH}"
        with urllib.request.urlopen(url, timeout=15) as r:
            STATE["manual_paused"] = bool(json.load(r).get("paused_manual", False))
    except Exception:
        pass

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
    n_band = n_today = n_36h = 0
    inband = []   # (hours_out, endDate, slug) — reveals whether near-term game markets exist & their date format
    for m in cands:
        p = m["yes_price"]; fav = max(p, 1 - p)
        ib = 0.90 <= fav <= 0.995
        rt = strategy._resolves_today(m["end_time"])
        if ib:
            n_band += 1
            h = strategy._hours_to_end(m["end_time"])
            inband.append((h, m.get("end_time"), m.get("slug")))
            if h <= 36: n_36h += 1
        if rt: n_today += 1
        same_day_ok = (not strategy.CFG.get("same_day_only", True)) or rt
        if ib and same_day_ok:
            keep.append(m)
    keep.sort(key=lambda m: strategy._hours_to_end(m["end_time"]))
    # funnel breakdown + the soonest in-band markets, so we can SEE if near-term games exist and their endDate format
    log.info("scan: %d open 2-outcome | in-band(0.90-0.99): %d | <=36h: %d | same-day: %d | BOTH: %d",
             len(cands), n_band, n_36h, n_today, len(keep))
    for h, e, s in sorted(inband)[:6]:
        log.info("  in-band soonest: %6.1fh | end=%s | %s", h, e, s)
    meta = {}
    for m in keep[:MAX_BBO]:
        try:
            b = pm_us.bbo(m["slug"])
            m["best_bid"], m["best_ask"], m["liquidity"] = b["best_bid"], b["best_ask"], b["liquidity"]
            meta[m["slug"]] = {"tick": m["tick"], "min_qty": m["min_qty"]}
        except Exception as e:
            log.warning("bbo failed %s: %s", m["slug"], e); m["liquidity"] = 0
    for m in keep[:6]:
        log.info("  cand %-28s fav=%.3f liq=%s spread=%.3f end~%.0fh",
                 (m["slug"] or "?")[:28], max(m["yes_price"], 1 - m["yes_price"]), m.get("liquidity"),
                 abs((m.get("best_ask") or 1) - (m.get("best_bid") or 0)), strategy._hours_to_end(m["end_time"]))
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
def book_paper_fill(led, o):
    """Simulate a fill into the local paper ledger. No real order, no real money."""
    slug = o["slug"]
    cost = round(o["contracts"] * o["price"], 2)
    if cost > led["cash"] + 1e-9:
        log.info("PAPER skip (insufficient paper cash) %s: need $%.2f, have $%.2f", slug, cost, led["cash"])
        return False
    led["cash"] = round(led["cash"] - cost, 2)
    led["positions"][slug] = {"side": o["side"], "contracts": int(o["contracts"]),
                              "price": o["price"], "cost": cost, "q": o.get("question", "")[:80]}
    log.info("PAPER FILL: %s %s x%d @ %.2f = $%.2f", o["side"], slug, o["contracts"], o["price"], cost)
    return True

def cycle(led):
    markets, meta = scan_markets()
    # 1) settle any resolved paper positions first (true W/L from the real settlement endpoint)
    settle_paper(led)
    # 2) paper account view — open positions marked to the latest scan prices
    price_by_slug = {m["slug"]: m["yes_price"] for m in markets}
    acct = paper_account(led, price_by_slug)
    log.info("paper account: balance=$%.2f cash=$%.2f open=%d record=%d-%d",
             acct["balance"], acct["cash"], len(acct["open_positions"]), acct["wins"], acct["losses"])

    plan = strategy.decide(acct, markets)
    log.info("[%s] plan: halt=%s orders=%d notes=%s", MODE, plan["halt"], len(plan["orders"]), plan["notes"])

    if STATE["manual_paused"]:
        STATE["paused"] = True; STATE["note"] = "manually paused"; log.warning("MANUALLY PAUSED — no new entries")
    elif plan["halt"]:
        STATE["paused"] = True; STATE["note"] = plan["halt"]; log.warning("PAUSED: %s", plan["halt"])
    else:
        STATE["paused"] = False
        for o in plan["orders"]:
            m = meta.get(o["slug"], {"tick": 0.01, "min_qty": 1})
            o["price"] = round(o["price"] / m["tick"]) * m["tick"]
            if o["contracts"] < m["min_qty"]:
                continue
            if MODE == "live":
                res = pm_us.place_order(o)
                if not res["ok"]: log.warning("order failed %s: %s", o["slug"], res["error"])
            else:
                book_paper_fill(led, o)

    save_ledger(led)
    # re-mark after fills so the published balance/positions are current
    acct = paper_account(led, price_by_slug)
    publish(acct, led)
    STATE["last_ok"] = time.time()

# --------------------------- publish live.json ----------------------------
def publish(acct, led):
    data = {"balance": round(acct["balance"], 2), "deposited": round(led["deposited"], 2),
            "pnl": round(acct["balance"] - led["deposited"], 2), "wins": led["wins"], "losses": led["losses"],
            "bets": led["wins"] + led["losses"], "positions": acct.get("open_positions", []),
            "mode": MODE, "paused": STATE["paused"], "paused_manual": STATE["manual_paused"],
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
    restore_pause_on_boot(led)
    STATE["ledger"] = led
    if STATE["manual_paused"]:
        log.warning("restored MANUAL PAUSE from last state")
    while True:
        try:
            cycle(led)
        except Exception as e:
            log.warning("CYCLE ERROR (loud): %s", e)
        if STATE["last_ok"] and time.time() - STATE["last_ok"] > STALE_SECS:
            STATE["paused"] = True; STATE["note"] = f"stale >{STALE_SECS}s — auto-paused"
            log.warning("HEARTBEAT STALE — auto-paused")
        time.sleep(POLL)

def control_page(token):
    return """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Infinity Control</title>
<style>body{margin:0;background:#0e1c30;color:#eaf1fb;font-family:-apple-system,system-ui,sans-serif;text-align:center}
.wrap{max-width:420px;margin:0 auto;padding:26px 18px}h1{font-size:19px;letter-spacing:.5px;margin:6px 0 2px}
.sub{color:#8fa3b8;font-size:13px;margin-bottom:20px}
.stat{display:flex;justify-content:space-between;background:#14263c;border:1px solid #24405c;border-radius:10px;padding:12px 16px;margin:8px 0;font-size:15px}
.state{font-size:16px;margin:18px 0 6px;font-weight:800}.run{color:#7CFFB0}.pause{color:#ffcf5c}
button{width:100%;padding:20px;font-size:20px;font-weight:800;border:0;border-radius:14px;margin-top:14px;color:#fff}
.bpause{background:#c0392b}.bresume{background:#1a9d5a}.note{color:#8fa3b8;font-size:12px;margin-top:18px;line-height:1.4}</style></head>
<body><div class=wrap><h1>DUNDER MIFFLIN INFINITY</h1><div class=sub>private control &middot; real money</div>
<div class=stat><span>Balance</span><b id=bal>&mdash;</b></div>
<div class=stat><span>Net P&amp;L</span><b id=pnl>&mdash;</b></div>
<div class=stat><span>Mode</span><b id=mode>&mdash;</b></div>
<div class=stat><span>Record</span><b id=rec>&mdash;</b></div>
<div class=state id=state>&hellip;</div><button id=btn>&hellip;</button>
<div class=note>This link is your key &mdash; keep it private. Pausing stops all new trades; open positions stay until they resolve.</div>
</div><script>
var T=new URLSearchParams(location.search).get('token');
function fmt(n){return (n>=0?'+$':'-$')+Math.abs(n).toFixed(2);}
async function refresh(){try{var d=await (await fetch('/live.json?t='+Date.now())).json();
 bal.textContent='$'+(+d.balance||0).toFixed(2);pnl.textContent=fmt(+d.pnl||0);
 mode.textContent=(d.mode||'?').toUpperCase();rec.textContent=(d.wins||0)+'\\u2013'+(d.losses||0);
 var p=!!d.paused_manual,b=document.getElementById('btn'),s=document.getElementById('state');
 if(p){s.textContent='\\u23F8 PAUSED';s.className='state pause';b.textContent='\\u25B6 RESUME TRADING';b.className='bresume';}
 else{s.textContent='\\u25CF RUNNING';s.className='state run';b.textContent='\\u23F8 PAUSE TRADING';b.className='bpause';}
 b.dataset.p=p?'1':'0';}catch(e){}}
document.getElementById('btn').onclick=async function(){var a=this.dataset.p==='1'?'resume':'pause';this.textContent='\\u2026';
 await fetch('/control?token='+encodeURIComponent(T)+'&action='+a,{method:'POST'});setTimeout(refresh,400);};
refresh();setInterval(refresh,4000);</script></body></html>"""

def _authok(q): return CONTROL_TOKEN and q.get("token", [""])[0] == CONTROL_TOKEN

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers()
        self.wfile.write(body.encode() if isinstance(body, str) else body)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path.startswith("/live.json"):
            self._send(200, json.dumps(STATE["live"])); return
        if u.path.startswith("/control"):
            if not _authok(q): self._send(403, "<h2>Forbidden</h2>", "text/html"); return
            self._send(200, control_page(q["token"][0]), "text/html"); return
        ok = (time.time() - STATE["last_ok"] < STALE_SECS) if STATE["last_ok"] else True
        self._send(200 if ok else 503, json.dumps({"ok": ok, "mode": MODE, "paused": STATE["paused"], "note": STATE["note"]}))
    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if not u.path.startswith("/control") or not _authok(q):
            self._send(403, json.dumps({"error": "forbidden"})); return
        a = q.get("action", ["toggle"])[0]
        STATE["manual_paused"] = True if a == "pause" else False if a == "resume" else not STATE["manual_paused"]
        led = STATE.get("ledger")
        if led is not None:
            led["manual_paused"] = STATE["manual_paused"]; save_ledger(led)
        # reflect immediately in the served live.json so the button flips at once
        if STATE["live"]:
            STATE["live"]["paused_manual"] = STATE["manual_paused"]
            STATE["live"]["paused"] = STATE["manual_paused"] or STATE["live"].get("paused", False)
        log.warning("CONTROL: manual_paused=%s", STATE["manual_paused"])
        self._send(200, json.dumps({"manual_paused": STATE["manual_paused"]}))

def serve():
    with socketserver.ThreadingTCPServer(("", PORT), H) as s:
        s.daemon_threads = True
        log.info("health + /live.json + /control on :%d", PORT); s.serve_forever()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        pm_us.test_connection(); sys.exit(0)
    threading.Thread(target=serve, daemon=True).start()
    trade_loop()
