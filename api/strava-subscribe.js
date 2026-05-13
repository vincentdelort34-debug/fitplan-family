// api/strava-subscribe.js
// One-shot admin endpoint to create/list/delete Strava push subscriptions.
// Bearer-protected by CRON_SECRET so only the admin can call it.
//
//   GET  /api/strava-subscribe                  → list existing subscriptions
//   POST /api/strava-subscribe                  → create a subscription (auto)
//   POST /api/strava-subscribe?delete=<id>      → delete a subscription by id

const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const VERIFY_TOKEN  = process.env.STRAVA_VERIFY_TOKEN;
const SITE_URL      = process.env.SITE_URL || 'https://fitplan-family.vercel.app';
const CRON_SECRET   = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !VERIFY_TOKEN) {
    return res.status(500).json({ error: 'missing STRAVA_* env vars',
      have_client_id: !!CLIENT_ID, have_client_secret: !!CLIENT_SECRET, have_verify_token: !!VERIFY_TOKEN });
  }

  const baseQs = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString();

  if (req.method === 'GET') {
    const r = await fetch(`https://www.strava.com/api/v3/push_subscriptions?${baseQs}`);
    const body = await r.json();
    return res.status(r.status).json({ status: r.status, body });
  }

  if (req.method === 'POST') {
    if (req.query.delete) {
      const id = String(req.query.delete);
      const r = await fetch(`https://www.strava.com/api/v3/push_subscriptions/${encodeURIComponent(id)}?${baseQs}`,
        { method: 'DELETE' });
      const text = await r.text();
      return res.status(r.status).json({ status: r.status, body: text });
    }
    // Create
    const form = new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      callback_url:  `${SITE_URL}/api/strava-webhook`,
      verify_token:  VERIFY_TOKEN,
    });
    const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    form.toString(),
    });
    const body = await r.json();
    return res.status(r.status).json({ status: r.status, body });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
