// api/fit-upload.js
// Parse a Garmin .fit activity file and store the extracted metrics in health_data.
//
// Auth: Bearer <Supabase user JWT> in Authorization header.
//
// Request:
//   POST /api/fit-upload
//   { "filename": "ACTIVITY.fit", "data": "<base64-encoded fit binary>" }
//
// Extracts (when present in the file):
//   - Session summary: total_distance, total_elapsed_time, avg/max HR, avg/max power,
//                      normalized_power, training_load, training_effects, calories,
//                      total_ascent, avg/max cadence, total_calories.
//   - Pedal dynamics (Garmin Vector / Rally / power meters with these fields):
//                      avg_left_right_balance, avg_left_pco, avg_right_pco,
//                      avg_left_torque_effectiveness, avg_right_torque_effectiveness,
//                      avg_left_pedal_smoothness, avg_right_pedal_smoothness,
//                      avg_left_power_phase, avg_right_power_phase
//                      (and the same _peak variants).
//   - Aggregated zones (HR + Power) if present in session message.
//
// Inserts ONE row in public.health_data with:
//   source='garmin_fit', metric_type='workout', metadata={... rich payload ...},
//   external_id='garmin_fit_<timestamp>'.

import FitParser from 'fit-file-parser';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

// 5 MB — typical multi-hour FIT files are ~1-2 MB
export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
};

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

function parseFitBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const fp = new (FitParser.default || FitParser)({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'list',
    });
    fp.parse(buffer, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

function sportTypeLabel(sport, sub_sport) {
  const map = {
    cycling: 'velo',  running: 'course',  walking: 'marche',  hiking: 'marche',
    swimming: 'swim',  fitness_equipment: 'muscu',  training: 'muscu',
  };
  return map[sport] || (sub_sport && map[sub_sport]) || 'velo';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_misconfigured' });

  const authHeader = req.headers['authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return res.status(401).json({ error: 'missing_token' });
  const user = await getUserFromJwt(jwt);
  if (!user || !user.id) return res.status(401).json({ error: 'invalid_token' });
  const userId = user.id;

  const { filename, data } = req.body || {};
  if (!data || typeof data !== 'string') {
    return res.status(400).json({ error: 'missing_data', hint: 'send {filename, data: base64}' });
  }

  let buf;
  try {
    buf = Buffer.from(data, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'bad_base64' });
  }
  if (buf.length < 100) return res.status(400).json({ error: 'file_too_small' });

  let parsed;
  try {
    parsed = await parseFitBuffer(buf);
  } catch (e) {
    return res.status(400).json({ error: 'fit_parse_failed', detail: String(e.message || e) });
  }

  // The shape depends on the FIT writer. Look for session messages.
  // In mode 'list', parsed is { sessions, laps, records, events, ... } at top level OR
  // parsed.activity.sessions depending on version. Be defensive.
  const sessions = parsed.sessions || parsed.activity?.sessions || (parsed.session ? [parsed.session] : []);
  const session = sessions[0] || {};
  const laps    = parsed.laps    || session.laps    || [];
  const records = parsed.records || session.records || [];

  // Build aggregates from records if session doesn't expose them
  function avgOf(field) {
    const vals = records.map(r => r[field]).filter(v => v != null && !isNaN(v));
    return vals.length ? +(vals.reduce((a,b)=>a+b,0) / vals.length).toFixed(2) : null;
  }
  function maxOf(field) {
    const vals = records.map(r => r[field]).filter(v => v != null && !isNaN(v));
    return vals.length ? Math.max(...vals) : null;
  }

  const startTime = session.start_time || (records[0] && records[0].timestamp) || new Date().toISOString();
  const startDate = new Date(startTime).toISOString().slice(0, 10);

  // External ID — stable per session start
  const externalId = `garmin_fit_${Math.floor(new Date(startTime).getTime() / 1000)}`;

  // Pedal dynamics aggregation
  const pedalDynamics = {
    avg_left_right_balance:        session.avg_left_right_balance        ?? avgOf('left_right_balance'),
    avg_left_pco:                  session.avg_left_pco                  ?? avgOf('left_pco'),
    avg_right_pco:                 session.avg_right_pco                 ?? avgOf('right_pco'),
    avg_left_torque_effectiveness: session.avg_left_torque_effectiveness ?? avgOf('left_torque_effectiveness'),
    avg_right_torque_effectiveness:session.avg_right_torque_effectiveness?? avgOf('right_torque_effectiveness'),
    avg_left_pedal_smoothness:     session.avg_left_pedal_smoothness     ?? avgOf('left_pedal_smoothness'),
    avg_right_pedal_smoothness:    session.avg_right_pedal_smoothness    ?? avgOf('right_pedal_smoothness'),
    avg_left_power_phase:          session.avg_left_power_phase          ?? null,
    avg_right_power_phase:         session.avg_right_power_phase         ?? null,
    avg_left_power_phase_peak:     session.avg_left_power_phase_peak     ?? null,
    avg_right_power_phase_peak:    session.avg_right_power_phase_peak    ?? null,
  };
  const hasPedalDynamics = Object.values(pedalDynamics).some(v => v != null && !(Array.isArray(v) && v.length === 0));

  // Time in HR / power zones (if exposed in session)
  const zones = {
    time_in_hr_zone:    session.time_in_hr_zone || null,
    time_in_power_zone: session.time_in_power_zone || null,
  };

  // Total distance & elapsed
  const totalDistanceM = session.total_distance ?? (records.length ? records[records.length - 1].distance : null);
  const totalTimeS     = session.total_elapsed_time ?? session.total_timer_time ?? null;
  const durationMin    = totalTimeS ? Math.round(totalTimeS / 60) : null;

  const type = sportTypeLabel(session.sport, session.sub_sport);

  const metadata = {
    source_file:     filename || 'activity.fit',
    sport:           session.sport,
    sub_sport:       session.sub_sport,
    type:            session.sport,
    sport_type:      session.sub_sport || session.sport,
    start_local:     startTime,
    distance_m:      totalDistanceM,
    moving_time_s:   session.total_moving_time ?? totalTimeS,
    elapsed_time_s:  totalTimeS,
    elevation_gain:  session.total_ascent ?? null,
    avg_hr:          session.avg_heart_rate ?? avgOf('heart_rate'),
    max_hr:          session.max_heart_rate ?? maxOf('heart_rate'),
    avg_watts:       session.avg_power      ?? avgOf('power'),
    max_watts:       session.max_power      ?? maxOf('power'),
    weighted_avg_watts: session.normalized_power ?? null,
    np:              session.normalized_power ?? null,
    ftp:             session.threshold_power ?? null,
    intensity:       session.intensity_factor ?? null,
    tss:             session.training_stress_score ?? null,
    training_load:   session.training_load ?? session.training_stress_score ?? null,
    te_aero:         session.total_training_effect ?? null,
    te_anaero:       session.total_anaerobic_training_effect ?? null,
    calories:        session.total_calories ?? null,
    kilojoules:      session.total_work ? Math.round(session.total_work / 1000) : null,
    avg_cadence:     session.avg_cadence ?? avgOf('cadence'),
    max_cadence:     session.max_cadence ?? maxOf('cadence'),
    avg_speed_kmh:   session.avg_speed ?? null,
    max_speed_kmh:   session.max_speed ?? null,
    avg_temp:        session.avg_temperature ?? avgOf('temperature'),
    laps_count:      laps.length,
    records_count:   records.length,
    hr_zones:        zones.time_in_hr_zone ? {
      z1: zones.time_in_hr_zone[1] || 0,
      z2: zones.time_in_hr_zone[2] || 0,
      z3: zones.time_in_hr_zone[3] || 0,
      z4: zones.time_in_hr_zone[4] || 0,
      z5: zones.time_in_hr_zone[5] || 0,
    } : null,
    pedal_dynamics:  hasPedalDynamics ? pedalDynamics : null,
  };

  // Cleanup: remove null fields to keep metadata compact
  for (const k of Object.keys(metadata)) if (metadata[k] === null || metadata[k] === undefined) delete metadata[k];

  const row = {
    user_id:     userId,
    date:        startDate,
    source:      'garmin_fit',
    metric_type: 'workout',
    value:       durationMin,
    unit:        'min',
    metadata,
    external_id: externalId,
  };

  try {
    const out = await supa(
      `/rest/v1/health_data?on_conflict=user_id,source,external_id,metric_type`,
      { method: 'POST', body: JSON.stringify([row]),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    return res.status(200).json({
      status: 'ok',
      inserted: out.length,
      source: 'garmin_fit',
      date: startDate,
      external_id: externalId,
      sport: session.sport,
      pedal_dynamics_present: hasPedalDynamics,
      summary: {
        distance_km: totalDistanceM ? +(totalDistanceM / 1000).toFixed(2) : null,
        duration_min: durationMin,
        avg_hr: metadata.avg_hr,
        avg_watts: metadata.avg_watts,
        np: metadata.np,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'db_upsert_failed', detail: String(e.message || e) });
  }
}
