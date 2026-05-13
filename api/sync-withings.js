// api/sync-withings.js — daily sync: weight/body composition + sleep + workouts (Withings Body+ / Scanwatch / Sleep Mat)

import { encrypt, decrypt } from './_lib/crypto.js';

const CLIENT_ID     = process.env.WITHINGS_CLIENT_ID;
const CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;

async function supa(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

async function refreshIfNeeded(conn) {
  const now = Math.floor(Date.now() / 1000);
  if (conn.credentials.expires_at && conn.credentials.expires_at > now + 60) {
    return { access_token: decrypt(conn.credentials.access_token), refreshed: false };
  }
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const r = await fetch('https://wbsapi.withings.net/v2/oauth2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'requesttoken', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token,
    }).toString(),
  });
  const j = await r.json();
  if (j.status !== 0) throw new Error(`Withings refresh status=${j.status}: ${j.error || ''}`);
  const b = j.body;
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH', body: JSON.stringify({
      credentials: { ...conn.credentials,
        access_token:  encrypt(b.access_token),
        refresh_token: encrypt(b.refresh_token),
        expires_at:    Math.floor(Date.now() / 1000) + (b.expires_in || 10800),
      },
      updated_at: new Date().toISOString(),
    }),
  });
  return { access_token: b.access_token, refreshed: true };
}

async function wAction(accessToken, baseUrl, action, params = {}) {
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action, ...params }).toString(),
  });
  const j = await r.json();
  if (j.status !== 0) {
    console.warn(`[sync-withings] ${baseUrl} action=${action} status=${j.status}`);
    return null;
  }
  return j.body;
}

// Withings measure types → metric_type
// 1=weight kg, 6=body fat %, 9=diastolic mmHg, 10=systolic mmHg, 11=HR bpm,
// 76=muscle mass kg, 77=hydration kg, 88=bone mass kg, 91=pulse wave velocity m/s
const MEAS_MAP = {
  1:  { metric: 'weight',          unit: 'kg' },
  6:  { metric: 'body_fat',        unit: 'pct' },
  9:  { metric: 'bp_diastolic',    unit: 'mmHg' },
  10: { metric: 'bp_systolic',     unit: 'mmHg' },
  11: { metric: 'resting_hr',      unit: 'bpm' },
  76: { metric: 'muscle_mass',     unit: 'kg' },
  77: { metric: 'hydration',       unit: 'kg' },
  88: { metric: 'bone_mass',       unit: 'kg' },
  91: { metric: 'pulse_wave_vel',  unit: 'm/s' },
};

