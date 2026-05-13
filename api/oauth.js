// api/oauth.js — Consolidated OAuth flow for Strava + Fitbit + Withings.
//
// Routes:
//   GET /api/oauth?provider=strava|fitbit|withings&action=connect&user=<uuid>
//       → redirect to provider's authorize URL
//   GET /api/oauth?provider=strava|fitbit|withings&action=callback&code=&state=
//       → exchange code → tokens, persist encrypted in user_connections, redirect to app
//
// Reduces 6 functions (strava-connect, strava-callback, fitbit-connect, fitbit-callback,
// withings-connect, withings-callback) to 1, to fit Vercel Hobby's 12-function limit.

import { encrypt } from './_lib/crypto.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL     = process.env.SITE_URL || 'https://fitplan-family.vercel.app';
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

// --- Provider configs
const PROVIDERS = {
  strava: {
    authorize_url: 'https://www.strava.com/oauth/authorize',
    token_url:     'https://www.strava.com/oauth/token',
    scope:         'read,activity:read_all,profile:read_all',
    client_id_env:     'STRAVA_CLIENT_ID',
    client_secret_env: 'STRAVA_CLIENT_SECRET',
    initial_days: 180,
    extract_creds(payload) {
      return {
        athlete_id:    encrypt(String(payload.athlete?.id || '')),
        access_token:  encrypt(payload.access_token),
        refresh_token: encrypt(payload.refresh_token),
        expires_at:    payload.expires_at,
        scope:         payload.scope || '',
      };
    },
    metadata(payload) {
      return { athlete: payload.athlete || {} };
    },
  },
  fitbit: {
    authorize_url: 'https://www.fitbit.com/oauth2/authorize',
    token_url:     'https://api.fitbit.com/oauth2/token',
    scope:         'activity heartrate sleep weight profile nutrition',
    client_id_env:     'FITBIT_CLIENT_ID',
    client_secret_env: 'FITBIT_CLIENT_SECRET',
    initial_days: 30,
    use_basic_auth: true, // Fitbit needs Basic auth header on token exchange
    extract_creds(payload) {
      return {
        fitbit_user_id: encrypt(String(payload.user_id || '')),
        access_token:   encrypt(payload.access_token),
        refresh_token:  encrypt(payload.refresh_token),
        expires_at:     Math.floor(Date.now() / 1000) + (payload.expires_in || 28800),
        scope:          payload.scope || '',
      };
    },
    metadata(payload) {
      return { fitbit_user_id: payload.user_id };
    },
  },
  withings: {
    authorize_url: 'https://account.withings.com/oauth2_user/authorize2',
    token_url:     'https://wbsapi.withings.net/v2/oauth2',
    scope:         'user.info,user.metrics,user.activity,user.sleepevents',
    client_id_env:     'WITHINGS_CLIENT_ID',
    client_secret_env: 'WITHINGS_CLIENT_SECRET',
    initial_days: 180,
    is_withings: true, // Withings has a non-standard wrapper around responses
    extract_creds(payload) {
      // payload here = the .body of Withings response
      return {
        withings_userid: encrypt(String(payload.userid || '')),
        access_token:    encrypt(payload.access_token),
        refresh_token:   encrypt(payload.refresh_token),
        expires_at:      Math.floor(Date.now() / 1000) + (payload.expires_in || 10800),
        scope:           payload.scope || '',
      };
    },
    metadata(payload) {
      return { withings_userid: payload.userid };
    },
  },
};

function bounce(res, providerKey, msg) {
  const u = new URL(`${SITE_URL}/`);
  u.searchParams.set(providerKey, 'error');
  u.searchParams.set('msg', msg.slice(0, 200));
  return res.redirect(302, u.toString());
}

export default async function handler(req, res) {
  const provider = (req.query.provider || '').toLowerCase();
  const action   = (req.query.action || 'connect').toLowerCase();
  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: 'unknown_provider', supported: Object.keys(PROVIDERS) });

  const clientId     = process.env[cfg.client_id_env];
  const clientSecret = process.env[cfg.client_secret_env];

  // -------- CONNECT (redirect to authorize URL) --------
  if (action === 'connect') {
    if (!clientId) return res.status(500).json({
      error: `${provider}_not_configured`,
      hint: `Set ${cfg.client_id_env} and ${cfg.client_secret_env} on Vercel`,
    });
    const userId = (req.query.user || '').trim();
    if (!/^[0-9a-f-]{32,40}$/i.test(userId)) return res.status(400).json({ error: 'missing_user' });

    const redirectUri = `${SITE_URL}/api/oauth?provider=${provider}&action=callback`;
    const authorizeUrl = new URL(cfg.authorize_url);
    authorizeUrl.searchParams.set('client_id',     clientId);
    authorizeUrl.searchParams.set('redirect_uri',  redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope',         cfg.scope);
    authorizeUrl.searchParams.set('state',         userId);
    if (provider === 'strava') authorizeUrl.searchParams.set('approval_prompt', 'auto');
    return res.redirect(302, authorizeUrl.toString());
  }

  // -------- CALLBACK --------
  if (action === 'callback') {
    const { code, state, error } = req.query;
    if (error) return bounce(res, provider, `denied: ${error}`);
    if (!code) return bounce(res, provider, 'missing_code');
    const userId = (state || '').trim();
    if (!/^[0-9a-f-]{32,40}$/i.test(userId)) return bounce(res, provider, 'invalid_state');
    if (!clientId || !clientSecret) return bounce(res, provider, 'oauth_not_configured');

    const redirectUri = `${SITE_URL}/api/oauth?provider=${provider}&action=callback`;

    // Build token-exchange request (Withings has a non-standard format)
    let body, headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (cfg.is_withings) {
      body = new URLSearchParams({
        action:        'requesttoken',
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }).toString();
    } else if (cfg.use_basic_auth) {
      // Fitbit: Basic auth header, body without client_secret
      headers['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      body = new URLSearchParams({
        clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      }).toString();
    } else {
      // Strava: standard form post with client_id + client_secret in body
      body = new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        grant_type: 'authorization_code', code,
      }).toString();
    }

    let tokenRes;
    try {
      tokenRes = await fetch(cfg.token_url, { method: 'POST', headers, body });
    } catch (e) { return bounce(res, provider, `token_network: ${e.message}`); }
    if (!tokenRes.ok) {
      return bounce(res, provider, `token_${tokenRes.status}: ${(await tokenRes.text()).slice(0,150)}`);
    }
    let payload = await tokenRes.json();
    if (cfg.is_withings) {
      if (payload.status !== 0 || !payload.body) {
        return bounce(res, provider, `withings_status_${payload.status}`);
      }
      payload = payload.body; // Withings wraps in .body
    }

    const credentials = cfg.extract_creds(payload);
    const metadata    = cfg.metadata(payload);

    try {
      await supa(`/rest/v1/user_connections?on_conflict=user_id,source`, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{
          user_id: userId, source: provider, status: 'active',
          credentials,
          last_sync_at: null,
          last_sync_status: 'connected, awaiting first sync',
          last_sync_error: null,
          metadata,
        }]),
      });
    } catch (e) { return bounce(res, provider, `db: ${e.message}`); }

    // Trigger initial backfill (fire and forget)
    fetch(`${SITE_URL}/api/sync?provider=${provider}&user=${userId}&days=${cfg.initial_days}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${CRON_SECRET || ''}` },
    }).catch(() => {});

    const u = new URL(`${SITE_URL}/`);
    u.searchParams.set(provider, 'connected');
    return res.redirect(302, u.toString());
  }

  return res.status(400).json({ error: 'unknown_action', supported: ['connect', 'callback'] });
}
