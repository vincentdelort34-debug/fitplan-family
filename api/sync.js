// api/sync.js — Consolidated sync dispatcher for all providers.
//
// Routes:
//   POST /api/sync?provider=strava|fitbit|withings|intervals_icu&user=<uuid>&days=N
//   POST /api/sync?all=1   (cron umbrella — syncs every active connection across providers)
//
// Reduces 5 files (sync-strava, sync-fitbit, sync-withings, sync-intervals, sync-all)
// to 1 to fit Vercel Hobby's 12-function limit.

import { encrypt, decrypt } from './_lib/crypto.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

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
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

// Normalize every row in a batch to the same key set so PostgREST accepts the
// batch upsert. Without this, mixing wellness rows (no `metadata`) and activity
// rows (with `metadata`) in the same payload triggers PGRST102
// "All object keys must match".
function normalizeRows(rows) {
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  const keys = Array.from(allKeys);
  return rows.map(r => {
    const out = {};
    for (const k of keys) out[k] = (k in r) ? r[k] : null;
    return out;
  });
}

async function upsertHealth(rows) {
  if (!rows.length) return 0;
  const normalized = normalizeRows(rows);
  let inserted = 0;
  for (let i = 0; i < normalized.length; i += 200) {
    const chunk = normalized.slice(i, i + 200);
    const out = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST', body: JSON.stringify(chunk),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    inserted += out.length;
  }
  return inserted;
}

// =============================================================================
// INTERVALS.ICU
// =============================================================================
const INTERVALS_MAP = [
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
  ['readiness',     'readiness',          v => v, 'score'],
  ['respiration',   'respiration_rate',   v => v, 'rpm'],
  ['spO2',          'spo2',               v => v, 'pct'],
  ['avgSleepingHR', 'avg_sleeping_hr',    v => v, 'bpm'],
];

async function syncIntervals(conn, daysBack) {
  const athleteId = decrypt(conn.credentials.athlete_id);
  const apiKey    = decrypt(conn.credentials.api_key);
  const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');
  const today = new Date(); const oldest = new Date(today); oldest.setDate(oldest.getDate() - daysBack);
  const fmt = d => d.toISOString().slice(0,10);

  const wRes = await fetch(`https://intervals.icu/api/v1/athlete/${athleteId}/wellness?oldest=${fmt(oldest)}&newest=${fmt(today)}`,
    { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!wRes.ok) throw new Error(`intervals_wellness_${wRes.status}`);
  const wellness = await wRes.json();
  const rows = [];
  for (const w of wellness) {
    for (const [field, metric, transform, unit] of INTERVALS_MAP) {
      const raw = w[field];
      if (raw == null) continue;
      rows.push({ user_id: conn.user_id, date: w.id, source: 'intervals_icu',
        metric_type: metric, value: transform(raw), unit,
        external_id: `intervals_${w.id}_${metric}` });
    }
  }

  const aRes = await fetch(`https://intervals.icu/api/v1/athlete/${athleteId}/activities?oldest=${fmt(oldest)}&newest=${fmt(today)}`,
    { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!aRes.ok) throw new Error(`intervals_activities_${aRes.status}`);
  const activities = await aRes.json();
  for (const a of activities) {
    const date = (a.start_date_local || a.start_date || '').slice(0,10);
    if (!date) continue;
    rows.push({ user_id: conn.user_id, date, source: 'intervals_icu', metric_type: 'workout',
      value: a.moving_time != null ? Math.round(a.moving_time/60) : null, unit: 'min',
      metadata: { id: a.id, name: a.name, type: a.type, distance_m: a.distance,
        moving_time_s: a.moving_time, elapsed_time_s: a.elapsed_time, elevation_gain: a.total_elevation_gain,
        avg_hr: a.average_heartrate, max_hr: a.max_heartrate,
        training_load: a.icu_training_load ?? a.training_load, tss: a.icu_training_load ?? a.tss,
        calories: a.calories, kilojoules: a.kilojoules,
        avg_watts: a.icu_average_watts ?? a.average_watts,
        max_watts: a.max_watts,
        weighted_avg_watts: a.icu_weighted_avg_watts ?? a.weighted_average_watts,
        ftp: a.icu_ftp,
        te_aero: a.icu_aerobic_training_effect, te_anaero: a.icu_anaerobic_training_effect,
        avg_speed: a.average_speed, max_speed: a.max_speed },
      external_id: `intervals_act_${a.id}` });
  }
  const inserted = await upsertHealth(rows);
  return { wellness_records: wellness.length, activities: activities.length, rows_upserted: inserted };
}

// =============================================================================
// STRAVA
// =============================================================================
async function refreshStrava(conn) {
  const now = Math.floor(Date.now() / 1000);
  if (conn.credentials.expires_at && conn.credentials.expires_at > now + 60) {
    return { access_token: decrypt(conn.credentials.access_token), refreshed: false };
  }
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token, grant_type: 'refresh_token',
    }).toString(),
  });
  if (!r.ok) throw new Error(`strava_refresh_${r.status}`);
  const t = await r.json();
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH', body: JSON.stringify({
      credentials: { ...conn.credentials,
        access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token),
        expires_at: t.expires_at },
      updated_at: new Date().toISOString(),
    }),
  });
  return { access_token: t.access_token, refreshed: true };
}

