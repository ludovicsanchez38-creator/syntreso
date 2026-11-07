# Réglages de Syntréso

Syntréso se règle à deux endroits, chacun avec son rôle :

| Fichier | Contient | Qui le modifie |
|---|---|---|
| `config/reglages.json` | L'interrupteur de l'assistant IA, la façon de lire la compta Indy (comptes, règles de classement), les hypothèses du prévisionnel de base, le connecteur Twenty | Vous ou votre agent, à l'installation puis de temps en temps |
| `donnees/company.json` | L'identité de l'entreprise, le seuil de sécurité, les réglages fiscaux (TVA, cotisations, IS) | Créé par `npm run init`, complété par l'import Indy, ajustable à la main |

`config/reglages.json` est relu à chaque import, à chaque synchronisation Twenty et à chaque demande faite à l'assistant : pas besoin de redémarrer. Après une modification de `company.json`, redémarrez le serveur ou lancez un import.

Une clé absente de `config/reglages.json` reprend sa valeur par défaut (celles de `config/reglages.exemple.json`). Attention : une liste (par exemple `reglesCategories`) remplace entièrement la liste par défaut, elle ne s'y ajoute pas. Les clés qui commencent par `_` sont des commentaires.

Tous les montants sont en **centimes d'euro** (5 000 EUR = `500000`). Les mois s'écrivent `AAAA-MM`, les dates `AAAA-MM-JJ`.

---

## 1. Lecture des exports Indy (`indy`)

### Comptes bancaires (`indy.comptesBancaires`)

```json
"comptesBancaires": {
  "courant": ["512"],
  "sousComptes": []
}
```

- `courant` : le ou les comptes bancaires principaux. La comparaison se fait sur le **début** du numéro : `"512"` couvre `512000`, `512100`, etc. C'est le réglage standard du plan comptable, il convient à la plupart des entreprises.
- `sousComptes` : les réserves bancaires que vous alimentez à part (compte « TVA », « cotisations », « personnel »). Chacune est **consolidée** dans la trésorerie (l'argent reste à l'entreprise) mais Syntréso sait ce qui est déjà mis de côté :

```json
"sousComptes": [
  { "compte": "512100", "role": "tva", "libelle": "Réserve TVA" },
  { "compte": "512200", "role": "urssaf", "libelle": "Réserve cotisations" },
  { "compte": "512300", "role": "perso", "libelle": "Réserve du dirigeant" }
]
```

`role` vaut `tva`, `urssaf`, `perso` ou `autre`. Les réserves `tva` et `urssaf` couvrent les dettes (TVA à reverser, cotisations) ; la réserve `perso` est retirée du « disponible net ». Le numéro exact d'un sous-compte se lit dans la balance Indy.

Les virements entre le compte courant et un sous-compte sont des mouvements internes : ils sont ignorés grâce à `libellesIgnores` (ci-dessous). Si vos virements internes portent un autre libellé, ajoutez-le.

### Solde d'ouverture (`indy.ouverture`)

- `"auto"` (défaut) : si le plus ancien grand livre fourni contient la ligne « OD d'extourne en début d'exercice » sur un compte bancaire, elle donne le solde d'ouverture ; sinon le solde d'ouverture vaut 0 (cas où vous fournissez les grands livres depuis la création de l'entreprise).
- `"zero"` : toujours 0.
- un nombre : solde d'ouverture en centimes, posé à la main.

Le mieux est de fournir les grands livres de **toutes les années depuis la création** : le contrôle de réconciliation (solde reconstruit comparé au solde de la balance) est alors exact au centime.

### Libellés ignorés (`indy.libellesIgnores`)

Expressions régulières (insensibles à la casse, testées sur le libellé en minuscules sans accents). Une ligne bancaire dont le libellé correspond est ignorée. Par défaut : dépôts et retraits de sous-compte, virements internes, écritures techniques d'Indy (extourne, clôture, transfert de capital, affectation du résultat).

### Règles de classement (`indy.reglesCategories`)

Chaque mouvement bancaire reçoit une **catégorie** (celles de `donnees/categories.json`). Les règles sont testées **dans l'ordre**, la première qui correspond gagne :

```json
{ "motif": "loyer|bail\\b", "sens": "sortie", "categorie": "dec_loyer" }
```

- `motif` : expression régulière testée sur le libellé bancaire en minuscules **sans accents** (écrire `remuneration`, pas `rémunération`). Dans un fichier JSON, une barre oblique inverse s'écrit double : `\\b`, `\\d`.
- `sens` : `entree`, `sortie` ou `tous`.
- `categorie` : identifiant existant dans `donnees/categories.json`. Une catégorie inconnue bloque l'import avec un message clair (rien n'est écrit).

Sans règle correspondante, le mouvement va dans `categorieParDefaut` (`enc_divers` pour une entrée, `dec_divers` pour une sortie). Le rapport d'import indique combien de mouvements sont tombés dans ces catégories par défaut : s'il y en a beaucoup, ajoutez des règles et relancez l'import (`npm run import -- --simulation` pour vérifier sans rien écrire).

Exemples utiles :

