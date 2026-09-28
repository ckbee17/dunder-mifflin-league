"""
bot.py — Dunder Mifflin Infinity: polymarket.us paper simulator (Railway).
"""
import os, sys, json, time, threading, logging, datetime, http.server, socketserver
from urllib.parse import urlparse, parse_qs
import strategy, pm_us

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

MODE       = os.environ.get("BOT_MODE", "paper").lower()
CONTROL_TOKEN = os.environ.get("CONTROL_TOKEN", "")
DEPOSITED  = float(os.environ.get("DEPOSITED_USD", "550"))
POLL       = int(os.environ.get("POLL_SECONDS", "300"))
PORT       = int(os.environ.get("PORT", "8080"))
LEDGER     = os.environ.get("LEDGER_PATH", "ledger.json")
LIVE_JSON  = os.environ.get("LIVE_JSON_PATH", "live.json")
STALE_SECS = int(os.environ.get("STALE_SECONDS", "1800"))
MAX_BBO    = int(os.environ.get("MAX_BBO_CHECKS", "40"))
GH_TOKEN   = os.environ.get("GH_TOKEN"); GH_REPO = os.environ.get("GH_REPO", "ckbee17/dunder-mifflin-league")
GH_PATH    = os.environ.get("GH_PATH", "live.json")

STATE = {"live": {}, "last_ok": 0, "paused": False, "manual_paused": False, "note": "starting"}

def restore_pause_on_boot(led):
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
    d.setdefault("cash", DEPOSITED)
    d.setdefault("positions", {})
    d.setdefault("wins", 0); d.setdefault("losses", 0)
    d.setdefault("counted", [])
    return d

def save_ledger(d):
    try: json.dump(d, open(LEDGER, "w"), indent=2)
    except Exception as e: log.warning("ledger save failed: %s", e)

def won(side, yes_won): return (side == "YES" and yes_won) or (side == "NO" and not yes_won)

def scan_markets():
    cands = pm_us.list_candidates()
    keep = []
    n_band = n_today = n_36h = 0
    inband = []
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
    return keep[:MAX_BBO], meta

def settle_paper(led):
    for slug in list(led["positions"].keys()):
        s = pm_us.settlement(slug)
        if s.get("settled"):
            pos = led["positions"].pop(slug)
            w = won(pos["side"], s["yes_won"])
            led["cash"] += pos["contracts"] * (1.0 if w else 0.0)
            led["wins" if w else "losses"] += 1
            log.info("PAPER settle %s: %s -> %s", slug, pos["side"], "WIN" if w else "LOSS")

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
            "open_positions":
