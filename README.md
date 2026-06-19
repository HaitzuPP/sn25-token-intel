# SN25 Mainframe: Token Intelligence

Live dashboard for the Bittensor **Subnet 25 (Mainframe / Macrocosmos)** alpha token.
Pylon Partners / TAO Institute.

**Live:** https://haitzupp.github.io/sn25-token-intel/

## What it shows
- Alpha price (TAO + USD), day-to-day change, and emission rank over time.
- Top 25 holders: alpha held, USD value, % of supply, first funded, and 24h / 7d / 30d Δ$.
- Holder concentration (top-1/10/25, HHI, wallets >5%, net whale flow).
- Liquidity & alpha mechanics (pool reserves, staked vs supply, 24h volume, sentiment).
- Client-side alert rules.

## Architecture
The page is static and reads `data/sn25-snapshot.json`. A GitHub Actions job
(`.github/workflows/refresh.yml`) runs `scripts/build-snapshot.mjs` once per day,
pulls from the Taostats API, and commits the refreshed JSON. **Viewers never call
the API**, so there is no rate-limit exposure.

Holder 24h/7d/30d change is derived from a rolling day-over-day history
(`data/sn25-history.json`) and populates as snapshots accrue. First-funded dates
are backfilled wallet-by-wallet into `data/sn25-firstfunded.json`.

## Setup
Add a repo secret `TAOSTATS_KEY` (Settings → Secrets → Actions) with a Taostats API key.
Run the workflow manually once (Actions → Refresh SN25 snapshot → Run workflow) to seed.

## Local
```
TAOSTATS_KEY=<key> node scripts/build-snapshot.mjs
```
