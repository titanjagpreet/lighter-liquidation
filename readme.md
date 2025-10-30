## lighter-liquidations

Rolling 24h liquidation tracker for Lighter.xyz (decentralized perpetuals DEX).

### What it does
- Connects to Lighter WebSocket streams for top markets
- Deduplicates repeated liquidation batches per market
- Aggregates liquidation USD amounts per-minute in Redis (Upstash)
- Exposes an HTTP API to fetch the rolling last 24h total

### Requirements
- Node 18+
- Upstash Redis REST

### Env vars (.env)
- `UPSTASH_REDIS_REST_URL` (required)
- `UPSTASH_REDIS_REST_TOKEN` (required)
- `MARKETS` (optional) default: `0,1,2,24`
- `PORT` (optional) default: `3001`
- `RESET_CACHE_ON_START` (optional) `true|false` (worker only)

### Install
```bash
npm install
```

### Run locally
- Start worker (WebSocket consumer + aggregator):
```bash
npm run start:worker
```
- Start server (HTTP API):
```bash
npm run start:server
```

### API
- `GET /api/liquidations` → `{ "total_24h_liquidation_usd": "12345.67" }`
- `POST /api/reset-cache` → delete last 48h minute-buckets and legacy key

### Deployment
- Recommend Railway for both services (always-on worker + HTTP server)
- Use the same env vars for both services

### Notes
- Uses minute buckets with 25h TTL to bound data size
- Dedup compares first trade `usd_amount` per channel to avoid replay inflation