import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();
import { getLastNMinuteKeys } from './utils.js';


const app = express();
const PORT = process.env.PORT || 3001;
const REDIS_KEY = process.env.REDIS_KEY || 'lighter:liquidations'; // legacy key (unused in new scheme)


console.log('[server] Starting API server');
console.log(`[server] PORT=${PORT}`);
console.log(`[server] REDIS_KEY=${REDIS_KEY}`);
console.log(`[server] UPSTASH_REDIS_REST_URL set? ${Boolean(process.env.UPSTASH_REDIS_REST_URL)}`);
console.log(`[server] UPSTASH_REDIS_REST_TOKEN set? ${Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)}`);

async function deleteKeys(keys = []) {
try {
const chunkSize = 200;
let deleted = 0;
for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const url = `${process.env.UPSTASH_REDIS_REST_URL}/del/${chunk.join('/')}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    if (!r.ok) {
        console.error('[server] DEL non-OK', r.status, r.statusText);
        continue;
    }
    const json = await r.json();
    const res = json?.result;
    if (typeof res === 'number') deleted += res;
}
return deleted;
} catch (e) {
console.error('[server] deleteKeys error', e);
return 0;
}
}

app.post('/api/reset-cache', async (req, res) => {
try {
console.log('[server] reset-cache: building keys...');
const minuteKeys48h = getLastNMinuteKeys(48 * 60);
const allKeys = [...minuteKeys48h, REDIS_KEY];
const unique = Array.from(new Set(allKeys));
console.log('[server] reset-cache: deleting keys:', unique.length);
const deleted = await deleteKeys(unique);
res.json({ status: 'ok', deleted_keys: deleted });
} catch (e) {
console.error('[server] reset-cache error', e);
res.status(500).json({ error: 'reset failed' });
}
});

app.get('/api/liquidations', async (req, res) => {
try {
console.log('[server] /api/liquidations: aggregating last 24h minute buckets...');
const keys = getLastNMinuteKeys(24 * 60);
console.log('[server] keys to fetch:', keys.length);

const chunkSize = 200;
let total = 0;
for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const url = `${process.env.UPSTASH_REDIS_REST_URL}/mget/${chunk.join('/')}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    if (!r.ok) {
        console.error('[server] Upstash MGET non-OK', r.status, r.statusText);
        continue;
    }
    const json = await r.json();
    const results = json?.result || [];
    if (Array.isArray(results)) {
        for (const v of results) {
            const num = parseFloat(v);
            if (Number.isFinite(num)) total += num;
        }
    }
}
console.log('[server] 24h total computed from buckets:', total);
res.json({ total_24h_liquidation_usd: total.toFixed(2) });
} catch (err) {
console.error('API error:', err);
res.status(500).json({ error: 'Failed to fetch liquidation data' });
}
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));