// Dérivations fiscales/sociales du moteur Syntréso : TVA à reverser et provision
// URSSAF/TNS. Ces grandeurs ne sont JAMAIS des montants en dur : elles se calculent
// à partir des flux (encaissements/décaissements) et des taux paramétrés dans
// company.fiscal. Toute valeur produite est en CENTIMES ENTIERS (garde-fou throw).
//
// Convention de signe interne (cohérente avec le moteur) : un décaissement est
// NÉGATIF. Les sous-composantes exposées au front (vatDueCents, socialProvisionCents)
// sont en revanche en VALEUR ABSOLUE POSITIVE (« montant réservé »), cf. kpis().

import { monthOf, addMonths, monthRange, todayFor } from './dates.js'
import { robustMonthlyOut } from './charges.js'
import { horizonEnd as horizonEndOf } from './horizon.js'
import { retainedFor, actualsByMonth, forecastByMonth } from './projection.js'

// Garde-fou centimes entiers : tout montant dérivé doit être entier ou throw.
function intCents(value, context) {
  if (!Number.isInteger(value)) throw new Error(`Montant fiscal non entier (${context}) : ${value}`)
  return value
}

// Taux de TVA d'une catégorie (points de %), tolérant à l'absence du champ.
function vatRateOf(cat) {
  return typeof cat?.vatRatePct === 'number' ? cat.vatRatePct : 0
}

/**
 * TVA portée par un flux d'un mois, selon que les montants sont TTC ou HT.
 * - montant TTC : tva = montant * taux / (100 + taux)
 * - montant HT  : tva = montant * taux / 100
 * Retourne une valeur positive (la TVA est extraite d'un montant en valeur absolue).
 */
function vatOnAmount(absAmountCents, ratePct, amountsAreTTC) {
  if (!ratePct || !absAmountCents) return 0
  const raw = amountsAreTTC
    ? (absAmountCents * ratePct) / (100 + ratePct)
    : (absAmountCents * ratePct) / 100
  return Math.round(raw)
}

/**
 * TVA collectée et déductible d'un mois donné, dérivées des montants retenus
 * (mêmes montants que la projection : réalisé/prévu selon la règle du moteur).
 * Retourne { collectedCents, deductibleCents, dueCents } en valeur absolue positive.
 * dueCents = max(0, collectée - déductible) (un crédit de TVA ne se « reverse » pas,
 * il s'impute ; on ne modélise pas le report de crédit dans ce proto -> plancher 0).
 */
export function vatForMonth(ym, state, actuals, forecasts, currentMonth) {
  const amountsAreTTC = state.company.fiscal?.amountsAreTTC !== false // défaut TTC
  let collected = 0
  let deductible = 0
  for (const cat of state.categories) {
    const rate = vatRateOf(cat)
    if (!rate) continue
    if (cat.id === 'dec_tva') continue // jamais de TVA sur la ligne de reversement
    const retained = retainedFor(ym, cat, actuals, forecasts, currentMonth)
    const vat = vatOnAmount(Math.abs(retained), rate, amountsAreTTC)
    if (cat.direction === 'in') collected += vat
    else deductible += vat
  }
  const dueCents = Math.max(0, collected - deductible)
  return { collectedCents: collected, deductibleCents: deductible, dueCents }
}

/**
 * TVA nette restant à constater pour un mois : pour le mois courant, la TVA des
 * opérations déjà passées est déjà dans la dette relevée en compta (vatDueActualCents,
 * balance au dataAsOf), on ne compte que le reste à venir (sinon un règlement déjà passé
 * en compta serait compté deux fois). Pour les autres mois : la TVA due du mois.
 */
export function vatRestantDuMois(ym, state, actuals, forecasts, currentMonth) {
  const full = vatForMonth(ym, state, actuals, forecasts, currentMonth)
  if (ym !== currentMonth) return full.dueCents
  const real = vatForMonth(ym, state, actuals, {}, currentMonth)
  return Math.max(0, full.collectedCents - full.deductibleCents - (real.collectedCents - real.deductibleCents))
}

/**
 * Taux effectif de provision TNS pour un mois donné, en POINTS de % (ex: 40).
 * Avec ACRE active (jusqu'à finMois inclus) : cotisationTauxPct.
 * À partir du mois suivant la fin d'ACRE : cotisationTauxApresAcrePct.
 */
export function tnsRatePctForMonth(ym, tns) {
  const withAcre = tns.cotisationTauxPct
  const afterAcre = tns.cotisationTauxApresAcrePct ?? withAcre
  const acre = tns.acre
  if (!acre?.actif || !acre.finMois) return withAcre
  return ym <= acre.finMois ? withAcre : afterAcre
}

/**
 * Provision URSSAF/TNS d'un mois = |rémunération retenue du mois| x taux effectif.
 * Retourne une valeur positive (le montant à provisionner). 0 si TNS non piloté.
 */
/**
 * Rémunération brute ATTRIBUÉE d'un mois (en centimes positifs). Sert de base commune
 * aux cotisations URSSAF ET à la charge de personnel du compte de résultat, pour que
 * les deux restent cohérentes. Rému attribuée mais NON versée (passée en compte courant
 * d'associé) : aucun flux de trésorerie, mais c'est une charge soumise à cotisations ->
 * on retient la base attribuée pour les mois futurs jusqu'à remunerationEnCcaJusquau.
 */
export function remunerationBruteForMonth(ym, state, actuals, forecasts, currentMonth) {
  const tns = state.company.fiscal?.tns
  const remCat = tns && state.categories.find((c) => c.id === tns.remunerationCategoryId)
  if (!remCat) return 0
  let base = Math.abs(retainedFor(ym, remCat, actuals, forecasts, currentMonth))
  const attribuee = tns.remunerationMensuelleBruteCents || 0
  if (inCcaWindow(ym, tns, currentMonth) && attribuee > 0) {
    base = Math.max(base, attribuee)
  }
  return base
}

/**
 * Le mois ym est-il dans la fenêtre « rémunération en compte courant d'associé » ?
 * Bornes : remunerationEnCcaDepuis -> remunerationEnCcaJusquau. Si `depuis` n'est pas
 * renseigné, repli sur l'ancien comportement (fenêtre = présent/futur seulement) - mais
 * SANS `depuis`, un mois CCA devenu passé perd sa charge au compte de résultat (la rému
 * attribuée non versée n'a pas de flux réalisé) : renseigner `depuis` dès que la
 * fenêtre commence (sinon la charge d'un mois disparaît du résultat dès qu'il devient
 * passé).
 */
