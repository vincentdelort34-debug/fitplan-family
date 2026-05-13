// api/strava-callback.js
// Step 2 of the OAuth dance: Strava redirects here with ?code=...&state=<user_id>.
// We exchange the code for an access_token + refresh_token, store them encrypted
// in user_connections, then redirect the user back to the FitPlan UI.

import { encrypt } from './_lib/crypto.js';

const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL      = process.env.SITE_URL || 'https://fitplan-family.vercel.app';

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

function bounceWithError(res, message) {
  // Send the user back to the FitPlan Connexions screen with a flash query.
  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set('strava', 'error');
  u.searchParams.set('msg', message.slice(0, 200));
  return res.redirect(302, u.toString());
}

export default async function handler(req, res) {
  const { code, state, error, scope } = req.query;

  if (error) {
    return bounceWithError(res, `Strava denied authorization: ${error}`);
  }
  if (!code) {
    return bounceWithError(res, 'missing authorization code');
  }
  const user_id = (state || '').trim();
  if (!/^[0-9a-f-]{32,40}$/i.test(user_id)) {
    return bounceWithError(res, 'invalid state parameter');
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return bounceWithError(res, 'STRAVA_CLIENT_ID/SECRET not configured');
  }

  // Exchange code → tokens
  let tokenRes;
  try {
    tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
      }).toString(),
    });
  } catch (e) {
    return bounceWithError(res, `token exchange network error: ${e.message}`);
  }
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return bounceWithError(res, `token exchange ${tokenRes.status}: ${body.slice(0,150)}`);
  }
  const payload = await tokenRes.json();
  // payload = { access_token, refresh_token, expires_at, expires_in, token_type, athlete: {id, firstname, lastname, ...} }

  // Encrypt and persist
  const credentials = {
    athlete_id:    encrypt(String(payload.athlete?.id || '')),
    access_token:  encrypt(payload.access_token),
    refresh_token: encrypt(payload.refresh_token),
    expires_at:    payload.expires_at, // plain int — not sensitive
    scope:         scope || '',
  };

  try {
    await supa(`/rest/v1/user_connections?on_conflict=user_id,source`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_id,
        source:           'strava',
        status:           'active',
        credentials,
        last_sync_at:     null,
        last_sync_status: 'connected, awaiting first sync',
        last_sync_error:  null,
        metadata: {
          athlete: {
            id:        payload.athlete?.id,
            firstname: payload.athlete?.firstname,
            lastname:  payload.athlete?.lastname,
            profile:   payload.athlete?.profile_medium,
            country:   payload.athlete?.country,
          },
        },
      }]),
    });
  } catch (e) {
    return bounceWithError(res, `db upsert failed: ${e.message}`);
  }

  // Trigger an initial sync in the background (fire-and-forget)
  try {
    await fetch(`${SITE_URL}/api/sync-strava?user=${user_id}&days=180`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET || ''}` },
    });
  } catch (e) { /* ignore; cron will catch up */ }

  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set('strava', 'connected');
  return res.redirect(302, u.toString());
}
