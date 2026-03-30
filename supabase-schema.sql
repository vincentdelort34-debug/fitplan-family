-- Tables FitPlan
CREATE TABLE IF NOT EXISTS public.fitplan_sorties (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  who text NOT NULL CHECK (who IN ('vincent','femme')),
  date date NOT NULL,
  type text,
  dist numeric,
  duree integer,
  fc integer,
  dplus integer DEFAULT 0,
  ressenti text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fitplan_poids (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  who text NOT NULL CHECK (who IN ('vincent','femme')),
  date date NOT NULL,
  val numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fitplan_glyco (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  datetime timestamptz NOT NULL,
  val numeric NOT NULL,
  ctx text DEFAULT 'jeun',
  note text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fitplan_repas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  who text NOT NULL CHECK (who IN ('vincent','femme')),
  date date NOT NULL,
  type text NOT NULL,
  label text,
  kcal numeric DEFAULT 0,
  proteines numeric DEFAULT 0,
  glucides numeric DEFAULT 0,
  lipides numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Désactiver RLS pour un usage family (app privée par mot de passe)
ALTER TABLE public.fitplan_sorties DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_poids DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_glyco DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fitplan_repas DISABLE ROW LEVEL SECURITY;
