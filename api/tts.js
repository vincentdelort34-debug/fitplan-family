// Vercel Serverless Function — Text-to-Speech (voix naturelle ElevenLabs)
// Renvoie un flux audio MP3 à partir d'un texte. Clé en variable d'env (jamais en dur).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'Configuration manquante (ELEVENLABS_API_KEY)' });
  }

  const { text, voice_id, voice_settings } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Texte manquant' });

  // Voix par défaut : pilotable via ELEVENLABS_VOICE_ID (choisis ta voix dans ta bibliothèque ElevenLabs)
  const vid = voice_id || process.env.ELEVENLABS_VOICE_ID || 'XrExE9yKIg1WjnnlVkGX';

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.slice(0, 2500),
        model_id: 'eleven_multilingual_v2',
        voice_settings: voice_settings || { stability: 0.32, similarity_boost: 0.85, style: 0.55, use_speaker_boost: true },
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error('[tts] ElevenLabs error:', detail);
      return res.status(502).json({ error: 'Erreur TTS', detail });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    console.error('[tts] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
