// Aides à la décision « feu vert / feu rouge » du moteur Syntréso. Le verdict est
// TOUJOURS calculé ici (jamais par le modèle de langage) : l'agent IA n'a qu'à
// FORMULER la phrase à partir des chiffres renvoyés. Aucune écriture : on applique un
// overlay ÉPHÉMÈRE via le même mécanisme que les scénarios (scenarioDeltas-like) et on
// recalcule la projection, sans toucher aux données.

import { project, monthOf, actualsByMonth, forecastByMonth } from './projection.js'
import { endOfMonth, todayFor } from './dates.js'
import { tnsRatePctForMonth, remunerationVsDividendes, resultatPrevisionnel, ccaStatus } from './fiscal.js'

// Seuils de runway du verdict (en mois de réserve sur le NET après l'opération).
// > 6 mois -> confortable ; 2 à 6 -> prudence ; < 2 -> rouge. Calibré solo.
const RUNWAY_GREEN_MONTHS = 6
const RUNWAY_AMBER_MONTHS = 2

/**
 * Construit l'overlay de deltas d'un prélèvement gérant ponctuel le mois `month` :
 * - sortie de `amountCents` (valeur absolue) sur la catégorie de rémunération,
 * - cotisations URSSAF/TNS couplées (taux effectif du mois) si le TNS est piloté,
 *   exactement comme le scénario sc_rem_up, pour ne pas mentir sur le coût réel.
 *
 * Retourne { deltas, couplingCents, ratePct, remCategoryId, provisionCategoryId }.
 * Les montants restent des centimes entiers (garde-fou intCents).
 */
function remunerationOverlay(state, { month, amountCents }) {
  const tns = state.company.fiscal?.tns
  const remId = tns?.remunerationCategoryId || 'dec_remuneration'
  const provId = tns?.provisionCategoryId
  const couples = !!(tns?.autoCompute && provId)
  const ratePct = couples ? tnsRatePctForMonth(month, tns) : 0
  const couplingCents = couples ? Math.round((amountCents * ratePct) / 100) : 0
  if (!Number.isInteger(amountCents) || !Number.isInteger(couplingCents)) {
    throw new Error(`Overlay rémunération non entier (${month})`)
  }
  const deltas = { [month]: { [remId]: -amountCents } }
  if (couplingCents) deltas[month][provId] = (deltas[month][provId] || 0) - couplingCents
  return { deltas, couplingCents, ratePct, remCategoryId: remId, provisionCategoryId: provId }
}

/**
 * Plus bas solde projeté disponible sur une fenêtre de N jours à partir d'aujourd'hui.
 *
 * Convention de calcul (évite le double comptage de la trésorerie engagée) :
 *  - le NET « aujourd'hui » = brut du jour J moins le committed (TVA/URSSAF dues) ;
 *  - le solde brut PROJETÉ d'une date future intègre DÉJÀ toutes les sorties dérivées
 *    posées par le moteur d'ici là (TVA, provisions). On ne re-retranche donc PAS le
 *    committed sur les points futurs : le brut projeté est déjà « net » des échéances
 *    franchies. On prend le minimum entre le NET d'aujourd'hui et le plus bas brut
 *    projeté de la fenêtre. C'est le « combien j'ai vraiment au plus bas ».
 */
function lowestNetWithin(projection, todayDate, horizonDays, minUntilDate = null) {
  // La fenêtre couvre au moins `horizonDays`, mais s'étend jusqu'à `minUntilDate` (fin
  // du mois ciblé) pour qu'un versement programmé plus loin que 60 j soit toujours
  // capté par le point bas (sinon le verdict raterait l'impact).
  const dayLimit = addDaysISO(todayDate, horizonDays)
  const limit = minUntilDate && minUntilDate > dayLimit ? minUntilDate : dayLimit
  let low = projection.netAvailableCents // borne « aujourd'hui » (brut - committed)
  let lowDate = todayDate
  for (const p of projection.series) {
    if (p.projectedCents === null) continue
    if (p.date <= todayDate || p.date > limit) continue
    if (p.projectedCents < low) {
      low = p.projectedCents
      lowDate = p.date
    }
  }
  return { cents: low, date: lowDate, committedCents: projection.balanceTodayCents - projection.netAvailableCents }
}

