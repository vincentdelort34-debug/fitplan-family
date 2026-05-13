// api/withings-connect.js — Step 1 of Withings OAuth (Body+ scales, sleep mats, watches)
// Register an app at https://developer.withings.com to get WITHINGS_CLIENT_ID/SECRET.

const CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
const SITE_URL  = process.env.SITE_URL || 'https://fitplan-family.vercel.app';

export default async function handler(req, res) {
  if (!CLIENT_ID) {
    return res.status(500).json({ error: 'withings_not_configured',
      hint: 'Register at https://developer.withings.com → set WITHINGS_CLIENT_ID + WITHINGS_CLIENT_SECRET on Vercel.' });
  }
  const user_id = (req.query.user || '').trim();
  if (!/^[0-9a-f-]{32,40}$/i.test(user_id)) {
    return res.status(400).json({ error: 'missing or malformed user param' });
  }
  const redirectUri = `${SITE_URL}/api/withings-callback`;
  // Scopes : user.info user.metrics user.activity user.sleepevents
  const authorizeUrl = new URL('https://account.withings.com/oauth2_user/authorize2');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id',     CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri',  redirectUri);
  authorizeUrl.searchParams.set('scope',         'user.info,user.metrics,user.activity,user.sleepevents');
  authorizeUrl.searchParams.set('state',         user_id);
  return res.redirect(302, authorizeUrl.toString());
}