async function syncStrava(conn, daysBack) {
  const tok = await refreshStrava(conn);
  const afterEpoch = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://www.strava.com/api/v3/athlete/activities?after=${afterEpoch}&per_page=100&page=${page}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) throw new Error(`strava_act_${r.status}`);
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const rows = all.map(a => ({
    user_id: conn.user_id,
    date: (a.start_date_local || a.start_date || '').slice(0,10),
    source: 'strava', metric_type: 'workout',
    value: a.moving_time != null ? Math.round(a.moving_time/60) : null, unit: 'min',
    metadata: {
      id: a.id, name: a.name, type: a.type, sport_type: a.sport_type,
      start_local: a.start_date_local, start_utc: a.start_date,
      distance_m: a.distance, moving_time_s: a.moving_time, elapsed_time_s: a.elapsed_time,
      elevation_gain: a.total_elevation_gain, avg_hr: a.average_heartrate, max_hr: a.max_heartrate,
      avg_speed: a.average_speed, max_speed: a.max_speed,
      avg_watts: a.average_watts, max_watts: a.max_watts, weighted_avg_watts: a.weighted_average_watts,
      kilojoules: a.kilojoules, kudos_count: a.kudos_count, calories: a.calories,
      trainer: a.trainer, commute: a.commute, gear_id: a.gear_id,
    },
    external_id: `strava_${a.id}`,
  })).filter(r => r.date);
  const inserted = await upsertHealth(rows);
  return { activities: all.length, rows_upserted: inserted, refreshed: tok.refreshed };
}

// =============================================================================
// FITBIT
// =============================================================================
async function refreshFitbit(conn) {
  const now = Math.floor(Date.now() / 1000);
  if (conn.credentials.expires_at && conn.credentials.expires_at > now + 60) {
    return { access_token: decrypt(conn.credentials.access_token), refreshed: false };
  }
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const basic = Buffer.from(`${process.env.FITBIT_CLIENT_ID}:${process.env.FITBIT_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST', headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
  });
  if (!r.ok) throw new Error(`fitbit_refresh_${r.status}`);
  const t = await r.json();
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH', body: JSON.stringify({
      credentials: { ...conn.credentials,
        access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token),
        expires_at: Math.floor(Date.now()/1000) + (t.expires_in || 28800) },
      updated_at: new Date().toISOString(),
    }),
  });
  return { access_token: t.access_token, refreshed: true };
}

async function fbGet(token, path) {
  const r = await fetch(`https://api.fitbit.com${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

async function syncFitbit(conn, daysBack) {
  const tok = await refreshFitbit(conn);
  const dates = [];
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0,10));
  }
  const rows = [];
  for (const date of dates) {
    const sl = await fbGet(tok.access_token, `/1.2/user/-/sleep/date/${date}.json`);
    if (sl && sl.summary && sl.summary.totalMinutesAsleep != null) {
      rows.push({ user_id: conn.user_id, date, source: 'fitbit', metric_type: 'sleep_duration',
        value: sl.summary.totalMinutesAsleep, unit: 'min', external_id: `fitbit_${date}_sleep_duration` });
    }
    const ac = await fbGet(tok.access_token, `/1/user/-/activities/date/${date}.json`);
    if (ac && ac.summary) {
      const s = ac.summary;
      if (s.steps != null) rows.push({ user_id: conn.user_id, date, source: 'fitbit', metric_type: 'steps', value: s.steps, unit: 'count', external_id: `fitbit_${date}_steps` });
      if (s.caloriesOut != null) rows.push({ user_id: conn.user_id, date, source: 'fitbit', metric_type: 'total_kcal', value: s.caloriesOut, unit: 'kcal', external_id: `fitbit_${date}_total_kcal` });
      if (s.activityCalories != null) rows.push({ user_id: conn.user_id, date, source: 'fitbit', metric_type: 'active_kcal', value: s.activityCalories, unit: 'kcal', external_id: `fitbit_${date}_active_kcal` });
    }
    const hr = await fbGet(tok.access_token, `/1/user/-/activities/heart/date/${date}/1d.json`);
    const rest = hr && hr['activities-heart'] && hr['activities-heart'][0] && hr['activities-heart'][0].value && hr['activities-heart'][0].value.restingHeartRate;
    if (rest) rows.push({ user_id: conn.user_id, date, source: 'fitbit', metric_type: 'resting_hr', value: rest, unit: 'bpm', external_id: `fitbit_${date}_resting_hr` });
    const hrv = await fbGet(tok.access_token, `/1/user/-/hrv/date/${date}.json`);
    const rmssd = hrv && hrv.hrv && hrv.hrv[0] && hrv.hrv[0].value && hrv.hrv[0].value.dailyRmssd;
    if (rmssd) rows.push({ user_id: conn.user_id, date, source: 'fitbit', metric_type: 'hrv', value: rmssd, unit: 'ms', external_id: `fitbit_${date}_hrv` });
  }
  const w = await fbGet(tok.access_token, `/1/user/-/body/log/weight/date/${dates[0]}/30d.json`);
  if (w && Array.isArray(w.weight)) {
    for (const e of w.weight) {
      rows.push({ user_id: conn.user_id, date: e.date, source: 'fitbit', metric_type: 'weight',
        value: e.weight, unit: 'kg', external_id: `fitbit_${e.date}_weight` });
    }
  }
  const inserted = await upsertHealth(rows);
  return { rows_upserted: inserted, refreshed: tok.refreshed };
}