export function inCcaWindow(ym, tns, currentMonth) {
  if (!tns?.remunerationEnCcaJusquau || ym > tns.remunerationEnCcaJusquau) return false
  const depuis = tns.remunerationEnCcaDepuis
  return depuis ? ym >= depuis : ym >= currentMonth
}

/**
 * État du compte courant d'associé alimenté par la rémunération non versée :
 * ce que la société DOIT au gérant. Levier de pilotage clé : un remboursement de CCA
 * est une sortie de trésorerie SANS cotisations ni impôt (remboursement de dette).
 * - accruedCents      : dû accumulé sur les mois CLOS de la fenêtre (attribuée - versée)
 * - projectedEndCents : dû total projeté à la fin de la fenêtre
 * Retourne null si le TNS n'est pas piloté ou si la fenêtre n'est pas bornée (depuis).
 *
 * Quand l'import a relevé le solde RÉEL des comptes 455 dans Indy (company.ccaActual),
 * c'est lui qui fait foi pour le dû à date : la compta y porte aussi les IK et frais
 * avancés, et la rému de la fenêtre a pu être versée en cash (le calcul théorique peut
 * alors s'écarter nettement du solde comptable). La projection n'ajoute alors que la
 * rému attribuée des mois à venir que le forecast ne prévoit pas de verser.
 */
export function ccaStatus(state) {
  const tns = state.company.fiscal?.tns
  const actual = state.company.ccaActual
  if (Number.isInteger(actual?.cents)) return ccaFromIndy(state, tns, actual)
  if (!tns?.autoCompute || !tns.remunerationEnCcaDepuis || !tns.remunerationEnCcaJusquau) return null
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const currentMonth = monthOf(todayFor(state.company))
  let accrued = 0
  let projected = 0
  for (const ym of monthRange(tns.remunerationEnCcaDepuis, tns.remunerationEnCcaJusquau)) {
    const attribuee = remunerationBruteForMonth(ym, state, actuals, forecasts, currentMonth)
    const versee = Math.abs(actuals[ym]?.[tns.remunerationCategoryId] || 0)
    const net = Math.max(0, attribuee - versee)
    projected += net
    if (ym < currentMonth) accrued += net
  }
  return {
    sinceMonth: tns.remunerationEnCcaDepuis,
    untilMonth: tns.remunerationEnCcaJusquau,
    accruedCents: accrued,
    projectedEndCents: projected,
    source: 'calcul',
  }
}

/** Dû au gérant lu dans Indy (comptes 455), projeté avec la seule rému attribuée non prévue au versement. */
function ccaFromIndy(state, tns, actual) {
  const remId = tns?.remunerationCategoryId || 'dec_remuneration'
  const attribuee = tns?.autoCompute ? tns.remunerationMensuelleBruteCents || 0 : 0
  const until = tns?.remunerationEnCcaJusquau || null
  const currentMonth = monthOf(todayFor(state.company))
  let projected = actual.cents
  const from = tns?.remunerationEnCcaDepuis > currentMonth ? tns.remunerationEnCcaDepuis : currentMonth
  if (attribuee > 0 && until && until >= from) {
    const actuals = actualsByMonth(state.transactions)
    const forecasts = forecastByMonth(state.forecast)
    for (const ym of monthRange(from, until)) {
      const prevue = Math.max(Math.abs(actuals[ym]?.[remId] || 0), Math.abs(forecasts[ym]?.[remId] || 0))
      projected += Math.max(0, attribuee - prevue)
    }
  }
  return {
    sinceMonth: tns?.remunerationEnCcaDepuis || null,
    untilMonth: until,
    accruedCents: actual.cents,
    projectedEndCents: projected,
    source: 'indy',
    asOfDate: actual.asOf || null,
  }
}

export function socialProvisionForMonth(ym, state, actuals, forecasts, currentMonth) {
  const tns = state.company.fiscal?.tns
  if (!tns?.autoCompute) return 0
  if (!state.categories.find((c) => c.id === tns.remunerationCategoryId)) return 0
  const base = remunerationBruteForMonth(ym, state, actuals, forecasts, currentMonth)
  const ratePct = tnsRatePctForMonth(ym, tns)
  return Math.round((base * ratePct) / 100)
}

/**
 * Échéancier RÉEL des appels URSSAF (fiscal.tns.echeancesUrssaf : [{ dueDate
 * 'YYYY-MM-DD', amountCents POSITIF, label }], relevé sur urssaf.fr). Quand il est
 * renseigné, il PRIME sur la provision mensuelle pour tous les mois jusqu'au dernier
 * appel connu - un mois couvert sans appel ne décaisse RIEN (les cotisations TNS
 * sortent par trimestres, pas tous les mois ; la provision mensuelle 45 % reste la
 * référence de ce qu'il faut mettre de côté). Au-delà du dernier appel connu, la
 * provision dérivée reprend (prudent, en attendant les appels suivants).
 *
 * Régularisation N+1 : dette de l'exercice (somme des provisions dérivées de l'année)
 * moins le total appelé, JAMAIS en dur, datée fiscal.tns.regularisation.dueMonth
 * (défaut novembre N+1 - l'URSSAF régularise après la déclaration de revenus,
 * A_CONFIRMER avec l'EC ; l'override dueMonth ne vaut que pour un échéancier
 * mono-année). Saisir les appels tels qu'ils figurent sur l'espace URSSAF.
 *
 * Retourne null si TNS non piloté ou échéancier absent (comportement historique).
 */
export function urssafEcheancier(state, { actuals, forecasts, currentMonth }) {
  const tns = state.company.fiscal?.tns
  const echeances = Array.isArray(tns?.echeancesUrssaf) ? tns.echeancesUrssaf : []
  if (!tns?.autoCompute || !echeances.length) return null
  const echByMonth = {}
  let lastKnown = ''
  for (const e of echeances) {
    intCents(e.amountCents, `échéance URSSAF ${e.dueDate}`)
    const ym = monthOf(e.dueDate)
    echByMonth[ym] = (echByMonth[ym] || 0) + e.amountCents
    if (ym > lastKnown) lastKnown = ym
  }
  // Années civiles couvertes par l'échéancier : leur dette est intégralement réglée
  // par appels réels + régularisation N+1. AUCUNE provision de repli sur leurs mois,
  // même après le dernier appel connu - sinon la dette de ces mois serait comptée
  // DEUX fois (une fois en provision, une fois dans la régularisation calculée).
  const coveredYears = new Set(echeances.map((e) => e.dueDate.slice(0, 4)))
  const reguls = []
  for (const y of [...new Set(echeances.map((e) => e.dueDate.slice(0, 4)))]) {
    const dueMonth = tns.regularisation?.dueMonth || `${Number(y) + 1}-11`
    const called = echeances
      .filter((e) => e.dueDate.slice(0, 4) === y)
      .reduce((s, e) => s + e.amountCents, 0)
    let owed = 0
    for (const ym of monthRange(`${y}-01`, `${y}-12`)) {
      owed += socialProvisionForMonth(ym, state, actuals, forecasts, currentMonth)
    }
    if (owed - called > 0) reguls.push({ year: y, dueMonth, amountCents: owed - called })
  }
  return { echeances, echByMonth, lastKnown, coveredYears, reguls }
}

