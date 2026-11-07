// Réglages propres à l'entreprise (plan comptable, règles de classement Indy,
// hypothèses du prévisionnel, connecteur Twenty). Rien de tout cela n'est codé en dur :
// les valeurs par défaut ci-dessous sont neutres (plan comptable général, compte
// bancaire 512) et le fichier config/reglages.json les surcharge clé par clé.
//
// Documentation complète des clés : docs/REGLAGES.md. Exemple commenté :
// config/reglages.exemple.json.

import { readFileSync, existsSync } from 'node:fs'
import { reglagesPath } from './paths.js'

export const REGLAGES_PAR_DEFAUT = {
  assistant: {
    // Interrupteur général de l'assistant IA. false = coupé : aucune génération, aucun
    // appel à Anthropic, le SDK n'est pas chargé (équivaut à SYNTRESO_ASSISTANT=non).
    // true = actif seulement si ANTHROPIC_API_KEY est renseignée.
    actif: true,
  },
  indy: {
    // Comptes bancaires lus dans le grand livre. Un numéro est reconnu s'il COMMENCE
    // par l'une des valeurs de `courant` (512 couvre 512000, 512100...) ou s'il figure
    // dans `sousComptes`. Toute la trésorerie est consolidée (courant + sous-comptes).
    comptesBancaires: {
      courant: ['512'],
      // ex. { "compte": "512100", "role": "tva", "libelle": "Réserve TVA" }
      // role : tva | urssaf | perso | autre
      sousComptes: [],
    },
    // Solde d'ouverture : "auto" = ligne « OD d'extourne en début d'exercice » du plus
    // ancien grand livre si elle existe, sinon 0 (grands livres depuis la création).
    // Ou un nombre de centimes posé à la main.
    ouverture: 'auto',
    // Libellés bancaires ignorés (virements internes et écritures techniques d'Indy).
    // Expressions régulières, insensibles à la casse.
    libellesIgnores: [
      '(depot|retrait) sous-compte',
      'virement interne',
      "od d'extourne",
      'od de cloture',
      'transfert de capital',
      'affectation (du )?resultat',
    ],
    // Classement par compte de contrepartie : une ligne bancaire dont la date et le
    // montant correspondent à une écriture au DÉBIT d'un de ces comptes prend la
    // catégorie indiquée, quel que soit son libellé. Préfixes de comptes.
    contreparties: [],
    // Comptes de TVA (préfixes) lus dans la balance pour la dette de TVA réelle.
    comptesTva: {
      collectee: ['44571'],
      deductible: ['44561', '44562', '44563', '44566'],
      credit: ['44567'],
      aDecaisser: ['44551'],
    },
    // Compte courant d'associé (préfixes). Solde créditeur = ce que la société doit au
    // dirigeant. fraisSansFluxBancaire : les crédits de ces comptes SANS ligne bancaire
    // correspondante (frais avancés, indemnités kilométriques) sont comptés en charges.
    compteCourantAssocie: {
      comptes: ['455'],
      fraisSansFluxBancaire: true,
    },
    // Règles de classement par libellé, appliquées dans l'ordre (la première qui
    // correspond gagne). sens : entree | sortie | tous. motif : expression régulière
    // insensible à la casse, testée sur le libellé bancaire sans accents.
    reglesCategories: [
      { motif: 'apport|augmentation de capital|deblocage (de )?pret|deblocage emprunt', sens: 'entree', categorie: 'enc_apport' },
      { motif: 'facture|reglement client|virement de|vente|stripe|sumup|paypal', sens: 'entree', categorie: 'enc_prestations' },
      { motif: '^\\d{6}-\\d+\\b|^fac?[- ]?\\d', sens: 'entree', categorie: 'enc_prestations' },
      { motif: 'remuneration|gerance|salaire gerant', sens: 'sortie', categorie: 'dec_remuneration' },
      { motif: 'remboursement (cca|compte courant|d.associe)', sens: 'sortie', categorie: 'dec_cca_remboursement' },
      { motif: 'salaire|paie\\b|net a payer', sens: 'sortie', categorie: 'dec_salaires' },
      { motif: 'urssaf|securite sociale|\\bssi\\b|retraite|prevoyance obligatoire|pole emploi|france travail', sens: 'sortie', categorie: 'dec_urssaf' },
      { motif: 'dgfip|impots?\\.gouv|\\btva\\b', sens: 'sortie', categorie: 'dec_tva' },
      { motif: '\\bcfe\\b|taxe fonciere|impot', sens: 'sortie', categorie: 'dec_impots' },
      { motif: 'echeance pret|remboursement pret|echeance emprunt|pret (immo|pro)', sens: 'sortie', categorie: 'dec_emprunts' },
      { motif: 'leasing|credit-bail|location longue duree|\\blld\\b|\\bloa\\b', sens: 'sortie', categorie: 'dec_leasing' },
      { motif: 'loyer|bail\\b|charges locatives', sens: 'sortie', categorie: 'dec_loyer' },
      { motif: 'assurance|mutuelle|prevoyance', sens: 'sortie', categorie: 'dec_assurance' },
      { motif: 'expert.?comptable|comptabilite|avocat|notaire|honoraires', sens: 'sortie', categorie: 'dec_honoraires' },
      { motif: 'telecom|telephonie|orange|sfr|bouygues|free mobile|\\bfree\\b|sosh|red by', sens: 'sortie', categorie: 'dec_telecom' },
      { motif: 'publicite|vistaprint|facebook ads|google ads|linkedin', sens: 'sortie', categorie: 'dec_pub' },
      { motif: 'google|microsoft|adobe|notion|slack|zoom|ovh|o2switch|ionos|abonnement|logiciel|saas', sens: 'sortie', categorie: 'dec_abonnements' },
      { motif: 'carburant|total ?energies|esso|shell|\\bbp\\b|avia|\\bstation\\b|peage|autoroute|parking|garage', sens: 'sortie', categorie: 'dec_vehicules' },
      { motif: 'sncf|train|avion|air france|hotel|airbnb|taxi|uber|deplacement|indemnite km', sens: 'sortie', categorie: 'dec_deplacements' },
      { motif: 'restaurant|resto|brasserie|cafe|boulangerie|traiteur', sens: 'sortie', categorie: 'dec_restaurants' },
      { motif: 'amazon|fnac|darty|ikea|bureau vallee|leroy merlin|castorama|materiel|fournitures', sens: 'sortie', categorie: 'dec_materiel' },
      { motif: 'frais bancaires|commission|cotisation carte|services bancaires|agios', sens: 'sortie', categorie: 'dec_banque' },
      { motif: 'sous-traitance|sous traitance', sens: 'sortie', categorie: 'dec_soustraitance' },
    ],
    categorieParDefaut: { entree: 'enc_divers', sortie: 'dec_divers' },
  },
  previsionnel: {
    // Fenêtre (mois clos) de la médiane des charges et encaissements récurrents.
    fenetreMedianeMois: 6,
    encaissements: {
      // "mediane" : médiane des encaissements récents (comme les charges) ;
      // "paliers" : montants HT posés à la main (paliersHT) convertis en TTC ;
      // "aucun"   : pas d'encaissement prévu par l'import (Twenty ou saisie à la main).
      mode: 'mediane',
      tauxTvaPct: 20,
      categorie: 'enc_prestations',
      // ex. { "depuis": "2027-01", "montantHTCents": 800000, "croissanceMensuellePct": 0 }
      paliersHT: [],
    },
    remunerationGerant: {
      categorie: 'dec_remuneration',
      // Vide = médiane du réalisé, comme une charge ordinaire.
      // ex. { "depuis": "2027-01", "montantCents": 300000 } (brut mensuel versé)
      paliers: [],
    },
  },
  twenty: {
    // Catégorie d'encaissement alimentée par le pipe commercial.
    categorieEncaissement: 'enc_prestations',
    // Twenty stocke des montants HT ; la trésorerie raisonne en TTC (ce qui arrive en
    // banque). true = on applique le taux de TVA de la catégorie ci-dessus.
    montantsHT: true,
    // Probabilité d'encaissement par étape du pipe (clé = valeur `stage` dans Twenty).
    // Une étape absente vaut 0.
    ponderations: {
      NEW: 0.05,
      SCREENING: 0.1,
      MEETING: 0.4,
      PROPOSAL: 0.25,
      NEGOCIATION: 0.5,
      WON: 0.8,
      CUSTOMER: 0,
      LOST: 0,
    },
    // Écart minimal (centimes) entre le pipe pondéré et le prévisionnel pour proposer
    // un ajustement.
    ecartMinimalCents: 50_000,
  },
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Fusion profonde : les objets se fusionnent clé par clé, les tableaux et scalaires remplacent. */
export function fusionner(base, surcharge) {
  if (!isPlainObject(base) || !isPlainObject(surcharge)) return surcharge === undefined ? base : surcharge
  const out = { ...base }
  for (const [k, v] of Object.entries(surcharge)) {
    if (k.startsWith('_')) continue // clés de commentaire (_doc, _note...)
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? fusionner(base[k], v) : v
  }
  return out
}

/**
 * Réglages effectifs = défauts neutres + config/reglages.json (s'il existe). Relu à
 * chaque appel (fichier court) : une modification s'applique sans redémarrer.
 * Un fichier illisible lève une erreur explicite plutôt que de retomber en silence
 * sur les défauts.
 */
export function lireReglages(fichier = reglagesPath()) {
  if (!existsSync(fichier)) return structuredClone(REGLAGES_PAR_DEFAUT)
  let brut
  try {
    brut = JSON.parse(readFileSync(fichier, 'utf8'))
  } catch (err) {
    throw new Error(`Réglages illisibles (${fichier}) : ${err.message}`)
  }
  return fusionner(structuredClone(REGLAGES_PAR_DEFAUT), brut)
}