```json
{ "motif": "dupont materiaux|negoce durance", "sens": "sortie", "categorie": "dec_achats" },
{ "motif": "virement de client alpha", "sens": "entree", "categorie": "enc_prestations" }
```

### Classement par compte de contrepartie (`indy.contreparties`)

Plus fiable que le libellé quand votre comptable impute directement un paiement sur un compte de charge : une ligne bancaire dont la **date et le montant** correspondent à un débit d'un de ces comptes prend la catégorie indiquée, quel que soit son libellé.

```json
"contreparties": [
  { "compte": "644", "categorie": "dec_remuneration" },
  { "compte": "6411", "categorie": "dec_salaires" }
]
```

Typiquement : la rémunération du gérant passée en 644 (ou 6411) apparaît en banque sous un libellé du genre « Virement vers M. X ». Ne s'applique qu'aux sorties.

### TVA (`indy.comptesTva`)

Comptes lus dans la balance pour calculer la **dette de TVA réelle** à date : collectée (`44571`) moins déductible (`44561`, `44562`, `44563`, `44566`) moins crédit reportable (`44567`) plus TVA déjà déclarée à payer (`44551`). Préfixes, à adapter si votre plan comptable diffère. Si aucun de ces comptes n'existe (franchise de TVA), rien n'est posé.

### Compte courant d'associé (`indy.compteCourantAssocie`)

- `comptes` : préfixes des comptes courants (`455` par défaut). Solde créditeur = ce que la société doit au dirigeant ; il sert au feu vert « puis-je me rembourser X du compte courant ? ».
- `fraisSansFluxBancaire` : `true` compte en charges les crédits de ces comptes qui n'ont pas de mouvement bancaire en face (frais avancés, indemnités kilométriques). Un apport en espèces (ligne bancaire le même jour, même montant) et une rémunération passée au compte courant (débit 64x en face) ne sont pas comptés.

---

## 2. Prévisionnel de base (`previsionnel`)

À chaque import, Syntréso pose un prévisionnel « de base » du premier mois non clos jusqu'à 18 mois devant : pour chaque catégorie, la **médiane** des montants des 6 derniers mois clos, pondérée par la fréquence (une charge payée 2 mois sur 6 compte pour un tiers). La TVA, la provision de cotisations pilotée et l'IS sont calculés par le moteur, les apports et investissements ne sont pas projetés.

Les lignes **saisies à la main** ou **validées** dans l'interface sont conservées d'un import à l'autre ; seules les lignes posées par l'import précédent sont remplacées. `npm run import -- --reinitialiser-previsionnel` repart d'un prévisionnel neuf.

- `fenetreMedianeMois` : nombre de mois clos de la médiane (6).
- `encaissements.mode` :
  - `"mediane"` (défaut) : même méthode que les charges ;
  - `"paliers"` : chiffre d'affaires mensuel HT fixé à la main, converti en TTC avec `tauxTvaPct`, sur la catégorie `categorie` :
    ```json
    "encaissements": {
      "mode": "paliers", "tauxTvaPct": 20, "categorie": "enc_prestations",
      "paliersHT": [
        { "depuis": "2026-11", "montantHTCents": 800000 },
        { "depuis": "2027-06", "montantHTCents": 1000000, "croissanceMensuellePct": 2 }
      ]
    }
    ```
  - `"aucun"` : pas d'encaissement prévu par l'import (vous le saisissez, ou Twenty le propose).
- `remunerationGerant.paliers` : rémunération brute mensuelle versée, par paliers (`[{ "depuis": "2027-01", "montantCents": 250000 }]`). Vide = médiane du réalisé.

---

## 3. Connecteur Twenty (`twenty`)

L'adresse et la clé vont dans `.env` (`TWENTY_URL`, `TWENTY_KEY`). Dans `config/reglages.json` :

- `categorieEncaissement` : catégorie alimentée par le pipe (`enc_prestations`). Elle doit exister.
- `montantsHT` : `true` si les montants Twenty sont HT (cas habituel) : la TVA de la catégorie est ajoutée pour raisonner en trésorerie (TTC).
- `ponderations` : probabilité d'encaissement par étape (valeur `stage` de vos opportunités Twenty). Une étape absente vaut 0. Par défaut : NEW 0,05 ; SCREENING 0,1 ; PROPOSAL 0,25 ; MEETING 0,4 ; NEGOCIATION 0,5 ; WON 0,8 ; CUSTOMER 0 ; LOST 0. Adaptez-les à vos étapes : si vous passez une affaire en CUSTOMER dès la signature (avant d'être payé), donnez-lui une pondération proche de 1.
- `ecartMinimalCents` : écart minimal par mois pour proposer un ajustement (500 EUR).

Une opportunité avec une date de clôture est rattachée à son mois ; sans date, elle est lissée sur les mois à venir. La synchronisation **ne modifie jamais** le prévisionnel : elle crée des propositions à valider.

---

## 4. Assistant IA (`assistant`)

- `actif` : `true` par défaut. `false` coupe entièrement l'assistant : aucune génération, aucun appel à Anthropic, le module de l'Agent SDK n'est même pas chargé. Même effet que `SYNTRESO_ASSISTANT=non` dans `.env` ; il suffit que l'un des deux soit coupé.