/**
 * Catégories fiscales PILOTÉES par le moteur (montant dérivé des flux, forecast
 * importé neutralisé) : TVA à reverser, provision URSSAF/TNS, décaissement d'IS.
 * Source unique des gardes : grille non éditable, PATCH forecast refusé, ligne
 * agent séparée dans le resolve des propositions.
 */
export function autoManagedCategoryIds(company) {
  const f = company?.fiscal || {}
  const ids = new Set()
  if (f.tva?.autoCompute === true) ids.add(f.tva.categoryId || 'dec_tva')
  if (f.tns?.autoCompute === true && f.tns.provisionCategoryId) ids.add(f.tns.provisionCategoryId)
  if (f.is?.autoDecaissement === true) ids.add(f.is.categoryId || 'dec_is')
  return ids
}

// Sur une catégorie pilotée, une ligne forecast « vivante » (posée par une proposition
// agent VALIDÉE ou par l'utilisateur) est un AJUSTEMENT qui s'ajoute au montant dérivé.
// Tout le reste (import : moyenne plate, morte) est neutralisé et remplacé par la
// dérivation (sans cette règle, une correction URSSAF validée dans l'interface serait
// écrite au prévisionnel puis neutralisée, et rien ne bougerait).
const LIVE_FORECAST_SOURCES = new Set(['agent', 'user'])

/**
 * Deltas mensuels dérivés (TVA + provision URSSAF), même forme que scenarioDeltas :
 * { '2026-07': { dec_tva: -412000 }, ... }. Appliqués sur le FUTUR uniquement
 * (mois >= currentMonth), pour ne jamais réécrire le réalisé.
 *
 * Principe « additif et réversible » :
 *  - tva.autoCompute=false ET tns.autoCompute=false -> aucun delta (comportement Lot 1).
 *  - tva.autoCompute=true  -> on NEUTRALISE les lignes forecast dec_tva MORTES (delta
 *    opposé) puis on POSE la TVA dérivée du mois M sur dec_tva au mois M+1
 *    (payDayOfMonth). Les lignes vivantes restent comptées par retainedFor : elles
 *    s'AJOUTENT au montant dérivé.
 *  - tns.autoCompute=true  -> idem pour provisionCategoryId (provision dérivée de la
 *    rému + ajustements vivants).
 *
 * Retourne aussi un index { vatDueByMonth, socialByMonth } (valeurs positives,
 * ajustements vivants inclus) pour que kpis() expose les sous-composantes sans
 * recalculer.
 */
