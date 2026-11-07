// Moteur de calcul unique de Syntréso. Toute valeur de solde affichée vient d'ici.
//
// Règle des montants retenus par mois et par catégorie :
//   mois passé   -> réalisé
//   mois courant -> entrées : réalisé + max(0, prévu - réalisé)
//                   sorties : réalisé + min(0, prévu - réalisé)
//                   (le prévu est un objectif mensuel : ce qui n'est pas encore
//                    constaté est supposé arriver d'ici la fin du mois)
//   mois futur   -> prévu
//
// Dates : chaînes 'YYYY-MM-DD' comparées lexicographiquement. Montants : centimes entiers.

import { readJson } from './store.js'
import { monthOf, daysInMonth, endOfMonth, addMonths, monthRange, addDays, todayFor } from './dates.js'
import { horizonEnd as horizonEndOf, gridStart } from './horizon.js'
import {
  derivedFiscalDeltas, committedFromDerived, tnsRatePctForMonth,
  breakEvenMonthly, resultatPrevisionnel, ccaStatus, autoManagedCategoryIds,
} from './fiscal.js'

// Fenêtre de trésorerie engagée (committedCents) : mois courant + N mois. La TVA et
// la provision URSSAF dues sur cet horizon court constituent la part du solde « pas à
// moi ». 3 mois couvre la prochaine échéance TVA + la prochaine régularisation rému.
const COMMITTED_WINDOW_MONTHS = 3

// Runway : on lisse le « burn » (sortie nette mensuelle) sur les N derniers mois clos
// pour absorber la volatilité d'un solo (encaissements en dents de scie). 6 mois est
// le compromis du brainstorm (assez long pour lisser, assez court pour rester actuel).
const BURN_LOOKBACK_MONTHS = 6

// Re-export des helpers de date : ils vivent désormais dans dates.js (pour casser
// le cycle d'import avec horizon.js) mais restent importables depuis projection.js,
// où les consommateurs historiques (tests, alerts.js, digest.js, routes) les
// prennent. Ne pas dupliquer les implémentations ici.
export { monthOf, daysInMonth, endOfMonth, addMonths, monthRange, addDays, todayFor }

export async function loadState() {
  const [company, accounts, categories, transactions, invoices, forecast, scenarios] = await Promise.all([
    readJson('company'),
    readJson('accounts'),
    readJson('categories'),
    readJson('transactions'),
    readJson('invoices'),
    readJson('forecast'),
    readJson('scenarios'),
  ])
  return { company, accounts, categories, transactions, invoices, forecast, scenarios }
}

// ------------------------------------------------------------------ Agrégats
/** Totaux réalisés par mois puis par catégorie : { '2026-05': { enc_chantiers: 1234, ... } } */
export function actualsByMonth(transactions) {
  const out = {}
  for (const t of transactions) {
    const ym = monthOf(t.date)
    out[ym] = out[ym] || {}
    out[ym][t.categoryId] = (out[ym][t.categoryId] || 0) + t.amountCents
  }
  return out
}

/** Prévisions par mois puis par catégorie. */
export function forecastByMonth(forecast) {
  const out = {}
  for (const f of forecast) {
    out[f.month] = out[f.month] || {}
    out[f.month][f.categoryId] = (out[f.month][f.categoryId] || 0) + f.amountCents
  }
  return out
}

/** Montant retenu pour (mois, catégorie) selon la règle documentée en tête de fichier. */
export function retainedFor(ym, cat, actuals, forecasts, currentMonth) {
  const r = actuals[ym]?.[cat.id] || 0
  const p = forecasts[ym]?.[cat.id] || 0
  if (ym < currentMonth) return r
  if (ym > currentMonth) return p
  return cat.direction === 'in' ? r + Math.max(0, p - r) : r + Math.min(0, p - r)
}

// ------------------------------------------------------------------ Scénarios
/**
 * Transforme les scénarios actifs en deltas mensuels par catégorie :
 * { '2026-09': { dec_salaires: -340000 }, ... }
 */
