import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAlerts, recurringCategoryIds } from './alerts.js'

// Régression du garde-fou « charges récurrentes » : la liste des catégories surveillées
// est dérivée des données réelles, pas figée sur les ids d'un seul jeu de données. On
// reproduit ici un profil de TPE de services (dec_assurance au SINGULIER, dec_serveurs,
// pas de dec_loyer ni dec_leasing), là où l'ancienne liste en dur ne surveillait que
// dec_abonnements et laissait passer une anomalie sur dec_assurance.

const CATS = [
  { id: 'enc_prestations', label: 'Prestations', direction: 'in', order: 1 },
  { id: 'dec_abonnements', label: 'Abonnements logiciels', direction: 'out', order: 2 },
  { id: 'dec_serveurs', label: 'Serveurs et hébergement', direction: 'out', order: 3 },
  { id: 'dec_assurance', label: 'Assurances & prévoyance', direction: 'out', order: 4 },
  { id: 'dec_honoraires', label: 'Honoraires', direction: 'out', order: 5 },
]

// Six mois clos d'historique (mois courant = 2026-06, donc non clos).
const HISTORY_MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']
const LAST_FULL = '2026-05'

function txns(categoryId, perMonth) {
  return Object.entries(perMonth).map(([ym, amountCents]) => ({
    id: `t_${categoryId}_${ym}`,
    date: `${ym}-15`,
    categoryId,
    amountCents,
  }))
}

// monthly: montant stable pour les 6 mois clos, montant spécifique pour le dernier mois plein.
function recurringTxns(categoryId, stableCents, lastFullCents) {
  const perMonth = Object.fromEntries(HISTORY_MONTHS.map((ym) => [ym, stableCents]))
  perMonth[LAST_FULL] = lastFullCents
  return txns(categoryId, perMonth)
}

function buildState() {
  return {
    company: { demoToday: '2026-06-17', lowCashThresholdCents: 300_00 },
    invoices: [],
    categories: CATS,
    transactions: [
      // dec_assurance : ~200 EUR stables puis pic à 500 EUR (>= 200 x 1.8) -> anomalie attendue
      ...recurringTxns('dec_assurance', -200_00, -500_00),
      // charges récurrentes stables : surveillées mais sans anomalie
      ...recurringTxns('dec_abonnements', -400_00, -400_00),
      ...recurringTxns('dec_serveurs', -80_00, -80_00),
      // dec_honoraires : seulement 2 mois (avril + mai) -> NON récurrent, donc non surveillé
      // même si le dernier mois explose. Vérifie que la régularité filtre bien.
      ...txns('dec_honoraires', { '2026-04': -100_00, '2026-05': -1_000_00 }),
    ],
  }
}

// lowPoint volontairement au-dessus du seuil pour ne pas polluer avec une alerte point bas.
const NO_LOW_POINT = { lowPoint: { cents: 10_000_00, date: '2026-12-31' } }

test('charges récurrentes : anomalie sur dec_assurance bien détectée (ids hors démo BTP)', () => {
  const alerts = computeAlerts(buildState(), NO_LOW_POINT)
  const anomalies = alerts.filter((a) => a.kind === 'anomaly')

  const assurance = anomalies.find((a) => a.categoryId === 'dec_assurance')
  assert.ok(assurance, 'une anomalie sur dec_assurance doit être levée')
  assert.equal(assurance.severity, 'info')
  assert.equal(assurance.month, '2026-05')
  assert.equal(assurance.amountCents, -500_00)
  assert.equal(assurance.medianCents, 200_00)
  assert.ok(assurance.title.includes('Assurances & prévoyance'), 'le libellé lisible doit être utilisé')

  // les charges stables ne lèvent pas d'anomalie
  assert.equal(anomalies.find((a) => a.categoryId === 'dec_abonnements'), undefined)
  assert.equal(anomalies.find((a) => a.categoryId === 'dec_serveurs'), undefined)
  // dec_honoraires explose mais n'est présent que 2 mois -> non récurrent -> ignoré
  assert.equal(anomalies.find((a) => a.categoryId === 'dec_honoraires'), undefined)

  // dec_assurance est la seule anomalie de ce jeu
  assert.equal(anomalies.length, 1)
})

test('recurringCategoryIds : dérive les sorties régulières, ignore le ponctuel et les entrées', () => {
  const ids = recurringCategoryIds(buildState())
  assert.ok(ids.includes('dec_assurance'))
  assert.ok(ids.includes('dec_abonnements'))
  assert.ok(ids.includes('dec_serveurs'))
  // ponctuel (2 mois) exclu
  assert.ok(!ids.includes('dec_honoraires'))
  // une catégorie d'encaissement n'est jamais une « charge » récurrente
  assert.ok(!ids.includes('enc_prestations'))
  // aucun id fantôme hérité de l'ancienne liste en dur (démo BTP)
  assert.ok(!ids.includes('dec_loyer'))
  assert.ok(!ids.includes('dec_leasing'))
  assert.ok(!ids.includes('dec_assurances'))
})