export function derivedFiscalDeltas(state, { actuals, forecasts, currentMonth }) {
  const fiscal = state.company.fiscal || {}
  const tvaAuto = fiscal.tva?.autoCompute === true
  const tnsAuto = fiscal.tns?.autoCompute === true
  const deltas = {}
  const vatDueByMonth = {}
  const socialByMonth = {}
  if (!tvaAuto && !tnsAuto) return { deltas, vatDueByMonth, socialByMonth }

  const horizonEnd = horizonEndOf(currentMonth)
  const add = (ym, categoryId, cents) => {
    intCents(cents, `delta ${ym}/${categoryId}`)
    if (!cents) return
    deltas[ym] = deltas[ym] || {}
    deltas[ym][categoryId] = (deltas[ym][categoryId] || 0) + cents
  }
  // Tri mort/vivant des lignes forecast (signées) : seules les MORTES (import) sont
  // neutralisables ; les vivantes (agent/user) restent comptées par retainedFor.
  const deadByMonth = {}
  const liveByMonth = {}
  for (const f of state.forecast || []) {
    const bucket = LIVE_FORECAST_SOURCES.has(f.source) ? liveByMonth : deadByMonth
    bucket[f.month] = bucket[f.month] || {}
    bucket[f.month][f.categoryId] = (bucket[f.month][f.categoryId] || 0) + f.amountCents
  }
  // Montant prévu NEUTRALISABLE (forecast mort) d'une catégorie sur un mois (signé).
  const forecastOf = (ym, categoryId) => deadByMonth[ym]?.[categoryId] || 0
  // Ajustement vivant (signé) d'une catégorie sur un mois.
  const liveOf = (ym, categoryId) => liveByMonth[ym]?.[categoryId] || 0

  // --- TVA dérivée, régime ANNUEL (CA12) : aucun reversement en cours d'année. La dette
  // réelle à date (fiscal.vatDueActualCents, balance Indy) plus la TVA nette de l'activité
  // à venir se décaissent en un seul bloc au mois de fiscal.tva.dueDate (date relevée dans
  // l'espace fiscal ou dans Indy). Les lignes forecast dec_tva mortes
  // sont neutralisées sur tout l'horizon (elles supposaient un paiement mensuel).
  const tvaAnnuelle = tvaAuto && fiscal.tva?.regime === 'annuel' && /^\d{4}-\d{2}-\d{2}$/.test(fiscal.tva?.dueDate || '')
  // Fin du régime annuel (fiscal.tva.annuelJusquau, changement de régime) : l'activité APRÈS ce mois repasse
  // au paiement mensuel (bloc suivant). null = régime annuel sans fin connue.
  const annuelJusquau = tvaAnnuelle ? fiscal.tva?.annuelJusquau || null : null
  if (tvaAnnuelle) {
    const dueMonth = monthOf(fiscal.tva.dueDate)
    let total = Math.max(0, fiscal.vatDueActualCents || 0)
    for (const ym of monthRange(currentMonth, horizonEnd)) {
      const planned = forecastOf(ym, 'dec_tva')
      if (planned) add(ym, 'dec_tva', -planned)
      if (annuelJusquau && ym > annuelJusquau) continue
      // Seule l'activité de l'EXERCICE précédant l'échéance entre dans ce bloc (CA12 de
      // l'année N payé en mai N+1).
      if (ym < dueMonth && ym.slice(0, 4) < dueMonth.slice(0, 4)) total += vatRestantDuMois(ym, state, actuals, forecasts, currentMonth)
    }
    if (dueMonth >= currentMonth && dueMonth <= horizonEnd && total) {
      add(dueMonth, 'dec_tva', -total)
      vatDueByMonth[dueMonth] = (vatDueByMonth[dueMonth] || 0) + total
    }
  }

  // --- TVA dérivée, régime mensuel (défaut) : pose au mois M+1 la TVA due de l'activité du mois M.
  if (tvaAuto && (!tvaAnnuelle || annuelJusquau)) {
    const payDay = fiscal.tva?.payDayOfMonth || 22
    const todayDay = Number((todayFor(state.company) || '').slice(8, 10)) || 0
    // Si le jour de reversement du mois courant est déjà passé, la TVA de ce mois est
    // déjà dans le réalisé : ne pas la re-poser (sinon double comptage avec le réel).
    const currentMonthAlreadyPaid = todayDay > payDay
    // Crédit de TVA reporté (ex. compte 445670 « Crédit de TVA » dans Indy) : il s'IMPUTE
    // sur les prochaines TVA dues, dans l'ordre chronologique, jusqu'à épuisement. Un mois
    // dont la TVA due est entièrement couverte par le crédit ne donne aucun décaissement.
    // En sortie de régime annuel, le crédit est déjà imputé dans vatDueActualCents (balance).
    let vatCredit = tvaAnnuelle ? 0 : Math.max(0, fiscal.tva?.vatCreditCarryCents || 0)
    // On parcourt les mois d'activité dont le reversement tombe DANS l'horizon futur.
    // L'activité du mois (M-1) se reverse en M ; on couvre donc currentMonth-1..horizonEnd-1.
    for (const ym of monthRange(addMonths(currentMonth, -1), addMonths(horizonEnd, -1))) {
      if (annuelJusquau && ym <= annuelJusquau) continue // activité couverte par la CA12
      const payMonth = addMonths(ym, 1)
      if (payMonth < currentMonth || payMonth > horizonEnd) continue
      if (payMonth === currentMonth && currentMonthAlreadyPaid) continue
      const { dueCents } = vatForMonth(ym, state, actuals, forecasts, currentMonth)
      // Imputer le crédit de TVA reporté sur la TVA due de ce mois, avant de la poser.
      let netDue = dueCents
      if (vatCredit > 0 && netDue > 0) {
        const applied = Math.min(vatCredit, netDue)
        netDue -= applied
        vatCredit -= applied
      }
      // Neutraliser la ligne forecast dec_tva du mois de paiement (évite le double comptage)
      const planned = forecastOf(payMonth, 'dec_tva')
      if (planned) add(payMonth, 'dec_tva', -planned)
      // Poser la TVA dérivée nette du crédit reporté (décaissement => négatif)
      if (netDue) {
        add(payMonth, 'dec_tva', -netDue)
        vatDueByMonth[payMonth] = (vatDueByMonth[payMonth] || 0) + netDue
      }
      // Ajustement vivant validé sur dec_tva : déjà compté dans le solde via
      // retainedFor (aucun delta) ; on le remonte dans l'index engagé/kpis.
      const liveTva = liveOf(payMonth, 'dec_tva')
      if (liveTva) vatDueByMonth[payMonth] = (vatDueByMonth[payMonth] || 0) - liveTva
    }
  }

  // --- URSSAF/TNS : échéancier réel s'il est renseigné, sinon provision dérivée de
  // la rémunération du mois.
  if (tnsAuto) {
    const provId = fiscal.tns.provisionCategoryId
    const sched = urssafEcheancier(state, { actuals, forecasts, currentMonth })
    for (const ym of monthRange(currentMonth, horizonEnd)) {
      // Neutraliser le forecast de provision saisi (moyenne morte) pour le mois courant
      // et les mois futurs, puis poser la sortie pilotée.
      const planned = forecastOf(ym, provId)
      if (planned) add(ym, provId, -planned)
      let due
      if (sched && ym <= sched.lastKnown) {
        // Échéancier réel : l'appel du mois, rien les mois sans appel. Garde
        // anti-double-compte : un réalisé URSSAF ce mois = appel déjà prélevé.
        due = actuals[ym]?.[provId] ? 0 : sched.echByMonth[ym] || 0
      } else if (sched?.coveredYears.has(ym.slice(0, 4))) {
        // Fin d'une année couverte par l'échéancier, après le dernier appel connu :
        // rien ne sort (appels trimestriels), la dette de ces mois est déjà dans la
        // régularisation N+1 - une provision de repli la compterait deux fois.
        due = 0
      } else {
        due = socialProvisionForMonth(ym, state, actuals, forecasts, currentMonth)
      }
      if (due) {
        add(ym, provId, -due)
        socialByMonth[ym] = (socialByMonth[ym] || 0) + due
      }
      // Ajustement vivant validé sur la provision : déjà compté dans le solde via
      // retainedFor (aucun delta) ; on le remonte dans l'index engagé/kpis.
      const liveProv = liveOf(ym, provId)
      if (liveProv) socialByMonth[ym] = (socialByMonth[ym] || 0) - liveProv
    }
    // Régularisation N+1 datée (dette de l'exercice moins appels réels, calculée par
    // urssafEcheancier), posée si elle tombe dans l'horizon.
    for (const r of sched?.reguls || []) {
      if (r.dueMonth < currentMonth || r.dueMonth > horizonEnd) continue
      add(r.dueMonth, provId, -r.amountCents)
      socialByMonth[r.dueMonth] = (socialByMonth[r.dueMonth] || 0) + r.amountCents
    }
  }

  // --- Solde d'IS : décaissé au mois fiscal.is.payMonth (défaut mai) de N+1 pour l'exercice N (clôture 31/12, pas
  // d'acomptes modélisés : en dessous de 3 000 EUR d'IS N-1 il n'y en a pas). AVANT ce
  // bloc, l'IS était calculé au compte de résultat mais JAMAIS décaissé dans la
  // projection -> point bas de N+1 surestimé. Additif et
  // réversible : fiscal.is.autoDecaissement !== true -> rien. La catégorie de sortie
  // (défaut dec_is) doit exister dans categories.json, sinon skip silencieux.
  if (fiscal.is?.autoDecaissement === true) {
    const isCatId = fiscal.is.categoryId || 'dec_is'
    if (state.categories.find((c) => c.id === isCatId)) {
      for (let y = Number(currentMonth.slice(0, 4)) - 1; ; y++) {
        // Solde d'IS d'un exercice clos au 31/12 : 15 mai N+1 (relevé de solde déposé avec
        // la liasse). Paramétrable via fiscal.is.payMonth (« MM »), défaut 05.
        const payMonth = `${y + 1}-${fiscal.is.payMonth || '05'}`
        if (payMonth > horizonEnd) break
        if (payMonth < currentMonth) continue
        // déjà payé en réalisé ce mois-là ? (garde anti-double-compte)
        if (actuals[payMonth]?.[isCatId]) continue
        const { isProvisionCents } = resultatPrevisionnel(state, { actuals, forecasts, currentMonth }, String(y))
        if (isProvisionCents > 0) {
          const planned = forecastOf(payMonth, isCatId)
          if (planned) add(payMonth, isCatId, -planned)
          add(payMonth, isCatId, -isProvisionCents)
        }
      }
    }
  }

  return { deltas, vatDueByMonth, socialByMonth }
}

