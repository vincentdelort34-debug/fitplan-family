-- FitPlan — Étape 1 : pipeline santé multi-sources
-- Target project: Vititrace (tndrqmyiwthkphzlviny) — note: nom historique du projet,
--                 c'est bien le backend FitPlan actuel.
-- Applied live via Supabase MCP on 2026-05-13.
-- This file is the canonical record of what was applied.

-- 1. Rename fitplan_profiles → fitplan_profils (cohérence FR avec le reste du schéma)
DROP POLICY IF EXISTS "user_own_profile" ON public.fitplan_profiles;
ALTER TABLE public.fitplan_profiles RENAME TO fitplan_profils;
CREATE POLICY "user_own_profil" ON public.fitplan_profils
  FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- 2. Nouvelle table health_data (schéma EAV unifié multi-sources)
-- Sources autorisées : strava, intervals_icu, apple_health, fitbit, manual, garmin_direct, garmin_scrape
-- metric_type exemples : sleep_duration, sleep_score, resting_hr, hrv, steps, weight, vo2max, workout, ...
CREATE TABLE IF NOT EXISTS public.health_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('strava','intervals_icu','apple_health','fitbit','manual','garmin_direct','garmin_scrape')),
  metric_type TEXT NOT NULL,
  value NUMERIC,
  value_text TEXT,
  unit TEXT,
  metadata JSONB,
  external_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT health_data_dedupe UNIQUE NULLS NOT DISTINCT (user_id, source, external_id, metric_type)
);
CREATE INDEX IF NOT EXISTS idx_health_data_user_date ON public.health_data (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_health_data_source ON public.health_data (source);
CREATE INDEX IF NOT EXISTS idx_health_data_metric ON public.health_data (metric_type);
ALTER TABLE public.health_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own health data" ON public.health_data;
CREATE POLICY "Users see own health data" ON public.health_data
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 3. Nouvelle table user_connections (générique tous providers)
-- Stocke OAuth tokens (Strava/Garmin) ET clés API (Intervals.icu) ET tokens custom (Apple Health) chiffrés.
-- credentials JSONB est chiffré côté serverless via api/_lib/crypto.js (AES-256-GCM).
CREATE TABLE IF NOT EXISTS public.user_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('strava','intervals_icu','apple_health','fitbit','manual','garmin_direct','garmin_scrape')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','disabled','expired','error')),
  credentials JSONB,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_error TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, source)
);
CREATE INDEX IF NOT EXISTS idx_user_connections_user ON public.user_connections (user_id);
ALTER TABLE public.user_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own connections" ON public.user_connections;
CREATE POLICY "Users manage own connections" ON public.user_connections
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 4. Fonction + triggers updated_at sur les nouvelles tables
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_health_data_updated_at ON public.health_data;
CREATE TRIGGER trg_health_data_updated_at
  BEFORE UPDATE ON public.health_data
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_user_connections_updated_at ON public.user_connections;
CREATE TRIGGER trg_user_connections_updated_at
  BEFORE UPDATE ON public.user_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
