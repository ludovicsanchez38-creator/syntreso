// Alertes calculées à la volée (jamais stockées) : point bas, factures en retard,
// anomalies de charges récurrentes.

import { actualsByMonth, addMonths, monthOf, reconciliation, todayFor } from './projection.js'
import { sanitizeTier } from './sanitize.js'

const ANOMALY_FACTOR = 1.8
// Nombre minimal de mois clos où une catégorie de sortie doit apparaître pour être
// considérée comme une charge récurrente (donc surveillée pour anomalie).
const MIN_RECURRING_MONTHS = 3

// Catégories de charges récurrentes à surveiller, dérivées des données réelles plutôt
// que figées en dur. Une liste en dur couplée aux ids d'un seul jeu de données (la démo
// BTP utilise dec_loyer / dec_leasing / dec_assurances, une autre entreprise aura
// d'autres catégories) laisserait filer en silence les charges récurrentes dès qu'on
// change de jeu de données. On retient ici toute catégorie de sortie présente (montant non nul) dans au
// moins MIN_RECURRING_MONTHS mois clos distincts.
export function recurringCategoryIds(state) {
  const currentMonth = monthOf(todayFor(state.company))
  const isOut = new Map(state.categories.map((c) => [c.id, c.direction === 'out']))
  const monthsByCategory = new Map() // categoryId -> Set des mois clos où elle est non nulle
  for (const t of state.transactions) {
    if (!isOut.get(t.categoryId)) continue
    if (!t.amountCents) continue
    const ym = monthOf(t.date)
    if (ym >= currentMonth) continue // le mois courant n'est pas clos : exclu du décompte
    if (!monthsByCategory.has(t.categoryId)) monthsByCategory.set(t.categoryId, new Set())
    monthsByCategory.get(t.categoryId).add(ym)
  }
  return state.categories
    .filter((c) => (monthsByCategory.get(c.id)?.size || 0) >= MIN_RECURRING_MONTHS)
    .map((c) => c.id)
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export function computeAlerts(state, projection) {
  const today = todayFor(state.company)
  const threshold = state.company.lowCashThresholdCents
  const alerts = []

  // --- point bas projeté sous le seuil
  if (projection.lowPoint.cents < threshold) {
    alerts.push({
      id: 'alert_low_point',
      kind: 'low_point',
      severity: projection.lowPoint.cents < 0 ? 'critical' : 'warning',
      title: 'Point bas projeté sous le seuil',
      detail: `Solde projeté au plus bas le ${projection.lowPoint.date}, sous le seuil de sécurité.`,
      amountCents: projection.lowPoint.cents,
      date: projection.lowPoint.date,
    })
  }

  // --- solde NET disponible sous le seuil alors que le BRUT le dépasse : c'est le
  // cas trompeur que vise le coeur comptable (la TVA collectée + la provision URSSAF
  // « dorment » sur le compte mais ne sont pas à nous). On n'émet l'alerte que si la
  // fiscalité dérivée engage réellement de la trésorerie (committedCents > 0).
  const net = projection.netAvailableCents
  if (typeof net === 'number' && projection.committedCents > 0 && net < threshold && projection.balanceTodayCents >= threshold) {
    alerts.push({
      id: 'alert_net_below_threshold',
      kind: 'net_below_threshold',
      severity: net < 0 ? 'critical' : 'warning',
      title: 'Solde net disponible sous le seuil',
      detail: `Le solde brut (${(projection.balanceTodayCents / 100).toLocaleString('fr-FR')} EUR) couvre le seuil, mais une fois la TVA à reverser et les cotisations provisionnées retranchées, le net disponible (${(net / 100).toLocaleString('fr-FR')} EUR) passe dessous.`,
      amountCents: net,
      committedCents: projection.committedCents,
    })
  }

  // --- réconciliation bancaire : le solde reconstruit (transactions rejouées) s'écarte
  // du solde réellement constaté sur le relevé. Signale un import partiel, un doublon ou
  // une transaction oubliée. N'apparaît que si un solde de relevé est renseigné.
  const reco = reconciliation(state)
  if (reco.status === 'mismatch') {
    const ecart = Math.abs(reco.deltaCents)
    const sens = reco.deltaCents > 0 ? 'au-dessus' : 'en dessous'
    alerts.push({
      id: 'alert_reconciliation',
      kind: 'reconciliation',
      severity: 'warning',
      title: 'Écart de réconciliation bancaire',
      detail: `Le solde reconstruit (${(reco.reconstructedCents / 100).toLocaleString('fr-FR')} EUR) est ${sens} du solde relevé au ${reco.date} (${(reco.expectedCents / 100).toLocaleString('fr-FR')} EUR), écart de ${(ecart / 100).toLocaleString('fr-FR')} EUR. Vérifier l'import (transaction manquante, doublon ou frais non saisis).`,
      amountCents: reco.deltaCents,
      date: reco.date,
    })
  }

  // --- factures en retard (statut recalculé contre demoToday, pas le champ stocké)
  for (const inv of state.invoices) {
    if (inv.status === 'paid') continue
    if (inv.dueDate < today) {
      const daysLate = Math.round((Date.parse(today) - Date.parse(inv.dueDate)) / 86_400_000)
      alerts.push({
        id: `alert_overdue_${inv.id}`,
        kind: 'overdue_invoice',
        severity: 'warning',
        // sanitizeTier : clientName/label = texte tiers, l'alerte part dans le digest de
        // l'assistant et peut être relayée ailleurs (notification) - mêmes précautions
        title: `Facture en retard : ${sanitizeTier(inv.clientName)}`,
        detail: `${sanitizeTier(inv.label)} - échue depuis ${daysLate} j (échéance ${inv.dueDate}).`,
        amountCents: inv.amountCents,
        invoiceId: inv.id,
        daysLate,
      })
    }
  }

  // --- anomalies de charges récurrentes : dernier mois plein vs médiane des 6 précédents
  const actuals = actualsByMonth(state.transactions)
  const lastFull = addMonths(monthOf(today), -1)
  for (const categoryId of recurringCategoryIds(state)) {
    const current = Math.abs(actuals[lastFull]?.[categoryId] || 0)
    if (!current) continue
    const history = []
    for (let i = 2; i <= 7; i++) {
      const v = actuals[addMonths(monthOf(today), -i)]?.[categoryId]
      if (v) history.push(Math.abs(v))
    }
    const med = median(history)
    if (med > 0 && current >= med * ANOMALY_FACTOR) {
      const label = state.categories.find((c) => c.id === categoryId)?.label || categoryId
      alerts.push({
        id: `alert_anomaly_${categoryId}`,
        kind: 'anomaly',
        severity: 'info',
        title: `Dépense inhabituelle : ${label}`,
        detail: `${(current / 100).toLocaleString('fr-FR')} € sur ${lastFull}, contre ${(med / 100).toLocaleString('fr-FR')} € de médiane sur les 6 mois précédents.`,
        amountCents: -current,
        categoryId,
        medianCents: med,
        month: lastFull,
      })
    }
  }

  return alerts
}