/**
 * Trésorerie engagée à horizon court : somme des sorties dérivées certaines à venir
 * non encore décaissées (TVA due + provision URSSAF) sur une fenêtre de N mois à
 * partir du mois courant inclus. Valeur POSITIVE (« montant réservé »).
 * Utilisée par kpis() pour committedCents / netAvailableCents.
 */
export function committedFromDerived({ vatDueByMonth, socialByMonth }, currentMonth, windowMonths) {
  // Fenêtre de `windowMonths` mois, MOIS COURANT INCLUS : monthRange est inclusif des deux
  // bornes, donc end = currentMonth + (windowMonths - 1) pour compter exactement N mois
  // (corrige l'off-by-one qui sommait N+1 mois).
  const end = addMonths(currentMonth, windowMonths - 1)
  let vat = 0
  let social = 0
  for (const ym of monthRange(currentMonth, end)) {
    vat += vatDueByMonth[ym] || 0
    social += socialByMonth[ym] || 0
  }
  return { vatDueCents: vat, socialProvisionCents: social, committedCents: vat + social }
}

// ------------------------------------------------------------------ Point mort
/**
 * Montant HT (en valeur absolue) d'un flux mensuel, pour le point mort.
 * Les charges fixes sont saisies TTC ou HT selon company.fiscal.amountsAreTTC ; le
 * point mort raisonne en HT (« CA HT à encaisser pour couvrir les charges »), on
 * convertit donc en HT quand les montants sont TTC.
 */
function toHT(absAmountCents, ratePct, amountsAreTTC) {
  if (!amountsAreTTC || !ratePct) return absAmountCents
  return Math.round((absAmountCents * 100) / (100 + ratePct))
}

/**
 * Point mort mensuel = total des CHARGES FIXES récurrentes, exprimé en EUR HT/mois.
 * Une catégorie est « fixe » si cat.fixed === true (loyer, leasing, assurances,
 * abonnements, rémunération gérant, salaires, emprunts...).
 *
 * Le calcul passe par la source unique
 * robustMonthlyOut (charges.js) : médiane des occurrences sur les `lookbackMonths`
 * derniers mois clos, mensualisée par la fréquence de présence. Corrige deux défauts
 * de l'ancienne moyenne presence-only : sensibilité aux pics, et charge trimestrielle
 * comptée au montant plein par mois (point mort surestimé x3).
 *
 * Retourne { breakEvenHTCents, fixedCategoryIds, lookbackMonths, byCategory }.
 * byCategory : charge mensuelle HT par catégorie fixe (transparence dans le digest).
 * La provision URSSAF/TNS dérivée (si pilotée par la rému) n'est PAS hors champ : la
 * rémunération du gérant est une charge fixe quand la catégorie porte fixed=true ;
 * les cotisations associées le sont aussi via dec_urssaf marqué fixed.
 */
export function breakEvenMonthly(state, actuals, currentMonth, lookbackMonths = 6) {
  const amountsAreTTC = state.company.fiscal?.amountsAreTTC !== false
  const fixedCats = state.categories.filter((c) => c.direction === 'out' && c.fixed === true)
  const robust = robustMonthlyOut(state, actuals, currentMonth, { lookbackMonths })
  const byCategory = {}
  let total = 0
  for (const cat of fixedCats) {
    const r = robust[cat.id]
    if (!r) continue
    const ht = toHT(r.monthlyCents, vatRateOf(cat), amountsAreTTC)
    if (ht) {
      byCategory[cat.id] = ht
      total += ht
    }
  }
  return {
    breakEvenHTCents: total,
    fixedCategoryIds: fixedCats.map((c) => c.id),
    lookbackMonths,
    byCategory,
  }
}

// ------------------------------------------------------------------ Résultat prévisionnel
/**
 * Convertit un montant signé (flux) en HT signé selon amountsAreTTC + taux de la
 * catégorie. Le résultat comptable se raisonne en HT (la TVA n'est ni un produit ni
 * une charge, c'est une dette de collecte). Conserve le signe.
 */
function signedToHT(signedCents, ratePct, amountsAreTTC) {
  const sign = signedCents < 0 ? -1 : 1
  return sign * toHT(Math.abs(signedCents), ratePct, amountsAreTTC)
}

/**
 * Résultat prévisionnel de l'EXERCICE (année civile par défaut) : produits HT
 * cumulés - charges HT cumulées sur les mois de l'exercice (réalisé + retenu), PUIS
 * provision IS estimée sur le bénéfice. Distinct de la trésorerie (cash) et de la
 * TVA/charges à reverser (dette).
 *
 * - On exclut la ligne dec_tva (la TVA n'entre pas au résultat).
 * - On exclut les remboursements de capital d'emprunt (vatRatePct 0 + cat fixed
 *   emprunt) ? Non : on ne sait pas distinguer capital/intérêts dans ce proto. On
 *   garde l'emprunt en charge (prudent, légère sous-estimation du résultat). Marqué
 *   comme limite connue.
 * - IS : 15% jusqu'à seuilReduit, 25% au-delà (paramétrable company.fiscal.is).
 *
 * Retourne { exerciseYear, fromMonth, toMonth, productsHTCents, chargesHTCents,
 * resultatAvantISCents, isProvisionCents, resultatApresISCents, isBracket }.
 */
