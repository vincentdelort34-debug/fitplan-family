export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return res.status(200).json({ error: 'Env vars manquants', url: !!url, key: !!key });
  try {
    const r = await fetch(`${url}/auth/v1/health`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    });
    const text = await r.text();
    return res.status(200).json({ status: r.status, body: text.substring(0, 200), url: url.substring(0, 40) });
  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
}
