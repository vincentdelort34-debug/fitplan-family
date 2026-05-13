// api/sync-all.js — single Vercel cron entry point that fans out to every per-source sync.
// Stays within Vercel Hobby plan's 2-cron limit.

const SITE_URL    = process.env.SITE_URL || 'https://fitplan-family.vercel.app';
const CRON_SECRET = process.env.CRON_SECRET;

const TARGETS = [
  { name: 'intervals_icu', path: '/api/sync-intervals' },
  { name: 'strava',        path: '/api/sync-strava?days=7' },
  { name: 'fitbit',        path: '/api/sync-fitbit?days=7' },
  { name: 'withings',      path: '/api/sync-withings?days=7' },
];

export default async function handler(req, res) {
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const out = {};
  for (const t of TARGETS) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${SITE_URL}${t.path}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CRON_SECRET || ''}` },
      });
      const body = await r.text();
      let json; try { json = JSON.parse(body); } catch { json = { raw: body.slice(0, 200) }; }
      out[t.name] = { status: r.status, ms: Date.now() - t0, ...json };
    } catch (e) {
      out[t.name] = { error: String(e.message || e), ms: Date.now() - t0 };
    }
  }
  return res.status(200).json({ ok: true, syncs: out });
}
