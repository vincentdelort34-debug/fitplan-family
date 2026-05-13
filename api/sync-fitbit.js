// api/sync-fitbit.js — daily Fitbit sync (sleep, activity, HR, HRV, weight, VO2max)

import { encrypt, decrypt } from './_lib/crypto.js';

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;

async function supa(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

async function refreshIfNeeded(conn) {
  const now = Math.floor(Date.now() / 1000);
  if (conn.credentials.expires_at && conn.credentials.expires_at > now + 60) {
    return { access_token: decrypt(conn.credentials.access_token), refreshed: false };
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const r = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString(),
  });
  if (!r.ok) throw new Error(`Fitbit refresh ${r.status}: ${(await r.text()).slice(0,200)}`);
  const t = await r.json();
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH', body: JSON.stringify({
      credentials: { ...conn.credentials,
        access_token:  encrypt(t.access_token),
        refresh_token: encrypt(t.refresh_token),
        expires_at:    Math.floor(Date.now() / 1000) + (t.expires_in || 28800),
      },
      updated_at: new Date().toISOString(),
    }),
  });
  return { access_token: t.access_token, refreshed: true };
}

async function fbGet(accessToken, path) {
  const r = await fetch(`https://api.fitbit.com${path}`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (r.status === 429) return null; // rate-limited, just skip
  if (!r.ok) {
    console.warn(`[sync-fitbit] ${path} → ${r.status}`, (await r.text()).slice(0,150));
    return null;
  }
  return r.json();
}

function dateRange(daysBack) {
  const out = [];
  const today = new Date();
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

async function syncOneUser(conn, daysBack) {
  const tok = await refreshIfNeeded(conn);
  const dates = dateRange(daysBack);
  const userId = conn.user_id;
  const rows = [];

  for (const date of dates) {
    // Sleep
    const sl = await fbGet(tok.access_token, `/1.2/user/-/sleep/date/${date}.json`);
    if (sl && sl.summary) {
      const total_min = sl.summary.totalMinutesAsleep;
      const sleep_score = (sl.sleep && sl.sleep[0] && sl.sleep[0].efficiency) || null;
      if (total_min != null) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'sleep_duration', value:total_min, unit:'min', external_id:`fitbit_${date}_sleep_duration` });
      if (sleep_score) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'sleep_score', value:sleep_score, unit:'pct', external_id:`fitbit_${date}_sleep_score` });
    }
    // Activity (steps, calories, distance, active minutes)
    const ac = await fbGet(tok.access_token, `/1/user/-/activities/date/${date}.json`);
    if (ac && ac.summary) {
      const s = ac.summary;
      if (s.steps != null) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'steps', value:s.steps, unit:'count', external_id:`fitbit_${date}_steps` });
      if (s.caloriesOut != null) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'total_kcal', value:s.caloriesOut, unit:'kcal', external_id:`fitbit_${date}_total_kcal` });
      if (s.activityCalories != null) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'active_kcal', value:s.activityCalories, unit:'kcal', external_id:`fitbit_${date}_active_kcal` });
      if (s.fairlyActiveMinutes != null && s.veryActiveMinutes != null) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'active_minutes', value:(s.fairlyActiveMinutes + s.veryActiveMinutes), unit:'min', external_id:`fitbit_${date}_active_minutes` });
      if (s.floors != null) rows.push({ user_id:userId, date, source:'fitbit', metric_type:'floors_climbed', value:s.floors, unit:'count', external_id:`fitbit_${date}_floors_climbed` });
    }
    // Resting HR (intraday endpoint requires premium scope; use the daily summary in /activities/heart)
    const hr = await fbGet(tok.access_token, `/1/user/-/activities/heart/date/${date}/1d.json`);
    if (hr && hr['activities-heart'] && hr['activities-heart'][0] && hr['activities-heart'][0].value && hr['activities-heart'][0].value.restingHeartRate) {
      rows.push({ user_id:userId, date, source:'fitbit', metric_type:'resting_hr', value:hr['activities-heart'][0].value.restingHeartRate, unit:'bpm', external_id:`fitbit_${date}_resting_hr` });
    }
    // HRV (Sense / Charge 5/6, etc.)
    const hrv = await fbGet(tok.access_token, `/1/user/-/hrv/date/${date}.json`);
    if (hrv && hrv.hrv && hrv.hrv[0] && hrv.hrv[0].value && hrv.hrv[0].value.dailyRmssd) {
      rows.push({ user_id:userId, date, source:'fitbit', metric_type:'hrv', value:hrv.hrv[0].value.dailyRmssd, unit:'ms', external_id:`fitbit_${date}_hrv` });
    }
  }

  // Weight log over the window (one call covers ~1 month max via /3m endpoint)
  const w = await fbGet(tok.access_token, `/1/user/-/body/log/weight/date/${dates[0]}/30d.json`);
  if (w && Array.isArray(w.weight)) {
    for (const e of w.weight) {
      rows.push({ user_id:userId, date:e.date, source:'fitbit', metric_type:'weight', value:e.weight, unit:'kg', external_id:`fitbit_${e.date}_weight` });
    }
  }

  // VO2 max (cardio fitness score, if available)
  const vo = await fbGet(tok.access_token, `/1/user/-/cardioscore/date/${dates[0]}/${dates[dates.length-1]}.json`);
  if (vo && Array.isArray(vo.cardioScore)) {
    for (const e of vo.cardioScore) {
      const val = e.value && e.value.vo2Max;
      if (val) {
        const m = String(val).match(/[\d.]+/);
        if (m) rows.push({ user_id:userId, date:e.dateTime, source:'fitbit', metric_type:'vo2max', value:parseFloat(m[0]), unit:'ml/kg/min', external_id:`fitbit_${e.dateTime}_vo2max` });
      }
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
    return res.status(500).json({ error: 'env missing (SUPABASE_*, FITBIT_*)' });
  }

  const daysBack = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 90));
  const targetUserId = req.query.user;

  try {
    const filter = targetUserId
      ? `source=eq.fitbit&user_id=eq.${targetUserId}`
      : `source=eq.fitbit&status=eq.active`;
    const conns = await supa(`/rest/v1/user_connections?${filter}&select=id,user_id,credentials`);

    const results = [];
    for (const c of conns) {
      const t0 = Date.now();
      try {
        const r = await syncOneUser(c, daysBack);
        await supa(`/rest/v1/user_connections?id=eq.${c.id}`, {
          method: 'PATCH', body: JSON.stringify({
            last_sync_at:     new Date().toISOString(),
            last_sync_status: `ok: ${r.rows_upserted} rows in ${Date.now()-t0}ms` + (r.refreshed ? ' (refreshed)' : ''),
            last_sync_error:  null, status: 'active',
          }),
        });
        results.push({ user_id: c.user_id, ...r, ms: Date.now()-t0 });
      } catch (e) {
        await supa(`/rest/v1/user_connections?id=eq.${c.id}`, {
          method: 'PATCH', body: JSON.stringify({
            last_sync_at:     new Date().toISOString(),
            last_sync_status: 'error',
            last_sync_error:  String(e.message || e).slice(0,500),
            status: 'error',
          }),
        });
        results.push({ user_id: c.user_id, error: String(e.message || e) });
      }
    }
    return res.status(200).json({ ok: true, days: daysBack, connections: conns.length, results });
  } catch (e) {
    console.error('[sync-fitbit] fatal', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