// addDays local (sans importer depuis dates.js pour rester autonome côté décision).
function addDaysISO(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * Feu vert « puis-je me verser X ce mois-ci ? ».
 * Applique l'overlay éphémère, recalcule la projection, et renvoie un verdict + tous
 * les chiffres qui le justifient (pour que l'agent FORMULE, ne calcule pas).
 *
 * @param state état complet (loadState)
 * @param amountCents montant du versement souhaité (centimes entiers, > 0)
 * @param month mois d'impact 'YYYY-MM' (défaut : mois courant)
 * @param horizonDays fenêtre du point bas court terme (défaut 60 j)
 */
export function remunerationCheck(state, { amountCents, month = null, horizonDays = 60 } = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('montantCents doit être un entier positif')
  }
  const today = todayFor(state.company)
  const targetMonth = month || monthOf(today)
  const threshold = state.company.lowCashThresholdCents

  // Avant : projection de référence (avec la fiscalité dérivée déjà appliquée).
  const before = project(state)
  // Après : overlay prélèvement gérant + cotisations couplées.
  const overlay = remunerationOverlay(state, { month: targetMonth, amountCents })
  const after = project(state, { deltas: overlay.deltas })

  const totalCostCents = amountCents + overlay.couplingCents
  // NB : netAfter et runwayAfter sont quasi invariants à un versement FUTUR (le solde
  // NET « aujourd'hui » et le burn historique ne dépendent pas d'un flux à venir).
  // L'impact réel d'un versement se lit sur le POINT BAS projeté de la fenêtre
  // (lowNext) : c'est le critère décisif du verdict. netAfter/runwayAfter renseignent
  // sur la santé structurelle, lowNext sur l'opération ponctuelle.
  const netAfterCents = after.netAvailableCents
  const lowNext = lowestNetWithin(after, today, horizonDays, endOfMonth(targetMonth))
  const runwayAfter = after.runwayMonths // null si pas de descente

  // Verdict moteur (jamais le LLM), du plus grave au plus sûr :
  //  1. ROUGE  si une borne passe sous ZÉRO (découvert) OU sous le seuil de sécurité
  //            (la réserve de sécurité est entamée : on déconseille fermement).
  //  2. VERT   si le NET après reste >= seuil, le point bas de la fenêtre reste >= seuil
  //            ET le runway est confortable (>= RUNWAY_GREEN_MONTHS, ou null = pas de
  //            descente détectée).
  //  3. AMBRE  entre les deux (au-dessus du seuil mais runway juste, prudence).
  const netOk = netAfterCents >= threshold
  const lowOk = lowNext.cents >= threshold
  const runwayOk = runwayAfter === null || runwayAfter >= RUNWAY_GREEN_MONTHS
  const runwayCritical = runwayAfter !== null && runwayAfter < RUNWAY_AMBER_MONTHS

  let verdict
  if (lowNext.cents < 0 || netAfterCents < 0 || !lowOk || !netOk) {
    verdict = 'rouge'
  } else if (netOk && lowOk && runwayOk && !runwayCritical) {
    verdict = 'vert'
  } else {
    verdict = 'ambre'
  }

  return {
    verdict, // 'vert' | 'ambre' | 'rouge'
    requestedCents: amountCents,
    month: targetMonth,
    horizonDays,
    // coût réel de l'opération (versement + cotisations couplées)
    couplingCents: overlay.couplingCents,
    couplingRatePct: overlay.ratePct,
    totalCostCents,
    // soldes NET avant / après pour la transparence
    netBeforeCents: before.netAvailableCents,
    netAfterCents,
    thresholdCents: threshold,
    // point bas NET court terme après l'opération
    lowPointNextCents: lowNext.cents,
    lowPointNextDate: lowNext.date,
    // runway avant / après (mois de réserve sur le NET)
    runwayBeforeMonths: before.runwayMonths,
    runwayAfterMonths: runwayAfter,
    // critères du verdict, exposés pour que l'agent explique
    criteria: { netOk, lowOk, runwayOk },
  }
}

/**
 * Feu vert « puis-je me REMBOURSER X du compte courant d'associé ? ».
 * Le levier le plus efficace fiscalement d'un gérant : un remboursement de CCA est
 * une sortie de trésorerie SANS cotisations ni impôt (remboursement d'une dette de la
 * société). Mêmes critères de trésorerie que remunerationCheck (seuil, point bas,
 * runway) MAIS sans couplage URSSAF, ET plafonné par le CCA réellement accumulé
 * (on ne « rembourse » pas une dette qui n'existe pas encore).
 */
export function ccaRepaymentCheck(state, { amountCents, month = null, horizonDays = 60 } = {}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('amountCents doit être un entier positif')
  }
  const cca = ccaStatus(state)
  if (!cca) {
    return { verdict: 'indisponible', reason: 'fenêtre CCA non paramétrée (remunerationEnCcaDepuis/Jusquau)' }
  }
  const today = todayFor(state.company)
  const targetMonth = month || monthOf(today)
  const threshold = state.company.lowCashThresholdCents

  // Plafond : dette accumulée à date (mois clos). Un remboursement futur pourra puiser
  // dans le projeté, mais le verdict reste conservateur : on rembourse ce qui est dû.
  const capCents = cca.accruedCents
  const exceedsCap = amountCents > capCents

  const tns = state.company.fiscal?.tns
  const remId = tns?.remunerationCategoryId || 'dec_remuneration'
  const before = project(state)
  const after = project(state, { deltas: { [targetMonth]: { [remId]: -amountCents } } })
  const netAfterCents = after.netAvailableCents
  const lowNext = lowestNetWithin(after, today, horizonDays, endOfMonth(targetMonth))
  const runwayAfter = after.runwayMonths

  const netOk = netAfterCents >= threshold
  const lowOk = lowNext.cents >= threshold
  const runwayOk = runwayAfter === null || runwayAfter >= RUNWAY_GREEN_MONTHS
  const runwayCritical = runwayAfter !== null && runwayAfter < RUNWAY_AMBER_MONTHS

  let verdict
  if (exceedsCap || lowNext.cents < 0 || netAfterCents < 0 || !lowOk || !netOk) {
    verdict = 'rouge'
  } else if (netOk && lowOk && runwayOk && !runwayCritical) {
    verdict = 'vert'
  } else {
    verdict = 'ambre'
  }

  return {
    verdict,
    requestedCents: amountCents,
    month: targetMonth,
    horizonDays,
    // pas de coût couplé : remboursement de dette, ni cotisations ni impôt
    couplingCents: 0,
    totalCostCents: amountCents,
    ccaAccruedCents: capCents,
    ccaProjectedEndCents: cca.projectedEndCents,
    exceedsCap,
    netBeforeCents: before.netAvailableCents,
    netAfterCents,
    thresholdCents: threshold,
    lowPointNextCents: lowNext.cents,
    lowPointNextDate: lowNext.date,
    runwayBeforeMonths: before.runwayMonths,
    runwayAfterMonths: runwayAfter,
    criteria: { netOk, lowOk, runwayOk, capOk: !exceedsCap },
  }
}

