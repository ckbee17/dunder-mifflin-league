"""
pm_us.py — polymarket.us API client (raw signed HTTP, no SDK).

Built against the real docs + a live response check:
  * Public market data  →  https://gateway.polymarket.us/v1   (no auth)
  * Authed trading/acct  →  https://api.polymarket.us/v1       (Ed25519-signed)

Auth (from docs.polymarket.us/api-reference/authentication):
  sign string = "{timestamp_ms}{METHOD}{path}"  (no body)
  ed25519 seed = base64decode(SECRET)[:32]
  headers: X-PM-Access-Key, X-PM-Timestamp (ms), X-PM-Signature (base64), Content-Type: application/json
Keys come from env (Railway); never hard-coded, never logged.
"""
import os, json, time, base64, logging, urllib.request, urllib.error
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

log = logging.getLogger("pm_us")
PUBLIC = "https://gateway.polymarket.us/v1"
AUTHED = "https://api.polymarket.us/v1"

def _keys():
    kid = os.environ.get("POLYMARKET_KEY_ID"); sec = os.environ.get("POLYMARKET_SECRET_KEY")
    if not kid or not sec:
        raise RuntimeError("Set POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY (Railway → Variables).")
    return kid, sec

def _sign(secret_b64, ts, method, path):
    seed = base64.b64decode(secret_b64)[:32]
    key = Ed25519PrivateKey.from_private_bytes(seed)
    sig = key.sign(f"{ts}{method}{path}".encode())
    return base64.b64encode(sig).decode()

def _request(base, method, path, body=None, auth=False, timeout=20):
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if auth:
        kid, sec = _keys()
        ts = str(int(time.time() * 1000))
        headers["X-PM-Access-Key"] = kid
        headers["X-PM-Timestamp"] = ts
        headers["X-PM-Signature"] = _sign(sec, ts, method, path)   # path includes /v1/...
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        # LOUD on every non-2xx — never swallow (the Kalshi phantom bug was a silenced error).
        log.warning("HTTP %s %s %s -> %s | %s", method, path, e.code, e.reason, detail)
        raise
    except Exception as e:
        log.warning("REQUEST FAILED %s %s: %s", method, path, e)
        raise

# path includes /v1 for signing; base already ends in /v1, so strip when signing:
def _pub(path):        return _request(PUBLIC, "GET", path)
def _authed(method, path, body=None):
    # sign with the FULL path including the /v1 prefix
    full = "/v1" + path
    return _request("https://api.polymarket.us", method, full, body=body, auth=True)

def _loads(x, d=None):
    if isinstance(x, (list, dict)): return x
    try: return json.loads(x)
    except Exception: return d

# ----------------------------- market data --------------------------------
def list_candidates():
    """Public. Returns 2-outcome active markets normalized to
       {slug, question, yes_price, end_time, category, min_qty, tick, outcomes}."""
    j = _pub("/markets?active=true&limit=500")
    out = []
    for m in (j.get("markets") if isinstance(j, dict) else j) or []:
        if m.get("closed") or not m.get("active"):
            continue
        outs = _loads(m.get("outcomes"), []); prices = _loads(m.get("outcomePrices"), [])
        if not outs or not prices or len(outs) != 2 or len(prices) != 2:
            continue
        try: yes = float(prices[0])
        except Exception: continue
        out.append({
            "slug": m.get("slug"), "question": m.get("question", ""), "yes_price": yes,
            "end_time": m.get("endDate"), "category": m.get("category", ""),
            "min_qty": float(m.get("minimumTradeQty") or 1),
            "tick": float(m.get("orderPriceMinTickSize") or 0.01),
            "outcomes": outs,
            "best_bid": None, "best_ask": None, "liquidity": None, "accepting_orders": True,
        })
    return out