// =============================================================================
// WITHINGS
// =============================================================================
async function refreshWithings(conn) {
  const now = Math.floor(Date.now() / 1000);
  if (conn.credentials.expires_at && conn.credentials.expires_at > now + 60) {
    return { access_token: decrypt(conn.credentials.access_token), refreshed: false };
  }
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const r = await fetch('https://wbsapi.withings.net/v2/oauth2', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'requesttoken',
      client_id: process.env.WITHINGS_CLIENT_ID,
      client_secret: process.env.WITHINGS_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token,
    }).toString(),
  });
  const j = await r.json();
  if (j.status !== 0) throw new Error(`withings_refresh_status_${j.status}`);
  const b = j.body;
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH', body: JSON.stringify({
      credentials: { ...conn.credentials,
        access_token: encrypt(b.access_token), refresh_token: encrypt(b.refresh_token),
        expires_at: Math.floor(Date.now()/1000) + (b.expires_in || 10800) },
      updated_at: new Date().toISOString(),
    }),
  });
  return { access_token: b.access_token, refreshed: true };
}

const WITHINGS_MEAS = {
  1:  ['weight','kg'], 6: ['body_fat','pct'], 9: ['bp_diastolic','mmHg'],
  10: ['bp_systolic','mmHg'], 11: ['resting_hr','bpm'], 76: ['muscle_mass','kg'],
  77: ['hydration','kg'], 88: ['bone_mass','kg'],
};

