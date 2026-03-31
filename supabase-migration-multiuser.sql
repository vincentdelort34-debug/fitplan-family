-- ============================================================
-- FitPlan — Migration multi-utilisateurs avec Supabase Auth
-- À exécuter dans l'éditeur SQL de votre projet Supabase
-- ============================================================

-- Ajouter user_id à toutes les tables fitplan
ALTER TABLE public.fitplan_sorties ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_poids ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_glyco ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_repas ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Table profils utilisateurs
CREATE TABLE IF NOT EXISTS public.fitplan_profils (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) UNIQUE NOT NULL,
  prenom text NOT NULL,
  nom text,
  age integer,
  poids_depart numeric,
  poids_objectif numeric,
  poids_actuel numeric,
  taille integer,
  fc_max integer,
  sports text[] DEFAULT '{}',
  sexe text DEFAULT 'h',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Activer RLS sur toutes les tables
ALTER TABLE public.fitplan_sorties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_poids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_glyco ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_repas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_profils ENABLE ROW LEVEL SECURITY;

-- Policies RLS
DROP POLICY IF EXISTS "user_owns_sorties" ON public.fitplan_sorties;
CREATE POLICY "user_owns_sorties" ON public.fitplan_sorties FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_owns_poids" ON public.fitplan_poids;
CREATE POLICY "user_owns_poids" ON public.fitplan_poids FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_owns_glyco" ON public.fitplan_glyco;
CREATE POLICY "user_owns_glyco" ON public.fitplan_glyco FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_owns_repas" ON public.fitplan_repas;
CREATE POLICY "user_owns_repas" ON public.fitplan_repas FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_owns_profil" ON public.fitplan_profils;
CREATE POLICY "user_owns_profil" ON public.fitplan_profils FOR ALL USING (auth.uid() = user_id);