/**
 * Aperçu d'impact d'UNE écriture prévisionnelle (proposition de l'agent ou simulation)
 * sur la trajectoire : on applique un delta éphémère `{ [month]: { [categoryId]: cents } }`
 * via le moteur (jamais d'écriture) et on renvoie base vs après (runway, point bas,
 * seuil). Sert le « verdict d'impact » d'une ProposalCard sans calcul côté front.
 *
 * @param state état complet
 * @param month 'YYYY-MM' mois d'impact de l'écriture
 * @param categoryId catégorie touchée (validée contre state.categories)
 * @param amountCents montant signé de l'écriture (centime entier, + entrée / - sortie)
 */
export function forecastImpact(state, { month, categoryId, amountCents } = {}) {
  if (!Number.isInteger(amountCents)) {
    throw new Error('amountCents doit être un entier (centimes)')
  }
  if (!month || !categoryId) {
    throw new Error('month et categoryId sont requis')
  }
  if (!state.categories.some((c) => c.id === categoryId)) {
    throw new Error(`Catégorie inconnue : ${categoryId}`)
  }
  const threshold = state.company.lowCashThresholdCents
  const before = project(state)
  const after = project(state, { deltas: { [month]: { [categoryId]: amountCents } } })

  // Delta de runway en mois : null si l'une des deux trajectoires ne descend jamais
  // sous le seuil (on ne soustrait pas un null, on n'invente pas d'infini).
  const runwayDeltaMonths =
    before.runwayMonths !== null && after.runwayMonths !== null
      ? Math.round((after.runwayMonths - before.runwayMonths) * 10) / 10
      : null

  return {
    month,
    categoryId,
    amountCents,
    thresholdCents: threshold,
    runwayBeforeMonths: before.runwayMonths,
    runwayAfterMonths: after.runwayMonths,
    runwayDeltaMonths,
    lowPointBeforeCents: before.lowPoint.cents,
    lowPointAfterCents: after.lowPoint.cents,
    lowPointAfterDate: after.lowPoint.date,
    crossesThreshold: after.lowPoint.cents < threshold,
  }
}

