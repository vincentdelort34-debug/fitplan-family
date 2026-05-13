// api/sync-health.js
// Unified webhook endpoint for OS-level health platforms.
//
// Apple iOS path:
//   Health Auto Export app on iPhone → POST { data: { metrics: [{name, data: [...]}], workouts: [...] } }
//   OR native Shortcut → POST { date, metrics: { sleep_minutes, resting_hr, ... } }
//
// Google Android path:
//   Health Sync / Tasker / custom companion app → POST any of:
//     1) { date, metrics: { sleep_minutes, resting_hr, steps, ... } }   (simple — recommended)
//     2) { metrics: [{type, value, unit, date}, ...] }                  (Health Sync flat array)
//     3) HAE-like { data: { metrics: [...] } }                          (compatible)
//
// Auth: header X-User-Token = user_connections.credentials.token (plain text).
// The source (apple_health vs google_health_connect) is determined by which user_connections
// row owns the token, not by the payload.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Apple Health Auto Export field names → internal metric_type
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

// Simple format (also matches Android Health Sync output)
const SIMPLE_MAP = {
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
  oxygen_saturation:{ metric: 'spo2',           unit: 'pct',   tx: v => v },
  respiration_rate: { metric: 'respiration_rate', unit: 'rpm', tx: v => v },
};

// Health Connect / Health Sync "type" field → metric_type
const HEALTH_CONNECT_MAP = {
  Steps:                     { metric: 'steps',            unit: 'count', tx: v => Math.round(v) },
  TotalCaloriesBurned:       { metric: 'total_kcal',       unit: 'kcal',  tx: v => Math.round(v) },
  ActiveCaloriesBurned:      { metric: 'active_kcal',      unit: 'kcal',  tx: v => Math.round(v) },
  Distance:                  { metric: 'distance_walked',  unit: 'm',     tx: v => Math.round(v) },
  FloorsClimbed:             { metric: 'floors_climbed',   unit: 'count', tx: v => Math.round(v) },
  HeartRate:                 { metric: 'resting_hr',       unit: 'bpm',   tx: v => Math.round(v) }, // average for the day
  RestingHeartRate:          { metric: 'resting_hr',       unit: 'bpm',   tx: v => Math.round(v) },
  HeartRateVariabilityRmssd: { metric: 'hrv',              unit: 'ms',    tx: v => Math.round(v) },
  RespiratoryRate:           { metric: 'respiration_rate', unit: 'rpm',   tx: v => Math.round(v) },
  OxygenSaturation:          { metric: 'spo2',             unit: 'pct',   tx: v => Math.round(v * (v <= 1 ? 100 : 1)) },
  Weight:                    { metric: 'weight',           unit: 'kg',    tx: v => v },
  BodyFat:                   { metric: 'body_fat',         unit: 'pct',   tx: v => v <= 1 ? v * 100 : v },
  LeanBodyMass:              { metric: 'muscle_mass',      unit: 'kg',    tx: v => v },
  Vo2Max:                    { metric: 'vo2max',           unit: 'ml/kg/min', tx: v => v },
  SleepSession:              { metric: 'sleep_duration',   unit: 'min',   tx: v => Math.round(v) },
  ExerciseSession:           { metric: 'active_minutes',   unit: 'min',   tx: v => Math.round(v) },
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
  if (!d) return null;
  const m = String(d).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function todayParis() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0,10);
}