export function scenarioDeltas(scenarios, activeIds, state) {
  const deltas = {}
  const add = (ym, categoryId, cents) => {
    if (!Number.isInteger(cents)) throw new Error(`Delta scénario non entier (${ym}/${categoryId})`)
    deltas[ym] = deltas[ym] || {}
    deltas[ym][categoryId] = (deltas[ym][categoryId] || 0) + cents
  }
  // Horizon glissant dérivé du mois courant (plus de '2026-12' en dur).
  const currentMonth = monthOf(todayFor(state.company))
  const horizonEnd = horizonEndOf(currentMonth)

  for (const sc of scenarios) {
    if (!activeIds.includes(sc.id)) continue
    if (sc.id === 'sc_embauche') {
      const { startMonth, monthlyCostCents, oneOffCents } = sc.params
      add(startMonth, 'dec_salaires', -(oneOffCents || 0))
      for (const ym of monthRange(startMonth, horizonEnd)) add(ym, 'dec_salaires', -monthlyCostCents)
    }
    if (sc.id === 'sc_invest') {
      const { month, amountCents, mode } = sc.params
      if (mode === 'cash') {
        add(month, 'dec_leasing', -amountCents)
      } else {
        const monthly = Math.round(amountCents / 36 / 100) * 100
        for (const ym of monthRange(month, horizonEnd)) add(ym, 'dec_leasing', -monthly)
      }
    }
    if (sc.id === 'sc_retard') {
      const { invoiceId, delayDays } = sc.params
      const inv = state.invoices.find((i) => i.id === invoiceId)
      if (inv && inv.status !== 'paid' && delayDays > 0) {
        const expected = inv.expectedPaymentDate || inv.dueDate
        const shifted = addDays(expected, delayDays)
        const fromYm = monthOf(expected)
        const toYm = monthOf(shifted)
        if (toYm !== fromYm) {
          add(fromYm, 'enc_chantiers', -inv.amountCents)
          if (toYm <= horizonEnd) add(toYm, 'enc_chantiers', inv.amountCents)
        }
      }
    }
    if (sc.id === 'sc_dev') {
      const { startMonth, monthlyCostCents, oneOffCents } = sc.params
      add(startMonth, 'dec_remuneration', -(oneOffCents || 0))
      for (const ym of monthRange(startMonth, horizonEnd)) add(ym, 'dec_remuneration', -monthlyCostCents)
    }
    if (sc.id === 'sc_rem_up') {
      const { startMonth, extraMonthlyCents } = sc.params
      // Couplage obligatoire : une hausse de rémunération du gérant TNS entraîne une
      // hausse de la provision URSSAF (taux effectif du mois, ACRE puis après ACRE).
      // Sans ce couplage, le scénario mentirait (rému en + sans cotisation en +).
      const tns = state.company.fiscal?.tns
      const remId = tns?.remunerationCategoryId || 'dec_remuneration'
      const couplesCotisations = tns?.autoCompute && tns.provisionCategoryId
      for (const ym of monthRange(startMonth, horizonEnd)) {
        add(ym, remId, -extraMonthlyCents)
        if (couplesCotisations) {
          const ratePct = tnsRatePctForMonth(ym, tns)
          const extraCotis = Math.round((extraMonthlyCents * ratePct) / 100)
          add(ym, tns.provisionCategoryId, -extraCotis)
        }
      }
    }
    if (sc.id === 'sc_pipe_prudent') {
      const { fromMonth, reductionPct } = sc.params
      for (const ym of monthRange(fromMonth, horizonEnd)) {
        const planned = state.forecast
          .filter((f) => f.month === ym && f.categoryId === 'enc_prestations')
          .reduce((s, f) => s + f.amountCents, 0)
        add(ym, 'enc_prestations', -Math.round((planned * reductionPct) / 100))
      }
    }
    if (sc.id === 'sc_retard_enc') {
      const { month, amountCents, delayMonths } = sc.params
      const toM = addMonths(month, delayMonths)
      add(month, 'enc_prestations', -amountCents)
      if (toM <= horizonEnd) add(toM, 'enc_prestations', amountCents)
    }
    if (sc.id === 'sc_achat') {
      const { month, amountCents } = sc.params
      add(month, 'dec_materiel', -amountCents)
    }
    if (sc.id === 'sc_pret') {
      const { month, amountCents, monthlyRepayCents } = sc.params
      add(month, 'enc_divers', amountCents)
      for (const ym of monthRange(month, horizonEnd)) add(ym, 'dec_divers', -monthlyRepayCents)
    }
    if (sc.id === 'sc_recurrent') {
      const { startMonth, monthlyCents } = sc.params
      for (const ym of monthRange(startMonth, horizonEnd)) add(ym, 'enc_prestations', monthlyCents)
    }
    if (sc.id === 'sc_pipe_optimiste') {
      const { fromMonth, increasePct } = sc.params
      for (const ym of monthRange(fromMonth, horizonEnd)) {
        const planned = state.forecast
          .filter((f) => f.month === ym && f.categoryId === 'enc_prestations')
          .reduce((s, f) => s + f.amountCents, 0)
        add(ym, 'enc_prestations', Math.round((planned * increasePct) / 100))
      }
    }
    if (sc.id === 'sc_dividendes') {
      // Distribution de dividendes : sortie de trésorerie ponctuelle de l'enveloppe de
      // coût entreprise (IS payé + dividende versé). On décaisse `grossCostCents` le mois
      // choisi sur la catégorie dédiée (paramétrable, fallback dec_divers / dec_remuneration).
      // La fiscalité fine (qui touche le NET en poche, pas la tréso société) est calculée
      // par fiscal.remunerationVsDividendes / decision.compareRemunerationDividendes.
      const { month, grossCostCents } = sc.params
      const tns = state.company.fiscal?.tns
      const divId = tns?.dividendesCategoryId
        || (state.categories.some((c) => c.id === 'dec_divers') ? 'dec_divers' : (tns?.remunerationCategoryId || 'dec_remuneration'))
      if (month && grossCostCents) add(month, divId, -grossCostCents)
    }
    if (sc.id === 'sc_arret_maladie') {
      // Arrêt maladie du dirigeant : N mois de facturation nulle (les encaissements des
      // catégories direction=in tombent à zéro sur la période) + indemnités journalières
      // TNS (faibles/nulles selon couverture, paramétrable). Stress test existentiel solo.
      const { startMonth, durationMonths = 2, dailyAllowanceCents = 0, waitingDays = 3 } = sc.params
      const inCats = state.categories.filter((c) => c.direction === 'in')
      const months = []
      for (let i = 0; i < durationMonths; i++) months.push(addMonths(startMonth, i))
      for (const ym of months) {
        if (ym > horizonEnd) continue
        // Annuler les encaissements retenus (réalisé/prévu) des catégories d'entrée :
        // delta = -(montant retenu) pour ramener le flux d'entrée à zéro sur le mois.
        for (const cat of inCats) {
          const retained = retainedFor(ym, cat, actualsByMonth(state.transactions), forecastByMonth(state.forecast), monthOf(todayFor(state.company)))
          if (retained) add(ym, cat.id, -retained)
        }
      }
      // Indemnités journalières TNS : versées à partir du 4e jour (délai de carence), sur
      // une catégorie d'entrée (enc_divers / 1re catégorie in). 0 par défaut.
      if (dailyAllowanceCents > 0) {
        const ijCatId = state.categories.some((c) => c.id === 'enc_divers') ? 'enc_divers' : inCats[0]?.id
        if (ijCatId) {
          months.forEach((ym, idx) => {
            if (ym > horizonEnd) return
            // ~30 jours indemnisés par mois, moins le délai de carence le 1er mois.
            const days = idx === 0 ? Math.max(0, 30 - waitingDays) : 30
            const ij = days * dailyAllowanceCents
            if (ij) add(ym, ijCatId, ij)
          })
        }
      }
    }
  }
  return deltas
}

