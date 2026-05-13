// api/sync-apple-health.js
// POST endpoint hit by Apple Health on iPhone.
// Accepts TWO payload formats:
//
// 1) "Health Auto Export" iOS app (recommended) — automatic, JSON Webhook export:
//    {
//      "data": {
//        "metrics": [
//          { "name": "step_count", "units": "count", "data": [{ "date": "2026-05-13 23:59:00 +0100", "qty": 12345 }] },
//          { "name": "heart_rate_resting", "units": "bpm", "data": [{ "date": "...", "qty": 52 }] },
//          { "name": "sleep_analysis", "data": [{ "sleepStart": "...", "sleepEnd": "...", "asleep": 27000, ... }] },
//          ...
//        ],
//        "workouts": [ { "name": "Cycling", "start": "...", "end": "...", "totalDistance": {...}, ... } ]
//      }
//    }
//
// 2) Simple format (native iOS Shortcut, manual dictionary):
//    {
//      "date": "2026-05-13",
//      "metrics": {
//        "sleep_minutes": 425, "resting_hr": 52, "hrv": 38, "steps": 8543,
//        "active_calories": 412, "weight_kg": 91.2, "vo2max": 40
//      }
//    }
//
// Auth: header X-User-Token = user_connections.credentials.token (plain text — Shortcuts/HAE can't AES).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- HAE field → (metric, unit, transform)
// Reference: https://www.healthexportapp.com/docs (metric names match HealthKit identifiers, lowercased)
const HAE_MAP = {
  'step_count':                   { metric: 'steps',            unit: 'count',  tx: v => v },
  'walking_running_distance':     { metric: 'distance_walked',  unit: 'm',      tx: v => Math.round(v) },
  'flights_climbed':              { metric: 'floors_climbed',   unit: 'count',  tx: v => v },
  'active_energy':                { metric: 'active_kcal',      unit: 'kcal',   tx: v => Math.round(v) },
  'basal_energy_burned':          { metric: 'basal_kcal',       unit: 'kcal',   tx: v => Math.round(v) },
  'apple_exercise_time':          { metric: 'active_minutes',   unit: 'min',    tx: v => v },
  'apple_stand_time':             { metric: 'stand_minutes',    unit: 'min',    tx: v => v },
  'heart_rate_resting':           { metric: 'resting_hr',       unit: 'bpm',    tx: v => Math.round(v) },
  'resting_heart_rate':           { metric: 'resting_hr',       unit: 'bpm',    tx: v => Math.round(v) },
  'heart_rate_variability':       { metric: 'hrv',              unit: 'ms',     tx: v => Math.round(v) },
  'walking_heart_rate_average':   { metric: 'walking_hr_avg',   unit: 'bpm',    tx: v => Math.round(v) },
  'respiratory_rate':             { metric: 'respiration_rate', unit: 'rpm',    tx: v => Math.round(v) },
  'blood_oxygen_saturation':      { metric: 'spo2',             unit: 'pct',    tx: v => Math.round(v * 100) },
  'body_mass':                    { metric: 'weight',           unit: 'kg',     tx: v => v },
  'weight_body_mass':             { metric: 'weight',           unit: 'kg',     tx: v => v },
  'body_fat_percentage':          { metric: 'body_fat',         unit: 'pct',    tx: v => v * 100 },
  'lean_body_mass':               { metric: 'muscle_mass',      unit: 'kg',     tx: v => v },
  'vo2_max':                      { metric: 'vo2max',           unit: 'ml/kg/min', tx: v => v },
};

// --- Simple format keys (kept for native Shortcut compatibility)
const SIMPLE_MAP = {
  sleep_minutes:   { metric: 'sleep_duration', unit: 'min',   tx: v => v },
  sleep_score:     { metric: 'sleep_score',    unit: 'score', tx: v => v },
  resting_hr:      { metric: 'resting_hr',     unit: 'bpm',   tx: v => v },
  hrv:             { metric: 'hrv',            unit: 'ms',    tx: v => v },
  hrv_sdnn:        { metric: 'hrv_sdnn',       unit: 'ms',    tx: v => v },
  steps:           { metric: 'steps',          unit: 'count', tx: v => v },
  distance_m:      { metric: 'distance_walked',unit: 'm',     tx: v => v },
  floors_climbed:  { metric: 'floors_climbed', unit: 'count', tx: v => v },
  active_calories: { metric: 'active_kcal',    unit: 'kcal',  tx: v => v },
  total_calories:  { metric: 'total_kcal',     unit: 'kcal',  tx: v => v },
  weight_kg:       { metric: 'weight',         unit: 'kg',    tx: v => v },
  body_fat_pct:    { metric: 'body_fat',       unit: 'pct',   tx: v => v },
  vo2max:          { metric: 'vo2max',         unit: 'ml/kg/min', tx: v => v },
  active_minutes:  { metric: 'active_minutes', unit: 'min',   tx: v => v },
};

async function supa(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

function pickDate(d) {
  // HAE date format: "2026-05-13 23:59:00 +0100"  → keep YYYY-MM-DD
  if (!d) return null;
  const m = String(d).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function todayParis() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0,10);
}

