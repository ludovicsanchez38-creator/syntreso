# Guide de l'API Syntréso pour un agent IA

Ce guide s'adresse à l'agent IA du dirigeant (par exemple un agent Claude) qui pilote Syntréso pour lui : lire la situation de trésorerie, simuler une décision, importer la compta Indy, synchroniser le CRM Twenty et **proposer** des écritures. La référence complète des routes et des réponses est `docs/openapi.yaml` (OpenAPI 3.1).

## Le principe à respecter : l'agent propose, l'humain valide, le serveur écrit

- **Lire et simuler, librement** : toutes les routes `GET`, les simulations (`/api/projection/impact`, `/api/projection/remuneration-check`, `/api/projection/cca-check`, `/api/projection/dividendes-vs-remuneration`) et les modes « essai » (`simulation`, `dry`) ne modifient rien.
- **Proposer** une écriture au prévisionnel : `POST /api/proposals`. La proposition reste **en attente** ; elle apparaît dans l'interface (panneau assistant, pastille sur le bouton) et c'est le dirigeant qui tranche.
- **Ne pas trancher à la place du dirigeant** : `POST /api/proposals/{id}/confirm` et `/reject` sont la décision humaine. Un agent ne les appelle que sur une instruction explicite du dirigeant portant sur cette proposition précise (« oui, valide la proposition du devis cuisine »).
- **Écriture directe** (`PATCH /api/forecast`) : réservée à une demande explicite du dirigeant (« mets 700 EUR de loyer en novembre »). Dans le doute, proposer.
- **Ne jamais calculer soi-même** un solde, une TVA ou un verdict : le serveur calcule (un seul moteur), l'agent reformule et explique.

## Connexion

Deux informations, données par le dirigeant :

```bash
export SYNTRESO_URL="http://127.0.0.1:3900"     # ou l'adresse HTTPS du serveur
export SYNTRESO_JETON="..."                      # ligne SYNTRESO_JETON du fichier .env
```

Chaque appel porte l'en-tête `Authorization: Bearer $SYNTRESO_JETON`. Sans jeton valide : `401`. Seule `/api/health` répond sans jeton.

## Les pièges à éviter

1. **Centimes partout** : tous les montants sont des entiers en centimes d'euro. 12 000 EUR s'écrit `1200000`. Une erreur d'un facteur 100 est la faute la plus probable : relire chaque montant envoyé.
2. **Signe** : positif = argent qui entre, négatif = argent qui sort. Une sortie proposée avec un montant positif est refusée.
3. **TTC ou HT** : la trésorerie (soldes, prévisionnel, propositions) est en **TTC**, comme la banque. Le compte de résultat et le point mort sont en **HT**. Un devis de 10 000 EUR HT à 20 % de TVA s'encaisse 12 000 EUR : proposer `1200000`.
4. **Date du jour** : utiliser `company.today` renvoyé par `GET /api/state`, jamais l'horloge de l'agent. En démonstration, la date est figée (`company.demoToday`).
5. **Mois** : format `AAAA-MM`. Une écriture prévisionnelle porte sur le mois où l'argent bouge (date du devis + délai de paiement), du mois courant jusqu'à 18 mois devant. Les mois passés sont refusés.
6. **Disponible net, pas solde brut** : pour « combien puis-je dépenser », lire `kpis.netAvailableCents` (le solde brut contient la TVA collectée et les cotisations dues, qui ne sont pas à l'entreprise).
7. **Fraîcheur** : `dataFreshness.indy.daysOld` donne l'âge des données comptables. Au-delà de 10 jours, signaler au dirigeant qu'un import Indy serait utile avant toute décision.
8. **Propositions additives** : une écriture prévisionnelle (`forecast_line`) **s'ajoute** au prévu du mois ; elle ne le remplace pas. Pour remplacer un montant récurrent, utiliser `forecast_recalage`.
9. **Catégories** : utiliser uniquement les identifiants de `categories` dans `GET /api/state` (ex. `enc_prestations`, `dec_loyer`).

## Les appels les plus utiles

Les exemples utilisent `jq` pour extraire l'essentiel ; il est facultatif.

### 1. La situation du jour

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" "$SYNTRESO_URL/api/state" \
  | jq '{jour: .company.today, brut: .kpis.balanceTodayCents, net: .kpis.netAvailableCents,
         tva: .kpis.vatDueCents, cotisations: .kpis.socialProvisionCents,
         point_bas: .kpis.lowPoint, autonomie_mois: .kpis.runwayMonths,
         alertes: [.alerts[].title], fraicheur: .dataFreshness, reconciliation: .reconciliation.status}'