// Apple HAE format
function rowsFromHAE(source, userId, payload) {
  const rows = [];
  const data = payload.data || payload;
  const metrics = data.metrics || [];
  for (const m of metrics) {
    const cfg = HAE_MAP[m.name];
    if (!cfg) continue;
    for (const entry of (m.data || [])) {
      const date = pickDate(entry.date || entry.endDate || entry.startDate);
      if (!date) continue;
      const qty = entry.qty ?? entry.value;
      if (qty == null || isNaN(Number(qty))) continue;
      rows.push({
        user_id: userId, date, source,
        metric_type: cfg.metric,
        value: cfg.tx(Number(qty)),
        unit: cfg.unit,
        external_id: `${source}_${date}_${cfg.metric}`,
      });
    }
  }
  const sleep = metrics.find(m => m.name === 'sleep_analysis');
  if (sleep && Array.isArray(sleep.data)) {
    for (const entry of sleep.data) {
      const date = pickDate(entry.sleepEnd || entry.endDate || entry.date);
      if (!date) continue;
      const asleepSec = entry.asleep ?? entry.totalSleep ?? null;
      if (asleepSec != null) {
        rows.push({ user_id: userId, date, source,
          metric_type: 'sleep_duration', value: Math.round(asleepSec / 60),
          unit: 'min', external_id: `${source}_${date}_sleep_duration` });
      }
    }
  }
  const workouts = data.workouts || [];
  for (const w of workouts) {
    const date = pickDate(w.start || w.startDate);
    if (!date) continue;
    rows.push({
      user_id: userId, date, source, metric_type: 'workout',
      value: w.duration != null ? Math.round(w.duration / 60) : null, unit: 'min',
      metadata: {
        name: w.name, type: w.activityType || w.type,
        start: w.start, end: w.end,
        distance_m: w.totalDistance?.qty ?? w.totalDistance,
        calories: w.totalEnergyBurned?.qty ?? w.totalEnergyBurned,
        avg_hr: w.avgHeartRate, max_hr: w.maxHeartRate,
      },
      external_id: `${source}_workout_${w.id || (w.start + '_' + (w.activityType || ''))}`,
    });
  }
  return rows;
}

// Simple format (manual Shortcut or Android Health Sync user mapping)
function rowsFromSimple(source, userId, payload) {
  const date = (payload.date && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)) ? payload.date : todayParis();
  const metrics = payload.metrics || {};
  const rows = [];
  for (const [field, value] of Object.entries(metrics)) {
    if (value == null) continue;
    const cfg = SIMPLE_MAP[field];
    if (!cfg) continue;
    rows.push({
      user_id: userId, date, source,
      metric_type: cfg.metric, value: cfg.tx(Number(value)), unit: cfg.unit,
      external_id: `${source}_${date}_${cfg.metric}`,
    });
  }
  return rows;
}

// Health Connect array format: [{type, value, unit, date}]
function rowsFromHealthConnect(source, userId, arr) {
  const rows = [];
  for (const entry of arr) {
    const type = entry.type || entry.dataType || entry.name;
    const cfg = HEALTH_CONNECT_MAP[type];
    if (!cfg) continue;
    const date = pickDate(entry.date || entry.endTime || entry.endDate || entry.startTime || entry.timestamp);
    if (!date) continue;
    const value = entry.value ?? entry.qty ?? entry.amount;
    if (value == null || isNaN(Number(value))) continue;
    rows.push({
      user_id: userId, date, source,
      metric_type: cfg.metric, value: cfg.tx(Number(value)), unit: cfg.unit,
      external_id: `${source}_${date}_${cfg.metric}`,
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

  const token = req.headers['x-user-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  // Look up connection by token (works for both apple_health and google_health_connect rows)
  let conn;
  try {
    const rows = await supa(
      `/rest/v1/user_connections?source=in.(apple_health,google_health_connect)&status=eq.active&credentials->>token=eq.${encodeURIComponent(token)}&select=id,user_id,source,credentials`
    );
    conn = rows[0];
  } catch (e) {
    console.error('[sync-health] lookup fail', e);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!conn) return res.status(401).json({ error: 'invalid_token' });

  const body = req.body || {};
  let rows = [];
  if (body.data && (body.data.metrics || body.data.workouts)) {
    rows = rowsFromHAE(conn.source, conn.user_id, body);
  } else if (Array.isArray(body.metrics)) {
    // Could be HAE-without-wrapper OR Health Connect flat array
    if (body.metrics.length > 0 && (body.metrics[0].name && body.metrics[0].data)) {
      rows = rowsFromHAE(conn.source, conn.user_id, body);
    } else {
      rows = rowsFromHealthConnect(conn.source, conn.user_id, body.metrics);
    }
  } else if (Array.isArray(body)) {
    rows = rowsFromHealthConnect(conn.source, conn.user_id, body);
  } else if (body.metrics && typeof body.metrics === 'object') {
    rows = rowsFromSimple(conn.source, conn.user_id, body);
  } else {
    return res.status(400).json({ error: 'unsupported_payload', hint: 'Send simple {metrics:{sleep_minutes,...}}, HAE {data:{metrics:[...]}}, or Health Connect array [{type,value,date}]' });
  }

  if (!rows.length) {
    return res.status(200).json({ status: 'ok', inserted: 0, source: conn.source, note: 'no_recognized_metrics' });
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
  return res.status(200).json({ status: 'ok', inserted, source: conn.source });
}
