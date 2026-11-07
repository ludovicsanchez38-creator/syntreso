// Échéancier des sorties datées (cash calendar 60-90 jours).
//
// Le moteur de projection (projection.js) reste MENSUEL : il dit « combien il reste fin
// de mois ». Mais un dirigeant solo se fait piéger par la CONCENTRATION d'échéances le
// même jour (TVA le 22 + URSSAF + loyer la même semaine). Ce service ne refond PAS le
// moteur en quotidien : il pose une COUCHE d'affichage qui DATE finement seulement les
// 3-4 grosses sorties certaines (TVA, URSSAF/cotisations, échéances saisies à la main)
// sur une fenêtre courte, pour un « voici ce qui sort dans les 60-90 jours ».
//
// Deux origines :
//  - DÉRIVÉES (source 'derived') : recalculées des flux via fiscal.js (TVA due M-1
//    payée le payDayOfMonth de M ; provision URSSAF du mois). Idempotentes : un même
//    (mois, kind) produit toujours le même id, jamais de doublon.
//  - SAISIES (source 'manual' | 'agent') : lues depuis echeances.json (tolérant à
//    l'absence du fichier). Pour dater une grosse sortie ponctuelle (CFE en décembre,
//    acompte IS, gros achat programmé) que le prévisionnel mensuel lisse.
//
// Montants en CENTIMES ENTIERS, négatifs pour une sortie (convention moteur).

import { readJsonOr } from './store.js'
import { monthOf, addMonths, monthRange, addDays, todayFor } from './dates.js'
import { vatForMonth, vatRestantDuMois, socialProvisionForMonth, resultatPrevisionnel, urssafEcheancier } from './fiscal.js'

// Fenêtre par défaut du cash calendar, en jours à partir d'aujourd'hui.
const DEFAULT_HORIZON_DAYS = 90

// Jour du mois retenu pour la provision URSSAF/TNS dérivée quand aucune date précise
// n'est connue (le prélèvement SSI tombe en général en début de mois). Utilisé seulement
// pour POSITIONNER l'échéance dans le calendrier, pas pour le calcul du montant.
const URSSAF_DEFAULT_DAY = 5

const KINDS = new Set(['tva', 'urssaf', 'is', 'loyer', 'assurance', 'emprunt', 'autre'])

