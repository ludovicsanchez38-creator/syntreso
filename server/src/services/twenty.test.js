import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeOpp,
  pipeForecastByMonth,
  currentPipeForecastByMonth,
  computePipeDeltas,
  readTwentyPipe,
  syncTwenty,
  STAGE_WEIGHTS,
} from './twenty.js'
import { readJson, readJsonOr } from './store.js'

// Tous les tests écrivent dans un dossier temporaire isolé (SYNTRESO_DATA_DIR), jamais la
// démo ni les vraies données (dossier donnees/).
let dir
let prev
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'syntreso-twenty-'))
  prev = process.env.SYNTRESO_DATA_DIR
  process.env.SYNTRESO_DATA_DIR = dir
  // réglages par défaut (pondérations d'origine), quel que soit config/reglages.json
  process.env.SYNTRESO_REGLAGES = path.join(dir, 'reglages-absents.json')
})
after(() => {
  if (prev === undefined) delete process.env.SYNTRESO_DATA_DIR
  else process.env.SYNTRESO_DATA_DIR = prev
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function writeData(name, value) {
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2))
}

// État minimal : company (currentMonth dérivé de demoToday) + forecast pipe existant.
function seedState({ forecast = [], today = '2026-06-10' } = {}) {
  writeData('company', { name: 'Test SARL', demoToday: today, importedAt: { indy: today, twenty: today } })
  writeData('forecast', forecast)
  writeData('proposals', [])
}

// Réponse Twenty mockée (forme REST réelle : data.opportunities[].amount.amountMicros).
function fakeTwenty(opps, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    json: async () => ({ data: { opportunities: opps } }),
  })
}

beforeEach(() => {
  seedState()
})

// ------------------------------------------------------------------ normalizeOpp
test('normalizeOpp : micros -> centimes, closeDate -> mois', () => {
  const o = normalizeOpp({ id: 'x', name: 'Deal', stage: 'WON', amount: { amountMicros: 2490000000 }, closeDate: '2026-07-15T00:00:00.000Z' })
  assert.equal(o.amountCents, 249000) // 2490 EUR -> 249000 cts
  assert.equal(o.stage, 'WON')
  assert.equal(o.closeMonth, '2026-07')
})

test('normalizeOpp : amount/closeDate absents -> 0 et null, ne plante pas', () => {
  const o = normalizeOpp({ id: 'y', name: null, stage: undefined })
  assert.equal(o.amountCents, 0)
  assert.equal(o.stage, 'NEW')
  assert.equal(o.closeMonth, null)
  assert.equal(o.name, '(sans nom)')
})

// ------------------------------------------------------------------ pondération mensuelle
test('pipeForecastByMonth : opp WON datée -> rattachée à son mois, pondérée 0,8', () => {
  const state = { company: { demoToday: '2026-06-10' } }
  const pipe = [{ id: '1', name: 'A', stage: 'WON', amountCents: 1_000_000, closeMonth: '2026-07' }]
  const { byMonth, weightedTotalCents } = pipeForecastByMonth(pipe, state)
  assert.equal(byMonth['2026-07'], 800_000) // 1 000 000 x 0,8
  assert.equal(weightedTotalCents, 800_000)
})

test('pipeForecastByMonth : opp non datée -> lissée sur les mois futurs (somme conservée)', () => {
  const state = { company: { demoToday: '2026-06-10' } }
  const pipe = [{ id: '1', name: 'A', stage: 'NEGOCIATION', amountCents: 1_000_000, closeMonth: null }]
  const { byMonth, weightedTotalCents } = pipeForecastByMonth(pipe, state)
  const sum = Object.values(byMonth).reduce((s, v) => s + v, 0)
  // poids NEGOCIATION = 0,5 -> 500 000 pondéré, lissé sans perte de centime
  assert.equal(weightedTotalCents, 500_000)
  assert.equal(sum, 500_000)
})

test('pipeForecastByMonth : opp passée ou LOST -> ignorée', () => {
  const state = { company: { demoToday: '2026-06-10' } }
  const pipe = [
    { id: '1', name: 'passée', stage: 'WON', amountCents: 1_000_000, closeMonth: '2026-01' },
    { id: '2', name: 'perdue', stage: 'LOST', amountCents: 5_000_000, closeMonth: '2026-08' },
  ]
  const { byMonth, weightedTotalCents } = pipeForecastByMonth(pipe, state)
  // LOST pondéré 0 ; passée hors horizon futur -> non ventilée
  assert.equal(weightedTotalCents, 800_000) // seule la WON passée est pondérée dans le total
  assert.equal(Object.values(byMonth).reduce((s, v) => s + v, 0), 0)
  assert.equal(STAGE_WEIGHTS.LOST, 0)
})

