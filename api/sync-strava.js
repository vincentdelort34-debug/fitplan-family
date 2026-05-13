// api/sync-strava.js
// Strava sync for FitPlan. Runs:
//   - On a daily Vercel cron (calls without ?user to process every active user)
//   - On demand from FitPlan UI ("Sync now" button)
//   - From strava-callback.js right after authorization (initial backfill, days=180)
//
// Steps per user:
//   1) Decrypt tokens from user_connections.credentials
//   2) Refresh access_token if expires_at < now+60s
//   3) GET https://www.strava.com/api/v3/athlete/activities?after=<epoch>
//   4) For each activity → one row in health_data with metric_type='workout'
//      and rich metadata. external_id = "strava_<activity_id>".
//   5) Update user_connections.last_sync_*

import { encrypt, decrypt } from './_lib/crypto.js';

const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;

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

async function refreshIfNeeded(conn) {
  const expiresAt = conn.credentials.expires_at;
  const now       = Math.floor(Date.now() / 1000);
  if (expiresAt && expiresAt > now + 60) {
    return { access_token: decrypt(conn.credentials.access_token), expires_at: expiresAt, refreshed: false };
  }
  // Refresh
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const r = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
      grant_type:    'refresh_token',
    }).toString(),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Strava refresh ${r.status}: ${body.slice(0,200)}`);
  }
  const t = await r.json();
  // Persist the new tokens (encrypted)
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH',
    body:   JSON.stringify({
      credentials: {
        ...conn.credentials,
        access_token:  encrypt(t.access_token),
        refresh_token: encrypt(t.refresh_token),
        expires_at:    t.expires_at,
      },
      updated_at: new Date().toISOString(),
    }),
  });
  return { access_token: t.access_token, expires_at: t.expires_at, refreshed: true };
}

async function fetchStravaActivities(access_token, afterEpoch) {
  // Paginate up to 5 pages of 100 to stay light on rate limits
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('after', String(afterEpoch));
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Strava activities ${r.status}: ${body.slice(0,200)}`);
    }
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function activityToRow(userId, a) {
  return {
    user_id:     userId,
    date:        (a.start_date_local || a.start_date || '').slice(0,10),
    source:      'strava',
    metric_type: 'workout',
    value:       a.moving_time != null ? Math.round(a.moving_time / 60) : null,
    unit:        'min',
    metadata: {
      id:             a.id,
      name:           a.name,
      type:           a.type,
      sport_type:     a.sport_type,
      start_local:    a.start_date_local,
      start_utc:      a.start_date,
      distance_m:     a.distance,
      moving_time_s:  a.moving_time,
      elapsed_time_s: a.elapsed_time,
      elevation_gain: a.total_elevation_gain,
      avg_hr:         a.average_heartrate,
      max_hr:         a.max_heartrate,
      avg_speed:      a.average_speed,
      max_speed:      a.max_speed,
      avg_watts:      a.average_watts,
      max_watts:      a.max_watts,
      weighted_avg_watts: a.weighted_average_watts,
      kilojoules:     a.kilojoules,
      device_watts:   a.device_watts,
      kudos_count:    a.kudos_count,
      calories:       a.calories,
      trainer:        a.trainer,
      commute:        a.commute,
      gear_id:        a.gear_id,
      external_id:    a.external_id,
      upload_id_str:  a.upload_id_str,
      timezone:       a.timezone,
      // Optional: location summary
      start_latlng:   a.start_latlng,
      end_latlng:     a.end_latlng,
    },
    external_id: `strava_${a.id}`,
  };
}

async function syncOneUser(conn, daysBack) {
  const tok = await refreshIfNeeded(conn);
  const afterEpoch = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const activities = await fetchStravaActivities(tok.access_token, afterEpoch);

  const rows = activities.map(a => activityToRow(conn.user_id, a)).filter(r => r.date);
  let inserted = 0;
  // Chunked upsert
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const out = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST',
        body:   JSON.stringify(chunk),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    inserted += out.length;
  }
  return { activities_fetched: activities.length, rows_upserted: inserted, refreshed: tok.refreshed };
}

export default async function handler(req, res) {
  // Allow cron with bearer token AND manual call (no auth header from UI; UI calls
  // through Vercel's protected internal route, but we keep the gate lenient here).
  if (CRON_SECRET) {
    const hdr  = req.headers['authorization'] || '';
    const user = req.query.user;
    const isCron = hdr === `Bearer ${CRON_SECRET}`;
    if (!isCron && !user) {
      return res.status(401).json({ error: 'unauthorized: provide ?user=<uuid> or Bearer CRON_SECRET' });
    }
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'env missing (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRAVA_*)' });
  }

  const daysBack = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 365));
  const targetUserId = req.query.user;

  try {
    const filter = targetUserId
      ? `source=eq.strava&user_id=eq.${targetUserId}`
      : `source=eq.strava&status=eq.active`;
    const conns = await supa(`/rest/v1/user_connections?${filter}&select=id,user_id,credentials,status`);

    const results = [];
    for (const c of conns) {
      const t0 = Date.now();
      try {
        const r = await syncOneUser(c, daysBack);
        await supa(`/rest/v1/user_connections?id=eq.${c.id}`, {
          method: 'PATCH',
          body:   JSON.stringify({
            last_sync_at:     new Date().toISOString(),
            last_sync_status: `ok: ${r.rows_upserted}/${r.activities_fetched} activities in ${Date.now()-t0}ms` + (r.refreshed ? ' (refreshed)' : ''),
            last_sync_error:  null,
            status:           'active',
          }),
        });
        results.push({ user_id: c.user_id, ...r, ms: Date.now() - t0 });
      } catch (e) {
        await supa(`/rest/v1/user_connections?id=eq.${c.id}`, {
          method: 'PATCH',
          body:   JSON.stringify({
            last_sync_at:     new Date().toISOString(),
            last_sync_status: 'error',
            last_sync_error:  String(e.message || e).slice(0,500),
            status:           'error',
          }),
        });
        results.push({ user_id: c.user_id, error: String(e.message || e) });
      }
    }

    return res.status(200).json({ ok: true, days: daysBack, connections: conns.length, results });
  } catch (e) {
    console.error('[sync-strava] fatal', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