/** Construit une date 'YYYY-MM-DD' pour un mois 'YYYY-MM' et un jour, borné au dernier jour. */
function dateInMonth(ym, day) {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${ym}-${String(Math.min(Math.max(1, day), last)).padStart(2, '0')}`
}

/**
 * Échéances DÉRIVÉES des flux (TVA + provision URSSAF/TNS), datées, sur la fenêtre.
 * Ne dépend d'aucun taux en dur : tout vient de fiscal.js (vatForMonth /
 * socialProvisionForMonth), donc des taux paramétrés dans company.fiscal.
 */
function derivedEcheances(state, { actuals, forecasts, currentMonth, fromDate, toDate }) {
  const fiscal = state.company.fiscal || {}
  const out = []

  // --- TVA, régime ANNUEL (CA12) : un seul paiement à fiscal.tva.dueDate, même bloc
  // que la projection (fiscal.js) : dette réelle à date + TVA nette de l'activité de
  // l'exercice précédant l'échéance. Sans cette branche, le calendrier posait des CA3
  // mensuelles qui n'existent pas (des sorties en trop sur la fenêtre de 90 jours).
  const tvaAnnuelle = fiscal.tva?.regime === 'annuel' && /^\d{4}-\d{2}-\d{2}$/.test(fiscal.tva?.dueDate || '')
  const annuelJusquau = tvaAnnuelle ? fiscal.tva?.annuelJusquau || null : null
  if (fiscal.tva?.autoCompute && tvaAnnuelle) {
    const dueDate = fiscal.tva.dueDate
    if (dueDate >= fromDate && dueDate <= toDate) {
      const dueMonth = monthOf(dueDate)
      let total = Math.max(0, fiscal.vatDueActualCents || 0)
      for (const ym of monthRange(currentMonth, addMonths(dueMonth, -1))) {
        if (annuelJusquau && ym > annuelJusquau) continue
        if (ym.slice(0, 4) < dueMonth.slice(0, 4)) total += vatRestantDuMois(ym, state, actuals, forecasts, currentMonth)
      }
      if (total) {
        out.push({
          id: `ech_${dueMonth}_tva`,
          label: `TVA annuelle CA12`,
          categoryId: 'dec_tva',
          dueDate,
          amountCents: -total,
          kind: 'tva',
          recurrence: 'annual',
          source: 'derived',
          note: 'TVA de l\'exercice, payée en une fois à l\'échéance du régime annuel',
        })
      }
    }
  }

  // --- TVA : la TVA due de l'activité du mois M se paie le payDayOfMonth de M+1.
  if (fiscal.tva?.autoCompute && (!tvaAnnuelle || annuelJusquau)) {
    const payDay = fiscal.tva.payDayOfMonth || 22
    // Mois d'activité dont le reversement tombe dans la fenêtre : on couvre largement
    // (mois courant-1 .. quelques mois en avant), puis on filtre par date.
    const startActivity = addMonths(monthOf(fromDate), -1)
    const endActivity = monthOf(toDate)
    for (const ym of monthRange(startActivity, endActivity)) {
      if (annuelJusquau && ym <= annuelJusquau) continue // couverte par la CA12
      const payMonth = addMonths(ym, 1)
      const dueDate = dateInMonth(payMonth, payDay)
      if (dueDate < fromDate || dueDate > toDate) continue
      const { dueCents } = vatForMonth(ym, state, actuals, forecasts, currentMonth)
      if (!dueCents) continue
      out.push({
        id: `ech_${payMonth}_tva`,
        label: `TVA CA3 ${ym}`,
        categoryId: 'dec_tva',
        dueDate,
        amountCents: -dueCents, // sortie => négatif
        kind: 'tva',
        recurrence: 'monthly',
        source: 'derived',
        note: `TVA à reverser de l'activité de ${ym}, payée le ${payDay} du mois suivant`,
      })
    }
  }

  // --- URSSAF/TNS : appels réels datés (échéancier saisi) sur les mois qu'ils
  // couvrent, provision dérivée (datée en début de mois) au-delà. Même logique que
  // derivedFiscalDeltas (fiscal.js) : le calendrier doit sommer vers la projection.
  if (fiscal.tns?.autoCompute) {
    const provId = fiscal.tns.provisionCategoryId || 'dec_urssaf'
    const sched = urssafEcheancier(state, { actuals, forecasts, currentMonth })
    for (const ym of monthRange(currentMonth, monthOf(toDate))) {
      // Mois couverts par l'échéancier (appels réels ci-dessous) OU fin d'une année
      // couverte (dette réglée par la régularisation N+1) : pas de provision de repli.
      if (sched && (ym <= sched.lastKnown || sched.coveredYears.has(ym.slice(0, 4)))) continue
      const dueDate = dateInMonth(ym, URSSAF_DEFAULT_DAY)
      if (dueDate < fromDate || dueDate > toDate) continue
      const provision = socialProvisionForMonth(ym, state, actuals, forecasts, currentMonth)
      if (!provision) continue
      out.push({
        id: `ech_${ym}_urssaf`,
        label: `Cotisations URSSAF/TNS ${ym}`,
        categoryId: provId,
        dueDate,
        amountCents: -provision,
        kind: 'urssaf',
        recurrence: 'monthly',
        source: 'derived',
        note: 'Provision sociale dérivée de la rémunération du mois',
      })
    }
    if (sched) {
      for (const e of sched.echeances) {
        if (e.dueDate < fromDate || e.dueDate > toDate) continue
        const ym = monthOf(e.dueDate)
        if (ym < currentMonth || actuals[ym]?.[provId]) continue // passé ou déjà prélevé
        out.push({
          id: `ech_${ym}_urssaf`,
          label: e.label || `Appel URSSAF ${ym}`,
          categoryId: provId,
          dueDate: e.dueDate,
          amountCents: -e.amountCents,
          kind: 'urssaf',
          recurrence: 'quarterly',
          source: 'derived',
          note: 'Appel de cotisations réel (échéancier urssaf.fr saisi dans company.fiscal)',
        })
      }
      for (const r of sched.reguls) {
        const dueDate = dateInMonth(r.dueMonth, URSSAF_DEFAULT_DAY)
        if (dueDate < fromDate || dueDate > toDate) continue
        out.push({
          id: `ech_${r.dueMonth}_urssaf_regul`,
          label: `Régularisation URSSAF ${r.year}`,
          categoryId: provId,
          dueDate,
          amountCents: -r.amountCents,
          kind: 'urssaf',
          recurrence: 'once',
          source: 'derived',
          note: `Cotisations dues au titre de ${r.year} (provision dérivée) moins appels réels : rattrapage estimé, date A_CONFIRMER avec l'EC`,
        })
      }
    }
  }

  // --- Solde d'IS de l'exercice N, payé le 15 du mois fiscal.is.payMonth de N+1 (défaut mai, clôture 31/12, pas
  // d'acomptes modélisés). Estimé par le compte de résultat prévisionnel. Le
  // décaissement correspondant est posé dans la projection par derivedFiscalDeltas
  // (fiscal.is.autoDecaissement) ; ici on le DATE dans le calendrier.
  if (fiscal.is?.autoDecaissement === true) {
    const isPayMonth = fiscal.is?.payMonth || '05'
    for (let y = Number(monthOf(fromDate).slice(0, 4)) - 1; `${y + 1}-${isPayMonth}` <= monthOf(toDate); y++) {
      const dueDate = `${y + 1}-${isPayMonth}-15`
      if (dueDate < fromDate || dueDate > toDate) continue
      const { isProvisionCents } = resultatPrevisionnel(state, { actuals, forecasts, currentMonth }, String(y))
      if (!isProvisionCents) continue
      out.push({
        id: `ech_${y + 1}-04_is`,
        label: `Solde IS exercice ${y}`,
        categoryId: fiscal.is.categoryId || 'dec_is',
        dueDate,
        amountCents: -isProvisionCents,
        kind: 'is',
        recurrence: 'annual',
        source: 'derived',
        note: `IS estimé de l'exercice ${y} (compte de résultat prévisionnel), solde au 15/${isPayMonth}/${y + 1}`,
      })
    }
  }

  // --- CFE : date fixe (15/12 par défaut), montant PARAMÉTRÉ (company.fiscal.cfe :
  // { amountCents, dueDay?, dueMonth? }). Jamais de montant inventé : sans paramètre,
  // aucune ligne (le montant dépend de la commune et des exonérations).
  if (Number.isInteger(fiscal.cfe?.amountCents) && fiscal.cfe.amountCents > 0) {
    const dueMonth = fiscal.cfe.dueMonth || 12
    const dueDay = fiscal.cfe.dueDay || 15
    for (let y = Number(monthOf(fromDate).slice(0, 4)); y <= Number(monthOf(toDate).slice(0, 4)); y++) {
      const dueDate = dateInMonth(`${y}-${String(dueMonth).padStart(2, '0')}`, dueDay)
      if (dueDate < fromDate || dueDate > toDate) continue
      out.push({
        id: `ech_${y}-${String(dueMonth).padStart(2, '0')}_cfe`,
        label: `CFE ${y}`,
        categoryId: fiscal.cfe.categoryId || null,
        dueDate,
        amountCents: -fiscal.cfe.amountCents,
        kind: 'autre',
        recurrence: 'annual',
        source: 'derived',
        note: 'CFE (montant paramétré dans company.fiscal.cfe, à ajuster à réception de l\'avis)',
      })
    }
  }

  return out
}

