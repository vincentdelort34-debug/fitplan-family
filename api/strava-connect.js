// api/strava-connect.js
// Step 1 of the OAuth dance: redirect the user to Strava's authorize page.
//
// Called from the FitPlan UI ("Se connecter avec Strava" button). The user
// arrives here logged in to FitPlan (we have an access_token in a cookie / query),
// we redirect them to Strava with the right scopes. Strava sends them back to
// /api/strava-callback?code=...&state=...

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const SITE_URL  = process.env.SITE_URL || 'https://fitplan-family.vercel.app';

export default async function handler(req, res) {
  if (!CLIENT_ID) return res.status(500).json({ error: 'STRAVA_CLIENT_ID missing' });

  // `state` carries the FitPlan user_id so the callback can attach the token
  // to the right row in user_connections. Vue → handler passes ?user=<uuid>.
  const user_id = (req.query.user || '').trim();
  if (!/^[0-9a-f-]{32,40}$/i.test(user_id)) {
    return res.status(400).json({ error: 'missing or malformed `user` query param (FitPlan auth.users.id)' });
  }

  const redirectUri = `${SITE_URL}/api/strava-callback`;
  // activity:read_all  → past + private activities
  // profile:read_all   → athlete profile (optional, useful for display name)
  const scope = 'read,activity:read_all,profile:read_all';

  const authorizeUrl = new URL('https://www.strava.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id',     CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri',  redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('approval_prompt','auto');
  authorizeUrl.searchParams.set('scope',         scope);
  authorizeUrl.searchParams.set('state',         user_id);

  return res.redirect(302, authorizeUrl.toString());
}
