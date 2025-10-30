// ...existing code...
import 'dotenv/config';
import WebSocket from 'ws';
import { groupAmountsByMinute } from './utils.js';

const REDIS_KEY = process.env.REDIS_KEY || 'lighter:liquidations';
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const WS_URL = process.env.WS_URL || 'wss://mainnet.zklighter.elliot.ai/stream';
const MARKETS = process.env.MARKETS ? process.env.MARKETS.split(',') : ['0', '1', '2', '24'];
const MS_24H = 24 * 60 * 60 * 1000;

// Dedup: remember the first liquidation trade's usd_amount per channel of last processed batch
const lastFirstLiquidationValueByChannel = new Map();

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN environment variables');
    process.exit(1);
}

async function deleteKeys(keys = []) {
    try {
        const chunkSize = 200;
        let deleted = 0;
        for (let i = 0; i < keys.length; i += chunkSize) {
            const chunk = keys.slice(i, i + chunkSize);
            const url = `${UPSTASH_REDIS_REST_URL}/del/${chunk.join('/')}`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` } });
            if (!r.ok) {
                console.error('[worker] DEL non-OK', r.status, r.statusText);
                continue;
            }
            const json = await r.json();
            const res = json?.result;
            if (typeof res === 'number') deleted += res;
        }
        return deleted;
    } catch (e) {
        console.error('[worker] deleteKeys error', e);
        return 0;
    }
}

async function incrByFloat(key, amount) {
    const url = `${UPSTASH_REDIS_REST_URL}/incrbyfloat/${key}/${amount}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    if (!res.ok) {
        console.error('[worker] INCRBYFLOAT failed', key, amount, res.status, res.statusText);
    }
}

async function expireKey(key, seconds) {
    const url = `${UPSTASH_REDIS_REST_URL}/expire/${key}/${seconds}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    if (!res.ok) {
        console.error('[worker] EXPIRE failed', key, seconds, res.status, res.statusText);
    }
}

async function getFromRedis() {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${REDIS_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    const json = await res.json();
    try {
        return JSON.parse(json.result || '[]');
    } catch {
        return [];
    }
}

function filterValidLiquidations(trades = []) {
    return trades
        .filter(t => (t?.type === 'liquidation'))
        .map(t => {
            const usd_amount = parseFloat(t.usd_amount ?? t.usdValue ?? t.amount_usd);
            const rawTs = Number(t.timestamp);
            const timestamp = Number.isFinite(rawTs) && rawTs > 0
                ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) // normalize to ms
                : Date.now();
            return usd_amount && !Number.isNaN(usd_amount)
                ? { usd_amount: usd_amount.toString(), timestamp }
                : null;
        })
        .filter(Boolean);
}

function trimOldEntries(entries = []) {
    const cutoff = Date.now() - MS_24H;
    return entries.filter(e => (e.timestamp || 0) >= cutoff);
}

async function startWorker() {
    const ws = new WebSocket(WS_URL);

    ws.on('open', async () => {
        console.log('✅ Connected to Lighter websocket');
        console.log(`[worker] REDIS_KEY=${REDIS_KEY}`);
        console.log(`[worker] UPSTASH_REDIS_REST_URL set? ${Boolean(UPSTASH_REDIS_REST_URL)}`);
        console.log(`[worker] UPSTASH_REDIS_REST_TOKEN set? ${Boolean(UPSTASH_REDIS_REST_TOKEN)}`);
        console.log(`[worker] Subscribing markets: ${MARKETS.join(',')}`);

        // Optional: clear cache on start
        if (String(process.env.RESET_CACHE_ON_START).toLowerCase() === 'true') {
            try {
                const { getLastNMinuteKeys } = await import('./utils.js');
                const keys = getLastNMinuteKeys(48 * 60);
                keys.push(REDIS_KEY);
                const unique = Array.from(new Set(keys));
                console.log(`[worker] RESET_CACHE_ON_START=true. Deleting ${unique.length} keys...`);
                const deleted = await deleteKeys(unique);
                console.log(`[worker] Cache reset completed. Deleted: ${deleted}`);
            } catch (e) {
                console.error('[worker] Cache reset failed', e);
            }
        }

        MARKETS.forEach(m => ws.send(JSON.stringify({ type: 'subscribe', channel: `trade/${m}` })));
    });

    ws.on('message', async msg => {
        const data = JSON.parse(msg.toString());

        // Extract liquidation trades from multiple possible locations per docs
        const liquidationTrades =
            data?.liquidation_trades ||
            data?.update?.liquidation_trades ||
            data?.subscription?.liquidation_trades ||
            [];

        if (!Array.isArray(liquidationTrades) || liquidationTrades.length === 0) return;

        const ch = data?.channel || data?.update?.channel || data?.subscription?.channel || 'trade:?';
        if (liquidationTrades?.length) {
            console.log(`Received ${liquidationTrades.length} liquidation trades on ${ch}`);
        }

        // Deduplicate batches: compare the first trade's usd_amount (exact string equality)
        const first = liquidationTrades[0] || {};
        const firstValueRaw = first.usd_amount ?? first.usdValue ?? first.amount_usd;
        const firstValue = firstValueRaw !== undefined && firstValueRaw !== null ? String(firstValueRaw) : '';
        const lastVal = lastFirstLiquidationValueByChannel.get(ch) || null;
        if (firstValue && firstValue === lastVal) {
            console.log(`[worker] Duplicate batch on ${ch} detected (same first usd_amount). Skipping. value=${firstValue}`);
            return;
        }

        const valid = filterValidLiquidations(liquidationTrades);
        if (!valid.length) return;

        // Update dedup tracker only after we know we'll process this batch
        lastFirstLiquidationValueByChannel.set(ch, firstValue);

        // Aggregate per-minute totals for this batch and increment Redis buckets
        const minuteTotals = groupAmountsByMinute(valid);
        console.log(`[worker] minute buckets in batch: ${minuteTotals.size}`);
        for (const [minuteKey, sum] of minuteTotals.entries()) {
            const amt = Number(sum.toFixed(8));
            console.log(`[worker] INCR ${minuteKey} by ${amt}`);
            await incrByFloat(minuteKey, amt);
            // Keep keys for ~25h
            await expireKey(minuteKey, 25 * 60 * 60);
        }
    });

    ws.on('error', err => console.error('WebSocket error:', err));
    ws.on('close', () => {
        console.log('❌ WebSocket closed. Reconnecting in 5s...');
        setTimeout(startWorker, 5000);
    });
}

startWorker();