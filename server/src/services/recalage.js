// Recalage du prévisionnel de charges sur le réalisé récent - par PROPOSITIONS,
// jamais d'écriture directe (même doctrine que la sync Twenty : le job propose,
// l'humain tranche dans l'interface, ses ajustements manuels restent maîtres).
//
// Pour chaque catégorie de sortie recalable (cf charges.js : hors TVA dérivée,
// rému/URSSAF pilotées, hors-résultat), on compare :
//   - le PRÉVU mensuel : moyenne des lignes forecast des `compareMonths` prochains mois ;
//   - la CIBLE : charge mensuelle robuste (médiane x fréquence, 6 mois clos).
// Écart au-delà des seuils -> une proposition `forecast_recalage` qui, si confirmée,
// réécrit les lignes de la catégorie du mois prochain à l'horizon.

import { loadState, actualsByMonth, forecastByMonth, monthOf, addMonths, todayFor } from './projection.js'
import { horizonEnd } from './horizon.js'
import { robustMonthlyOut, recalableOutCategories } from './charges.js'
import { readJsonOr, updateJson } from './store.js'

// Seuils : on ne propose un recalage que si l'écart est à la fois relatif (>30 %) et
// absolu (>50 EUR/mois) - en dessous, le bruit ne vaut pas un clic du dirigeant.
const REL_THRESHOLD = 0.30
const ABS_THRESHOLD_CENTS = 5_000
const COMPARE_MONTHS = 6

let recalageSeq = 0

/** Écarts prévu vs cible par catégorie (diagnostic pur, rien d'écrit). */
export function computeRecalage(state) {
  const currentMonth = monthOf(todayFor(state.company))
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const robust = robustMonthlyOut(state, actuals, currentMonth)
  const fromMonth = addMonths(currentMonth, 1)
  const toMonth = horizonEnd(currentMonth)

  const items = []
  for (const cat of recalableOutCategories(state)) {
    const r = robust[cat.id]
    // prévu mensuel = moyenne des cellules forecast des COMPARE_MONTHS prochains mois
    let planned = 0
    let months = 0
    for (let i = 1; i <= COMPARE_MONTHS; i++) {
      const ym = addMonths(currentMonth, i)
      planned += Math.abs(forecasts[ym]?.[cat.id] || 0)
      months += 1
    }
    const plannedMonthly = months ? Math.round(planned / months) : 0
    const targetMonthly = r?.monthlyCents || 0
    if (!plannedMonthly && !targetMonthly) continue
    const gap = targetMonthly - plannedMonthly
    const rel = Math.abs(gap) / Math.max(Math.abs(plannedMonthly), Math.abs(targetMonthly))
    if (Math.abs(gap) <= ABS_THRESHOLD_CENTS || rel <= REL_THRESHOLD) continue
    items.push({
      categoryId: cat.id,
      label: cat.label,
      plannedMonthlyCents: plannedMonthly,
      targetMonthlyCents: targetMonthly,
      gapMonthlyCents: gap,
      medianCents: r?.medianCents || 0,
      presence: r ? `${r.presence}/${r.lookbackMonths}` : '0/6',
      fromMonth,
      toMonth,
    })
  }
  return { currentMonth, fromMonth, toMonth, items }
}

/**
 * Émet une proposition `forecast_recalage` par écart détecté (idempotent : même
 * catégorie + même cible déjà en attente -> sautée). dryRun : diagnostic seul.
 */
export async function recalageCharges({ dryRun = false } = {}) {
  const state = await loadState()
  const report = computeRecalage(state)
  if (dryRun || !report.items.length) {
    return { ok: true, dryRun, ...report, created: 0 }
  }

  const before = (await readJsonOr('proposals', [])).length
  await updateJson(
    'proposals',
    (proposals) => {
      const list = Array.isArray(proposals) ? proposals : []
      let touched = false
      for (const it of report.items) {
        const dup = list.some(
          (p) =>
            p.status === 'pending' &&
            p.kind === 'forecast_recalage' &&
            p.payload?.categoryId === it.categoryId &&
            p.payload?.monthlyCents === -it.targetMonthlyCents,
        )
        if (dup) continue
        recalageSeq += 1
        list.push({
          id: `prop_rc_${Date.now().toString(36)}_${recalageSeq}`,
          createdAt: new Date().toISOString(),
          status: 'pending',
          source: 'recalage-charges',
          kind: 'forecast_recalage',
          payload: {
            kind: 'forecast_recalage',
            categoryId: it.categoryId,
            monthlyCents: -it.targetMonthlyCents, // sortie : signé négatif
            fromMonth: it.fromMonth,
            toMonth: it.toMonth,
            label: `Recalage ${it.label} : ${Math.round(it.plannedMonthlyCents / 100)} -> ${Math.round(it.targetMonthlyCents / 100)} EUR/mois (médiane 6 mois, présent ${it.presence})`,
          },
          context: {
            plannedMonthlyCents: it.plannedMonthlyCents,
            targetMonthlyCents: it.targetMonthlyCents,
            medianCents: it.medianCents,
            presence: it.presence,
          },
        })
        touched = true
      }
      return touched ? list : undefined
    },
    [],
  )
  const after = (await readJsonOr('proposals', [])).length
  return { ok: true, dryRun: false, ...report, created: after - before }
}
