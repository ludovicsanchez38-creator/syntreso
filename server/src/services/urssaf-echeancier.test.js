import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Data dir TEMPORAIRE : cashCalendar lit les échéances saisies via le store.
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-urssaf-ech-'))
process.env.SYNTRESO_DATA_DIR = DATA_DIR

const { derivedFiscalDeltas, compteResultatMensuel, urssafEcheancier } = await import('./fiscal.js')
const { project, actualsByMonth, forecastByMonth } = await import('./projection.js')
const { cashCalendar } = await import('./echeances.js')

// Fixture fictive : échéancier d'appels URSSAF - T1 100 EUR (payé le 05/02), pas d'appel
// T2, T3 1 500 EUR au 05/08, T4 2 500 EUR au 05/11. Rémunération 1 500 EUR versée en
// avril et mai, puis au compte courant de juin à décembre (provision dérivée 675 EUR/mois
// d'avril à décembre). Attendu : les mois couverts par l'échéancier décaissent l'appel
// réel (rien les mois sans appel), la provision reprend au-delà, et la régularisation
// N+1 = dette de l'exercice (6 075 EUR) - appelé (4 100 EUR) = 1 975 EUR en novembre N+1.
const ECHEANCES = [
  { dueDate: '2026-02-05', amountCents: 10_000, label: 'T1 2026 (début d\'activité)' },
  { dueDate: '2026-08-05', amountCents: 150_000, label: 'T3 2026' },
  { dueDate: '2026-11-05', amountCents: 250_000, label: 'T4 2026' },
]
const company = (over = {}) => ({
  name: 'Test SARL',
  demoToday: '2026-07-15',
  fiscal: {
    amountsAreTTC: true,
    tns: {
      autoCompute: true,
      remunerationCategoryId: 'dec_remuneration',
      provisionCategoryId: 'dec_urssaf',
      remunerationMensuelleBruteCents: 150_000,
      cotisationTauxPct: 45,
      remunerationEnCcaDepuis: '2026-06',
      remunerationEnCcaJusquau: '2026-12',
      echeancesUrssaf: ECHEANCES,
      ...over,
    },
  },
})
const CATEGORIES = [
  { id: 'enc_p', label: 'Prestations', direction: 'in', order: 1 },
  { id: 'dec_remuneration', label: 'Rémunération', direction: 'out', order: 2 },
  { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 3 },
]
const REMU_TX = [
  { id: 't_rem_avril', date: '2026-04-28', categoryId: 'dec_remuneration', amountCents: -150_000, label: 'rému avril' },
  { id: 't_rem_mai', date: '2026-05-28', categoryId: 'dec_remuneration', amountCents: -150_000, label: 'rému mai' },
  { id: 't_urssaf_t1', date: '2026-02-05', categoryId: 'dec_urssaf', amountCents: -10_000, label: 'URSSAF T1' },
]
const baseState = ({ forecast = [], transactions = REMU_TX, tnsOver = {} } = {}) => ({
  company: company(tnsOver),
  accounts: [{ id: 'acc1', label: 'Courant', openingBalanceCents: 1_000_000, openingDate: '2026-01-01' }],
  categories: CATEGORIES,
  transactions,
  invoices: [],
  scenarios: [],
  forecast,
})
const ctxOf = (state) => ({
  actuals: actualsByMonth(state.transactions),
  forecasts: forecastByMonth(state.forecast),
  currentMonth: '2026-07',
})

test('urssafEcheancier : appels indexés + régularisation N+1 calculée (jamais en dur)', () => {
  const s = baseState()
  const sched = urssafEcheancier(s, ctxOf(s))
  assert.equal(sched.lastKnown, '2026-11')
  assert.equal(sched.echByMonth['2026-08'], 150_000)
  assert.equal(sched.echByMonth['2026-11'], 250_000)
  // dette 2026 = 675 x 9 (avr-déc : versée puis CCA) = 607 500 ; appelé = 410 000
  assert.deepEqual(sched.reguls, [{ year: '2026', dueMonth: '2027-11', amountCents: 197_500 }])
})

