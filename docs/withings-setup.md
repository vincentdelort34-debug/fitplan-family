# Withings → FitPlan — Setup developer app

L'intégration Withings (Body+ scales, ScanWatch, Sleep Analyzer, etc.) utilise OAuth 2.0. À faire UNE fois côté admin.

## Étape 1 — Créer un compte Withings Public Cloud API

1. Va sur https://developer.withings.com (clique sur "Try Health Cloud Sandbox" si pas encore loggué)
2. Connecte-toi avec ton compte Withings perso ou crée-en un dédié
3. Une fois dans le dashboard développeur, tape **"Create an application"**
4. Choisis **"Public API Integration"** (gratuit)
5. Remplis :
   - **Application name** : `FitPlan`
   - **Description** : `Personal fitness & wellness tracking`
   - **Logo** : (optionnel, max 1MB PNG)
   - **Contact email** : ton email
   - **Application website** : `https://fitplan-family.vercel.app`
   - **Callback URI** : `https://fitplan-family.vercel.app/api/withings-callback`
6. Sauvegarde

## Étape 2 — Récupérer les credentials

Withings affiche :
- **Client ID** (commence souvent par un nombre)
- **Consumer Secret** (clique sur l'œil pour révéler)

## Étape 3 — Ajouter sur Vercel

Va sur https://vercel.com/vincentdelort34-1430s-projects/fitplan-family/settings/environment-variables et ajoute :

| Key | Value |
|---|---|
| `WITHINGS_CLIENT_ID` | (Client ID) |
| `WITHINGS_CLIENT_SECRET` | (Consumer Secret) |

Coche les 3 environnements. Save.

## Étape 4 — C'est prêt

Vercel redéploie. Les utilisateurs peuvent aller dans **⚙️ Connexions → Withings → "Se connecter avec Withings"** et autoriser. Un cron quotidien (`/api/sync-withings`) rafraîchit leurs données :
- **Body+ scales** : poids, masse grasse, masse musculaire, hydratation, masse osseuse
- **ScanWatch** : sommeil, FC repos, fréquence respiratoire, activités sportives
- **Sleep Analyzer** : sommeil détaillé (deep/REM/light), apnée
- **BPM Connect** : tension artérielle

## Limites Withings à connaître

- Token access valide **3 heures**, refresh automatique par le sync
- L'app commence en mode **"Development"** (5 users max) — quand tu veux scaler, demande le passage en **"Production"** (gratuit, formulaire, ~1 semaine)
- Toutes les données métriques utilisent un encodage `value * 10^unit` (déjà décodé par notre connecteur)
