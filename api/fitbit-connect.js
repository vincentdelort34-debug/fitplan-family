// api/fitbit-connect.js
// Step 1 of Fitbit OAuth — redirect to Fitbit's authorize page.
// Requires FITBIT_CLIENT_ID + FITBIT_CLIENT_SECRET env vars (Web app type, redirect URI registered).

const CLIENT_ID = process.env.FITBIT_CLIENT_ID;
const SITE_URL  = process.env.SITE_URL || 'https://fitplan-family.vercel.app';

export default async function handler(req, res) {
  if (!CLIENT_ID) {
    return res.status(500).json({
      error: 'fitbit_not_configured',
      hint:  'Register an app at https://dev.fitbit.com/apps then set FITBIT_CLIENT_ID + FITBIT_CLIENT_SECRET on Vercel.',
    });
  }
  const user_id = (req.query.user || '').trim();
  if (!/^[0-9a-f-]{32,40}$/i.test(user_id)) {
    return res.status(400).json({ error: 'missing or malformed user param' });
  }
  const redirectUri = `${SITE_URL}/api/fitbit-callback`;
  const scope = 'activity heartrate sleep weight profile nutrition';
  const authorizeUrl = new URL('https://www.fitbit.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id',     CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri',  redirectUri);
  authorizeUrl.searchParams.set('scope',         scope);
  authorizeUrl.searchParams.set('state',         user_id);
  authorizeUrl.searchParams.set('expires_in',    '604800'); // 7 days for the auth code, max
  authorizeUrl.searchParams.set('prompt',        'consent'); // force re-consent if user already authorized
  return res.redirect(302, authorizeUrl.toString());
}