// Garde-fou anti-régression : toute catégorie surveillée DOIT exister dans
// categories.json. C'est l'invariant que l'ancienne liste en dur violait (elle
// listait dec_leasing / dec_loyer absents de ce profil). Si un jour quelqu'un
// réintroduit un id figé qui n'existe pas dans les données, ce test casse.
test('recurringCategoryIds : aucun id surveillé absent des catégories (anti-liste-en-dur)', () => {
  const state = buildState()
  const known = new Set(state.categories.map((c) => c.id))
  for (const id of recurringCategoryIds(state)) {
    assert.ok(known.has(id), `catégorie surveillée inexistante dans categories.json : ${id}`)
  }
})

// Même invariant sur un profil BTP (démo) : la dérivation reste robuste quel que
// soit le jeu d'ids. Ici dec_loyer / dec_leasing EXISTENT (contrairement au profil services),
// donc ils peuvent être surveillés - mais jamais un id absent du jeu.
// Alerte « solde net sous le seuil » (lot 2) : le brut couvre le seuil, mais une fois
// la trésorerie engagée (TVA + URSSAF) retranchée, le net passe dessous. On ne l'émet
// que si committedCents > 0 (fiscalité dérivée active) -> les anciens mocks de
// projection sans champs NET ne déclenchent rien (pas de régression).
test('net_below_threshold : émise quand le brut couvre mais le net passe sous le seuil', () => {
  const state = {
    company: { demoToday: '2026-06-17', lowCashThresholdCents: 1_500_000 },
    invoices: [],
    categories: CATS,
    transactions: [],
  }
  const projection = {
    lowPoint: { cents: 10_000_00, date: '2026-12-31' }, // pas d'alerte point bas
    balanceTodayCents: 4_600_000, // brut au-dessus du seuil
    netAvailableCents: 1_300_000, // net SOUS le seuil
    committedCents: 3_300_000,
    vatDueCents: 3_300_000,
    socialProvisionCents: 0,
  }
  const alerts = computeAlerts(state, projection)
  const net = alerts.find((a) => a.kind === 'net_below_threshold')
  assert.ok(net, 'alerte net_below_threshold attendue')
  assert.equal(net.severity, 'warning')
  assert.equal(net.amountCents, 1_300_000)
})

test('net_below_threshold : pas émise si committed=0 (fiscalité dérivée inactive)', () => {
  const state = {
    company: { demoToday: '2026-06-17', lowCashThresholdCents: 1_500_000 },
    invoices: [],
    categories: CATS,
    transactions: [],
  }
  const projection = {
    lowPoint: { cents: 10_000_00, date: '2026-12-31' },
    balanceTodayCents: 1_000_000, // brut déjà sous le seuil, mais committed=0
    netAvailableCents: 1_000_000,
    committedCents: 0,
    vatDueCents: 0,
    socialProvisionCents: 0,
  }
  const alerts = computeAlerts(state, projection)
  assert.equal(alerts.find((a) => a.kind === 'net_below_threshold'), undefined)
})

test('recurringCategoryIds : invariant respecté aussi sur un profil BTP', () => {
  const BTP_CATS = [
    { id: 'enc_chantiers', label: 'Chantiers', direction: 'in', order: 1 },
    { id: 'dec_loyer', label: 'Loyer dépôt', direction: 'out', order: 2 },
    { id: 'dec_leasing', label: 'Leasing matériel', direction: 'out', order: 3 },
    { id: 'dec_assurances', label: 'Assurances & mutuelle', direction: 'out', order: 4 },
  ]
  const state = {
    company: { demoToday: '2026-06-17', lowCashThresholdCents: 300_00 },
    invoices: [],
    categories: BTP_CATS,
    transactions: [
      ...recurringTxns('dec_loyer', -120_00, -120_00),
      ...recurringTxns('dec_leasing', -90_00, -90_00),
      ...recurringTxns('dec_assurances', -150_00, -150_00),
    ],
  }
  const known = new Set(BTP_CATS.map((c) => c.id))
  const ids = recurringCategoryIds(state)
  assert.ok(ids.length >= 3, 'les charges BTP récurrentes doivent être surveillées')
  for (const id of ids) assert.ok(known.has(id), `id surveillé inexistant : ${id}`)
})
