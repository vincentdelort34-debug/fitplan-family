// api/withings-callback.js — Step 2: exchange code → tokens via Withings' v2/oauth2 endpoint.

import { encrypt } from './_lib/crypto.js';

const CLIENT_ID     = process.env.WITHINGS_CLIENT_ID;
const CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL      = process.env.SITE_URL || 'https://fitplan-family.vercel.app';

async function supa(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

function bounce(res, msg) {
  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set('withings', 'error');
  u.searchParams.set('msg', msg.slice(0, 200));
  return res.redirect(302, u.toString());
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;
  if (error) return bounce(res, `Withings denied: ${error}`);
  if (!code) return bounce(res, 'missing code');
  const user_id = (state || '').trim();
  if (!/^[0-9a-f-]{32,40}$/i.test(user_id)) return bounce(res, 'invalid state');
  if (!CLIENT_ID || !CLIENT_SECRET) return bounce(res, 'WITHINGS_* missing');

  const redirectUri = `${SITE_URL}/api/withings-callback`;
  let tokenRes;
  try {
    tokenRes = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action:        'requesttoken',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }).toString(),
    });
  } catch (e) { return bounce(res, `network: ${e.message}`); }

  const txt = await tokenRes.text();
  let payload;
  try { payload = JSON.parse(txt); } catch { return bounce(res, `bad json: ${txt.slice(0,150)}`); }
  if (payload.status !== 0 || !payload.body) {
    return bounce(res, `withings status=${payload.status}: ${(payload.error || txt).slice(0,150)}`);
  }
  const b = payload.body;
  // b = { userid, access_token, refresh_token, expires_in, scope, token_type }

  const expires_at = Math.floor(Date.now() / 1000) + (b.expires_in || 10800);
  const credentials = {
    withings_userid: encrypt(String(b.userid || '')),
    access_token:    encrypt(b.access_token),
    refresh_token:   encrypt(b.refresh_token),
    expires_at,
    scope: b.scope || '',
  };

  try {
    await supa(`/rest/v1/user_connections?on_conflict=user_id,source`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_id, source: 'withings', status: 'active',
        credentials,
        last_sync_status: 'connected, awaiting first sync',
        last_sync_error: null,
        metadata: { withings_userid: b.userid },
      }]),
    });
  } catch (e) { return bounce(res, `db: ${e.message}`); }

  fetch(`${SITE_URL}/api/sync-withings?user=${user_id}&days=180`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET || ''}` },
  }).catch(() => {});

  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set('withings', 'connected');
  return res.redirect(302, u.toString());
}
