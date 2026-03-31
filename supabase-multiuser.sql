-- 1. Table profils utilisateurs
CREATE TABLE IF NOT EXISTS public.fitplan_profils (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  nom text NOT NULL,
  prenom text,
  age integer,
  sexe text CHECK (sexe IN ('homme','femme','autre')),
  poids_depart numeric,
  poids_objectif numeric,
  poids_actuel numeric,
  taille integer,
  sport_principal text DEFAULT 'velo',
  fc_max integer,
  objectif_kcal integer DEFAULT 1800,
  objectif_proteines integer DEFAULT 150,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Ajouter user_id aux tables existantes (si pas déjà fait)
ALTER TABLE public.fitplan_sorties ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_poids ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_glyco ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_repas ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- 3. Supprimer colonne "who" (plus nécessaire avec user_id)
-- ALTER TABLE public.fitplan_sorties DROP COLUMN IF EXISTS who; -- optionnel

-- 4. Activer RLS sur toutes les tables
ALTER TABLE public.fitplan_profils ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_sorties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_poids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_glyco ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_repas ENABLE ROW LEVEL SECURITY;

-- 5. Policies RLS
-- Profils
CREATE POLICY IF NOT EXISTS "user_owns_profil" ON public.fitplan_profils
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Sorties
CREATE POLICY IF NOT EXISTS "user_owns_sorties" ON public.fitplan_sorties
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Poids
CREATE POLICY IF NOT EXISTS "user_owns_poids" ON public.fitplan_poids
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Glyco
CREATE POLICY IF NOT EXISTS "user_owns_glyco" ON public.fitplan_glyco
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Repas
CREATE POLICY IF NOT EXISTS "user_owns_repas" ON public.fitplan_repas
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