/**
 * Normalise et valide une échéance SAISIE (echeances.json). Rejette silencieusement
 * (retourne null) les lignes malformées plutôt que de planter tout le calendrier.
 */
function normalizeManual(raw, categoryIds) {
  if (!raw || typeof raw !== 'object') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate || '')) return null
  if (!Number.isInteger(raw.amountCents)) return null
  if (raw.categoryId && !categoryIds.has(raw.categoryId)) return null
  const kind = KINDS.has(raw.kind) ? raw.kind : 'autre'
  return {
    id: raw.id || `ech_${raw.dueDate.slice(0, 7)}_${kind}`,
    label: String(raw.label || kind),
    categoryId: raw.categoryId || null,
    dueDate: raw.dueDate,
    amountCents: raw.amountCents,
    kind,
    recurrence: raw.recurrence || 'once',
    source: raw.source === 'agent' ? 'agent' : 'manual',
    note: raw.note || null,
  }
}

/**
 * Cash calendar : toutes les sorties (et entrées datées) certaines sur la fenêtre, des
 * deux origines (dérivées + saisies), triées par date.
 *
 * Retourne { fromDate, toDate, horizonDays, items, totalOutCents, byMonth }.
 * - items : échéances triées par dueDate (puis par id pour la stabilité).
 * - totalOutCents : somme des sorties (valeur négative) sur la fenêtre.
 * - byMonth : regroupement { 'YYYY-MM': { outCents, count } } pour repérer les mois de
 *   concentration d'échéances (le risque du dirigeant solo).
 */
export async function cashCalendar(state, { horizonDays = DEFAULT_HORIZON_DAYS, actuals, forecasts } = {}) {
  const today = todayFor(state.company)
  const currentMonth = monthOf(today)
  const fromDate = today
  const toDate = addDays(today, horizonDays)
  const categoryIds = new Set(state.categories.map((c) => c.id))

  const derived = derivedEcheances(state, { actuals, forecasts, currentMonth, fromDate, toDate })

  const rawManual = await readJsonOr('echeances', [])
  const manual = []
  const seen = new Set(derived.map((e) => e.id))
  for (const raw of Array.isArray(rawManual) ? rawManual : []) {
    const e = normalizeManual(raw, categoryIds)
    if (!e) continue
    if (e.dueDate < fromDate || e.dueDate > toDate) continue
    // Idempotence : une échéance saisie portant le même id qu'une dérivée ne la
    // duplique pas (la dérivée fait foi, elle est recalculée des flux).
    if (seen.has(e.id)) continue
    seen.add(e.id)
    manual.push(e)
  }

  const items = [...derived, ...manual].sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id < b.id ? -1 : 1,
  )

  let totalOutCents = 0
  const byMonth = {}
  for (const e of items) {
    const ym = monthOf(e.dueDate)
    byMonth[ym] = byMonth[ym] || { outCents: 0, inCents: 0, count: 0 }
    byMonth[ym].count += 1
    if (e.amountCents < 0) {
      totalOutCents += e.amountCents
      byMonth[ym].outCents += e.amountCents
    } else {
      byMonth[ym].inCents += e.amountCents
    }
  }

  return { fromDate, toDate, horizonDays, items, totalOutCents, byMonth }
}
