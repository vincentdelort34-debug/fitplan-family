-- 1. Ajouter user_id à toutes les tables fitplan
ALTER TABLE public.fitplan_sorties ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_poids ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_glyco ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_repas ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- 2. Table profils utilisateurs
CREATE TABLE IF NOT EXISTS public.fitplan_profiles (
  id uuid REFERENCES auth.users(id) PRIMARY KEY,
  nom text NOT NULL,
  age integer,
  poids_depart numeric,
  poids_objectif numeric,
  poids_actuel numeric,
  taille integer,
  fc_max integer,
  sport_principal text DEFAULT 'velo',
  objectif_kcal integer DEFAULT 1800,
  objectif_proteines integer DEFAULT 150,
  created_at timestamptz DEFAULT now()
);

-- 3. Activer RLS
ALTER TABLE public.fitplan_sorties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_poids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_glyco ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_repas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_profiles ENABLE ROW LEVEL SECURITY;

-- 4. Politiques RLS — chaque user voit uniquement ses données
DROP POLICY IF EXISTS "user_own_sorties" ON public.fitplan_sorties;
CREATE POLICY "user_own_sorties" ON public.fitplan_sorties FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_poids" ON public.fitplan_poids;
CREATE POLICY "user_own_poids" ON public.fitplan_poids FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_glyco" ON public.fitplan_glyco;
CREATE POLICY "user_own_glyco" ON public.fitplan_glyco FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_repas" ON public.fitplan_repas;
CREATE POLICY "user_own_repas" ON public.fitplan_repas FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_profile" ON public.fitplan_profiles;
CREATE POLICY "user_own_profile" ON public.fitplan_profiles FOR ALL USING (auth.uid() = id);
