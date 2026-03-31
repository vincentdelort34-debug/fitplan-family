export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, email, password, refresh_token } = req.body;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  try {
    if (action === 'signIn') {
      const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      return res.status(200).json(await r.json());

    } else if (action === 'signUp') {
      const r = await fetch(`${url}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'apikey': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      return res.status(200).json(await r.json());

    } else if (action === 'refresh') {
      const r = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'apikey': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token })
      });
      return res.status(200).json(await r.json());
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