/**
 * Comparateur « rémunération vs dividendes » : pour une enveloppe de coût entreprise
 * donnée (`grossCostCents`, « combien je sors de la société »), combien arrive NET dans
 * la poche du dirigeant par chaque voie. Le calcul fiscal vit dans `fiscal.js`
 * (`remunerationVsDividendes`) ; ici on l'alimente avec les vrais paramètres de la
 * société (bénéfice déjà réalisé pour la tranche marginale d'IS, capital social, taux).
 *
 * @param state état complet (loadState)
 * @param grossCostCents enveloppe de coût entreprise (centimes entiers > 0)
 * @param month mois d'application (taux TNS ACRE/après-ACRE) - défaut mois courant
 */
export function compareRemunerationDividendes(state, { grossCostCents, month = null } = {}) {
  if (!Number.isInteger(grossCostCents) || grossCostCents <= 0) {
    throw new Error('grossCostCents doit être un entier positif (centimes)')
  }
  const fiscal = state.company.fiscal || {}
  const tns = fiscal.tns
  const today = todayFor(state.company)
  const currentMonth = monthOf(today)
  const targetMonth = month || currentMonth
  // Bénéfice prévisionnel déjà réalisé sur l'exercice : sert à savoir si l'euro marginal
  // sorti en dividendes tombe dans la tranche réduite (15%) ou normale (25%) de l'IS.
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const resultat = resultatPrevisionnel(state, { actuals, forecasts, currentMonth })
  const beneficeAvantISCents = Math.max(0, resultat.resultatAvantISCents)

  const comparison = remunerationVsDividendes({
    fiscal,
    tns,
    capitalSocialCents: state.company.capitalSocialCents,
    grossCostCents,
    month: targetMonth,
    beneficeAvantISCents,
  })

  return {
    ...comparison,
    beneficeAvantISCents,
    exerciseYear: resultat.exerciseYear,
    // Réserve méthodologique exposée pour que l'agent la cite (transparence IA Act) :
    // l'IR sur la rémunération n'est pas modélisé, donc le NET rému est AVANT IR.
    avertissements: [
      "Le net en rémunération est affiché AVANT impôt sur le revenu (barème progressif non modélisé) : la rémunération réelle en poche est plus faible.",
      'Les dividendes ne génèrent pas de droits sociaux (retraite, IJ maladie) contrairement à la rémunération.',
      'Le taux de cotisations TNS sur la fraction de dividendes > 10% du capital est une estimation (à confirmer avec l\'expert-comptable).',
    ],
  }
}
