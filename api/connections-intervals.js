// api/connections-intervals.js
// Called from the FitPlan UI (Connexions tab) to save Intervals.icu credentials
// for the current user. Auth: Supabase user JWT in Authorization: Bearer <token>.
//
//   POST /api/connections-intervals
//        body: { athlete_id, api_key }
//        → encrypt credentials, upsert user_connections, trigger initial sync
//
//   POST /api/connections-intervals?action=sync
//        → trigger a sync for the current user (no body required)
//
//   DELETE /api/connections-intervals
//        → mark connection as disabled

import { encrypt } from './_lib/crypto.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;
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
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase ${path} → ${r.status} ${body.slice(0,300)}`);
  }
  return r.status === 204 ? null : r.json();
}

async function getUserFromJwt(jwt) {
  // Validate the Supabase user JWT by hitting /auth/v1/user with the user token
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${jwt}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth via Supabase user JWT
  const authHeader = req.headers['authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return res.status(401).json({ error: 'missing_token' });
  const user = await getUserFromJwt(jwt);
  if (!user || !user.id) return res.status(401).json({ error: 'invalid_token' });
  const userId = user.id;

  // ?action=sync → trigger sync for this user
  if (req.method === 'POST' && req.query.action === 'sync') {
    try {
      const r = await fetch(`${SITE_URL}/api/sync?provider=intervals_icu&user=${userId}&days=14`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${CRON_SECRET || ''}` },
      });
      const out = await r.json();
      return res.status(200).json({ status: 'triggered', result: out });
    } catch (e) {
      return res.status(500).json({ error: 'sync trigger failed', detail: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    await supa(`/rest/v1/user_connections?user_id=eq.${userId}&source=eq.intervals_icu`, {
      method: 'PATCH', body: JSON.stringify({ status: 'disabled', updated_at: new Date().toISOString() }),
    });
    return res.status(200).json({ status: 'disabled' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const body = req.body || {};
  const athleteId = String(body.athlete_id || '').trim();
  const apiKey    = String(body.api_key    || '').trim();
  if (!athleteId || !apiKey) {
    return res.status(400).json({ error: 'missing_fields', need: ['athlete_id', 'api_key'] });
  }
  // Athlete IDs look like "i123456" — sanity-check shape.
  if (!/^i\d{3,9}$/i.test(athleteId)) {
    return res.status(400).json({ error: 'malformed_athlete_id', hint: 'expected i123456 form' });
  }

  // Test the credentials against Intervals.icu before saving
  const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');
  try {
    const ping = await fetch(`https://intervals.icu/api/v1/athlete/${athleteId}`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' },
    });
    if (!ping.ok) {
      const text = await ping.text();
      return res.status(400).json({ error: 'intervals_auth_failed', status: ping.status, detail: text.slice(0,150) });
    }
  } catch (e) {
    return res.status(500).json({ error: 'intervals_unreachable', detail: String(e.message || e) });
  }

  const credentials = {
    athlete_id: encrypt(athleteId),
    api_key:    encrypt(apiKey),
  };

  try {
    await supa(`/rest/v1/user_connections?on_conflict=user_id,source`, {
      method:  'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body:    JSON.stringify([{
        user_id:          userId,
        source:           'intervals_icu',
        status:           'active',
        credentials,
        last_sync_status: 'connected, awaiting first sync',
        last_sync_error:  null,
        metadata:         { plain_athlete_id: athleteId },
      }]),
    });
  } catch (e) {
    return res.status(500).json({ error: 'db_upsert_failed', detail: String(e.message || e) });
  }

  // Fire-and-forget initial sync
  fetch(`${SITE_URL}/api/sync?provider=intervals_icu&user=${userId}&days=14`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${CRON_SECRET || ''}` },
  }).catch(() => {});

  return res.status(200).json({ status: 'connected', source: 'intervals_icu' });
}
