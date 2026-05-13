// api/fitbit-callback.js
// Step 2 — Fitbit redirects back with ?code=&state=. Exchange code for tokens, store encrypted.

import { encrypt } from './_lib/crypto.js';

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
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
  if (!r.ok) { throw new Error(`Supabase ${path} → ${r.status} ${await r.text().then(t=>t.slice(0,300))}`); }
  return r.status === 204 ? null : r.json();
}

function bounceWithError(res, message) {
  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set('fitbit', 'error');
  u.searchParams.set('msg', message.slice(0, 200));
  return res.redirect(302, u.toString());
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;
  if (error) return bounceWithError(res, `Fitbit denied: ${error}`);
  if (!code) return bounceWithError(res, 'missing authorization code');
  const user_id = (state || '').trim();
  if (!/^[0-9a-f-]{32,40}$/i.test(user_id)) return bounceWithError(res, 'invalid state');
  if (!CLIENT_ID || !CLIENT_SECRET) return bounceWithError(res, 'FITBIT_CLIENT_ID/SECRET missing');

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const redirectUri = `${SITE_URL}/api/fitbit-callback`;

  let tokenRes;
  try {
    tokenRes = await fetch('https://api.fitbit.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        clientId:     CLIENT_ID,
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
  } catch (e) { return bounceWithError(res, `token network error: ${e.message}`); }

  if (!tokenRes.ok) {
    return bounceWithError(res, `token exchange ${tokenRes.status}: ${(await tokenRes.text()).slice(0,150)}`);
  }
  const payload = await tokenRes.json();
  // { access_token, refresh_token, expires_in, scope, user_id, token_type }

  const expires_at = Math.floor(Date.now() / 1000) + (payload.expires_in || 28800);

  const credentials = {
    fitbit_user_id: encrypt(String(payload.user_id || '')),
    access_token:   encrypt(payload.access_token),
    refresh_token:  encrypt(payload.refresh_token),
    expires_at,
    scope: payload.scope || '',
  };

  try {
    await supa(`/rest/v1/user_connections?on_conflict=user_id,source`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_id,
        source: 'fitbit',
        status: 'active',
        credentials,
        last_sync_status: 'connected, awaiting first sync',
        last_sync_error:  null,
        metadata: { fitbit_user_id: payload.user_id },
      }]),
    });
  } catch (e) { return bounceWithError(res, `db: ${e.message}`); }

  // Initial backfill (30 days, fire and forget)
  fetch(`${SITE_URL}/api/sync-fitbit?user=${user_id}&days=30`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET || ''}` },
  }).catch(() => {});

  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set('fitbit', 'connected');
  return res.redirect(302, u.toString());
}