/**
 * Compte de résultat MENSUEL de l'exercice (12 mois + total), en HT.
 *
 * Source unique du résultat (l'annuel `resultatPrevisionnel` n'en est qu'un agrégat).
 * Règles :
 *  - On exclut la TVA (dette de collecte, ni produit ni charge).
 *  - Charges de personnel (rému gérant + URSSAF) traitées à part pour être JUSTES :
 *    réalisé pour les mois passés (ce qui a été payé), dérivé pour le présent/futur
 *    (rému attribuée même en CCA + provision URSSAF au taux du mois). Sinon la rému en
 *    compte courant d'associé et les cotisations dérivées seraient oubliées du résultat.
 *  - Les autres produits/charges suivent le réalisé puis le prévisionnel (retainedFor).
 *  - IS estimé sur le bénéfice ANNUEL (il ne se calcule pas mois par mois).
 *
 * Limite connue (proto) : on ne distingue pas capital/intérêts d'un remboursement
 * d'emprunt ni les immobilisations (pas d'amortissement) -> niveau « simplifié » assumé.
 */
export function compteResultatMensuel(state, { actuals, forecasts, currentMonth }, exerciseYear) {
  const amountsAreTTC = state.company.fiscal?.amountsAreTTC !== false
  const year = exerciseYear || currentMonth.slice(0, 4)
  const months = monthRange(`${year}-01`, `${year}-12`)
  const tns = state.company.fiscal?.tns
  const tnsAuto = !!tns?.autoCompute
  const remCatId = tns?.remunerationCategoryId
  const provCatId = tns?.provisionCategoryId
  const vatCatId = state.company.fiscal?.tva?.categoryId || 'dec_tva'
  const labelOf = (id) => state.categories.find((c) => c.id === id)?.label || id
  // Quand le pilotage TNS est actif, rému + URSSAF sont dérivées : on les sort de la
  // boucle générique pour ne pas les compter deux fois.
  const handledApart = new Set([vatCatId])
  if (tnsAuto && remCatId) handledApart.add(remCatId)
  if (tnsAuto && provCatId) handledApart.add(provCatId)
  // Opérations de financement (apport / restitution de capital, remboursement du capital
  // d'un emprunt, mouvements de compte courant) : elles bougent la trésorerie mais ne sont
  // ni un produit ni une charge -> exclues du compte de résultat (flag categorie).
  for (const c of state.categories) if (c.excludeFromResultat) handledApart.add(c.id)

  // Ajustements vivants (agent/user) sur la provision URSSAF : la boucle générique
  // ignore provCatId (handledApart), il faut donc les reporter sur la charge dérivée
  // pour que le résultat reste cohérent avec la projection de trésorerie.
  const liveProvByMonth = {}
  if (tnsAuto && provCatId) {
    for (const f of state.forecast || []) {
      if (f.categoryId !== provCatId || !LIVE_FORECAST_SOURCES.has(f.source)) continue
      liveProvByMonth[f.month] = (liveProvByMonth[f.month] || 0) + f.amountCents
    }
  }

  const lines = {} // id -> { categoryId, label, direction, parMois:{}, totalCents }
  const touch = (id, label, direction) =>
    (lines[id] ||= { categoryId: id, label, direction, parMois: {}, totalCents: 0 })
  const addLine = (id, label, direction, ym, htCents) => {
    if (!htCents) return
    const l = touch(id, label, direction)
    l.parMois[ym] = (l.parMois[ym] || 0) + htCents
    l.totalCents += htCents
  }

  const parMois = {}
  for (const ym of months) {
    let produitsHT = 0
    let chargesHT = 0 // négatif
    for (const cat of state.categories) {
      if (handledApart.has(cat.id)) continue
      const retained = retainedFor(ym, cat, actuals, forecasts, currentMonth)
      if (!retained) continue
      const ht = signedToHT(retained, vatRateOf(cat), amountsAreTTC)
      if (cat.direction === 'in') {
        produitsHT += ht
        addLine(cat.id, cat.label || cat.id, 'in', ym, ht)
      } else {
        chargesHT += ht
        addLine(cat.id, cat.label || cat.id, 'out', ym, ht)
      }
    }
    // Charges de personnel (rému + URSSAF) : réel pour le passé, dérivé pour présent/
    // futur - SAUF mois passé dans la fenêtre CCA : la rému attribuée non versée est
    // une vraie charge (soumise à cotisations) sans flux réalisé, le « réel » la
    // perdrait (la charge disparaîtrait du résultat dès que le mois devient passé).
    if (tnsAuto && remCatId) {
      let remCents
      let urssafCents
      if (ym < currentMonth && !inCcaWindow(ym, tns, currentMonth)) {
        remCents = Math.abs(actuals[ym]?.[remCatId] || 0)
        // Cotisations : charge DUE sur la rému du mois (taux de provision), pas ce qui a
        // été appelé. Les appels de première année sont forfaitaires et régularisés en N+1 :
        // compter le payé sous-estimerait la charge de la première année.
        urssafCents = Math.round((remCents * tnsRatePctForMonth(ym, tns)) / 100)
      } else {
        remCents = remunerationBruteForMonth(ym, state, actuals, forecasts, currentMonth)
        // provision dérivée + ajustements vivants du mois (liveProvByMonth est signé
        // négatif pour un surcoût -> on le retranche pour grossir la charge)
        urssafCents = socialProvisionForMonth(ym, state, actuals, forecasts, currentMonth) - (liveProvByMonth[ym] || 0)
      }
      chargesHT += -remCents - urssafCents
      addLine(remCatId, labelOf(remCatId), 'out', ym, -remCents)
      if (provCatId) addLine(provCatId, labelOf(provCatId), 'out', ym, -urssafCents)
    }
    // Frais avancés par le gérant et IK, crédités au compte courant d'associé : des
    // charges sans flux bancaire au moment où elles naissent (le remboursement, lui, est
    // hors résultat). Réel = crédits du compte 455 relevés par l'importeur ; prévu =
    // company.fraisCCA.prevuParMoisCents (IK au barème). Mois courant : le plus grand des deux.
    const fca = state.company.fraisCCA
    if (fca) {
      const reel = fca.reelParMoisCents?.[ym] || 0
      const prevu = fca.prevuParMoisCents?.[ym] || 0
      const cents = ym < currentMonth ? reel : ym === currentMonth ? Math.max(reel, prevu) : prevu
      if (cents) {
        chargesHT -= cents
        addLine('frais_cca', "Frais avancés et IK (compte courant d'associé)", 'out', ym, -cents)
      }
    }
    parMois[ym] = {
      produitsHTCents: produitsHT,
      chargesHTCents: chargesHT,
      resultatAvantISCents: produitsHT + chargesHT,
      realized: ym < currentMonth,
    }
  }

  // Dotations aux amortissements : étalement linéaire (durée `amortissementMois` par
  // catégorie) des achats immobilisés. L'achat lui-même est hors résultat
  // (excludeFromResultat) et sort en trésorerie ; seule la dotation pèse au compte de
  // résultat, étalée sur la durée d'usage à partir du mois de mise en service.
  const amortCats = state.categories.filter((c) => c.amortissementMois > 0)
  if (amortCats.length) {
    const dotationParMois = {}
    for (const cat of amortCats) {
      const duree = cat.amortissementMois
      const achats = [
        ...state.transactions.filter((t) => t.categoryId === cat.id).map((t) => ({ ym: t.date.slice(0, 7), cents: Math.abs(t.amountCents) })),
        ...state.forecast.filter((f) => f.categoryId === cat.id).map((f) => ({ ym: f.month, cents: Math.abs(f.amountCents) })),
      ]
      for (const a of achats) {
        const dotation = Math.round(toHT(a.cents, vatRateOf(cat), amountsAreTTC) / duree)
        for (let i = 0; i < duree; i++) {
          const ym = addMonths(a.ym, i)
          dotationParMois[ym] = (dotationParMois[ym] || 0) + dotation
        }
      }
    }
    for (const ym of months) {
      const dot = dotationParMois[ym] || 0
      if (!dot) continue
      addLine('dotation_amortissement', 'Dotations aux amortissements', 'out', ym, -dot)
      parMois[ym].chargesHTCents -= dot
      parMois[ym].resultatAvantISCents -= dot
    }
  }

  const totalProduitsHTCents = months.reduce((s, ym) => s + parMois[ym].produitsHTCents, 0)
  const totalChargesHTCents = months.reduce((s, ym) => s + parMois[ym].chargesHTCents, 0)
  const resultatAvantISCents = totalProduitsHTCents + totalChargesHTCents
  // Déficits antérieurs reportables (fiscal.is.deficitsReportablesCents { "2026": cents }) :
  // imputés sur le bénéfice de l'exercice avant le calcul de l'IS.
  const deficit = Math.max(0, state.company.fiscal?.is?.deficitsReportablesCents?.[year] || 0)
  const isProvision = estimateIS(Math.max(0, resultatAvantISCents - deficit), state.company.fiscal?.is)
  const resultatApresISCents = resultatAvantISCents - isProvision.isCents
  const pct = (num) => (totalProduitsHTCents > 0 ? Math.round((num / totalProduitsHTCents) * 1000) / 10 : null)
  const sortLines = (dir) =>
    Object.values(lines)
      .filter((l) => l.direction === dir)
      .sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents))

  return {
    exerciseYear: year,
    months,
    currentMonth,
    produits: sortLines('in'),
    charges: sortLines('out'),
    parMois,
    totalProduitsHTCents,
    totalChargesHTCents,
    resultatAvantISCents,
    isProvisionCents: isProvision.isCents,
    resultatApresISCents,
    isBracket: isProvision.bracket,
    ratios: {
      tauxMargeNettePct: pct(resultatApresISCents),
      tauxResultatAvantISPct: pct(resultatAvantISCents),
    },
    breakEvenHTCents: breakEvenMonthly(state, actuals, currentMonth).breakEvenHTCents,
  }
}

