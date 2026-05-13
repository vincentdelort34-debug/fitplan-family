// api/strava-webhook.js
// Strava push events. Two responsibilities:
//
//   GET  /api/strava-webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//       → Strava subscription verification. We echo `hub.challenge` if
//         `hub.verify_token` matches STRAVA_VERIFY_TOKEN.
//
//   POST /api/strava-webhook
//       → Event push (aspect_type = create | update | delete; object_type = activity | athlete).
//         For activity events we trigger a per-user sync to refresh that activity.
//
// To register the subscription (one-time setup), call from a terminal:
//   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
//     -F client_id=$STRAVA_CLIENT_ID \
//     -F client_secret=$STRAVA_CLIENT_SECRET \
//     -F callback_url=https://fitplan-family.vercel.app/api/strava-webhook \
//     -F verify_token=$STRAVA_VERIFY_TOKEN

const VERIFY_TOKEN  = process.env.STRAVA_VERIFY_TOKEN;
const SITE_URL      = process.env.SITE_URL || 'https://fitplan-family.vercel.app';
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

export default async function handler(req, res) {
  // ---- Subscription verification (Strava → GET with hub.* params) ----
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return res.status(200).json({ 'hub.challenge': challenge });
    }
    return res.status(403).json({ error: 'verification_failed' });
  }

  // ---- Event push ----
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const evt = req.body || {};
  // Expected: { object_type, object_id, aspect_type, owner_id, subscription_id, event_time, updates }
  // owner_id = Strava athlete id of the user the event concerns.
  console.log('[strava-webhook] event', JSON.stringify(evt));

  // Acknowledge immediately to Strava (must return 2xx within 2 seconds).
  res.status(200).json({ ok: true });

  // Best-effort async processing — do not await before responding.
  if (evt.object_type === 'activity' && (evt.aspect_type === 'create' || evt.aspect_type === 'update')) {
    try {
      // Find which FitPlan user this Strava athlete belongs to
      const conns = await supa(
        `/rest/v1/user_connections?source=eq.strava&metadata->athlete->>id=eq.${evt.owner_id}&select=user_id`
      );
      if (conns.length) {
        const userId = conns[0].user_id;
        // Trigger a recent-window sync (last 7 days covers most updates)
        fetch(`${SITE_URL}/api/sync?provider=strava&user=${userId}&days=7`, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET || ''}` },
        }).catch(e => console.error('[strava-webhook] sync trigger failed', e));
      }
    } catch (e) {
      console.error('[strava-webhook] processing error', e);
    }
  }
}