test('moteur : appels réels sur les mois couverts, rien le reste de l\'année, provision dès l\'année suivante', () => {
  const s = baseState()
  const { deltas, socialByMonth } = derivedFiscalDeltas(s, ctxOf(s))
  assert.deepEqual(socialByMonth, {
    '2026-08': 150_000,
    '2026-11': 250_000,
    // PAS de '2026-12' : année couverte par l'échéancier -> la dette de décembre est
    // dans la régularisation N+1, une provision de repli la compterait deux fois.
    '2027-11': 197_500, // régularisation 2026 datée
  })
  assert.equal(deltas['2026-08'].dec_urssaf, -150_000)
  assert.equal(deltas['2026-07'], undefined) // mois couvert sans appel : rien ne sort
  assert.equal(deltas['2026-09'], undefined)
  assert.equal(deltas['2026-12'], undefined)
  assert.equal(deltas['2027-11'].dec_urssaf, -197_500)
})

test('le repli provision reprend sur la première année SANS échéancier', () => {
  // CCA étendue à mars 2027 : la rému attribuée court sur jan-mars 2027 (675/mois).
  // 2026 reste couverte (aucun repli), 2027 ne l\'est pas -> provision de repli.
  const s = baseState({ tnsOver: { remunerationEnCcaJusquau: '2027-03' } })
  const { socialByMonth } = derivedFiscalDeltas(s, ctxOf(s))
  assert.equal(socialByMonth['2026-12'], undefined)
  assert.equal(socialByMonth['2027-01'], 67_500)
  assert.equal(socialByMonth['2027-03'], 67_500)
  assert.equal(socialByMonth['2027-04'], undefined) // CCA finie, rému 2027 non prévue
  // la régularisation 2026 ne bouge pas (dette 2026 inchangée)
  assert.equal(socialByMonth['2027-11'], 197_500)
})

test('garde anti-double-compte : un réalisé URSSAF sur le mois d\'un appel ne le re-pose pas', () => {
  const s = baseState({
    transactions: [...REMU_TX, { id: 't_urssaf_t3', date: '2026-08-05', categoryId: 'dec_urssaf', amountCents: -150_000, label: 'URSSAF T3' }],
  })
  const { socialByMonth } = derivedFiscalDeltas(s, ctxOf(s))
  assert.equal(socialByMonth['2026-08'], undefined)
  assert.equal(socialByMonth['2026-11'], 250_000)
})

test('forecast mort neutralisé et ajustement vivant conservé avec l\'échéancier', () => {
  const morte = { id: 'fc_2026-09_dec_urssaf', month: '2026-09', categoryId: 'dec_urssaf', amountCents: -20_000, source: 'indy-import' }
  const vivante = { id: 'fc_2026-09_dec_urssaf_agent', month: '2026-09', categoryId: 'dec_urssaf', amountCents: -30_000, source: 'agent' }
  const closingSept = (st) => project(st).monthly.find((m) => m.month === '2026-09').closingCents
  const sans = closingSept(baseState())
  assert.equal(closingSept(baseState({ forecast: [morte] })), sans)
  assert.equal(closingSept(baseState({ forecast: [morte, vivante] })), sans - 30_000)
  const s = baseState({ forecast: [morte, vivante] })
  assert.equal(derivedFiscalDeltas(s, ctxOf(s)).socialByMonth['2026-09'], 30_000)
})

test('compte de résultat : la charge reste la provision dérivée, échéancier ou pas', () => {
  const avec = baseState()
  const sans = baseState({ tnsOver: { echeancesUrssaf: [] } })
  const crAvec = compteResultatMensuel(avec, ctxOf(avec), '2026')
  const crSans = compteResultatMensuel(sans, ctxOf(sans), '2026')
  assert.deepEqual(crAvec.parMois, crSans.parMois)
})

test('cash calendar : appels réels datés, pas de provision mensuelle sur les mois couverts', async () => {
  const s = baseState()
  const ctx = ctxOf(s)
  const cal = await cashCalendar(s, { horizonDays: 365, actuals: ctx.actuals, forecasts: ctx.forecasts })
  const urssaf = cal.items.filter((e) => e.kind === 'urssaf')
  const t3 = urssaf.find((e) => e.dueDate === '2026-08-05')
  assert.equal(t3.amountCents, -150_000)
  assert.equal(t3.label, 'T3 2026')
  const t4 = urssaf.find((e) => e.dueDate === '2026-11-05')
  assert.equal(t4.amountCents, -250_000)
  // aucune provision mensuelle sur toute l'année couverte (décembre inclus : sa
  // dette est dans la régularisation N+1, pas dans une provision de repli)
  assert.equal(urssaf.length, 2)
})
