// api/sync-intervals.js
// Vercel cron handler — runs daily and syncs Intervals.icu wellness + activities
// for every user with an active intervals_icu connection in user_connections.
//
// Reads `credentials` (encrypted JSONB) → decrypts with ENCRYPTION_SECRET → calls
// Intervals.icu REST API → upserts into health_data via Supabase service-role key.
// Records sync status (and any per-user error) in user_connections.

import { decrypt } from './_lib/crypto.js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET; // optional gating

const WELLNESS_MAP = [
  ['sleepSecs',     'sleep_duration',     v => Math.round(v/60), 'min'],
  ['sleepScore',    'sleep_score',        v => v, 'score'],
  ['restingHR',     'resting_hr',         v => v, 'bpm'],
  ['hrv',           'hrv',                v => v, 'ms'],
  ['hrvSDNN',       'hrv_sdnn',           v => v, 'ms'],
  ['steps',         'steps',              v => v, 'count'],
  ['weight',        'weight',             v => v, 'kg'],
  ['bodyFat',       'body_fat',           v => v, 'pct'],
  ['vo2max',        'vo2max',             v => v, 'ml/kg/min'],
  ['ctl',           'training_load',      v => v, 'ctl'],
  ['atl',           'fatigue',            v => v, 'atl'],
  ['rampRate',      'ramp_rate',          v => v, 'ctl/wk'],
  ['stress',        'stress_subjective',  v => v, 'rpe'],
  ['fatigue',       'fatigue_subjective', v => v, 'rpe'],
  ['mood',          'mood',               v => v, 'rpe'],
  ['motivation',    'motivation',         v => v, 'rpe'],
  ['readiness',     'readiness',          v => v, 'score'],
  ['respiration',   'respiration_rate',   v => v, 'rpm'],
  ['spO2',          'spo2',               v => v, 'pct'],
  ['systolic',      'bp_systolic',        v => v, 'mmHg'],
  ['diastolic',     'bp_diastolic',       v => v, 'mmHg'],
  ['avgSleepingHR', 'avg_sleeping_hr',    v => v, 'bpm'],
  ['kcalConsumed',  'kcal_consumed',      v => v, 'kcal'],
];

function fmt(d) { return d.toISOString().slice(0,10); }

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

async function syncOneUser(conn) {
  const userId = conn.user_id;
  let athleteId, apiKey;
  try {
    athleteId = decrypt(conn.credentials.athlete_id);
    apiKey    = decrypt(conn.credentials.api_key);
  } catch (e) {
    throw new Error(`credential decrypt failed: ${e.message}`);
  }
  const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');

  // Window: last 14 days (covers Intervals.icu late-arriving Garmin sync)
  const today  = new Date();
  const oldest = new Date(today); oldest.setDate(oldest.getDate() - 14);

  // 1) Wellness
  const wRes = await fetch(
    `https://intervals.icu/api/v1/athlete/${athleteId}/wellness?oldest=${fmt(oldest)}&newest=${fmt(today)}`,
    { headers: { Authorization: auth, Accept: 'application/json' } }
  );
  if (!wRes.ok) throw new Error(`intervals wellness ${wRes.status}`);
  const wellness = await wRes.json();

  const wellnessRows = [];
  for (const w of wellness) {
    const meta = { rampRate: w.rampRate, fatigue: w.atl, fitness: w.ctl,
                   form: (w.ctl != null && w.atl != null) ? w.ctl - w.atl : undefined };
    for (const [field, metric, transform, unit] of WELLNESS_MAP) {
      const raw = w[field];
      if (raw == null) continue;
      wellnessRows.push({
        user_id:     userId,
        date:        w.id,
        source:      'intervals_icu',
        metric_type: metric,
        value:       transform(raw),
        unit,
        metadata:    meta,
        external_id: `intervals_${w.id}_${metric}`,
      });
    }
  }

  // 2) Activities
  const aRes = await fetch(
    `https://intervals.icu/api/v1/athlete/${athleteId}/activities?oldest=${fmt(oldest)}&newest=${fmt(today)}`,
    { headers: { Authorization: auth, Accept: 'application/json' } }
  );
  if (!aRes.ok) throw new Error(`intervals activities ${aRes.status}`);
  const activities = await aRes.json();

  const workoutRows = activities.map(a => ({
    user_id:     userId,
    date:        (a.start_date_local || a.start_date || '').slice(0,10),
    source:      'intervals_icu',
    metric_type: 'workout',
    value:       a.moving_time != null ? Math.round(a.moving_time/60) : null,
    unit:        'min',
    metadata: {
      id: a.id, name: a.name, type: a.type,
      distance_m: a.distance, moving_time_s: a.moving_time, elapsed_time_s: a.elapsed_time,
      elevation_gain: a.total_elevation_gain,
      avg_hr: a.average_heartrate, max_hr: a.max_heartrate,
      avg_speed: a.average_speed, max_speed: a.max_speed,
      avg_power: a.average_watts, np: a.normalized_power, ftp: a.ftp,
      intensity: a.intensity, training_load: a.training_load, tss: a.tss,
      calories: a.calories,
      hr_zones: { z1: a.zone1Seconds, z2: a.zone2Seconds, z3: a.zone3Seconds, z4: a.zone4Seconds, z5: a.zone5Seconds },
      te_aero: a.aerobic_training_effect, te_anaero: a.anaerobic_training_effect,
    },
    external_id: `intervals_act_${a.id}`,
  })).filter(r => r.date);

  // 3) Upsert
  const chunk = (arr, n) => Array.from({length:Math.ceil(arr.length/n)},(_,i)=>arr.slice(i*n,(i+1)*n));
  let wellnessInserted = 0, workoutInserted = 0;
  for (const c of chunk(wellnessRows, 200)) {
    const res = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST', body: JSON.stringify(c),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    wellnessInserted += res.length;
  }
  for (const c of chunk(workoutRows, 100)) {
    const res = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST', body: JSON.stringify(c),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    workoutInserted += res.length;
  }

  return { wellness_rows: wellnessInserted, workout_rows: workoutInserted };
}

export default async function handler(req, res) {
  // Optional CRON_SECRET check (Vercel sets Authorization: Bearer $CRON_SECRET on cron calls)
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  try {
    // 1) Fetch active intervals_icu connections
    const conns = await supa(
      `/rest/v1/user_connections?source=eq.intervals_icu&status=eq.active&select=id,user_id,credentials`
    );

    const results = [];
    for (const c of conns) {
      const t0 = Date.now();
      try {
        const r = await syncOneUser(c);
        await supa(
          `/rest/v1/user_connections?id=eq.${c.id}`,
          { method: 'PATCH', body: JSON.stringify({
              last_sync_at:     new Date().toISOString(),
              last_sync_status: `ok: ${r.wellness_rows}+${r.workout_rows} rows in ${Date.now()-t0}ms`,
              last_sync_error:  null,
              status:           'active',
            }) }
        );
        results.push({ user_id: c.user_id, ...r, ms: Date.now()-t0 });
      } catch (e) {
        await supa(
          `/rest/v1/user_connections?id=eq.${c.id}`,
          { method: 'PATCH', body: JSON.stringify({
              last_sync_at:     new Date().toISOString(),
              last_sync_status: 'error',
              last_sync_error:  String(e.message || e).slice(0,500),
              status:           'error',
            }) }
        );
        results.push({ user_id: c.user_id, error: String(e.message || e) });
      }
    }
    return res.status(200).json({ ok: true, connections: conns.length, results });
  } catch (e) {
    console.error('[sync-intervals] fatal', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
