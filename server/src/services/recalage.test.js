import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Data dir TEMPORAIRE posé AVANT les imports applicatifs (résolu à l'appel dans
// store.js, mais on ne prend aucun risque d'ordre).
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-recalage-'))
process.env.SYNTRESO_DATA_DIR = DATA_DIR

const { robustMonthlyOut, recalableOutCategories } = await import('./charges.js')
const { computeRecalage, recalageCharges } = await import('./recalage.js')
const { resolveProposal } = await import('./agent.js')
const { qualitePrevisions } = await import('./qualite.js')
const { actualsByMonth } = await import('./projection.js')

// Fixture : TNS solo, mois courant 2026-07. Déplacements = mensuels volatils avec un
// pic (la moyenne ment, la médiane tient). Honoraires = 2 mois sur 6 à 300 EUR (charge
// trimestrielle : doit peser 100 EUR/mois, pas 300).
const CATEGORIES = [
  { id: 'enc_p', label: 'Prestations', direction: 'in', order: 1 },
  { id: 'dec_depl', label: 'Déplacements', direction: 'out', order: 2 },
  { id: 'dec_hono', label: 'Honoraires', direction: 'out', order: 3, fixed: true },
  { id: 'dec_tva', label: 'TVA', direction: 'out', order: 4 },
  { id: 'dec_remuneration', label: 'Rémunération', direction: 'out', order: 5 },
  { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 6 },
  { id: 'dec_invest', label: 'Investissement', direction: 'out', order: 7, excludeFromResultat: true },
]
const TXS = []
// déplacements : jan-juin, 100 EUR sauf pic 1 400 en mars
for (const [i, ym] of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].entries()) {
  TXS.push({ id: `t_depl_${i}`, date: `${ym}-10`, categoryId: 'dec_depl', amountCents: ym === '2026-03' ? -140_000 : -10_000, label: 'depl' })
}
// honoraires : 300 EUR en février et mai (2/6)
TXS.push({ id: 't_h1', date: '2026-02-15', categoryId: 'dec_hono', amountCents: -30_000, label: 'hono' })
TXS.push({ id: 't_h2', date: '2026-05-15', categoryId: 'dec_hono', amountCents: -30_000, label: 'hono' })

// forecast erroné façon moyenne plate : déplacements 317 EUR/mois, honoraires absents
const FORECAST = []
for (const ym of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) {
  FORECAST.push({ id: `fc_${ym}_dec_depl`, month: ym, categoryId: 'dec_depl', amountCents: -31_700, note: 'moyenne réalisée', source: 'indy-import' })
}

const STATE = {
  company: { demoToday: '2026-07-10', fiscal: { tns: { autoCompute: true, remunerationCategoryId: 'dec_remuneration', provisionCategoryId: 'dec_urssaf' } } },
  categories: CATEGORIES,
  transactions: TXS,
  forecast: FORECAST,
  invoices: [],
  scenarios: [],
  accounts: [],
}

before(() => {
  const w = (name, data) => writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2))
  w('company', STATE.company)
  w('categories', CATEGORIES)
  w('transactions', TXS)
  w('forecast', FORECAST)
  w('invoices', [])
  w('scenarios', [])
  w('accounts', [])
  w('proposals', [])
  // archive du prévisionnel de juin (pour qualitePrevisions) : déplacements prévus 200 EUR
  mkdirSync(path.join(DATA_DIR, 'archives'), { recursive: true })
  writeFileSync(
    path.join(DATA_DIR, 'archives', 'forecast-2026-06.json'),
    JSON.stringify([{ id: 'fc_2026-06_dec_depl', month: '2026-06', categoryId: 'dec_depl', amountCents: -20_000 }]),
  )
})

test('robustMonthlyOut : médiane robuste au pic + mensualisation par la fréquence', () => {
  const r = robustMonthlyOut(STATE, actualsByMonth(TXS), '2026-07')
  // déplacements 6/6 : médiane 100 EUR (le pic de 1 400 ne pollue pas), mensualisé x6/6
  assert.equal(r.dec_depl.medianCents, 10_000)
  assert.equal(r.dec_depl.presence, 6)
  assert.equal(r.dec_depl.monthlyCents, 10_000)
  // honoraires 2/6 à 300 EUR : charge mensuelle équivalente 100 EUR (pas 300)
  assert.equal(r.dec_hono.medianCents, 30_000)
  assert.equal(r.dec_hono.presence, 2)
  assert.equal(r.dec_hono.monthlyCents, 10_000)
})

test('recalableOutCategories : exclut dérivées, pilotées et hors-résultat', () => {
  const ids = recalableOutCategories(STATE).map((c) => c.id)
  assert.deepEqual(ids, ['dec_depl', 'dec_hono'])
})

test('computeRecalage : détecte le prévu gonflé par la moyenne et la charge absente', () => {
  const r = computeRecalage(STATE)
  assert.equal(r.fromMonth, '2026-08')
  const depl = r.items.find((i) => i.categoryId === 'dec_depl')
  // prévu 317 EUR vs cible 100 EUR : écart -217 (> 30 % et > 50 EUR) -> proposé
  assert.ok(depl, 'écart déplacements détecté')
  assert.equal(depl.plannedMonthlyCents, 31_700)
  assert.equal(depl.targetMonthlyCents, 10_000)
  const hono = r.items.find((i) => i.categoryId === 'dec_hono')
  // prévu 0 vs cible 100 EUR -> proposé aussi (charge oubliée du prévisionnel)
  assert.ok(hono, 'écart honoraires détecté')
  assert.equal(hono.targetMonthlyCents, 10_000)
})

test('recalageCharges + confirmation : les lignes forecast sont réécrites sur la plage', async () => {
  const report = await recalageCharges({})
  assert.equal(report.created, 2)
  // idempotence : un second run ne recrée rien
  const again = await recalageCharges({})
  assert.equal(again.created, 0)

  const proposals = JSON.parse(await readFile(path.join(DATA_DIR, 'proposals.json'), 'utf8'))
  const depl = proposals.find((p) => p.kind === 'forecast_recalage' && p.payload.categoryId === 'dec_depl')
  assert.equal(depl.payload.monthlyCents, -10_000)

  const { proposal, error } = await resolveProposal(depl.id, 'confirm')
  assert.equal(error, undefined)
  assert.equal(proposal.status, 'confirmed')
  const forecast = JSON.parse(await readFile(path.join(DATA_DIR, 'forecast.json'), 'utf8'))
  const aug = forecast.find((f) => f.id === 'fc_2026-08_dec_depl')
  assert.equal(aug.amountCents, -10_000)
  assert.equal(aug.source, 'recalage')
  // la plage va jusqu'à l'horizon : une ligne créée là où il n'y en avait pas
  const far = forecast.find((f) => f.id === 'fc_2027-06_dec_depl')
  assert.ok(far, 'ligne créée jusqu\'à l\'horizon')
  assert.equal(far.amountCents, -10_000)
})

test('qualitePrevisions : prévu (archive) vs réalisé du mois clos', async () => {
  const r = await qualitePrevisions({ month: '2026-06' })
  assert.equal(r.hasArchive, true)
  const depl = r.items.find((i) => i.categoryId === 'dec_depl')
  // prévu -200 EUR (archive), réalisé -100 EUR -> écart +100 EUR
  assert.equal(depl.plannedCents, -20_000)
  assert.equal(depl.actualCents, -10_000)
  assert.equal(depl.gapCents, 10_000)
  // mois sans archive : on le dit
  const r2 = await qualitePrevisions({ month: '2026-05' })
  assert.equal(r2.hasArchive, false)
})