/**
 * Résultat prévisionnel de l'EXERCICE (agrégat annuel du compte de résultat mensuel).
 * Conserve la forme historique pour le PDF dossier banquier, le digest et l'arbitrage
 * dividendes -> tous lisent désormais le même calcul juste.
 */
export function resultatPrevisionnel(state, ctx, exerciseYear) {
  const m = compteResultatMensuel(state, ctx, exerciseYear)
  return {
    exerciseYear: m.exerciseYear,
    fromMonth: m.months[0],
    toMonth: m.months[m.months.length - 1],
    productsHTCents: m.totalProduitsHTCents,
    chargesHTCents: m.totalChargesHTCents,
    resultatAvantISCents: m.resultatAvantISCents,
    isProvisionCents: m.isProvisionCents,
    resultatApresISCents: m.resultatApresISCents,
    isBracket: m.isBracket,
  }
}

/**
 * Impôt sur les sociétés estimé sur un bénéfice (centimes entiers positifs).
 * Barème 2026 paramétrable : taux réduit (15%) jusqu'à seuilReduit (42 500 EUR),
 * taux normal (25%) au-delà. Si is absent : 0 (pas d'hypothèse inventée).
 * Sources : impots.gouv.fr / economie.gouv.fr (vérifié 2026-06-18).
 */
export function estimateIS(beneficeCents, is) {
  if (!is || beneficeCents <= 0) return { isCents: 0, bracket: 'aucun' }
  const seuil = is.seuilReduitCents ?? 4_250_000
  const tauxReduit = is.tauxReduitPct ?? 15
  const tauxNormal = is.tauxNormalPct ?? 25
  const reduitBase = Math.min(beneficeCents, seuil)
  const normalBase = Math.max(0, beneficeCents - seuil)
  const isCents = Math.round((reduitBase * tauxReduit) / 100) + Math.round((normalBase * tauxNormal) / 100)
  const bracket = normalBase > 0 ? 'réduit+normal' : 'réduit'
  return { isCents, bracket }
}

// ------------------------------------------------------------------ Arbitrage rému / dividendes
// Taux marginal d'IS au-delà du bénéfice déjà réalisé : pour 1 EUR de bénéfice
// supplémentaire conservé dans la société, l'IS coûte 15% sous le seuil, 25% au-delà.
// On part du bénéfice déjà acquis (resultatAvantISCents) pour savoir dans quelle
// tranche tombe l'euro marginal sorti en dividendes.
function marginalISRatePct(is, beneficeDejaRealiseCents) {
  const seuil = is?.seuilReduitCents ?? 4_250_000
  const tauxReduit = is?.tauxReduitPct ?? 15
  const tauxNormal = is?.tauxNormalPct ?? 25
  return Math.max(0, beneficeDejaRealiseCents) >= seuil ? tauxNormal : tauxReduit
}

