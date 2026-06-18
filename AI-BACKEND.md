# Backend IA — FitPlan

## Ou vit l'IA
FitPlan a son PROPRE endpoint IA (plus aucune dependance a VitiTrace) :
- `api/chat.js` : proxy generique Anthropic, sur le meme domaine que l'app.

Le frontend (`index.html`) appelle l'IA en same-origin via `fetch('/api/chat', ...)`
(8 points d'appel). Avant juin 2026, 7 de ces appels pointaient en dur vers
`https://viti-tracabilit.vercel.app/api/chat` : c'etait un point de defaillance unique
(si VitiTrace tombait, FitPlan perdait l'IA). C'est corrige.

## Modele
Nom du modele lu depuis la variable Vercel `ANTHROPIC_MODEL`, fallback dans le code :

```js
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
```

Valeur actuelle : `ANTHROPIC_MODEL = claude-sonnet-4-5` (Production + Preview).

## En cas de depreciation de modele (procedure 30 s)
1. Vercel > projet `fitplan-family` > Settings > Environment Variables.
2. Editer `ANTHROPIC_MODEL` avec le nouveau nom de modele.
3. Redeploy.
=> Aucune modification de code, aucun commit.

## Cles
- `ANTHROPIC_API_KEY` : cle API Anthropic (deja configuree, NE JAMAIS mettre en dur).

## Gestion d'erreur
`api/chat.js` renvoie un HTTP 502 explicite (avec `detail` + `model`) quand l'API
Anthropic retourne une erreur, au lieu d'un 200 trompeur. Logs : `[chat] Erreur API...`.

## A surveiller
Verification conseillee ~tous les 6 mois.
Prochaine verification conseillee : **decembre 2026**.