```

C'est le premier appel de toute session. `alerts` liste les points d'attention (point bas sous le seuil, facture en retard, charge anormale, écart de réconciliation).

### 2. La trajectoire des prochains mois

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" "$SYNTRESO_URL/api/projection?range=6M" \
  | jq '[.monthly[] | select(.projected) | {mois: .month, entrees: .inCents, sorties: .outCents, fin_de_mois: .closingCents}]'
```

### 3. Les sorties certaines à venir

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" "$SYNTRESO_URL/api/echeances?jours=60" \
  | jq '.items[] | {date: .dueDate, libelle: .label, montant: .amountCents}'
```

### 4. « Et si... » : simuler avant de proposer

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/projection/impact" \
  -d '{"mois":"2026-12","categoryId":"enc_prestations","montantCents":1200000}'
```

Réponse : point bas avant et après, passage sous le seuil (`crossesThreshold`), autonomie avant et après. Rien n'est enregistré.

### 5. « Puis-je me verser 2 000 EUR ? »

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/projection/remuneration-check" \
  -d '{"montantCents":200000,"mois":"2026-11"}' | jq '{verdict, totalCostCents, netAfterCents, lowPointNextCents, criteria}'
```

`verdict` vaut `vert`, `ambre` ou `rouge` (calculé par le serveur, à reprendre tel quel). Pour un remboursement de compte courant d'associé (sans cotisations), utiliser `/api/projection/cca-check` avec le même corps.

### 6. Proposer une écriture au prévisionnel

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/proposals" \
  -d '{"kind":"forecast_line","month":"2026-12","categoryId":"enc_prestations","amountCents":1200000,"label":"Devis signé, paiement à 30 jours"}'
```

Réponse `201` avec la proposition `pending`. En cas de refus (`400`), le motif est dans `error` (mois passé, catégorie inconnue, signe incohérent...). Ensuite, dire au dirigeant qu'une proposition l'attend dans Syntréso, avec son impact (appel 4).

Pour corriger durablement une charge récurrente (par exemple un abonnement passé de 30 à 45 EUR) :

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/proposals" \
  -d '{"kind":"forecast_recalage","categoryId":"dec_abonnements","monthlyCents":-4500,"fromMonth":"2026-11","toMonth":"2027-12","label":"Abonnement logiciel à 45 EUR par mois"}'
```

### 7. Suivre les propositions

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" "$SYNTRESO_URL/api/proposals" \
  | jq '[.[] | select(.status=="pending") | {id, kind, source, payload}]'
```

Sur instruction explicite du dirigeant uniquement :

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/proposals/ID_DE_LA_PROPOSITION/confirm" -d '{}'
# ou, pour ajuster le montant au passage : -d '{"amendments":{"amountCents":1000000}}'
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -X POST "$SYNTRESO_URL/api/proposals/ID_DE_LA_PROPOSITION/reject"
```

### 8. Mettre à jour la compta depuis Indy

Le dirigeant (ou l'agent, s'il a accès aux fichiers) télécharge dans Indy le **grand livre** de chaque exercice et la **balance** (Documents, Comptabilité, bouton de téléchargement, format « Excel », qui donne un CSV). Puis :

```bash
# déposer les fichiers (inutile s'ils sont déjà copiés dans le dossier entree-indy)
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: text/csv" \
  -T grand-livre-2026.csv "$SYNTRESO_URL/api/import/indy/fichiers/grand-livre-2026.csv"
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: text/csv" \
  -T balance-2026.csv "$SYNTRESO_URL/api/import/indy/fichiers/balance-2026.csv"

