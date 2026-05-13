# Upload .fit Garmin → FitPlan : récupérer les métriques avancées

Pour avoir les **pedal dynamics** (équilibre G/D, PCO, torque effectiveness, pedal smoothness, power phase) et toutes les métriques détaillées Garmin qui ne sont pas dans Strava, FitPlan accepte les fichiers `.fit` exportés depuis Garmin Connect.

## 1. Exporter un .fit depuis Garmin Connect

### Depuis l'app mobile Garmin Connect
1. Ouvre l'activité que tu veux uploader
2. Tape les **⋯** (trois points) en haut à droite
3. **Exporter l'activité → Fichier d'origine (.fit)**
4. Choisis "Enregistrer dans Fichiers" → AirDrop / Mail / Dropbox / Google Drive

### Depuis le site web https://connect.garmin.com
1. Va sur ton activité
2. **⚙️ Engrenage** en haut à droite
3. **Exporter le fichier d'origine** → télécharge un `.fit`

## 2. Uploader dans FitPlan

1. Ouvre FitPlan → onglet **🚴 Sortie**
2. Section **📁 Importer depuis Garmin** (drop zone en haut)
3. Drop le fichier `.fit` OU clique pour ouvrir le sélecteur de fichiers
4. FitPlan fait DEUX choses simultanément :
   - **Préremplit le formulaire** d'ajout manuel avec distance/durée/FC (parser client-side)
   - **Upload vers `/api/fit-upload`** côté serveur pour extraire les métriques avancées (parser serveur Node.js avec fit-file-parser)
5. Sous le formulaire tu vois apparaître :
   - `✨ Parser serveur OK · Pedal dynamics extraits ✓` (succès, avec métriques avancées)
   - OU `✨ Parser serveur OK · 38.2km, 128min · pas de pedal dynamics dans ce .fit` (succès, mais ta montre/pédales ne remontent pas ces métriques)
   - OU une erreur si le serveur n'a pas pu parser le fichier

## 3. Visualiser les pedal dynamics

Une fois uploadée, ta sortie apparaît dans l'historique avec un pill **GARMIN_FIT** (au lieu de STRAVA).

Clique sur **✨ Analyser cette sortie** sur la ligne de la sortie → l'IA coach va recevoir TOUTES les métriques avancées et te générer une analyse spécifique :

- 🎯 Type de séance (Z2 endurance, sweet spot, fractionné, etc.)
- 📊 Lecture données puissance / FC / zones
- 🦵 **Biomécanique du pédalage** (nouvelle section quand pedal dynamics présents) :
  - Équilibre G/D et compensation éventuelle
  - PCO (Platform Center Offset) — où tu appuies sur la pédale, asymétrie G/D
  - Torque Effectiveness — % de pédalage qui produit du couple positif
  - Pedal Smoothness — régularité du couple
  - Power Phase — début/fin de la phase active
- 💡 Point fort / point d'attention
- 🌙 Recommandation de récup

## 4. Quels capteurs remontent les pedal dynamics ?

- **Garmin Vector / Vector 2 / Vector 3** : pedal dynamics complètes (PCO, power phase, torque eff, pedal smoothness)
- **Garmin Rally RS/RK/XC** : idem
- **Stages Power LR (dual)** : équilibre + cadence, parfois torque effectiveness
- **Quarq DZero / Power2max / Favero Assioma Duo** : équilibre G/D, généralement pas PCO
- **Power meter mono côté (Stages LH, Favero Assioma Uno)** : pas de pedal dynamics (single-leg, on ne peut pas calculer G/D)
- **Aucun capteur de puissance** : aucune pedal dynamics (logique 🙂)

Si ton matériel ne remonte pas les pedal dynamics, l'upload .fit reste utile pour récupérer : zones HR détaillées, splits par lap, training effects précis, calories, temperature, GPS détaillé, etc. — tout ce que Strava donne moins finement.

## 5. Pourquoi ne pas faire ça automatiquement ?

L'idéal serait que toutes tes activités Garmin remontent automatiquement avec pedal dynamics. Pour ça, il faudrait :
- **Garmin Health API officielle** (Developer Program, 2-6 semaines d'attente d'approbation Garmin)
- OU une app Android/iOS qui lit Garmin Connect Mobile via webhooks

En attendant, l'upload manuel `.fit` te déverrouille toutes ces métriques sur les sorties qui t'intéressent. Tu peux uploader rétroactivement n'importe quelle sortie depuis ton historique Garmin Connect.
