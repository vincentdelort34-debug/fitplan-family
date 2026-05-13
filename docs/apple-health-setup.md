# Apple Health → FitPlan — Méthode recommandée

Apple a verrouillé l'app Raccourcis pour la lecture massive de données Santé sur iOS récent. **La voie fiable aujourd'hui** est l'app **Health Auto Export** sur l'App Store — 3 € one-shot, taillée pour ça : elle lit toutes tes données Apple Health et les POST automatiquement vers un endpoint webhook chaque matin (ou à l'intervalle que tu veux).

Si tu utilises déjà Garmin/Strava/Intervals.icu, **Apple Health est optionnel** (les données sont déjà dans FitPlan via les autres sources). Apple Health est utile surtout pour les utilisateurs iPhone-only ou Apple Watch sans Garmin.

---

## Étape 1 — Installer Health Auto Export

1. App Store sur ton iPhone → cherche **"Health Auto Export"** (auteur Lybron Sobers, icône cardiogramme bleu/vert)
2. Achète l'app (3 € en achat unique, pas d'abonnement)
3. Ouvre-la, accepte de lire toutes les données Santé qu'elle propose

## Étape 2 — Récupérer ton token FitPlan

Ouvre FitPlan dans Safari → onglet **⚙️ Connexions** → carte **🍎 Apple Health**.
Ton token personnel est affiché dedans, du genre :

```
6T97cMsPpexpSJrbM93SnARrv2PbV4QS
```

Copie-le.

## Étape 3 — Configurer le webhook dans Health Auto Export

Dans l'app **Health Auto Export** :

1. **Automations** (icône en bas) → **Add Automation**
2. **Frequency** : Daily (chaque jour)
3. **Time** : `7:00 AM`
4. **Format** : **JSON**
5. **Aggregate** : **Daily**
6. **Data Types** : sélectionne au minimum :
   - Step Count
   - Active Energy
   - Heart Rate Resting (Resting Heart Rate)
   - Heart Rate Variability
   - Sleep Analysis
   - Body Mass (Weight)
   - VO2 Max
   - Walking + Running Distance
   - Apple Exercise Time
7. **Destination** : choisis **REST API** ou **Webhook**
   - **URL** : `https://fitplan-family.vercel.app/api/sync-apple-health`
   - **Method** : `POST`
   - **Headers** : ajoute deux headers
     - `X-User-Token` : `<ton token copié à l'étape 2>`
     - `Content-Type` : `application/json`
8. Sauvegarde

## Étape 4 — Tester immédiatement

Dans Health Auto Export, ouvre l'automatisation et tape **"Run Now"** (ou Export Now). Tu devrais voir un message de succès `inserted: N rows` ou similaire.

Vérification côté FitPlan : retourne sur l'onglet ⚙️ Connexions, recharge la page → la carte Apple Health passe en **"Connecté"** avec `Dernière sync à l'instant`.

## Étape 5 — C'est fait

À partir de demain matin 7h, Health Auto Export envoie automatiquement tes données du jour. La carte Apple Health dans FitPlan se met à jour seule, et la vue unifiée `health_data_unified` combinera les données Apple avec celles de Strava/Intervals.icu en privilégiant la source la plus fiable par métrique.

---

## Alternative gratuite (limitée) — Raccourci iOS

Si tu veux pas payer 3 €, tu peux faire un Raccourci iOS qui POST un dictionnaire JSON avec quelques métriques basiques (pas, calories actives, dernier poids). Apple a hélas restreint les types lisibles par Shortcuts récemment (sommeil, FC repos, HRV pas accessibles directement sur iOS 17+ via Shortcuts).

Le endpoint `/api/sync-apple-health` accepte ces 2 formats :

**Format simple (Raccourci iOS)** :
```json
{
  "date": "2026-05-13",
  "metrics": {
    "sleep_minutes": 425, "resting_hr": 52, "hrv": 38, "steps": 8543,
    "active_calories": 412, "weight_kg": 91.2, "vo2max": 40
  }
}
```

**Format Health Auto Export** :
```json
{
  "data": {
    "metrics": [
      { "name": "step_count", "data": [{ "date": "...", "qty": 8543 }] },
      { "name": "sleep_analysis", "data": [{ "sleepEnd": "...", "asleep": 25500 }] }
    ]
  }
}
```

Recommandation : **paye les 3 € pour Health Auto Export**, c'est de loin la solution la plus fiable et complète.

---

## Dépannage

| Erreur | Solution |
|---|---|
| `{"error":"missing_token"}` | Header `X-User-Token` absent ou mal écrit (respecte la casse) |
| `{"error":"invalid_token"}` | Token ne correspond pas à un compte FitPlan. Vérifie en recopiant depuis l'onglet Connexions |
| `inserted: 0` | Aucune métrique reconnue. Vérifie que tu coches bien des "Data Types" dans HAE |
| Pas de webhook reçu | Health Auto Export → onglet Logs → vérifie qu'il n'y a pas d'erreur HTTP |