Allumé, l'assistant ne fonctionne qu'avec une clé d'API Anthropic (`ANTHROPIC_API_KEY` dans `.env`) : sans clé, il reste coupé. Rechargez la page après un changement pour que l'interface le prenne en compte.

---

## 5. Réglages de l'entreprise (`donnees/company.json`)

Créé par `npm run init`. Champs principaux :

| Champ | Rôle |
|---|---|
| `name`, `sector`, `location`, `employees` | Identité (affichée, et lue par l'assistant) |
| `lowCashThresholdCents` | Seuil de sécurité : alerte si le disponible net ou le point bas passe dessous |
| `capitalSocialCents` | Capital social (règle des 10 % pour les dividendes d'un gérant TNS) |
| `businessAssumptions` | Liste de phrases d'hypothèses métier (délais de paiement, saisonnalité...) reprises par l'assistant et le dossier banquier |
| `seasonality` | `{ "enabled": true, "monthly": [12 coefficients] }` module les encaissements prévus (1 = neutre, 0,5 en août = moitié moins) |
| `fraisCCA.prevuParMoisCents` | Frais avancés ou indemnités kilométriques prévus par mois (`{ "2026-11": 30000 }`) |

### Fiscalité (`company.fiscal`)

| Champ | Rôle |
|---|---|
| `amountsAreTTC` | `true` : les montants de trésorerie sont TTC (cas de l'import bancaire). Laisser `true` |
| `tva.autoCompute` | `true` : la TVA à reverser est calculée à partir des flux (taux `vatRatePct` de chaque catégorie) |
| `tva.payDayOfMonth` | Jour de paiement de la TVA mensuelle (22) |
| `tva.regime`, `tva.dueDate` | `"annuel"` + date d'échéance de la CA12 (`"2027-05-05"`) pour le régime annuel |
| `tva.annuelJusquau` | Dernier mois couvert par le régime annuel (en cas de changement de régime) |
| `tva.vatCreditCarryCents` | Crédit de TVA reporté à imputer sur les prochains paiements |
| `tns.autoCompute` | `true` : provision de cotisations = rémunération du gérant x taux (gérant non salarié) |
| `tns.cotisationTauxPct`, `tns.cotisationTauxApresAcrePct`, `tns.acre` | Taux de cotisations (en points), avec ACRE (`{ "actif": true, "finMois": "2027-03" }`) |
| `tns.remunerationMensuelleBruteCents`, `tns.remunerationEnCcaDepuis`, `tns.remunerationEnCcaJusquau` | Rémunération attribuée mais laissée au compte courant d'associé sur une période |
| `tns.echeancesUrssaf` | Appels réels de l'URSSAF : `[{ "dueDate": "2027-02-05", "amountCents": 80000, "label": "T1 2027" }]` |
| `tns.dividendesTauxPct` | Taux de cotisations sur la part de dividendes au-delà de 10 % du capital |
| `is.seuilReduitCents`, `is.tauxReduitPct`, `is.tauxNormalPct` | Barème de l'IS (15 % jusqu'à 42 500 EUR, puis 25 %, à vérifier chaque année) |
| `is.autoDecaissement`, `is.payMonth` | `true` : le solde d'IS estimé est décaissé en N+1 au mois `payMonth` (`"05"`) |
| `is.deficitsReportablesCents` | Déficits reportables par exercice : `{ "2027": 150000 }` |
| `cfe` | `{ "amountCents": 60000, "dueMonth": 12, "dueDay": 15 }` pour dater la CFE |
| `flatTaxPct` | Prélèvement forfaitaire unique sur les dividendes (31,4 en 2026, à vérifier) |
| `vatDueActualCents` | Posé par l'import Indy (dette de TVA réelle). Ne pas modifier à la main |

Les taux fiscaux par défaut sont indicatifs : faites-les valider par votre expert-comptable.

### Catégories (`donnees/categories.json`)

Chaque catégorie a un `id` (`enc_...` pour une entrée, `dec_...` pour une sortie), un `label`, une `direction` (`in` ou `out`), un ordre d'affichage, `vatRatePct` (taux de TVA du flux, 0 si hors TVA), `fixed` (charge fixe, pour le point mort) et éventuellement `excludeFromResultat` (apports, emprunts reçus, investissements : de la trésorerie, pas du résultat) ou `amortissementMois` (durée d'amortissement d'un investissement). Vous pouvez en ajouter ; pensez à mettre à jour les règles de classement.

### Échéances datées (`donnees/echeances.json`)

Sorties certaines à dater au jour près dans l'échéancier (prêt, loyer, assurance annuelle) :

```json
[{ "id": "ech_pret_2026-11", "label": "Échéance prêt véhicule", "categoryId": "dec_emprunts",
   "dueDate": "2026-11-10", "amountCents": -45000, "kind": "emprunt", "recurrence": "monthly" }]
```

`kind` : `tva`, `urssaf`, `is`, `loyer`, `assurance`, `emprunt` ou `autre`. Cet échéancier sert à l'affichage ; le prévisionnel mensuel, lui, reste dans la grille.