def bbo(slug):
    """Public per-market depth: {best_bid, best_ask, currentPx, liquidity(open_interest)}."""
    j = _pub(f"/markets/{slug}/bbo")
    d = j.get("data", j) if isinstance(j, dict) else {}
    return {
        "best_bid":  float(d.get("bestBid") or 0),
        "best_ask":  float(d.get("bestAsk") or 1),
        "currentPx": float(d.get("currentPx") or d.get("lastTradePx") or 0),
        "liquidity": float(d.get("openInterest") or d.get("sharesTraded") or 0),
    }

def settlement(slug):
    """Public. Returns {settled, yes_won} or {settled: False}. Used for TRUE win/loss."""
    try:
        j = _pub(f"/markets/{slug}/settlement")
    except Exception:
        return {"settled": False}
    d = j.get("data", j) if isinstance(j, dict) else {}
    price = d.get("settlementPrice", d.get("price"))
    if price is None:
        return {"settled": False}
    try:
        return {"settled": True, "yes_won": float(price) >= 0.5}
    except Exception:
        return {"settled": False}

# ------------------------------ account -----------------------------------
def get_account(deposited):
    """Authed. Returns {balance, deposited, cash, open_positions:[{slug,side,contracts,cost,value}]}."""
    bals = _authed("GET", "/account/balances")
    arr = (bals.get("balances") if isinstance(bals, dict) else bals) or []
    usd = next((b for b in arr if (b.get("currency") or "USD").upper() == "USD"), (arr[0] if arr else {}))
    cash = float(usd.get("buyingPower") or 0)
    fiat = float(usd.get("currentBalance") or 0)
    asset = float(usd.get("assetNotional") or 0)
    balance = fiat + asset            # total account value = cash-ish fiat + securities notional

    poss = _authed("GET", "/portfolio/positions")
    pmap = (poss.get("positions") if isinstance(poss, dict) else {}) or {}
    positions = []
    for slug, p in pmap.items():
        contracts = float(p.get("netPositionDecimal") or 0)
        if contracts == 0:
            continue
        cost = float((p.get("cost") or {}).get("value") or 0)
        unreal = float((p.get("cashValue") or {}).get("value") or 0)
        md = p.get("marketMetadata") or {}
        positions.append({"slug": slug, "side": (md.get("outcome") or "YES"),
                          "contracts": contracts, "cost": cost, "value": cost + unreal})
    return {"balance": balance, "deposited": deposited, "cash": cash, "open_positions": positions}

# ------------------------------- orders -----------------------------------
def place_order(order):
    """Authed. LIVE order only — the caller guards paper vs live. Returns {ok, id, error, resp}."""
    intent = "ORDER_INTENT_BUY_LONG" if order["side"] == "YES" else "ORDER_INTENT_BUY_SHORT"
    payload = {
        "marketSlug": order["slug"], "intent": intent, "type": "ORDER_TYPE_LIMIT",
        "price": {"value": f'{order["price"]:.4f}', "currency": "USD"},
        "quantity": int(order["contracts"]), "tif": "TIME_IN_FORCE_GOOD_TILL_CANCEL",
    }
    try:
        resp = _authed("POST", "/orders", body=payload)
        oid = resp.get("id") if isinstance(resp, dict) else None
        log.warning("LIVE ORDER ok id=%s: %s %s x%d @ %.2f", oid, order["side"], order["slug"],
                    order["contracts"], order["price"])
        return {"ok": True, "id": oid, "resp": resp, "error": None}
    except Exception as e:
        return {"ok": False, "id": None, "resp": None, "error": str(e)}

# ---------------------------- diagnostics ---------------------------------
def test_connection():
    print("== balances =="); print(json.dumps(_authed("GET", "/account/balances"), indent=2)[:1500])
    print("== positions =="); print(json.dumps(_authed("GET", "/portfolio/positions"), indent=2)[:1500])
    c = list_candidates(); print("== candidates ==", len(c))
    if c:
        print(json.dumps(c[0], indent=2)); print("bbo:", json.dumps(bbo(c[0]["slug"]), indent=2))