// ------------------------------------------------------------------ deltas
test('currentPipeForecastByMonth : somme uniquement enc_prestations', () => {
  const state = {
    forecast: [
      { month: '2026-07', categoryId: 'enc_prestations', amountCents: 100_000 },
      { month: '2026-07', categoryId: 'enc_prestations', amountCents: 50_000 },
      { month: '2026-07', categoryId: 'dec_salaires', amountCents: -300_000 },
    ],
  }
  const by = currentPipeForecastByMonth(state)
  assert.equal(by['2026-07'], 150_000)
})

test('computePipeDeltas : ne propose que les hausses au-dessus du seuil, baisses séparées', () => {
  const state = {
    company: { demoToday: '2026-06-10' },
    forecast: [{ month: '2026-07', categoryId: 'enc_prestations', amountCents: 100_000 }],
  }
  // cible 800 000 sur 2026-07 -> hausse de 700 000 (proposée) ;
  // un mois où le pipe rétrécit en dessous de l'existant -> baisse (non proposée).
  const pipe = [
    { id: '1', name: 'A', stage: 'WON', amountCents: 1_000_000, closeMonth: '2026-07' },
  ]
  // on ajoute un forecast existant sur 2026-08 sans opp -> baisse à 0
  state.forecast.push({ month: '2026-08', categoryId: 'enc_prestations', amountCents: 300_000 })
  const deltas = computePipeDeltas(state, pipe)
  const aug = deltas.find((d) => d.month === '2026-08')
  const jul = deltas.find((d) => d.month === '2026-07')
  assert.ok(jul, 'hausse de juillet proposée')
  assert.equal(jul.deltaCents, 700_000)
  assert.equal(aug, undefined, 'baisse d\'août pas dans les propositions')
  assert.ok(deltas.decreases.some((d) => d.month === '2026-08'), 'baisse d\'août dans decreases')
})

test('computePipeDeltas : ignore les écarts sous le seuil de bruit (500 EUR)', () => {
  const state = {
    company: { demoToday: '2026-06-10' },
    forecast: [{ month: '2026-07', categoryId: 'enc_prestations', amountCents: 799_000 }],
  }
  const pipe = [{ id: '1', name: 'A', stage: 'WON', amountCents: 1_000_000, closeMonth: '2026-07' }]
  // cible 800 000 vs 799 000 -> écart 1 000 cts (10 EUR) < seuil -> rien
  const deltas = computePipeDeltas(state, pipe)
  assert.equal(deltas.length, 0)
})

// ------------------------------------------------------------------ readTwentyPipe
test('readTwentyPipe : parse la réponse REST, normalise', async () => {
  const fetchImpl = fakeTwenty([
    { id: '1', name: 'Deal', stage: 'WON', amount: { amountMicros: 1000000000 }, closeDate: '2026-07-10' },
  ])
  const pipe = await readTwentyPipe({ baseUrl: 'http://x', apiKey: 'k', fetchImpl })
  assert.equal(pipe.length, 1)
  assert.equal(pipe[0].amountCents, 100_000)
})

test('readTwentyPipe : API en erreur -> throw lisible', async () => {
  const fetchImpl = fakeTwenty([], { ok: false, status: 401 })
  await assert.rejects(
    readTwentyPipe({ baseUrl: 'http://x', apiKey: 'k', fetchImpl }),
    /Twenty API 401/,
  )
})

test('readTwentyPipe : clé manquante -> throw avant tout réseau', async () => {
  await assert.rejects(readTwentyPipe({ baseUrl: 'http://x', apiKey: '' }), /TWENTY_KEY/)
})