/**
 * Arbitrage rémunération vs dividendes pour une SARL-U à l'IS, gérant majoritaire TNS.
 * Modélise le « pont » entre la trésorerie SORTIE de la société et le NET dans la poche
 * du dirigeant, pour une enveloppe de coût entreprise donnée (`grossCostCents`,
 * « combien je sors de la société »).
 *
 * VOIE RÉMUNÉRATION (déductible de l'IS) :
 *   coût entreprise = brut + cotisations TNS (taux effectif du mois, ACRE puis après).
 *   La rému et ses cotisations sont des charges déductibles -> pas d'IS dessus.
 *   net en poche ≈ brut - IR. Le proto NE modélise PAS l'IR (barème progressif,
 *   dépend du foyer fiscal) : on renvoie le BRUT en poche et on signale que l'IR
 *   reste à appliquer (transparence). On expose donc « brut versé » comme proxy du
 *   net avant IR, jamais un net inventé.
 *
 * VOIE DIVIDENDES (après IS) :
 *   coût entreprise = bénéfice avant IS. On paie d'abord l'IS (taux marginal), le
 *   dividende distribuable = bénéfice - IS. Puis sur le dividende :
 *     - fraction <= 10% du capital social : prélèvements sociaux du PFU (flatTax) +
 *       IR du PFU (12,8%). Pas de cotisations TNS.
 *     - fraction > 10% du capital social : cotisations sociales TNS (dividendesTauxPct)
 *       + IR (12,8% du PFU). Pas de prélèvements sociaux (mutuellement exclusif avec
 *       les cotisations TNS sur la même fraction).
 *   net en poche = dividende - IS social/PFU - IR.
 *
 * Le PFU (flatTaxPct, défaut 31,4% = 12,8% IR + 18,6% PS) est décomposé : part IR
 * (pfuIrPct) et part prélèvements sociaux (flatTaxPct - pfuIrPct). Paramétrable.
 *
 * @param fiscal company.fiscal (is, flatTaxPct, tns.dividendesTauxPct)
 * @param tns company.fiscal.tns
 * @param capitalSocialCents capital social libéré (seuil de 10%)
 * @param grossCostCents enveloppe de coût entreprise à arbitrer (> 0)
 * @param month mois d'application (pour le taux TNS ACRE/après-ACRE)
 * @param beneficeAvantISCents bénéfice déjà réalisé (pour la tranche marginale d'IS sur dividendes)
 * @param pfuIrPct part IR du PFU (défaut 12,8)
 *
 * Renvoie les deux voies détaillées + le delta net (positif = dividendes plus avantageux).
 * Tous les montants en centimes entiers (garde-fou intCents).
 */
export function remunerationVsDividendes(
  { fiscal, tns, capitalSocialCents, grossCostCents, month, beneficeAvantISCents = 0, pfuIrPct = 12.8 } = {},
) {
  if (!Number.isInteger(grossCostCents) || grossCostCents <= 0) {
    throw new Error('grossCostCents doit être un entier positif (centimes)')
  }
  const flatTaxPct = fiscal?.flatTaxPct ?? 31.4
  // part prélèvements sociaux du PFU. Arrondi 1 décimale pour éviter l'artefact IEEE754
  // (31,4 - 12,8 = 18,599999...) à l'AFFICHAGE ; les montants restent calculés en entiers.
  const psPct = Math.max(0, Math.round((flatTaxPct - pfuIrPct) * 10) / 10)
  const cotisRatePct = tns ? tnsRatePctForMonth(month, tns) : 0
  const divCotisPct = tns?.dividendesTauxPct ?? 45
  const capital = Math.max(0, capitalSocialCents || 0)

  // --- VOIE RÉMUNÉRATION : l'enveloppe = brut + cotisations (= brut x (1 + taux/100)).
  // On résout le brut tel que brut x (1 + taux/100) = grossCost.
  const remBrutCents = Math.round((grossCostCents * 100) / (100 + cotisRatePct))
  const remCotisCents = grossCostCents - remBrutCents
  // Net en poche = brut (l'IR n'est pas modélisé ici). Proxy « avant IR ».
  const remNetAvantIRCents = remBrutCents

  // --- VOIE DIVIDENDES : l'enveloppe = bénéfice avant IS. On paie l'IS marginal.
  const isRatePct = marginalISRatePct(fiscal?.is, beneficeAvantISCents)
  const divISCents = Math.round((grossCostCents * isRatePct) / 100)
  const dividendeBrutCents = grossCostCents - divISCents // dividende distribuable
  // Découpe au seuil de 10% du capital social.
  const seuil10Cents = Math.round(capital / 10)
  const fractionSousSeuilCents = Math.min(dividendeBrutCents, seuil10Cents)
  const fractionSurSeuilCents = Math.max(0, dividendeBrutCents - seuil10Cents)
  // Fraction <= seuil : prélèvements sociaux du PFU. Fraction > seuil : cotisations TNS.
  const divPsCents = Math.round((fractionSousSeuilCents * psPct) / 100)
  const divCotisCents = Math.round((fractionSurSeuilCents * divCotisPct) / 100)
  // IR du PFU sur tout le dividende (les deux fractions supportent l'IR).
  const divIrCents = Math.round((dividendeBrutCents * pfuIrPct) / 100)
  const divNetCents = dividendeBrutCents - divPsCents - divCotisCents - divIrCents

  // Garde-fou centimes entiers sur toutes les sorties.
  for (const [ctx, v] of Object.entries({
    remBrutCents, remCotisCents, divISCents, dividendeBrutCents, divPsCents, divCotisCents, divIrCents, divNetCents,
  })) {
    intCents(v, `arbitrage ${ctx}`)
  }

  return {
    grossCostCents,
    month: month || null,
    capitalSocialCents: capital,
    seuil10Cents,
    remuneration: {
      brutCents: remBrutCents,
      cotisationsCents: remCotisCents,
      cotisationRatePct: cotisRatePct,
      isCents: 0, // rému déductible -> pas d'IS
      netAvantIRCents: remNetAvantIRCents,
      // L'IR sur la rému dépend du barème progressif et du foyer : non modélisé.
      irModelise: false,
    },
    dividendes: {
      isRatePct,
      isCents: divISCents,
      dividendeBrutCents,
      fractionSousSeuilCents,
      fractionSurSeuilCents,
      prelevementsSociauxCents: divPsCents,
      prelevementsSociauxPct: psPct,
      cotisationsTnsCents: divCotisCents,
      cotisationsTnsPct: divCotisPct,
      irCents: divIrCents,
      irPct: pfuIrPct,
      netCents: divNetCents,
      irModelise: true, // l'IR du PFU (12,8%) EST modélisé (forfaitaire)
    },
    // Delta net : dividendes - rému. ATTENTION : comparaison imparfaite car l'IR de la
    // rému n'est pas modélisé (la rému réelle en poche est < brut). On signale donc que
    // le NET rému affiché est AVANT IR (favorable à la rému). Le delta « brut » sert
    // d'indication, l'agent doit citer la réserve IR.
    deltaNetDividendesMoinsRemAvantIRCents: divNetCents - remNetAvantIRCents,
  }
}