function rowsFromHAE(userId, payload) {
  const rows = [];
  const data = payload.data || payload; // HAE can wrap in "data"
  const metrics = data.metrics || [];
  for (const m of metrics) {
    const cfg = HAE_MAP[m.name];
    if (!cfg) continue;
    for (const entry of (m.data || [])) {
      const date = pickDate(entry.date || entry.endDate || entry.startDate);
      if (!date) continue;
      // HAE uses `qty` for scalar values
      const qty = entry.qty ?? entry.value;
      if (qty == null || isNaN(Number(qty))) continue;
      rows.push({
        user_id:     userId,
        date,
        source:      'apple_health',
        metric_type: cfg.metric,
        value:       cfg.tx(Number(qty)),
        unit:        cfg.unit,
        external_id: `apple_${date}_${cfg.metric}`,
      });
    }
  }
  // Sleep_analysis is special — HAE returns ranges with `asleep` (seconds)
  const sleep = metrics.find(m => m.name === 'sleep_analysis');
  if (sleep && Array.isArray(sleep.data)) {
    for (const entry of sleep.data) {
      const date = pickDate(entry.sleepEnd || entry.endDate || entry.date);
      if (!date) continue;
      const asleepSec = entry.asleep ?? entry.totalSleep ?? null;
      if (asleepSec != null) {
        rows.push({ user_id:userId, date, source:'apple_health',
          metric_type: 'sleep_duration', value: Math.round(asleepSec / 60),
          unit: 'min', external_id: `apple_${date}_sleep_duration` });
      }
      // Optional stages
      ['deep','rem','core','light'].forEach(stage => {
        const v = entry[stage];
        if (v != null && !isNaN(v)) {
          rows.push({ user_id:userId, date, source:'apple_health',
            metric_type: `sleep_${stage === 'light' ? 'light' : stage}`,
            value: Math.round(v / 60), unit: 'min',
            external_id: `apple_${date}_sleep_${stage}` });
        }
      });
    }
  }
  // Workouts
  const workouts = data.workouts || [];
  for (const w of workouts) {
    const date = pickDate(w.start || w.startDate);
    if (!date) continue;
    rows.push({
      user_id: userId, date, source: 'apple_health', metric_type: 'workout',
      value: w.duration != null ? Math.round(w.duration / 60) : null, unit: 'min',
      metadata: {
        name: w.name, type: w.activityType || w.type,
        start: w.start, end: w.end,
        distance_m: w.totalDistance && w.totalDistance.qty ? w.totalDistance.qty : w.totalDistance,
        calories:   w.totalEnergyBurned && w.totalEnergyBurned.qty ? w.totalEnergyBurned.qty : w.totalEnergyBurned,
        avg_hr:     w.avgHeartRate,
        max_hr:     w.maxHeartRate,
      },
      external_id: `apple_workout_${w.id || (w.start + '_' + (w.activityType || ''))}`,
    });
  }
  return rows;
}

function rowsFromSimple(userId, payload) {
  const date = (payload.date && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)) ? payload.date : todayParis();
  const metrics = payload.metrics || {};
  const rows = [];
  for (const [field, value] of Object.entries(metrics)) {
    if (value == null) continue;
    const cfg = SIMPLE_MAP[field];
    if (!cfg) continue;
    rows.push({
      user_id: userId, date, source: 'apple_health',
      metric_type: cfg.metric, value: cfg.tx(Number(value)), unit: cfg.unit,
      external_id: `apple_${date}_${cfg.metric}`,
    });
  }
  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_misconfigured' });

  // Accept token in header or in query (HAE allows both)
  const token = req.headers['x-user-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  // Look up the user from the token (stored plain-text on user_connections.credentials.token)
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

  // Auto-detect format
  const body = req.body || {};
  let rows = [];
  if (body.data && (body.data.metrics || body.data.workouts)) {
    rows = rowsFromHAE(conn.user_id, body);
  } else if (Array.isArray(body.metrics)) {
    rows = rowsFromHAE(conn.user_id, body); // HAE without "data" wrapper
  } else if (body.metrics && typeof body.metrics === 'object') {
    rows = rowsFromSimple(conn.user_id, body);
  } else {
    return res.status(400).json({ error: 'unsupported_payload', hint: 'expected HAE format ({data:{metrics:[…]}}) or simple ({metrics:{sleep_minutes:…}})' });
  }

  if (!rows.length) {
    return res.status(200).json({ status: 'ok', inserted: 0, note: 'no_recognized_metrics' });
  }

  let inserted = 0;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const data = await supa(
        `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
        { method: 'POST', body: JSON.stringify(chunk),
          headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
      );
      inserted += data.length;
    }
    await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
      method: 'PATCH', body: JSON.stringify({
        last_sync_at: new Date().toISOString(),
        last_sync_status: `ok: ${inserted} rows`,
        last_sync_error: null, status: 'active',
      }),
    });
  } catch (e) {
    await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
      method: 'PATCH', body: JSON.stringify({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'error',
        last_sync_error: String(e.message || e).slice(0,500),
        status: 'error',
      }),
    });
    return res.status(500).json({ error: 'upsert_failed', detail: String(e.message || e) });
  }
  return res.status(200).json({ status: 'ok', inserted });
}
