"""
strategy.py — the winning-staff decision logic + risk rails.

Pure functions. No network, no SDK, no keys. Given normalized markets + account
state, it decides which bets to place and enforces every safety rail. This is the
same brain as the paper league's top staff, adapted to polymarket.us contracts.
"""
import math, datetime

# ------------------------------- config -----------------------------------
CFG = {
    "min_p":          0.93,   # only back a side priced in this band (the sweet spot)
    "max_p":          0.97,
    "max_concurrent": 3,      # max open positions at once
    "cash_buffer":    0.60,   # always keep >=60% of bankroll in cash
    "base_unit_pct":  0.034,  # one "unit" = 3.4% of current bankroll
    "max_pos_pct":    0.08,   # never >8% of bankroll in one position
    "min_ticket":     5.0,    # skip orders under $5 (fee round-up murders tiny tickets)
    "ladder_every":   200,    # every N settled bets ...
    "ladder_gate":    0.95,   # ... if win rate >=95% ...
    "ladder_step":    1.25,   # ... step the unit up by this factor (gentle, NOT doubling)
    "drawdown_halt":  0.85,   # halt NEW bets if bankroll < 85% of deposited
    "winrate_halt":   0.90,   # halt NEW bets if win rate < 90% (after >=20 bets)
    "min_liquidity":  3000,   # skip thin books
    "max_hours_out":  48,     # only near-term markets
    "max_spread":     0.03,   # skip wide spreads
}

def _hours_to_end(end_iso):
    if not end_iso:
        return 1e9
    try:
        d = datetime.datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return (d - datetime.datetime.now(datetime.timezone.utc)).total_seconds() / 3600.0
    except Exception:
        return 1e9

def base_unit(account):
    bankroll = account["balance"]
    unit = bankroll * CFG["base_unit_pct"]
    settled = account.get("settled", account.get("wins", 0) + account.get("losses", 0))
    wr = (account["wins"] / settled) if settled else 1.0
    steps = settled // CFG["ladder_every"]
    if wr >= CFG["ladder_gate"]:
        unit *= (CFG["ladder_step"] ** steps)
    return min(unit, bankroll * CFG["max_pos_pct"])

def halted(account):
    dep = account.get("deposited", account["balance"])
    if account["balance"] < dep * CFG["drawdown_halt"]:
        return (f"DRAWDOWN HALT: bankroll ${account['balance']:.2f} < "
                f"{int(CFG['drawdown_halt']*100)}% of deposited (${dep:.2f}).")
    settled = account.get("settled", account.get("wins", 0) + account.get("losses", 0))
    wr = (account["wins"] / settled) if settled else 1.0
    if settled >= 20 and wr < CFG["winrate_halt"]:
        return (f"WIN-RATE HALT: {wr*100:.1f}% over {settled} bets < "
                f"{int(CFG['winrate_halt']*100)}%. Thesis broken — stop and review.")
    return None

def _qualify(m):
    """m is a NORMALIZED market dict (see pm_us.list_markets). Returns a pick or None."""
    if not m.get("accepting_orders", True):
        return None
    if float(m.get("liquidity", 0)) < CFG["min_liquidity"]:
        return None
    if _hours_to_end(m.get("end_time")) > CFG["max_hours_out"]:
        return None
    bid, ask = float(m.get("best_bid", 0)), float(m.get("best_ask", 1))
    if abs(ask - bid) > CFG["max_spread"]:
        return None
    for side in ("YES", "NO"):
        p = m["yes_price"] if side == "YES" else 1.0 - m["yes_price"]
        if CFG["min_p"] <= p <= CFG["max_p"]:
            return {"slug": m["slug"], "question": m.get("question", ""),
                    "side": side, "price": round(p, 4), "liq": float(m.get("liquidity", 0)),
                    "end_h": _hours_to_end(m.get("end_time"))}
    return None

def decide(account, markets):
    """
    Returns {"halt": reason|None, "orders": [...], "notes": [...]}.
    An order: {slug, question, side, price, dollars, contracts, reason}.
    Sizing is converted to WHOLE contracts (polymarket.us takes integer quantity).
    """
    notes = []
    stop = halted(account)
    if stop:
        return {"halt": stop, "orders": [], "notes": [stop]}

    open_pos = account.get("open_positions", [])
    held = {p.get("slug") for p in open_pos}
    slots = CFG["max_concurrent"] - len(open_pos)
    if slots <= 0:
        return {"halt": None, "orders": [], "notes": ["At max concurrent positions; holding."]}

    deployable = account["balance"] * (1 - CFG["cash_buffer"]) - sum(p.get("dollars", 0) for p in open_pos)
    unit = base_unit(account)
    if unit < CFG["min_ticket"]:
        return {"halt": None, "orders": [], "notes": [f"Unit ${unit:.2f} below min ticket; holding."]}

    cands = [c for c in (_qualify(m) for m in markets) if c]
    cands.sort(key=lambda c: (-c["liq"], c["end_h"]))

    orders = []
    for c in cands:
        if slots <= 0 or deployable < CFG["min_ticket"]:
            break
        if c["slug"] in held:
            continue
        dollars = min(unit, deployable)
        contracts = int(dollars // c["price"])          # whole contracts only
        if contracts < 1 or contracts * c["price"] < CFG["min_ticket"]:
            continue
        spend = round(contracts * c["price"], 2)
        orders.append({
            "slug": c["slug"], "question": c["question"][:90], "side": c["side"],
            "price": c["price"], "dollars": spend, "contracts": contracts,
            "reason": f"favored {c['side']} @ {c['price']:.2f}, liq ${int(c['liq'])}, ~{c['end_h']:.0f}h",
        })
        held.add(c["slug"]); slots -= 1; deployable -= spend

    if not orders:
        notes.append("No qualifying markets in the 0.93-0.97 band right now.")
    notes.append(f"unit=${unit:.2f} | open={len(open_pos)} | placing={len(orders)}")
    return {"halt": None, "orders": orders, "notes": notes}
