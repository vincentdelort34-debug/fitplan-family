// api/sync-apple-health.js
// Vercel POST endpoint hit by the user's iOS Shortcut once a day.
//
// Auth: header `X-User-Token: <token>` matches a row in user_connections
// where source='apple_health' and credentials.token == that token (plain text — no
// roundtrip is required because the iOS Shortcut can't run AES).
//
// Body (JSON):
//   {
//     "date": "2026-05-13",                  // optional, defaults to today (Paris)
//     "metrics": {
//       "sleep_minutes":   425,
//       "resting_hr":      52,
//       "hrv":             38,
//       "steps":           8543,
//       "active_calories": 412,
//       "weight_kg":       91.2,
//       ...
//     }
//   }
//
// Response: { status:'ok', inserted: <n> }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Mapping from Shortcut payload keys → (metric_type, unit, transform).
// Add freely as the iOS Shortcut grows.
const APPLE_MAP = {
  sleep_minutes:    { metric: 'sleep_duration', unit: 'min',   tx: v => v },
  sleep_score:      { metric: 'sleep_score',    unit: 'score', tx: v => v },
  resting_hr:       { metric: 'resting_hr',     unit: 'bpm',   tx: v => v },
  hrv:              { metric: 'hrv',            unit: 'ms',    tx: v => v },
  hrv_sdnn:         { metric: 'hrv_sdnn',       unit: 'ms',    tx: v => v },
  steps:            { metric: 'steps',          unit: 'count', tx: v => v },
  distance_m:       { metric: 'distance_walked',unit: 'm',     tx: v => v },
  floors_climbed:   { metric: 'floors_climbed', unit: 'count', tx: v => v },
  active_calories:  { metric: 'active_kcal',    unit: 'kcal',  tx: v => v },
  total_calories:   { metric: 'total_kcal',     unit: 'kcal',  tx: v => v },
  weight_kg:        { metric: 'weight',         unit: 'kg',    tx: v => v },
  body_fat_pct:     { metric: 'body_fat',       unit: 'pct',   tx: v => v },
  vo2max:           { metric: 'vo2max',         unit: 'ml/kg/min', tx: v => v },
  active_minutes:   { metric: 'active_minutes', unit: 'min',   tx: v => v },
};

async function supa(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase ${path} → ${r.status} ${body.slice(0,300)}`);
  }
  return r.status === 204 ? null : r.json();
}

function todayParis() {
  // YYYY-MM-DD in Europe/Paris regardless of Vercel region
  const tz = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
  return tz.slice(0,10);
}

export default async function handler(req, res) {
  // CORS — Shortcuts send no Origin so we just allow anything for the POST.
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: 'missing_token' });

  // Look up user by token in user_connections.credentials.token
  // Stored as plain text for apple_health (the iOS Shortcut can't decrypt).
  // Other providers (Strava/Intervals.icu) DO encrypt because they live server-side.
  let conn;
  try {
    const rows = await supa(
      `/rest/v1/user_connections?source=eq.apple_health&status=eq.active&credentials->>token=eq.${encodeURIComponent(token)}&select=id,user_id,credentials`
    );
    conn = rows[0];
  } catch (e) {
    console.error('[sync-apple-health] lookup fail', e);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!conn) return res.status(401).json({ error: 'invalid_token' });

  const body = req.body || {};
  const date = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayParis();
  const metrics = body.metrics || {};

  const rows = [];
  for (const [field, value] of Object.entries(metrics)) {
    if (value == null) continue;
    const m = APPLE_MAP[field];
    if (!m) continue; // ignore unknown fields rather than error — Shortcut can grow over time
    rows.push({
      user_id:     conn.user_id,
      date,
      source:      'apple_health',
      metric_type: m.metric,
      value:       m.tx(Number(value)),
      unit:        m.unit,
      external_id: `apple_${date}_${m.metric}`,
    });
  }

  if (!rows.length) {
    return res.status(200).json({ status: 'ok', inserted: 0, note: 'no_recognized_metrics' });
  }

  let inserted = 0;
  try {
    const data = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST', body: JSON.stringify(rows),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    inserted = data.length;

    // Bookkeeping on the connection row
    await supa(
      `/rest/v1/user_connections?id=eq.${conn.id}`,
      { method: 'PATCH', body: JSON.stringify({
          last_sync_at:     new Date().toISOString(),
          last_sync_status: `ok: ${inserted} rows`,
          last_sync_error:  null,
          status:           'active',
        }) }
    );
  } catch (e) {
    await supa(
      `/rest/v1/user_connections?id=eq.${conn.id}`,
      { method: 'PATCH', body: JSON.stringify({
          last_sync_at:     new Date().toISOString(),
          last_sync_status: 'error',
          last_sync_error:  String(e.message || e).slice(0,500),
          status:           'error',
        }) }
    );
    return res.status(500).json({ error: 'upsert_failed', detail: String(e.message || e) });
  }

  return res.status(200).json({ status: 'ok', inserted, date });
}