/**
 * Profil saisonnier : applique aux ENCAISSEMENTS prévisionnels (catégories direction=in)
 * des mois FUTURS un multiplicateur mensuel (company.seasonality.monthly[0..11], base 1).
 * Renvoie des deltas { ym: { catId: cents } } = (multiplicateur - 1) x montant prévu, pour
 * ne JAMAIS toucher le réalisé ni les sorties. Désactivé (deltas vides) si
 * seasonality.enabled !== true (additif et réversible).
 *
 * Le multiplicateur module la PROJECTION linéaire par défaut : un creux d'été (coef < 1)
 * abaisse les encaissements prévus de juillet/août, un pic les rehausse. C'est le profil
 * d'activité paramétrable demandé (vs une moyenne plate).
 */
export function seasonalityDeltas(state, currentMonth) {
  const season = state.company.seasonality
  const deltas = {}
  if (!season?.enabled || !Array.isArray(season.monthly) || season.monthly.length !== 12) return deltas
  const forecasts = forecastByMonth(state.forecast)
  const actuals = actualsByMonth(state.transactions)
  const horizonEnd = horizonEndOf(currentMonth)
  const inCats = state.categories.filter((c) => c.direction === 'in')
  // On démarre au mois COURANT (sa part prévue non encore réalisée bouge aussi) et on
  // s'arrête à l'horizon. Le réalisé des mois passés n'est jamais touché.
  for (const ym of monthRange(currentMonth, horizonEnd)) {
    const monthIdx = Number(ym.slice(5, 7)) - 1
    const coef = season.monthly[monthIdx]
    if (typeof coef !== 'number' || coef === 1) continue
    for (const cat of inCats) {
      // On module le montant RETENU (prévu pour le futur, prévu non réalisé pour le mois
      // courant), pas le forecast brut : cohérent avec le moteur (un mois courant déjà
      // bien réalisé bouge peu).
      const retained = retainedFor(ym, cat, actuals, forecasts, currentMonth)
      if (!retained) continue
      const delta = Math.round(retained * (coef - 1))
      if (!Number.isInteger(delta)) throw new Error(`Delta saisonnier non entier (${ym}/${cat.id})`)
      if (delta) {
        deltas[ym] = deltas[ym] || {}
        deltas[ym][cat.id] = (deltas[ym][cat.id] || 0) + delta
      }
    }
  }
  return deltas
}

/**
 * Fusionne deux jeux de deltas mensuels { ym: { catId: cents } } en un nouveau,
 * en additionnant les montants par (mois, catégorie). N'altère pas les sources.
 */