async function syncWithings(conn, daysBack) {
  const tok = await refreshWithings(conn);
  const now = Math.floor(Date.now() / 1000);
  const startEpoch = now - daysBack * 86400;
  const rows = [];

  const measForm = new URLSearchParams({
    action: 'getmeas', meastypes: Object.keys(WITHINGS_MEAS).join(','),
    category: '1', startdate: String(startEpoch), enddate: String(now),
  });
  const mr = await fetch('https://wbsapi.withings.net/measure', {
    method: 'POST', headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: measForm.toString(),
  });
  const mj = await mr.json();
  if (mj.status === 0 && Array.isArray(mj.body.measuregrps)) {
    for (const g of mj.body.measuregrps) {
      const date = new Date(g.date * 1000).toISOString().slice(0, 10);
      for (const meas of (g.measures || [])) {
        const cfg = WITHINGS_MEAS[meas.type];
        if (!cfg) continue;
        const val = meas.value * Math.pow(10, meas.unit);
        rows.push({ user_id: conn.user_id, date, source: 'withings',
          metric_type: cfg[0], value: val, unit: cfg[1],
          external_id: `withings_${g.grpid}_${cfg[0]}` });
      }
    }
  }

  const fmt = e => new Date(e * 1000).toISOString().slice(0,10);
  const sleepForm = new URLSearchParams({
    action: 'getsummary',
    startdateymd: fmt(startEpoch), enddateymd: fmt(now),
    data_fields: 'asleepduration,sleep_score,deepsleepduration,lightsleepduration,remsleepduration,hr_average,hr_min',
  });
  const sr = await fetch('https://wbsapi.withings.net/v2/sleep', {
    method: 'POST', headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: sleepForm.toString(),
  });
  const sj = await sr.json();
  if (sj.status === 0 && Array.isArray(sj.body.series)) {
    for (const s of sj.body.series) {
      const date = s.date;
      const d = s.data || {};
      if (d.asleepduration != null) rows.push({ user_id: conn.user_id, date, source: 'withings', metric_type: 'sleep_duration', value: Math.round(d.asleepduration / 60), unit: 'min', external_id: `withings_${date}_sleep_duration` });
      if (d.sleep_score != null)    rows.push({ user_id: conn.user_id, date, source: 'withings', metric_type: 'sleep_score', value: d.sleep_score, unit: 'score', external_id: `withings_${date}_sleep_score` });
      if (d.hr_min != null)         rows.push({ user_id: conn.user_id, date, source: 'withings', metric_type: 'resting_hr', value: d.hr_min, unit: 'bpm', external_id: `withings_${date}_resting_hr` });
    }
  }

  const inserted = await upsertHealth(rows);
  return { rows_upserted: inserted, refreshed: tok.refreshed };
}

// =============================================================================
// DISPATCHER
// =============================================================================
const DISPATCH = {
  intervals_icu: { sync: syncIntervals, defaultDays: 14 },
  strava:        { sync: syncStrava,    defaultDays: 7 },
  fitbit:        { sync: syncFitbit,    defaultDays: 7 },
  withings:      { sync: syncWithings,  defaultDays: 7 },
};

async function runSyncForConnection(conn, daysBack) {
  const fn = DISPATCH[conn.source];
  if (!fn) {
    // Push-based providers (apple_health) or future providers we don't pull-sync — skip silently
    return { user_id: conn.user_id, source: conn.source, skipped: 'no_pull_sync' };
  }
  const t0 = Date.now();
  try {
    const r = await fn.sync(conn, daysBack);
    await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
      method: 'PATCH', body: JSON.stringify({
        last_sync_at: new Date().toISOString(),
        last_sync_status: `ok: ${JSON.stringify(r)} in ${Date.now()-t0}ms`,
        last_sync_error: null, status: 'active',
      }),
    });
    return { user_id: conn.user_id, source: conn.source, ms: Date.now()-t0, ...r };
  } catch (e) {
    await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
      method: 'PATCH', body: JSON.stringify({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'error',
        last_sync_error: String(e.message || e).slice(0,500),
        status: 'error',
      }),
    });
    return { user_id: conn.user_id, source: conn.source, error: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  // Auth: Bearer CRON_SECRET, or any authenticated user passing user= (we don't validate JWT here,
  // since the supabase RLS gates access elsewhere; we just allow it for the UI "sync now" button).
  if (CRON_SECRET) {
    const hdr = req.headers['authorization'] || '';
    const isCron = hdr === `Bearer ${CRON_SECRET}`;
    if (!isCron && !req.query.user) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'env_missing' });
  }

  const providerQ = (req.query.provider || '').toLowerCase();
  const userId    = req.query.user;
  const all       = req.query.all === '1';
  const days      = parseInt(req.query.days || '0', 10);

  try {
    let filter;
    if (all) {
      filter = `status=eq.active&select=id,user_id,source,credentials`;
    } else if (providerQ && userId) {
      filter = `source=eq.${providerQ}&user_id=eq.${userId}&select=id,user_id,source,credentials`;
    } else if (providerQ) {
      filter = `source=eq.${providerQ}&status=eq.active&select=id,user_id,source,credentials`;
    } else {
      return res.status(400).json({ error: 'need provider= or all=1' });
    }
    const conns = await supa(`/rest/v1/user_connections?${filter}`);
    const results = [];
    for (const c of conns) {
      const daysBack = days || (DISPATCH[c.source]?.defaultDays || 7);
      results.push(await runSyncForConnection(c, daysBack));
    }
    return res.status(200).json({ ok: true, connections: conns.length, results });
  } catch (e) {
    console.error('[sync] fatal', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