# vérifier ce qui sera pris, puis simuler, puis importer
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" "$SYNTRESO_URL/api/import/indy"
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/import/indy" -d '{"simulation":true}' | jq '{transactions, periode, reconciliation, classeesParDefaut}'
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -H "Content-Type: application/json" \
  -X POST "$SYNTRESO_URL/api/import/indy" -d '{}' | jq '{transactions, dateDesDonnees, reconciliation}'
```

Contrôles après import : `reconciliation.statut` doit valoir `ok` (le solde reconstruit colle au solde bancaire de la balance) ; si `ecart`, prévenir le dirigeant (grand livre manquant, solde d'ouverture, virements internes non reconnus : voir `docs/REGLAGES.md`). Si `classeesParDefaut` est élevé, proposer au dirigeant d'ajouter des règles de classement dans `config/reglages.json`. L'import conserve les saisies et propositions validées du prévisionnel.

### 9. Synchroniser le pipe commercial Twenty

```bash
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -X POST "$SYNTRESO_URL/api/integrations/twenty/sync?dry=1" \
  | jq '{oppCount, weightedTotalCents, deltas, decreases}'
curl -s -H "Authorization: Bearer $SYNTRESO_JETON" -X POST "$SYNTRESO_URL/api/integrations/twenty/sync" \
  | jq '{proposalsCreated, proposalsSkipped}'
```

La synchronisation crée des **propositions** (hausses du pipe pondéré par rapport au prévisionnel), jamais d'écriture directe. Elle peut être relancée sans créer de doublons. Les baisses sont seulement listées dans `decreases` : à signaler au dirigeant.

### 10. Autres lectures utiles

| Besoin | Appel |
|---|---|
| Mouvements bancaires d'un mois | `GET /api/transactions?month=2026-09` (ou `&categoryId=dec_loyer`, `&limit=20`) |
| Résultat de l'exercice (HT) | `GET /api/compte-resultat?year=2026` |
| Grille complète du prévisionnel | `GET /api/forecast` |
| Prévu ou réalisé du mois dernier | `GET /api/qualite-previsions` (ou `?format=text`) |
| Charges à recaler sur le réalisé | `POST /api/integrations/recalage-charges?dry=1` (sans `dry` : crée des propositions) |
| Qui a modifié quoi | `GET /api/audit?limit=50` |
| Dossier pour le banquier | `GET /api/export/dossier` (page HTML à imprimer) |

## Codes de réponse

| Code | Sens |
|---|---|
| 200, 201 | Succès |
| 400 | Requête invalide (montant non entier, mois passé, catégorie inconnue) : lire `error` |
| 401 | Jeton absent ou faux |
| 404 | Proposition, scénario ou route inconnus |
| 409 | Proposition déjà validée ou rejetée |
| 422 | Import impossible (fichiers manquants ou illisibles), catégorie Twenty absente |
| 429 | Assistant intégré déjà occupé |
| 502 | Twenty injoignable ou clé refusée |
| 503 | Base non initialisée, connecteur Twenty non configuré, ou assistant intégré désactivé |

## Assistant intégré et agent externe

Syntréso embarque son propre assistant (bouton en bas à droite de l'interface, routes `/api/agent/*`), optionnel et désactivé sans clé Anthropic. Un agent externe n'en a pas besoin : il appelle directement les routes ci-dessus, qui donnent les mêmes chiffres. `GET /api/agent/status` indique si l'assistant intégré est actif.
