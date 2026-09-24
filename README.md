# Dunder Mifflin Infinity — polymarket.us Trader (Railway)

An always-on bot that trades the winning-staff strategy on **polymarket.us** and feeds
your dashboard. Built against the **real API** (verified from the live endpoints + official
docs), not a guessed SDK. Same infra shape as your Kalshi bot: `bot.py` + `Procfile` + Railway env vars.

**Ships in PAPER mode** — a genuine local simulator that uses live public prices, fills
proposed bets at the ask into a local ledger, and **settles them with the real settlement
endpoint** (true win/loss). It places **nothing** on the exchange. It cannot spend real
money until you set `BOT_MODE=live`.

## How it talks to Polymarket
- **Public market data** → `https://gateway.polymarket.us/v1` (no auth): `/markets`, `/markets/{slug}/bbo`, `/markets/{slug}/settlement`.
- **Your account + orders** → `https://api.polymarket.us/v1` (Ed25519-signed): `/account/balances`, `/portfolio/positions`, `POST /orders`.
- The bot signs requests itself (from `POLYMARKET_SECRET_KEY`) — **no SDK to break**. Only dependency is `cryptography`.

## Files
- `bot.py` — the loop: scan → decide → (paper: book locally | live: place) → settle → publish `live.json`. Loud logging, heartbeat auto-pause, health + `/live.json` server.
- `strategy.py` — brain + rails: favored side 0.93–0.97, near-term, liquid; 3.4%/bet with the 200-bet/95% ladder; drawdown & win-rate halts; ≤3 open, ≤8% each, ≥60% cash. Pure, no keys.
- `pm_us.py` — the only file touching polymarket.us. Signed HTTP, reads keys from env.
- `Procfile`, `requirements.txt` (`cryptography`), `runtime.txt`, `.env.example`.

## Setup (once)
1. **Keys** — polymarket.us/developer (after KYC in the app): `POLYMARKET_KEY_ID` + `POLYMARKET_SECRET_KEY` (secret shown once).
2. **Own GitHub repo** for this folder — *not* the public dashboard repo (a trading key must never live near public code).
3. **Railway** → New Project → Deploy from GitHub → this repo.
4. **Railway → Variables** (see `.env.example`): `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY`, `BOT_MODE=paper`, `DEPOSITED_USD=550`. Optional `GH_TOKEN`/`GH_REPO`/`GH_PATH` to push `live.json` into the dashboard repo. You set these values in Railway — never in code, never to me.

## First run — confirm the shapes (2 minutes)
The market fields are verified against the live endpoint; the account/positions/bbo/settlement
field names come from the docs. Run once to print the real responses and confirm:
```
BOT_MODE=paper POLYMARKET_KEY_ID=... POLYMARKET_SECRET_KEY=... python bot.py test
```
It prints your real `balances`, `positions`, a sample market, and its `bbo`. If any field name
differs from what `pm_us.py` reads (the `.get(...)` calls), fix it there — it's isolated to that one file.

Then let it run in **paper mode**: every 5 min it scans, books simulated fills, and settles them
for real win/loss. Watch the ledger and logs for a good while — that's the real test of the strategy
*and* the wiring, with zero risk.

## Going live
Only after paper looks right: set `BOT_MODE=live`, redeploy. Same scan + same decisions — it now
places real orders and reads your real account. Start small (dial `base_unit_pct`/`max_pos_pct` down
in `strategy.py` for the first live run).

## Dashboard hookup
The bot serves its numbers at `GET https://<your-railway-url>/live.json` (CORS open) **and**, if you
set `GH_TOKEN`, commits `live.json` into the league repo each cycle so the existing **DM Infinity**
tab updates itself with no dashboard changes. Either works.

## Hardening still worth doing (your Kalshi lessons)
- **Private WebSocket** (`wss://api.polymarket.us/v1/ws/private`) instead of REST polling, to kill position-drift.
- **Test failure paths** before live: bad slug (404), bad signature (401), rate-limit, dropped connection — confirm each logs loudly and doesn't corrupt the ledger.
- The bot already uses the **real settlement endpoint** for win/loss (not a heuristic), and reconciles positions each cycle.

## The honest part
The winning-staff edge is ~1¢ on the dollar; live fills and fees tend to grind it toward zero.
Unsupervised auto-trading is the riskiest way to run it. Keep the halts on, watch the logs daily,
start small, and treat every dollar as one you're fine losing. The halts and your own eyes protect
the account — not the strategy.