async function syncOneUser(conn, daysBack) {
  const tok = await refreshIfNeeded(conn);
  const userId = conn.user_id;
  const now = Math.floor(Date.now() / 1000);
  const startEpoch = now - daysBack * 86400;
  const rows = [];

  // 1. Body measurements
  const m = await wAction(tok.access_token, 'https://wbsapi.withings.net/measure', 'getmeas', {
    meastypes: Object.keys(MEAS_MAP).join(','),
    category:  '1',
    startdate: String(startEpoch),
    enddate:   String(now),
  });
  if (m && Array.isArray(m.measuregrps)) {
    for (const g of m.measuregrps) {
      const date = new Date(g.date * 1000).toISOString().slice(0, 10);
      for (const meas of (g.measures || [])) {
        const cfg = MEAS_MAP[meas.type];
        if (!cfg) continue;
        const val = meas.value * Math.pow(10, meas.unit); // Withings encodes scale via 'unit' (exponent)
        rows.push({
          user_id: userId, date, source: 'withings',
          metric_type: cfg.metric, value: val, unit: cfg.unit,
          external_id: `withings_${g.grpid}_${cfg.metric}`,
        });
      }
    }
  }

  // 2. Sleep summary
  const fmt = e => new Date(e * 1000).toISOString().slice(0,10);
  const sl = await wAction(tok.access_token, 'https://wbsapi.withings.net/v2/sleep', 'getsummary', {
    startdateymd: fmt(startEpoch),
    enddateymd:   fmt(now),
    data_fields:  'asleepduration,sleep_score,deepsleepduration,lightsleepduration,remsleepduration,hr_average,hr_min,rr_average',
  });
  if (sl && Array.isArray(sl.series)) {
    for (const s of sl.series) {
      const date = s.date; // YYYY-MM-DD
      const d = s.data || {};
      if (d.asleepduration != null)       rows.push({ user_id:userId, date, source:'withings', metric_type:'sleep_duration', value: Math.round(d.asleepduration / 60), unit:'min', external_id:`withings_${date}_sleep_duration` });
      if (d.sleep_score != null)          rows.push({ user_id:userId, date, source:'withings', metric_type:'sleep_score', value: d.sleep_score, unit:'score', external_id:`withings_${date}_sleep_score` });
      if (d.deepsleepduration != null)    rows.push({ user_id:userId, date, source:'withings', metric_type:'sleep_deep', value: Math.round(d.deepsleepduration / 60), unit:'min', external_id:`withings_${date}_sleep_deep` });
      if (d.lightsleepduration != null)   rows.push({ user_id:userId, date, source:'withings', metric_type:'sleep_light', value: Math.round(d.lightsleepduration / 60), unit:'min', external_id:`withings_${date}_sleep_light` });
      if (d.remsleepduration != null)     rows.push({ user_id:userId, date, source:'withings', metric_type:'sleep_rem', value: Math.round(d.remsleepduration / 60), unit:'min', external_id:`withings_${date}_sleep_rem` });
      if (d.hr_min != null)               rows.push({ user_id:userId, date, source:'withings', metric_type:'resting_hr', value: d.hr_min, unit:'bpm', external_id:`withings_${date}_resting_hr` });
      if (d.rr_average != null)           rows.push({ user_id:userId, date, source:'withings', metric_type:'respiration_rate', value: d.rr_average, unit:'rpm', external_id:`withings_${date}_respiration_rate` });
    }
  }

  // 3. Workouts (Withings activities)
  const w = await wAction(tok.access_token, 'https://wbsapi.withings.net/v2/measure', 'getworkouts', {
    startdateymd: fmt(startEpoch),
    enddateymd:   fmt(now),
    data_fields:  'calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,distance,steps',
  });
  if (w && Array.isArray(w.series)) {
    for (const ev of w.series) {
      const date = new Date(ev.startdate * 1000).toISOString().slice(0,10);
      const d = ev.data || {};
      rows.push({
        user_id: userId, date, source: 'withings', metric_type: 'workout',
        value: Math.round((ev.enddate - ev.startdate) / 60), unit: 'min',
        metadata: {
          id:           ev.id,
          category:     ev.category,
          model:        ev.model,
          start_date:   new Date(ev.startdate * 1000).toISOString(),
          end_date:     new Date(ev.enddate * 1000).toISOString(),
          calories:     d.calories || d.manual_calories,
          distance_m:   d.distance || d.manual_distance,
          avg_hr:       d.hr_average,
          min_hr:       d.hr_min,
          max_hr:       d.hr_max,
          intensity:    d.intensity,
          steps:        d.steps,
        },
        external_id: `withings_act_${ev.id}`,
      });
    }
  }

  // Upsert chunked
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const out = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST', body: JSON.stringify(chunk),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    inserted += out.length;
  }
  return { rows_upserted: inserted, refreshed: tok.refreshed };
}

export default async function handler(req, res) {
  if (CRON_SECRET) {
    const hdr = req.headers['authorization'] || '';
    if (hdr !== `Bearer ${CRON_SECRET}` && !req.query.user) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'env missing (SUPABASE_*, WITHINGS_*)' });
  }
  const daysBack = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 365));
  const target = req.query.user;
  try {
    const filter = target ? `source=eq.withings&user_id=eq.${target}` : `source=eq.withings&status=eq.active`;
    const conns = await supa(`/rest/v1/user_connections?${filter}&select=id,user_id,credentials`);
    const results = [];
    for (const c of conns) {
      const t0 = Date.now();
      try {
        const r = await syncOneUser(c, daysBack);
        await supa(`/rest/v1/user_connections?id=eq.${c.id}`, {
          method: 'PATCH', body: JSON.stringify({
            last_sync_at: new Date().toISOString(),
            last_sync_status: `ok: ${r.rows_upserted} rows in ${Date.now()-t0}ms` + (r.refreshed ? ' (refreshed)' : ''),
            last_sync_error: null, status: 'active',
          }),
        });
        results.push({ user_id: c.user_id, ...r, ms: Date.now()-t0 });
      } catch (e) {
        await supa(`/rest/v1/user_connections?id=eq.${c.id}`, {
          method: 'PATCH', body: JSON.stringify({
            last_sync_at: new Date().toISOString(),
            last_sync_status: 'error',
            last_sync_error: String(e.message || e).slice(0,500),
            status: 'error',
          }),
        });
        results.push({ user_id: c.user_id, error: String(e.message || e) });
      }
    }
    return res.status(200).json({ ok: true, days: daysBack, connections: conns.length, results });
  } catch (e) {
    console.error('[sync-withings] fatal', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
