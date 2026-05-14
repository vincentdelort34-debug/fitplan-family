// api/admin-stats.js
// Returns aggregated stats about all FitPlan users — restricted to Vincent's account.
// Auth: Bearer <Supabase user JWT>. Verifies the user_id matches the hardcoded admin uuid.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

// Vincent's user_id — only this user can read aggregated stats.
const ADMIN_USER_ID = 'aab8ac2a-e4b7-40ab-88d9-e72b1f28758c';

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
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.status === 204 ? null : r.json();
}

async function getUserFromJwt(jwt) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${jwt}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers['authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return res.status(401).json({ error: 'missing_token' });
  const user = await getUserFromJwt(jwt);
  if (!user || user.id !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'forbidden', detail: 'admin only' });
  }

  try {
    // SQL via Supabase REST — get aggregated stats per user
    const sql = `
      SELECT
        u.id AS user_id,
        u.email,
        u.created_at,
        u.last_sign_in_at,
        (SELECT nom FROM public.fitplan_profils WHERE id = u.id) AS nom,
        (SELECT COUNT(*) FROM public.fitplan_repas WHERE user_id = u.id) AS nb_repas_total,
        (SELECT COUNT(*) FROM public.fitplan_repas WHERE user_id = u.id AND date >= NOW() - INTERVAL '7 days') AS nb_repas_7j,
        (SELECT COUNT(*) FROM public.fitplan_poids WHERE user_id = u.id) AS nb_poids_total,
        (SELECT COUNT(*) FROM public.fitplan_poids WHERE user_id = u.id AND date >= NOW() - INTERVAL '7 days') AS nb_poids_7j,
        (SELECT COUNT(*) FROM public.fitplan_sorties WHERE user_id = u.id) AS nb_sorties_total,
        (SELECT COUNT(*) FROM public.fitplan_glyco WHERE user_id = u.id) AS nb_glyco_total,
        (SELECT COUNT(*) FROM public.health_data WHERE user_id = u.id) AS nb_health_data,
        (SELECT array_agg(DISTINCT source) FROM public.user_connections WHERE user_id = u.id AND status = 'active') AS sources_actives,
        -- Days active in last 14 days: any day with at least one repas/poids/glyco logged
        (SELECT COUNT(DISTINCT d.day) FROM (
          SELECT date AS day FROM public.fitplan_repas WHERE user_id = u.id AND date >= NOW() - INTERVAL '14 days'
          UNION
          SELECT date FROM public.fitplan_poids WHERE user_id = u.id AND date >= NOW() - INTERVAL '14 days'
          UNION
          SELECT datetime::date FROM public.fitplan_glyco WHERE user_id = u.id AND datetime >= NOW() - INTERVAL '14 days'
        ) d) AS days_active_14d
      FROM auth.users u
      ORDER BY u.created_at DESC;
    `;
    // Supabase REST doesn't support arbitrary SQL. Use the RPC convention: call a Postgres function.
    // Alternative: PostgREST exposes a way via SQL views or RPC functions. Easiest: use rpc/exec_sql is unavailable.
    // → Workaround: hit /rest/v1 with multiple table reads, aggregate in JS.

    const [users, repas, poids, glyco, sorties, healthData, connections, profils] = await Promise.all([
      // Use Supabase admin auth API to list users
      fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
      }).then(r => r.json()),
      supa(`/rest/v1/fitplan_repas?select=user_id,date`),
      supa(`/rest/v1/fitplan_poids?select=user_id,date`),
      supa(`/rest/v1/fitplan_glyco?select=user_id,datetime`),
      supa(`/rest/v1/fitplan_sorties?select=user_id,date`),
      supa(`/rest/v1/health_data?select=user_id,date,source`),
      supa(`/rest/v1/user_connections?select=user_id,source,status,last_sync_at`),
      supa(`/rest/v1/fitplan_profils?select=id,nom,prenom`),
    ]);

    const userList = Array.isArray(users) ? users : (users.users || []);
    const profilsMap = {};
    profils.forEach(p => { profilsMap[p.id] = p; });

    const now = Date.now();
    const D7  = now - 7*86400000;
    const D14 = now - 14*86400000;

    const stats = userList.map(u => {
      const uid = u.id;
      const repasU = repas.filter(r => r.user_id === uid);
      const repas7d = repasU.filter(r => new Date(r.date).getTime() >= D7);
      const poidsU = poids.filter(p => p.user_id === uid);
      const poids7d = poidsU.filter(p => new Date(p.date).getTime() >= D7);
      const glycoU = glyco.filter(g => g.user_id === uid);
      const sortiesU = sorties.filter(s => s.user_id === uid);
      const healthU = healthData.filter(h => h.user_id === uid);
      const connU = connections.filter(c => c.user_id === uid && c.status === 'active');
      // Days active in last 14 days
      const daysActiveSet = new Set();
      const addDay = d => { if (new Date(d).getTime() >= D14) daysActiveSet.add(String(d).slice(0,10)); };
      repasU.forEach(r => addDay(r.date));
      poidsU.forEach(p => addDay(p.date));
      glycoU.forEach(g => addDay(g.datetime));
      const prof = profilsMap[uid];
      return {
        user_id: uid,
        email: u.email,
        nom: prof?.nom || prof?.prenom || null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        days_since_signup: Math.floor((now - new Date(u.created_at).getTime()) / 86400000),
        hours_since_last_login: u.last_sign_in_at ? Math.floor((now - new Date(u.last_sign_in_at).getTime()) / 3600000) : null,
        nb_repas_total: repasU.length,
        nb_repas_7d: repas7d.length,
        nb_poids_total: poidsU.length,
        nb_poids_7d: poids7d.length,
        nb_sorties: sortiesU.length,
        nb_glyco: glycoU.length,
        nb_health_data: healthU.length,
        days_active_14d: daysActiveSet.size,
        engagement_pct: Math.round((daysActiveSet.size / 14) * 100),
        sources_actives: connU.map(c => c.source),
        last_sync_at: connU.map(c => c.last_sync_at).filter(Boolean).sort().reverse()[0] || null,
      };
    });

    // Sort by engagement desc
    stats.sort((a, b) => b.days_active_14d - a.days_active_14d || (new Date(b.last_sign_in_at || 0) - new Date(a.last_sign_in_at || 0)));

    return res.status(200).json({
      ok: true,
      total_users: stats.length,
      users: stats,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin-stats] error', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
