-- Ajouter user_id aux tables fitplan
ALTER TABLE public.fitplan_sorties ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_poids ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_glyco ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.fitplan_repas ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Table profils utilisateurs
CREATE TABLE IF NOT EXISTS public.fitplan_profils (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) UNIQUE NOT NULL,
  nom text NOT NULL,
  age integer,
  sexe text DEFAULT 'h',
  poids_depart numeric,
  poids_objectif numeric,
  taille integer,
  sport_principal text DEFAULT 'velo',
  fc_max integer,
  objectif_kcal integer DEFAULT 1800,
  objectif_proteines integer DEFAULT 150,
  created_at timestamptz DEFAULT now()
);

-- Activer RLS
ALTER TABLE public.fitplan_sorties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_poids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_glyco ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_repas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_profils ENABLE ROW LEVEL SECURITY;

-- Policies (chaque user voit ses données)
DROP POLICY IF EXISTS "user_own_sorties" ON public.fitplan_sorties;
CREATE POLICY "user_own_sorties" ON public.fitplan_sorties FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_poids" ON public.fitplan_poids;
CREATE POLICY "user_own_poids" ON public.fitplan_poids FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_glyco" ON public.fitplan_glyco;
CREATE POLICY "user_own_glyco" ON public.fitplan_glyco FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_repas" ON public.fitplan_repas;
CREATE POLICY "user_own_repas" ON public.fitplan_repas FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_profil" ON public.fitplan_profils;
CREATE POLICY "user_own_profil" ON public.fitplan_profils FOR ALL USING (auth.uid() = user_id);
