# Fitbit → FitPlan — Setup developer app

L'intégration Fitbit utilise OAuth 2.0. **Cette étape est à faire UNE fois côté admin (Vincent)** pour autoriser FitPlan à demander aux utilisateurs leur consentement. Ensuite chaque utilisateur clique simplement sur "Se connecter avec Fitbit" dans l'app.

## Étape 1 — Créer une app Fitbit Developer

1. Va sur https://dev.fitbit.com/apps et connecte-toi avec ton compte Fitbit perso (ou un compte dédié)
2. Tape **"Register a new app"** en haut à droite
3. Remplis le formulaire :
   - **Application Name** : `FitPlan`
   - **Description** : `Personal fitness & wellness tracking app`
   - **Application Website URL** : `https://fitplan-family.vercel.app`
   - **Organization** : (ton nom ou la SARL/EI selon ton statut)
   - **Organization Website URL** : pareil que ci-dessus
   - **Terms of Service URL** : `https://fitplan-family.vercel.app/terms` (mets ça même si la page n'existe pas encore)
   - **Privacy Policy URL** : `https://fitplan-family.vercel.app/privacy`
   - **OAuth 2.0 Application Type** : **Server** (très important — pas "Client")
   - **Redirect URL** : `https://fitplan-family.vercel.app/api/fitbit-callback`
   - **Default Access Type** : **Read-Only**
4. Coche "I agree to the Fitbit Platform Terms of Service" et "Register"

## Étape 2 — Récupérer les credentials

Sur la page de ton app nouvellement créée tu verras :
- **OAuth 2.0 Client ID** : un code à 6 caractères du genre `23ABCD`
- **Client Secret** : une longue chaîne de caractères (clique sur "Reveal" pour la voir)

## Étape 3 — Ajouter sur Vercel

Va sur https://vercel.com/vincentdelort34-1430s-projects/fitplan-family/settings/environment-variables et ajoute :

| Key | Value |
|---|---|
| `FITBIT_CLIENT_ID` | (le Client ID copié) |
| `FITBIT_CLIENT_SECRET` | (le Client Secret copié) |

Coche les 3 environnements (Production + Preview + Development). Save.

## Étape 4 — Redéploiement automatique

Vercel redéploie automatiquement sous 30s avec les nouvelles env vars.

À partir de là, n'importe quel utilisateur FitPlan peut aller dans **⚙️ Connexions → Fitbit → "Se connecter avec Fitbit"** et autoriser l'app. Les tokens sont chiffrés AES-256-GCM côté serveur, et un cron quotidien (`/api/sync-fitbit`) rafraîchit ses données chaque matin.

## Limites Fitbit à connaître

- **150 calls/heure** par user (largement suffisant pour un sync quotidien)
- Le sommeil/HRV/VO2max ne sont disponibles que sur certains modèles (Sense, Charge 5/6, Versa 3/4, etc.)
- Si tu veux distribuer FitPlan sur l'App Store/Google Play à terme, il faudra demander à Fitbit le statut "Production" (gratuit, formulaire en ligne, validation ~2 semaines)
