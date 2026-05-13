# Google Health Connect → FitPlan — Setup Android

Sur Android, **Health Connect** est le hub santé central de Google (depuis 2023). Il agrège les données de Samsung Health, Garmin Connect, Fitbit, Polar, Withings, etc., dans un format unifié.

Pour pousser ces données vers FitPlan, le plus simple aujourd'hui c'est l'app **Health Sync** sur Play Store (5€ achat unique, bien maintenue).

Si tu utilises déjà Strava/Intervals.icu (cas de Vincent), ce setup est **optionnel** — les sources existantes couvrent déjà 95% des données.

---

## Étape 1 — Vérifier que Health Connect est actif

Sur ton Android, ouvre **Paramètres → Apps → Health Connect** (ou cherche "Health Connect" dans le menu apps). Si l'app n'existe pas, installe-la depuis le Play Store. Vérifie que tes apps santé (Samsung Health, Garmin Connect, Fitbit, etc.) sont autorisées à écrire dans Health Connect.

## Étape 2 — Installer Health Sync

Play Store → cherche **"Health Sync"** (auteur appyhapps Nederland B.V., icône verte avec flèches circulaires). Achète l'app (~5€). Ouvre-la, accorde les permissions Health Connect demandées.

## Étape 3 — Récupérer ton token FitPlan

Ouvre FitPlan dans Chrome → onglet **⚙️ Connexions** → carte **🤖 Health Connect (Android)**. Ton token personnel s'affiche, du genre :

```
GH7kpA2vNmRsXdT9jBfL4yWzC8eQpUiM
```

Copie-le.

## Étape 4 — Configurer le webhook dans Health Sync

Dans Health Sync :

1. **Settings** → **Add Service** → cherche **"Webhook"** ou **"Custom URL"**
2. **URL** : `https://fitplan-family.vercel.app/api/sync-health`
3. **Method** : `POST`
4. **Headers** : ajoute
   - `X-User-Token` : `<ton token copié>`
   - `Content-Type` : `application/json`
5. **Data types** à synchroniser : coche au minimum
   - Steps
   - Heart Rate (Resting)
   - Heart Rate Variability
   - Sleep
   - Active Energy
   - Distance
   - Weight
   - VO2 Max
6. **Sync frequency** : Daily à 7h00
7. **Format** : JSON

Sauvegarde.

## Étape 5 — Tester

Dans Health Sync, tape **"Sync Now"**. Tu devrais voir un message de succès `inserted: N`.

Vérification côté FitPlan : retourne sur l'onglet ⚙️ Connexions, recharge la page → la carte Health Connect passe en **"Connecté"** avec `Dernière sync à l'instant`.

---

## Alternative gratuite — Tasker + plugin HTTP

Si tu veux pas payer Health Sync :

1. Installe **Tasker** (3,99€ une fois, mais 1 semaine gratuit) + le plugin gratuit **HTTP Request Shortcuts**
2. Crée un Profile qui se déclenche tous les jours à 7h
3. Crée une Task qui :
   - Lit les valeurs Health Connect via les actions Tasker Health Plugin
   - Construit un dictionnaire JSON
   - POST vers `/api/sync-health` avec les headers `X-User-Token` + `Content-Type`

Plus de paramétrage manuel, mais c'est faisable et gratuit.

---

## Alternative future (planifiée) — App FitPlan native

Quand FitPlan grossira, on prévoit une **app companion FitPlan native** (iOS + Android) qui :
- Lit Health Connect (Android) et HealthKit (iOS) sans intermédiaire
- POST automatiquement chaque matin
- Distribuée sur App Store + Play Store

Pour l'instant, on s'appuie sur Health Auto Export (iOS) et Health Sync (Android) pour ne pas devoir maintenir une app mobile.

---

## Format JSON accepté

L'endpoint `/api/sync-health` est très permissif et accepte 3 formats :

**Format simple** (le plus facile pour Health Sync ou un script Tasker) :
```json
{
  "date": "2026-05-13",
  "metrics": {
    "sleep_minutes": 425, "resting_hr": 52, "hrv": 38, "steps": 8543,
    "active_calories": 412, "weight_kg": 91.2, "vo2max": 40
  }
}
```

**Format Health Connect "flat array"** :
```json
{
  "metrics": [
    { "type": "Steps", "value": 12345, "date": "2026-05-13" },
    { "type": "RestingHeartRate", "value": 52, "date": "2026-05-13" },
    { "type": "SleepSession", "value": 425, "date": "2026-05-13", "unit": "min" }
  ]
}
```

**Format Apple HAE-compatible** (au cas où) :
```json
{
  "data": {
    "metrics": [
      { "name": "step_count", "data": [{ "date": "2026-05-13", "qty": 12345 }] }
    ]
  }
}
```

---

## Dépannage

| Erreur | Solution |
|---|---|
| `{"error":"invalid_token"}` | Le X-User-Token est incorrect. Vérifie en recopiant depuis l'onglet Connexions. |
| `inserted: 0` | Aucune métrique reconnue. Vérifie que les `type` matchent (Steps, RestingHeartRate, HeartRateVariabilityRmssd, etc.) |
| Pas de webhook reçu | Health Sync → onglet Logs → vérifie qu'il n'y a pas d'erreur HTTP côté envoi |
