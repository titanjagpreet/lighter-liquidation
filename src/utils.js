export function filterValidLiquidations(liquidations) {
return liquidations.filter(l => {
const amount = parseFloat(l.usd_amount);
return l.type === 'liquidation' && amount > 5000;
});
}


export function sumLiquidations(liquidations) {
return liquidations.reduce((sum, l) => sum + parseFloat(l.usd_amount), 0);
}


export function trimOldEntries(entries) {
const now = Date.now();
const dayAgo = now - 24 * 60 * 60 * 1000;
return entries.filter(e => e.timestamp >= dayAgo);
}

// Time-bucketing helpers for minute-level aggregation
export function formatMinuteKey(timestampMs) {
    const d = new Date(timestampMs);
    const YYYY = d.getUTCFullYear();
    const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
    const DD = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `liq:${YYYY}${MM}${DD}${hh}${mm}`;
}

export function getLastNMinuteKeys(n, nowMs = Date.now()) {
    const keys = [];
    const minuteMs = 60 * 1000;
    for (let i = 0; i < n; i++) {
        const t = nowMs - i * minuteMs;
        keys.push(formatMinuteKey(t));
    }
    return keys;
}

export function groupAmountsByMinute(entries) {
    const minuteTotals = new Map();
    for (const e of entries) {
        const ts = Number(e.timestamp) || Date.now();
        const tsMs = ts < 1e12 ? ts * 1000 : ts;
        const key = formatMinuteKey(tsMs);
        const amt = parseFloat(e.usd_amount);
        if (!Number.isFinite(amt)) continue;
        minuteTotals.set(key, (minuteTotals.get(key) || 0) + amt);
    }
    return minuteTotals;
}