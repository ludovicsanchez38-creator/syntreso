import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { actualsByMonth, forecastByMonth } from './projection.js'
import { cashCalendar } from './echeances.js'

// cashCalendar lit echeances.json via store.js (readJsonOr) -> on isole un data dir
// temporaire et on y écrit le fichier de test au besoin.
let dir
let prev
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'syntreso-ech-'))
  prev = process.env.SYNTRESO_DATA_DIR
  process.env.SYNTRESO_DATA_DIR = dir
})
after(() => {
  if (prev === undefined) delete process.env.SYNTRESO_DATA_DIR
  else process.env.SYNTRESO_DATA_DIR = prev
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function writeEcheances(list) {
  writeFileSync(path.join(dir, 'echeances.json'), JSON.stringify(list, null, 2))
}

// Fixture TNS solo : TVA + URSSAF dérivées, pour des échéances datées vérifiables.
// demoToday = 2026-05-10 -> fenêtre 90 j ~ jusqu'au 2026-08-08.
const FIXTURE = () => ({
  company: {
    demoToday: '2026-05-10',
    lowCashThresholdCents: 100_000,
    fiscal: {
      vatRatePct: 20,
      amountsAreTTC: true,
      tva: { autoCompute: true, payDayOfMonth: 22 },
      tns: {
        autoCompute: true,
        remunerationCategoryId: 'dec_rem',
        provisionCategoryId: 'dec_urssaf',
        cotisationTauxPct: 40,
        cotisationTauxApresAcrePct: 45,
        acre: { actif: true, tauxPct: 25, finMois: '2026-12' },
      },
    },
  },
  accounts: [{ id: 'acc', openingBalanceCents: 1_000_000, openingDate: '2026-04-01' }],
  categories: [
    { id: 'enc_presta', label: 'Prestations', direction: 'in', order: 1, vatRatePct: 20 },
    { id: 'dec_rem', label: 'Rémunération', direction: 'out', order: 2, vatRatePct: 0, fixed: true },
    { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 3, vatRatePct: 0, fixed: true },
    { id: 'dec_tva', label: 'TVA', direction: 'out', order: 4, vatRatePct: 0 },
    { id: 'dec_loyer', label: 'Loyer', direction: 'out', order: 5, vatRatePct: 20, fixed: true },
  ],
  transactions: [{ id: 't1', date: '2026-05-05', categoryId: 'enc_presta', amountCents: 1_200_000 }],
  invoices: [],
  forecast: [
    { id: 'f1', month: '2026-06', categoryId: 'enc_presta', amountCents: 1_200_000 },
    { id: 'f2', month: '2026-06', categoryId: 'dec_rem', amountCents: -200_000 },
    { id: 'f3', month: '2026-05', categoryId: 'dec_rem', amountCents: -200_000 },
  ],
  scenarios: [],
})

async function build(state) {
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  return cashCalendar(state, { actuals, forecasts })
}

test('cash calendar : TVA dérivée datée au payDay du mois M+1', async () => {
  writeEcheances([])
  const cal = await build(FIXTURE())
  // activité mai (réalisé 1 200 000 TTC -> TVA due 200 000) -> reversement 2026-06-22
  const tva = cal.items.find((e) => e.kind === 'tva' && e.dueDate === '2026-06-22')
  assert.ok(tva, 'échéance TVA attendue le 22/06')
  assert.equal(tva.amountCents, -200_000)
  assert.equal(tva.source, 'derived')
  assert.equal(tva.categoryId, 'dec_tva')
})

test('cash calendar : provision URSSAF dérivée datée, montant = rému x taux', async () => {
  writeEcheances([])
  const cal = await build(FIXTURE())
  // La provision de mai serait datée au 05/05, AVANT demoToday (10/05) -> hors fenêtre
  // (une date passée n'est pas « à venir »). On vérifie la provision de JUIN : rému
  // forecast 200 000, ACRE active (fin 12) -> 40% = 80 000, datée 2026-06-05.
  const urssaf = cal.items.find((e) => e.kind === 'urssaf' && e.dueDate.startsWith('2026-06'))
  assert.ok(urssaf, 'provision URSSAF de juin attendue')
  assert.equal(urssaf.amountCents, -80_000)
  assert.equal(urssaf.source, 'derived')
  // la provision de mai (datée avant aujourd'hui) n'apparaît pas
  assert.equal(cal.items.some((e) => e.kind === 'urssaf' && e.dueDate.startsWith('2026-05')), false)
})

test('cash calendar : échéances saisies dans la fenêtre, hors fenêtre exclues', async () => {
  writeEcheances([
    { id: 'ech_m1', label: 'Loyer', categoryId: 'dec_loyer', dueDate: '2026-06-03', amountCents: -90_000, kind: 'loyer', source: 'manual' },
    { id: 'ech_far', label: 'CFE', categoryId: null, dueDate: '2026-12-15', amountCents: -142_000, kind: 'autre', source: 'manual' }, // hors 90 j
  ])
  const cal = await build(FIXTURE())
  assert.ok(cal.items.find((e) => e.id === 'ech_m1'), 'loyer dans la fenêtre attendu')
  assert.equal(cal.items.some((e) => e.id === 'ech_far'), false, 'CFE hors fenêtre exclue')
})

test('cash calendar : échéance saisie malformée ou catégorie inconnue est ignorée', async () => {
  writeEcheances([
    { id: 'bad1', dueDate: 'pas-une-date', amountCents: -100, kind: 'autre', source: 'manual' },
    { id: 'bad2', dueDate: '2026-06-01', amountCents: 100.5, kind: 'autre', source: 'manual' }, // non entier
    { id: 'bad3', dueDate: '2026-06-01', amountCents: -100, categoryId: 'inconnu', kind: 'autre', source: 'manual' },
    { id: 'good', dueDate: '2026-06-01', amountCents: -100, categoryId: 'dec_loyer', kind: 'loyer', source: 'manual' },
  ])
  const cal = await build(FIXTURE())
  assert.equal(cal.items.some((e) => e.id === 'bad1'), false)
  assert.equal(cal.items.some((e) => e.id === 'bad2'), false)
  assert.equal(cal.items.some((e) => e.id === 'bad3'), false)
  assert.ok(cal.items.find((e) => e.id === 'good'))
})

test('cash calendar : une saisie ne duplique pas une dérivée de même id (idempotence)', async () => {
  // on injecte une saisie avec l'id qu'aurait la TVA dérivée de juin -> doit être ignorée
  writeEcheances([
    { id: 'ech_2026-06_tva', label: 'TVA doublon', categoryId: 'dec_tva', dueDate: '2026-06-22', amountCents: -1, kind: 'tva', source: 'manual' },
  ])
  const cal = await build(FIXTURE())
  const tvaJuin = cal.items.filter((e) => e.id === 'ech_2026-06_tva')
  assert.equal(tvaJuin.length, 1, 'une seule échéance TVA juin (dérivée gagne)')
  assert.equal(tvaJuin[0].source, 'derived')
  assert.equal(tvaJuin[0].amountCents, -200_000) // la dérivée, pas le -1 saisi
})

test('cash calendar : trié par date, total des sorties et regroupement par mois', async () => {
  writeEcheances([
    { id: 'ech_m1', label: 'Loyer', categoryId: 'dec_loyer', dueDate: '2026-06-03', amountCents: -90_000, kind: 'loyer', source: 'manual' },
  ])
  const cal = await build(FIXTURE())
  // tri croissant par dueDate
  for (let i = 1; i < cal.items.length; i++) {
    assert.ok(cal.items[i - 1].dueDate <= cal.items[i].dueDate, 'items triés par date')
  }
  // total des sorties = somme des montants négatifs
  const expectedTotal = cal.items.filter((e) => e.amountCents < 0).reduce((s, e) => s + e.amountCents, 0)
  assert.equal(cal.totalOutCents, expectedTotal)
  // byMonth agrège bien (juin a au moins le loyer + la TVA)
  assert.ok(cal.byMonth['2026-06'])
  assert.ok(cal.byMonth['2026-06'].count >= 2)
  assert.ok(cal.byMonth['2026-06'].outCents < 0)
})

test('cash calendar : fiscalité inactive -> pas de dérivées, seulement les saisies', async () => {
  writeEcheances([
    { id: 'ech_loyer', label: 'Loyer', categoryId: 'dec_loyer', dueDate: '2026-06-03', amountCents: -90_000, kind: 'loyer', source: 'manual' },
  ])
  const state = FIXTURE()
  state.company.fiscal.tva.autoCompute = false
  state.company.fiscal.tns.autoCompute = false
  const cal = await build(state)
  assert.equal(cal.items.every((e) => e.source !== 'derived'), true)
  assert.equal(cal.items.length, 1)
})

test('cash calendar : montants tous en centimes entiers', async () => {
  writeEcheances([])
  const cal = await build(FIXTURE())
  assert.ok(cal.items.every((e) => Number.isInteger(e.amountCents)))
  assert.ok(Number.isInteger(cal.totalOutCents))
})

test('cash calendar : régime annuel, aucune CA3 mensuelle, un seul paiement à l\'échéance', async () => {
  writeEcheances([])
  const state = FIXTURE()
  state.company.fiscal.tva = { autoCompute: true, regime: 'annuel', dueDate: '2026-07-18' }
  state.company.fiscal.vatDueActualCents = 50_000
  const cal = await build(state)
  const tva = cal.items.filter((e) => e.kind === 'tva')
  assert.equal(tva.length, 1)
  assert.equal(tva[0].dueDate, '2026-07-18')
  assert.equal(tva[0].amountCents, -50_000)
  state.company.fiscal.tva.dueDate = '2027-05-18'
  const later = await build(state)
  assert.equal(later.items.filter((e) => e.kind === 'tva').length, 0)
})