export function mergeDeltas(...sources) {
  const out = {}
  for (const src of sources) {
    for (const [ym, byCat] of Object.entries(src || {})) {
      out[ym] = out[ym] || {}
      for (const [catId, cents] of Object.entries(byCat)) {
        out[ym][catId] = (out[ym][catId] || 0) + cents
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ Projection
/** Solde réalisé à une date donnée (incluse). */
export function balanceAt(state, date) {
  const opening = state.accounts.reduce((s, a) => s + a.openingBalanceCents, 0)
  return state.transactions.reduce((s, t) => (t.date <= date ? s + t.amountCents : s), opening)
}

// ------------------------------------------------------------------ Réconciliation bancaire
// Écart toléré entre le solde reconstruit (transactions rejouées) et le solde réellement
// constaté sur le relevé bancaire, au-delà duquel on lève une alerte. 50 EUR : assez fin
// pour repérer un import partiel ou un doublon, assez large pour absorber les arrondis et
// quelques frais bancaires non saisis.
const RECONCILE_TOLERANCE_CENTS = 5_000

/**
 * Contrôle de réconciliation : compare le solde RECONSTRUIT par le moteur (ouverture +
 * transactions jusqu'à la date de relevé) au solde RÉELLEMENT constaté sur le relevé
 * (champ `expectedBalanceCents` + `expectedBalanceDate` saisi par compte, ou agrégé sur
 * company). Sans solde attendu renseigné : status 'unknown' (pas de fausse alerte).
 *
 * C'est le garde-fou « rien ne garantit que le solde rejoué colle au relevé » : un import
 * Indy partiel, un doublon de transaction ou une transaction oubliée se voient ici.
 *
 * Retourne { status, expectedCents, reconstructedCents, deltaCents, date, perAccount }.
 * status : 'ok' (|delta| <= tolérance) | 'mismatch' (au-delà) | 'unknown' (pas de relevé).
 */
export function reconciliation(state) {
  const accounts = state.accounts || []
  const transactions = state.transactions || []
  const singleAccount = accounts.length === 1
  const perAccount = []
  let anyExpected = false
  let totalExpected = 0
  let totalReconstructed = 0
  let refDate = null

  for (const acc of accounts) {
    const expected = acc.expectedBalanceCents
    const date = acc.expectedBalanceDate
    if (!Number.isInteger(expected) || !date) {
      perAccount.push({ accountId: acc.id, label: acc.label, status: 'unknown' })
      continue
    }
    anyExpected = true
    refDate = refDate && refDate > date ? refDate : date
    // Solde reconstruit de CE compte à la date du relevé. Une transaction sans
    // accountId est rattachée au compte unique (cas mono-compte fréquent) ; sinon on
    // ne compte que les transactions explicitement du compte.
    const reconstructed = transactions.reduce(
      (s, t) =>
        (t.date <= date && (t.accountId === acc.id || (singleAccount && t.accountId == null)))
          ? s + t.amountCents
          : s,
      acc.openingBalanceCents,
    )
    const delta = reconstructed - expected
    totalExpected += expected
    totalReconstructed += reconstructed
    perAccount.push({
      accountId: acc.id,
      label: acc.label,
      date,
      expectedCents: expected,
      reconstructedCents: reconstructed,
      deltaCents: delta,
      status: Math.abs(delta) <= RECONCILE_TOLERANCE_CENTS ? 'ok' : 'mismatch',
    })
  }

  if (!anyExpected) {
    return { status: 'unknown', toleranceCents: RECONCILE_TOLERANCE_CENTS, perAccount }
  }
  const deltaCents = totalReconstructed - totalExpected
  return {
    status: Math.abs(deltaCents) <= RECONCILE_TOLERANCE_CENTS ? 'ok' : 'mismatch',
    expectedCents: totalExpected,
    reconstructedCents: totalReconstructed,
    deltaCents,
    date: refDate,
    toleranceCents: RECONCILE_TOLERANCE_CENTS,
    perAccount,
  }
}

/**
 * Série quotidienne passée + points mensuels projetés.
 * Retourne { series, monthly, lowPoint, balanceTodayCents }.
 * options.deltas : overlays de scénarios (sortie de scenarioDeltas).
 */
export function project(state, { fromDate = null, toDate = null, deltas = {} } = {}) {
  const today = todayFor(state.company)
  const currentMonth = monthOf(today)
  const horizonEnd = horizonEndOf(currentMonth)
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const opening = state.accounts.reduce((s, a) => s + a.openingBalanceCents, 0)
  const startDate = state.accounts[0].openingDate

  // Profil saisonnier (lot 3) : module les encaissements prévisionnels futurs par un
  // multiplicateur mensuel paramétrable. Désactivé par défaut (deltas vides). Appliqué
  // AVANT la fiscalité dérivée pour que la TVA collectée suive l'activité saisonnalisée
  // (la TVA se dérive des montants retenus + ces deltas le cas échéant ? non : la TVA
  // dérivée lit retainedFor, pas les deltas saisonniers -> on l'accepte comme proto, la
  // saisonnalité reste une couche d'ajustement de tréso, pas de re-dérivation TVA).
  const seasonal = seasonalityDeltas(state, currentMonth)
  // Deltas fiscaux dérivés (TVA à reverser + provision URSSAF/TNS) : remplacent les
  // lignes en dur du forecast (dec_tva, dec_urssaf) par des montants calculés sur les
  // flux. Fusionnés AVANT les deltas de scénarios pour que les scénarios (ex. hausse
  // de rému) se combinent avec la fiscalité dérivée le cas échéant.
  const derived = derivedFiscalDeltas(state, { actuals, forecasts, currentMonth })
  deltas = mergeDeltas(seasonal, derived.deltas, deltas)

  // --- série quotidienne réalisée
  const txnByDate = {}
  for (const t of state.transactions) txnByDate[t.date] = (txnByDate[t.date] || 0) + t.amountCents
  const series = []
  let bal = opening
  for (let d = startDate; d <= today; d = addDays(d, 1)) {
    bal += txnByDate[d] || 0
    series.push({ date: d, actualCents: bal, projectedCents: null })
  }
  const balanceTodayCents = bal

  // --- points mensuels projetés (fin de mois), scénarios appliqués
  const retainedNet = (ym) =>
    state.categories.reduce((s, cat) => s + retainedFor(ym, cat, actuals, forecasts, currentMonth), 0) +
    Object.values(deltas[ym] || {}).reduce((s, v) => s + v, 0)

  // raccord : la série projetée démarre sur le dernier point réel
  if (series.length) series[series.length - 1].projectedCents = balanceTodayCents

  // ancres mensuelles projetées (fin de mois), puis interpolation quotidienne :
  // l'axe X du graphique est catégoriel à pas quotidien, le futur doit avoir la même densité
  const monthly = []
  const anchors = [{ date: today, cents: balanceTodayCents }]
  let projBal = balanceTodayCents
  {
    const realizedCurrent = state.categories.reduce((s, c) => s + (actuals[currentMonth]?.[c.id] || 0), 0)
    const remaining = retainedNet(currentMonth) - realizedCurrent
    projBal += remaining
    anchors.push({ date: endOfMonth(currentMonth), cents: projBal })
  }
  for (const ym of monthRange(addMonths(currentMonth, 1), horizonEnd)) {
    projBal += retainedNet(ym)
    anchors.push({ date: endOfMonth(ym), cents: projBal })
  }
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1]
    const to = anchors[i]
    const span = Math.round((Date.parse(to.date) - Date.parse(from.date)) / 86_400_000)
    for (let j = 1; j <= span; j++) {
      const date = addDays(from.date, j)
      const cents = Math.round(from.cents + ((to.cents - from.cents) * j) / span)
      series.push({ date, actualCents: null, projectedCents: j === span ? to.cents : cents })
    }
  }

  // --- table mensuelle (waterfall) : ouverture / entrées / sorties / clôture
  let monthlyOpening = opening
  for (const ym of monthRange(monthOf(startDate), horizonEnd)) {
    let inCents = 0
    let outCents = 0
    for (const cat of state.categories) {
      const v = retainedFor(ym, cat, actuals, forecasts, currentMonth) + (deltas[ym]?.[cat.id] || 0)
      if (v >= 0) inCents += v
      else outCents += v
    }
    const closing = monthlyOpening + inCents + outCents
    monthly.push({
      month: ym,
      openingCents: monthlyOpening,
      inCents,
      outCents,
      closingCents: closing,
      projected: ym >= currentMonth,
    })
    monthlyOpening = closing
  }

  // --- point bas projeté (à partir d'aujourd'hui)
  const futurePoints = series.filter((p) => p.projectedCents !== null)
  const lowPoint = futurePoints.reduce((min, p) => (p.projectedCents < min.projectedCents ? p : min), futurePoints[0])
  // Point bas des 90 prochains jours, aujourd'hui exclu (aujourd'hui = solde du jour,
  // déjà affiché) : c'est le « creux à venir » que lit le bandeau du tableau de bord.
  const in90 = addDays(today, 90)
  const next90 = futurePoints.filter((p) => p.date > today && p.date <= in90)
  const low90 = next90.length ? next90.reduce((min, p) => (p.projectedCents < min.projectedCents ? p : min), next90[0]) : null
  // Trésorerie projetée à la clôture de décembre de l'année en cours.
  const yearEndRow = monthly.find((m) => m.month === `${today.slice(0, 4)}-12`)

  // --- solde NET disponible : on retranche du solde brut la trésorerie engagée
  // (TVA à reverser + provision URSSAF dues à horizon court, déjà certaines mais pas
  // encore décaissées). Additif et réversible : si la fiscalité dérivée est inactive,
  // committed = 0 et netAvailable = balanceToday (zéro changement de comportement).
  const { vatDueCents: vatDerivedCents, socialProvisionCents } = committedFromDerived(derived, currentMonth, COMMITTED_WINDOW_MONTHS)
  // Dette de TVA RÉELLE de la compta (balance Indy : collectée - déductible - crédit),
  // si renseignée : elle prime sur la TVA dérivée des flux, car c'est le vrai montant dû
  // à l'État à date. Fallback sur la dérivée (comportement antérieur).
  const vatDueActualCents = state.company.fiscal?.vatDueActualCents
  // Régime annuel (fiscal.tva.regime === 'annuel' + dueDate) : la dette réelle n'est
  // « engagée » que si son échéance tombe dans la fenêtre courte ; sinon elle reste
  // affichée (tvaAReverserCents) mais ne grève pas le net disponible du jour.
  // Choix retenu : la dette de TVA réelle est retenue QUELLE QUE SOIT son échéance. En
  // régime annuel (CA12 payée en mai N+1), ne la compter que si l'échéance tombe dans la
  // fenêtre courte gonflait le disponible de toute la TVA collectée de l'année. La TVA
  // collectée n'est jamais à l'entreprise, même payable dans huit mois.
  const vatDueCents = Number.isInteger(vatDueActualCents) && vatDueActualCents > 0 ? vatDueActualCents : vatDerivedCents
  // Trésorerie engagée = ce qui n'est PAS à moi : dette TVA + provision URSSAF.
  const committedCents = vatDueCents + socialProvisionCents
  // Provisions DÉJÀ mises de côté sur les sous-comptes dédiés (ce que le dirigeant a
  // sécurisé). Le perso est une réserve affectée distincte (argent qu'il se garde).
  const ph = state.company.provisionsHeld || {}
  const provisionsHeldCents = (ph.tvaCents || 0) + (ph.urssafCents || 0)
  const persoReserveCents = ph.persoCents || 0
  // Reste à mettre de côté pour couvrir les dettes (info de gestion).
  const resteAProvisionnerCents = Math.max(0, committedCents - provisionsHeldCents)
  // Net réellement libre : solde consolidé - engagé (dettes) - réserve perso affectée,
  // sans jamais compter comme libre ce qui est déjà mis de côté sur les sous-comptes :
  // si le dirigeant a provisionné plus que la dette calculée, l'excédent reste sur les
  // sous-comptes, il n'est pas « disponible ». Équivaut à : compte courant - reste à
  // provisionner.
  const netAvailableCents = balanceTodayCents - Math.max(committedCents, provisionsHeldCents) - persoReserveCents

  // --- runway : nombre de mois de réserve avant épuisement, calculé sur le NET
  // disponible (pas le brut), en divisant par le burn mensuel net lissé. Deux bases :
  //   - burn lissé (moyenne des sorties nettes des mois clos déficitaires)
  //   - worst-case (zéro nouvel encaissement : on consomme toutes les charges fixes)
  const runway = computeRunway(state, { actuals, currentMonth, netAvailableCents, breakEven: null })

  return {
    today,
    balanceTodayCents,
    netAvailableCents,
    committedCents,
    vatDueCents,
    socialProvisionCents,
    provisionsHeldCents,
    persoReserveCents,
    resteAProvisionnerCents,
    runwayMonths: runway.runwayMonths,
    runwayWorstCaseMonths: runway.runwayWorstCaseMonths,
    monthlyBurnNetCents: runway.monthlyBurnNetCents,
    // Série bornée à la fenêtre d'affichage [fromDate, toDate] (sélecteur 1M/3M/6M/12M).
    // Le point bas et les KPI restent calculés sur l'horizon complet ci-dessus.
    series:
      fromDate || toDate
        ? series.filter((p) => (!fromDate || p.date >= fromDate) && (!toDate || p.date <= toDate))
        : series,
    monthly,
    lowPoint: { date: lowPoint.date, cents: lowPoint.projectedCents },
    lowPoint90: low90 ? { date: low90.date, cents: low90.projectedCents } : null,
    yearEndProjected: yearEndRow ? { month: yearEndRow.month, cents: yearEndRow.closingCents } : null,
  }
}

/**
 * Burn mensuel net et runway. Le burn = moyenne des soldes nets mensuels NÉGATIFS
 * (entrées - sorties d'un mois clos) sur BURN_LOOKBACK_MONTHS, en valeur absolue
 * (EUR consommés par mois). On ne compte que les mois déficitaires : un mois
 * excédentaire ne « finance » pas le runway (prudence). Si aucun mois déficitaire
 * sur la fenêtre, le burn lissé est 0 -> runway null (pas de descente, on n'invente
 * pas un infini).
 *
 * runwayMonths = netAvailable / burn lissé (null si burn = 0 ou net <= 0).
 * runwayWorstCaseMonths = net / charges fixes mensuelles (zéro nouvel encaissement),
 * la borne basse pessimiste. Retourne aussi les bases pour la transparence.
 */
export function computeRunway(state, { actuals, currentMonth, netAvailableCents }) {
  // Soldes nets des mois CLOS (réalisé seul), sur la fenêtre de lookback.
  const monthlyNets = []
  for (let i = 1; i <= BURN_LOOKBACK_MONTHS; i++) {
    const ym = addMonths(currentMonth, -i)
    const byCat = actuals[ym]
    if (!byCat) continue
    const net = Object.values(byCat).reduce((s, v) => s + v, 0)
    monthlyNets.push(net)
  }
  const deficits = monthlyNets.filter((n) => n < 0).map((n) => -n)
  const monthlyBurnNetCents = deficits.length
    ? Math.round(deficits.reduce((s, v) => s + v, 0) / deficits.length)
    : 0

  const runwayMonths =
    monthlyBurnNetCents > 0 && netAvailableCents > 0
      ? Math.round((netAvailableCents / monthlyBurnNetCents) * 10) / 10
      : null

  // Worst-case : aucun nouvel encaissement, on ne supporte que les charges fixes
  // moyennées (point mort). Borne basse du runway. null si pas de charge fixe connue.
  const fixedMonthly = fixedChargesMonthly(state, actuals, currentMonth)
  const runwayWorstCaseMonths =
    fixedMonthly > 0 && netAvailableCents > 0
      ? Math.round((netAvailableCents / fixedMonthly) * 10) / 10
      : null

  return { runwayMonths, runwayWorstCaseMonths, monthlyBurnNetCents, fixedChargesMonthlyCents: fixedMonthly }
}

/**
 * Total mensuel des charges fixes (cat.fixed === true), moyenné sur les 6 derniers
 * mois clos, en valeur absolue positive (montants tels que saisis, TTC ou HT selon la
 * source). Sert au runway worst-case. Voisin de fiscal.breakEvenMonthly mais sans
 * conversion HT (le worst-case raisonne en cash décaissé, pas en résultat).
 */
function fixedChargesMonthly(state, actuals, currentMonth, lookbackMonths = 6) {
  const fixedCats = state.categories.filter((c) => c.direction === 'out' && c.fixed === true)
  let total = 0
  for (const cat of fixedCats) {
    let sum = 0
    let count = 0
    for (let i = 1; i <= lookbackMonths; i++) {
      const v = actuals[addMonths(currentMonth, -i)]?.[cat.id]
      if (v) {
        sum += Math.abs(v)
        count += 1
      }
    }
    if (count) total += Math.round(sum / count)
  }
  return total
}

// ------------------------------------------------------------------ KPI
export function kpis(state, projection) {
  const today = todayFor(state.company)
  const d30 = addDays(today, -30)
  let in30 = 0
  let out30 = 0
  for (const t of state.transactions) {
    if (t.date > d30 && t.date <= today) {
      if (t.amountCents >= 0) in30 += t.amountCents
      else out30 += t.amountCents
    }
  }
  const balance30dAgo = balanceAt(state, d30)
  const currentMonth = monthOf(today)
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  // Point mort mensuel (charges fixes HT moyennées) et résultat prévisionnel de
  // l'exercice (produits HT - charges HT - IS). Trois plans distincts exposés ici :
  // trésorerie (solde/NET/runway), rentabilité (résultat), dette (TVA/cotisations).
  const breakEven = breakEvenMonthly(state, actuals, currentMonth)
  const resultat = resultatPrevisionnel(state, { actuals, forecasts, currentMonth })
  return {
    balanceTodayCents: projection.balanceTodayCents,
    deltaVs30dCents: projection.balanceTodayCents - balance30dAgo,
    in30dCents: in30,
    out30dCents: out30,
    lowPoint: projection.lowPoint,
    lowPoint90: projection.lowPoint90,
    yearEndProjected: projection.yearEndProjected,
    // Compte courant hors sous-comptes de provision (relevé de la compta, comme le
    // dirigeant le lit dans sa banque). null si l'import ne le fournit pas.
    currentAccountCents: (state.accounts || []).some((a) => Number.isInteger(a.currentAccountCents))
      ? (state.accounts || []).reduce((s, a) => s + (a.currentAccountCents || 0), 0)
      : null,
    lowCashThresholdCents: state.company.lowCashThresholdCents,
    // --- solde NET disponible (« combien de ce solde est vraiment à moi »).
    // Noms figés par le contrat (décision 7) : le front consomme ceux-ci.
    netAvailableCents: projection.netAvailableCents,
    committedCents: projection.committedCents,
    vatDueCents: projection.vatDueCents,
    socialProvisionCents: projection.socialProvisionCents,
    provisionsHeldCents: projection.provisionsHeldCents,
    persoReserveCents: projection.persoReserveCents,
    resteAProvisionnerCents: projection.resteAProvisionnerCents,
    // --- runway (mois de réserve sur le NET, lissé sur le burn ; worst-case sans
    // nouvel encaissement). null = pas de descente sous épuisement détectée.
    runwayMonths: projection.runwayMonths,
    runwayWorstCaseMonths: projection.runwayWorstCaseMonths,
    monthlyBurnNetCents: projection.monthlyBurnNetCents,
    // --- point mort mensuel (seuil de rentabilité) : CA HT/mois à encaisser pour
    // couvrir les charges fixes récurrentes.
    breakEvenHTCents: breakEven.breakEvenHTCents,
    breakEvenLookbackMonths: breakEven.lookbackMonths,
    // --- résultat prévisionnel de l'exercice (rentabilité, distinct de la tréso).
    resultatPrevisionnel: {
      exerciseYear: resultat.exerciseYear,
      productsHTCents: resultat.productsHTCents,
      chargesHTCents: resultat.chargesHTCents,
      resultatAvantISCents: resultat.resultatAvantISCents,
      isProvisionCents: resultat.isProvisionCents,
      resultatApresISCents: resultat.resultatApresISCents,
    },
    // --- compte courant d'associé (rému attribuée non versée) : ce que la société
    // DOIT au gérant. null si la fenêtre CCA n'est pas paramétrée. Levier clé : un
    // remboursement de CCA sort SANS cotisations ni impôt.
    cca: ccaStatus(state),
    // --- seuil de sécurité SUGGÉRÉ = 1,5 mois de consommation nette réelle (burn
    // lissé). null si aucun burn détecté. À comparer au seuil configuré (qui reste
    // souverain) : un seuil rond posé à la main peut être déconnecté du vrai rythme.
    suggestedThresholdCents:
      projection.monthlyBurnNetCents ? Math.round(projection.monthlyBurnNetCents * 1.5) : null,
    // Alias français explicites (consigne lot 2 A) pour les libellés métier.
    soldeBrutCents: projection.balanceTodayCents,
    // Régime annuel : afficher la dette réelle à date (payable à l'échéance CA12), même si
    // elle n'est pas « engagée » à court terme ; le net disponible, lui, ne la retranche pas.
    tvaAReverserCents: state.company.fiscal?.tva?.regime === 'annuel' && Number.isInteger(state.company.fiscal?.vatDueActualCents)
      ? state.company.fiscal.vatDueActualCents : projection.vatDueCents,
    tvaDueDate: state.company.fiscal?.tva?.regime === 'annuel' ? state.company.fiscal?.tva?.dueDate || null : null,
    cotisationsProvisionneesCents: projection.socialProvisionCents,
    soldeNetDisponibleCents: projection.netAvailableCents,
    // Fenêtre (mois) sur laquelle la trésorerie engagée est sommée, pour le front.
    committedWindowMonths: COMMITTED_WINDOW_MONTHS,
  }
}

// ------------------------------------------------------------------ Fraîcheur des données
// Seuils du bandeau « données au JJ/MM par source » : âge calculé serveur contre
// todayFor(company) (demoToday figé en démo, date réelle sur les vraies données - c'est ce
// qui fait vieillir le bandeau entre deux imports), jamais new Date() au front.
const FRESHNESS_WARN_DAYS = 10 // au-delà : orange
const FRESHNESS_STALE_DAYS = 30 // au-delà : rouge

/**
 * Âge et niveau d'alerte de chaque source de données (indy, twenty, ...).
 * Retourne { indy: { date, daysOld, level }, ... }. level: 'fresh' | 'warn' | 'stale' | 'unknown'.
 * Tolère l'absence de company.importedAt ou d'une source -> level 'unknown' (pas d'alerte trompeuse).
 */
export function dataFreshness(company) {
  const today = todayFor(company)
  const imported = company.importedAt || {}
  const out = {}
  for (const [source, date] of Object.entries(imported)) {
    if (!date || typeof date !== 'string') {
      out[source] = { date: null, daysOld: null, level: 'unknown' }
      continue
    }
    const daysOld = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000)
    let level = 'fresh'
    if (daysOld > FRESHNESS_STALE_DAYS) level = 'stale'
    else if (daysOld > FRESHNESS_WARN_DAYS) level = 'warn'
    out[source] = { date, daysOld, level }
  }
  return out
}

// ------------------------------------------------------------------ Grille prévisionnel
/** Données de la grille : pour chaque (mois, catégorie), prévu / réalisé / retenu. */
export function forecastGrid(state) {
  const today = todayFor(state.company)
  const currentMonth = monthOf(today)
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const months = monthRange(gridStart(currentMonth), horizonEndOf(currentMonth))
  const notes = {}
  // Détail d'une case : lignes nommées du prévisionnel
  // (champ `details` d'une entrée forecast) et mouvements bancaires réels du mois.
  const details = {}
  for (const f of state.forecast) {
    if (f.note) notes[`${f.month}|${f.categoryId}`] = f.note
    if (Array.isArray(f.details) && f.details.length) details[`${f.month}|${f.categoryId}`] = f.details
  }
  const actualDetails = {}
  for (const t of state.transactions || []) {
    if (!t.date || !t.categoryId) continue
    const key = `${monthOf(t.date)}|${t.categoryId}`
    ;(actualDetails[key] ||= []).push({ date: t.date, label: t.label || '', amountCents: t.amountCents })
  }
  for (const k of Object.keys(actualDetails)) {
    actualDetails[k].sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))
  }

  // Deltas fiscaux dérivés (TVA réelle + provision URSSAF pilotée par la rému), IDENTIQUES
  // à ceux appliqués à la projection/solde. Sans eux, les lignes TVA/URSSAF de la grille
  // afficheraient le forecast brut (faux) et ne sommeraient pas vers le solde de pied.
  const { deltas: fiscalDeltas } = derivedFiscalDeltas(state, { actuals, forecasts, currentMonth })
  const autoIds = autoManagedCategoryIds(state.company)

  const rows = state.categories.map((cat) => {
    // Lignes pilotées automatiquement (TVA dérivée, provision URSSAF, IS) : non
    // éditables, car le moteur les recalcule. Un ajustement passe par une proposition
    // de l'assistant (additif par-dessus le montant dérivé), jamais par la grille.
    const isAuto = autoIds.has(cat.id)
    return {
      categoryId: cat.id,
      label: cat.label,
      direction: cat.direction,
      cells: months.map((ym) => {
        const delta = fiscalDeltas[ym]?.[cat.id] || 0
        const baseForecast = forecasts[ym]?.[cat.id] ?? null
        return {
          month: ym,
          actualCents: actuals[ym]?.[cat.id] ?? null,
          forecastCents: delta ? (baseForecast || 0) + delta : baseForecast,
          retainedCents: retainedFor(ym, cat, actuals, forecasts, currentMonth) + delta,
          note: notes[`${ym}|${cat.id}`] || null,
          details: details[`${ym}|${cat.id}`] || null,
          actualDetails: ym <= currentMonth ? actualDetails[`${ym}|${cat.id}`] || null : null,
          editable: ym >= currentMonth && !isAuto,
        }
      }),
    }
  })

  // pied de grille : solde de fin de mois (réalisé puis projeté)
  const proj = project(state)
  const closingByMonth = {}
  for (const m of proj.monthly) closingByMonth[m.month] = { closingCents: m.closingCents, projected: m.projected }

  return { months, currentMonth, rows, closings: months.map((ym) => ({ month: ym, ...closingByMonth[ym] })) }
}
