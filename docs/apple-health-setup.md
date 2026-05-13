# Apple Health → FitPlan : configuration du Raccourci iOS

Une fois par jour, un Raccourci iOS lit tes données Santé Apple sur ton iPhone, et fait un POST vers `https://fitplan-family.vercel.app/api/sync-apple-health`. Les données arrivent dans la table `health_data` de FitPlan en quelques secondes.

**Ton token personnel** (à utiliser dans le Raccourci) :

```
6T97cMsPpexpSJrbM93SnARrv2PbV4QS
```

Ce token est unique à toi, déjà enregistré dans la base FitPlan (`user_connections`). Garde-le secret — c'est lui qui prouve à l'API que c'est ton iPhone qui pousse les données.

---

## 1. Créer le Raccourci

Sur ton iPhone, ouvre l'app **Raccourcis** → onglet **Mes raccourcis** → **+** en haut à droite.

Nomme le raccourci **"FitPlan Santé daily sync"**.

### Étape A — Lire les valeurs Santé Apple

Ajoute ces actions, l'une après l'autre. Tu trouves "Obtenir l'échantillon le plus récent" dans l'app Recherche du panneau d'actions, catégorie **Santé**.

Pour chaque action de type "Obtenir l'échantillon le plus récent de l'état de santé" :

| # | Action | Type de donnée | Paramètres |
|---|---|---|---|
| 1 | Obtenir l'échantillon le plus récent | **Sommeil – Analyse du sommeil** | Dernières 24h, total en **minutes** |
| 2 | Obtenir l'échantillon le plus récent | **FC au repos** | Dernière valeur |
| 3 | Obtenir l'échantillon le plus récent | **Variabilité de la fréquence cardiaque** | Dernière valeur (en ms) |
| 4 | Obtenir l'échantillon le plus récent | **Pas** | Aujourd'hui, somme |
| 5 | Obtenir l'échantillon le plus récent | **Énergie active** | Aujourd'hui, somme (kcal) |
| 6 | Obtenir l'échantillon le plus récent | **Étages montés** | Aujourd'hui, somme |
| 7 | Obtenir l'échantillon le plus récent | **Poids** | Dernière valeur (kg) — optionnel |
| 8 | Obtenir l'échantillon le plus récent | **VO2 max** | Dernière valeur — optionnel |

Juste après chaque action, ajoute **"Définir une variable"** :

| Variable | Valeur |
|---|---|
| `Sommeil_min` | Résultat de l'action 1 |
| `RHR` | Résultat de l'action 2 |
| `HRV` | Résultat de l'action 3 |
| `Pas` | Résultat de l'action 4 |
| `Kcal` | Résultat de l'action 5 |
| `Etages` | Résultat de l'action 6 |
| `Poids` | Résultat de l'action 7 |
| `VO2` | Résultat de l'action 8 |

### Étape B — Construire le dictionnaire JSON

Ajoute l'action **"Dictionnaire"** et configure-le comme ceci :

```
date            : (laisse vide — le serveur prendra aujourd'hui en heure de Paris)
metrics         : (Sous-dictionnaire ↓)
  sleep_minutes    : variable Sommeil_min
  resting_hr       : variable RHR
  hrv              : variable HRV
  steps            : variable Pas
  active_calories  : variable Kcal
  floors_climbed   : variable Etages
  weight_kg        : variable Poids
  vo2max           : variable VO2
```

### Étape C — POST vers FitPlan

Ajoute l'action **"Obtenir le contenu de l'URL"** avec ces paramètres :

- **URL** : `https://fitplan-family.vercel.app/api/sync-apple-health`
- **Méthode** : POST
- **En-têtes** :
  - `X-User-Token` : `6T97cMsPpexpSJrbM93SnARrv2PbV4QS`
  - `Content-Type` : `application/json`
- **Corps de la requête** : Type **JSON**, contenu = le dictionnaire de l'étape B

### Étape D — Afficher la réponse (optionnel, pour vérifier)

Ajoute **"Afficher la notification"** avec comme contenu le résultat de l'action C. Tu verras `{"status":"ok","inserted":8}` (ou pareil).

---

## 2. Tester le Raccourci une fois

Appuie sur le bouton **▶︎** en haut du raccourci pour le lancer maintenant. La première fois, iOS te demande l'autorisation de lire les données Santé : accepte tout.

Tu devrais voir une notification de succès avec `inserted: N`.

Vérification côté FitPlan : dans Supabase Studio → table `health_data` → filtre `source = apple_health` → tu vois tes lignes du jour. Ou plus tard via l'écran "Connexions" de FitPlan.

---

## 3. Automatiser tous les matins

Dans l'app Raccourcis :

1. Onglet **Automatisation** (en bas)
2. **+** en haut à droite → **Créer une automatisation personnelle**
3. **Heure du jour** → règle sur **7:00**
4. **Tous les jours** coché → **Suivant**
5. **+ Ajouter une action** → cherche **"Exécuter le raccourci"** → choisis **FitPlan Santé daily sync**
6. **Suivant** → **désactive** "Demander avant d'exécuter" (sinon ça nécessite ton accord chaque matin)
7. **OK**

Voilà, à partir de demain matin 7h, ton iPhone pousse automatiquement vers FitPlan.

---

## Dépannage

**"Token invalide"** → vérifie que tu as bien copié `6T97cMsPpexpSJrbM93SnARrv2PbV4QS` dans le header X-User-Token (avec les majuscules exactes).

**"inserted: 0"** → la requête est arrivée mais aucune métrique reconnue. Vérifie les clés du dictionnaire (elles doivent être exactement `sleep_minutes`, `resting_hr`, `hrv`, etc.).

**Le Raccourci ne se déclenche pas tout seul** → vérifie dans Réglages iOS → Raccourcis → autorisations, et désactive bien "Demander avant d'exécuter" dans l'automatisation.

**Tu veux re-tester sans attendre demain** → bouton ▶︎ dans le raccourci, ou demande à Siri : "FitPlan Santé daily sync".