// ------------------------------------------------------------------ syncTwenty (bout en bout)
test('syncTwenty : émet des propositions forecast_line (jamais d\'écriture forecast directe)', async () => {
  seedState({ forecast: [{ month: '2026-07', categoryId: 'enc_prestations', amountCents: 0 }] })
  const fetchImpl = fakeTwenty([
    { id: '1', name: 'Deal gagné', stage: 'WON', amount: { amountMicros: 1000000000 }, closeDate: '2026-07-10' },
  ])
  const report = await syncTwenty({ baseUrl: 'http://x', apiKey: 'k', fetchImpl })
  assert.equal(report.ok, true)
  assert.equal(report.proposalsCreated, 1)

  // une proposition pending, source twenty-sync, kind forecast_line
  const proposals = await readJson('proposals')
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].status, 'pending')
  assert.equal(proposals[0].source, 'twenty-sync')
  assert.equal(proposals[0].kind, 'forecast_line')
  assert.equal(proposals[0].payload.categoryId, 'enc_prestations')
  // amountMicros 1 000 000 000 = 1000 EUR -> 100 000 cts ; WON x0,8 = 80 000 cts
  assert.equal(proposals[0].payload.amountCents, 80_000)

  // le forecast N'A PAS été modifié (pas d'écriture directe)
  const forecast = await readJson('forecast')
  assert.equal(forecast.find((f) => f.month === '2026-07').amountCents, 0)

  // importedAt.twenty mis à jour
  const company = await readJson('company')
  assert.ok(company.importedAt.twenty)
})

test('syncTwenty : idempotent (2e passage ne recrée pas la même proposition)', async () => {
  seedState({ forecast: [{ month: '2026-07', categoryId: 'enc_prestations', amountCents: 0 }] })
  const fetchImpl = fakeTwenty([
    { id: '1', name: 'Deal', stage: 'WON', amount: { amountMicros: 1000000000 }, closeDate: '2026-07-10' },
  ])
  const r1 = await syncTwenty({ baseUrl: 'http://x', apiKey: 'k', fetchImpl })
  const r2 = await syncTwenty({ baseUrl: 'http://x', apiKey: 'k', fetchImpl })
  assert.equal(r1.proposalsCreated, 1)
  assert.equal(r2.proposalsCreated, 0)
  assert.equal(r2.proposalsSkipped, 1)
  const proposals = await readJsonOr('proposals', [])
  assert.equal(proposals.filter((p) => p.source === 'twenty-sync').length, 1)
})

test('syncTwenty : dryRun -> calcule les deltas sans créer de proposition ni écrire', async () => {
  seedState({ forecast: [{ month: '2026-07', categoryId: 'enc_prestations', amountCents: 0 }] })
  const before = await readJson('company')
  const fetchImpl = fakeTwenty([
    { id: '1', name: 'Deal', stage: 'WON', amount: { amountMicros: 1000000000 }, closeDate: '2026-07-10' },
  ])
  const report = await syncTwenty({ baseUrl: 'http://x', apiKey: 'k', fetchImpl, dryRun: true })
  assert.equal(report.dryRun, true)
  assert.ok(report.deltas.length >= 1)
  const proposals = await readJson('proposals')
  assert.equal(proposals.length, 0)
  // importedAt inchangé en dry run
  const after = await readJson('company')
  assert.equal(after.importedAt.twenty, before.importedAt.twenty)
})

test('syncTwenty : deltas dérivés respectent les centimes entiers', async () => {
  seedState({ forecast: [] })
  const fetchImpl = fakeTwenty([
    // montant volontairement "non rond" pour vérifier l'arrondi en centimes entiers
    { id: '1', name: 'Deal', stage: 'NEGOCIATION', amount: { amountMicros: 1234567000 }, closeDate: null },
  ])
  const report = await syncTwenty({ baseUrl: 'http://x', apiKey: 'k', fetchImpl, dryRun: true })
  for (const d of report.deltas) {
    assert.ok(Number.isInteger(d.deltaCents), `delta ${d.month} doit être un entier`)
  }
})

test('pipeForecastByMonth : montants Twenty HT convertis en TTC selon la TVA de la catégorie', () => {
  const state = { company: { asOfDate: '2026-10-03' }, forecast: [], categories: [{ id: 'enc_prestations', vatRatePct: 20 }] }
  const pipe = [{ id: 'o1', name: 'A', stage: 'WON', amountCents: 100_000, closeMonth: '2026-11' }]
  const { byMonth, weightedTotalCents } = pipeForecastByMonth(pipe, state)
  assert.equal(byMonth['2026-11'], 96_000)
  assert.equal(weightedTotalCents, 96_000)
})
