// api/activity-streams.js — renvoie les streams d'une activité (GPS, FC, altitude, puissance, vitesse)
// Source : Intervals.icu en priorité, Strava en secours. Auth : token Supabase de l'utilisateur.
import { encrypt, decrypt } from './_lib/crypto.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

async function supa(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`supabase_${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function userFromToken(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

async function refreshStrava(conn) {
  const now = Math.floor(Date.now() / 1000);
  if (conn.credentials.expires_at && conn.credentials.expires_at > now + 60) {
    return decrypt(conn.credentials.access_token);
  }
  const refresh_token = decrypt(conn.credentials.refresh_token);
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!r.ok) throw new Error(`strava_refresh_${r.status}`);
  const t = await r.json();
  await supa(`/rest/v1/user_connections?id=eq.${conn.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ credentials: { ...conn.credentials, access_token: encrypt(t.access_token), refresh_token: encrypt(t.refresh_token), expires_at: t.expires_at } }),
  });
  return t.access_token;
}

const norm = { latlng: [], heart_rate: [], altitude: [], watts: [], velocity_smooth: [] };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, source, activity_id } = req.body || {};
    if (!token || !activity_id) return res.status(400).json({ error: 'token et activity_id requis' });

    const user = await userFromToken(token);
    if (!user || !user.id) return res.status(401).json({ error: 'Non authentifié' });

    const out = { latlng: [], heart_rate: [], altitude: [], watts: [], velocity_smooth: [] };
    const src = source || 'intervals_icu';

    if (src === 'intervals_icu') {
      const rows = await supa(`/rest/v1/user_connections?user_id=eq.${user.id}&source=eq.intervals_icu&select=credentials&limit=1`);
      if (!rows || !rows[0]) return res.status(404).json({ error: 'Connexion Intervals introuvable' });
      const apiKey = decrypt(rows[0].credentials.api_key);
      const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');
      const r = await fetch(`https://intervals.icu/api/v1/activity/${activity_id}/streams?types=latlng,altitude,heartrate,watts,velocity_smooth`, { headers: { Authorization: auth } });
      if (!r.ok) return res.status(502).json({ error: `Intervals ${r.status}` });
      const arr = await r.json();
      for (const s of arr) {
        if (s.type === 'latlng') out.latlng = s.data;
        else if (s.type === 'heartrate') out.heart_rate = s.data;
        else if (s.type === 'altitude') out.altitude = s.data;
        else if (s.type === 'watts') out.watts = s.data;
        else if (s.type === 'velocity_smooth') out.velocity_smooth = s.data;
      }
    } else if (src === 'strava') {
      const rows = await supa(`/rest/v1/user_connections?user_id=eq.${user.id}&source=eq.strava&select=id,credentials&limit=1`);
      if (!rows || !rows[0]) return res.status(404).json({ error: 'Connexion Strava introuvable' });
      const access = await refreshStrava(rows[0]);
      const r = await fetch(`https://www.strava.com/api/v3/activities/${activity_id}/streams?keys=latlng,altitude,heartrate,watts,velocity_smooth&key_by_type=true`, { headers: { Authorization: `Bearer ${access}` } });
      if (!r.ok) return res.status(502).json({ error: `Strava ${r.status}` });
      const d = await r.json();
      if (d.latlng) out.latlng = d.latlng.data;
      if (d.heartrate) out.heart_rate = d.heartrate.data;
      if (d.altitude) out.altitude = d.altitude.data;
      if (d.watts) out.watts = d.watts.data;
      if (d.velocity_smooth) out.velocity_smooth = d.velocity_smooth.data;
    } else {
      return res.status(400).json({ error: 'Source inconnue' });
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
