import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Data dir TEMPORAIRE posé AVANT les imports applicatifs (résolu à l'appel dans
// store.js, mais on ne prend aucun risque d'ordre).
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-fiscal-adjust-'))
process.env.SYNTRESO_DATA_DIR = DATA_DIR

const { derivedFiscalDeltas, compteResultatMensuel, autoManagedCategoryIds } = await import('./fiscal.js')
const { project, forecastGrid, actualsByMonth, forecastByMonth } = await import('./projection.js')
const { resolveProposal } = await import('./agent.js')

// Fixture : TNS piloté (rému 1 500 EUR en CCA, provision 45 % -> 675 EUR/mois) + TVA
// et IS auto. Le cas couvert : une proposition agent validée sur dec_urssaf était
// écrite dans le forecast puis NEUTRALISÉE par derivedFiscalDeltas -> le prévisionnel
// ne bougeait pas. Attendu désormais : les lignes forecast « vivantes » (source
// agent/user) sur les catégories auto-gérées S'AJOUTENT au montant dérivé ; seules
// les lignes importées (moyenne morte) restent neutralisées.
const COMPANY = {
  name: 'Test SARL',
  demoToday: '2026-07-15',
  fiscal: {
    amountsAreTTC: true,
    tva: { autoCompute: true, payDayOfMonth: 22 },
    tns: {
      autoCompute: true,
      remunerationCategoryId: 'dec_remuneration',
      provisionCategoryId: 'dec_urssaf',
      remunerationMensuelleBruteCents: 150_000,
      cotisationTauxPct: 45,
      remunerationEnCcaDepuis: '2026-06',
      remunerationEnCcaJusquau: '2026-12',
    },
    is: { autoDecaissement: true },
  },
}
const CATEGORIES = [
  { id: 'enc_p', label: 'Prestations', direction: 'in', vatRatePct: 20, order: 1 },
  { id: 'dec_remuneration', label: 'Rémunération', direction: 'out', order: 2 },
  { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 3 },
  { id: 'dec_tva', label: 'TVA', direction: 'out', order: 4 },
  { id: 'dec_is', label: 'IS', direction: 'out', order: 5, excludeFromResultat: true },
]
const ACCOUNTS = [{ id: 'acc1', label: 'Courant', openingBalanceCents: 1_000_000, openingDate: '2026-01-01' }]

const MORTE = { id: 'fc_2026-11_dec_urssaf', month: '2026-11', categoryId: 'dec_urssaf', amountCents: -20_000, note: 'moyenne réalisée', source: 'indy-import' }
const VIVANTE = { id: 'fc_2026-11_dec_urssaf_agent', month: '2026-11', categoryId: 'dec_urssaf', amountCents: -57_700, note: 'Correction URSSAF T4', source: 'agent' }

const baseState = (forecast) => ({
  company: COMPANY,
  accounts: ACCOUNTS,
  categories: CATEGORIES,
  transactions: [],
  invoices: [],
  scenarios: [],
  forecast,
})
const ctxOf = (state) => ({
  actuals: actualsByMonth(state.transactions),
  forecasts: forecastByMonth(state.forecast),
  currentMonth: '2026-07',
})
const closingNov = (state) => project(state).monthly.find((m) => m.month === '2026-11').closingCents

test('autoManagedCategoryIds : les 3 catégories fiscales pilotées', () => {
  const ids = autoManagedCategoryIds(COMPANY)
  assert.deepEqual([...ids].sort(), ['dec_is', 'dec_tva', 'dec_urssaf'])
  assert.equal(autoManagedCategoryIds({ fiscal: {} }).size, 0)
})

test('ligne morte (indy-import) sur dec_urssaf : toujours neutralisée', () => {
  assert.equal(closingNov(baseState([MORTE])), closingNov(baseState([])))
})

test('ajustement vivant (agent) sur dec_urssaf : s\'ajoute à la provision dérivée', () => {
  const sans = closingNov(baseState([MORTE]))
  assert.equal(closingNov(baseState([MORTE, VIVANTE])), sans - 57_700)
  // même comportement pour une ligne posée par l'utilisateur
  const user = { ...VIVANTE, id: 'fc_2026-11_dec_urssaf_user', source: 'user' }
  assert.equal(closingNov(baseState([MORTE, user])), sans - 57_700)
})

test('derivedFiscalDeltas : la ligne vivante n\'induit aucun delta mais remonte dans socialByMonth (tréso engagée)', () => {
  const s1 = baseState([MORTE])
  const s2 = baseState([MORTE, VIVANTE])
  const d1 = derivedFiscalDeltas(s1, ctxOf(s1))
  const d2 = derivedFiscalDeltas(s2, ctxOf(s2))
  assert.deepEqual(d2.deltas, d1.deltas)
  assert.equal(d2.socialByMonth['2026-11'], d1.socialByMonth['2026-11'] + 57_700)
})

test('TVA : morte neutralisée, vivante additive (solde + vatDueByMonth)', () => {
  const morteTva = { id: 'fc_2026-11_dec_tva', month: '2026-11', categoryId: 'dec_tva', amountCents: -5_000, source: 'indy-import' }
  const vivanteTva = { id: 'fc_2026-11_dec_tva_agent', month: '2026-11', categoryId: 'dec_tva', amountCents: -3_000, source: 'agent' }
  const s0 = baseState([])
  const s1 = baseState([morteTva])
  const s2 = baseState([morteTva, vivanteTva])
  assert.equal(closingNov(s1), closingNov(s0))
  assert.equal(closingNov(s2), closingNov(s0) - 3_000)
  const d1 = derivedFiscalDeltas(s1, ctxOf(s1))
  const d2 = derivedFiscalDeltas(s2, ctxOf(s2))
  assert.deepEqual(d2.deltas, d1.deltas)
  assert.equal(d2.vatDueByMonth['2026-11'] || 0, (d1.vatDueByMonth['2026-11'] || 0) + 3_000)
})

test('compte de résultat : l\'ajustement vivant charge aussi le résultat du mois', () => {
  const s1 = baseState([MORTE])
  const s2 = baseState([MORTE, VIVANTE])
  const cr1 = compteResultatMensuel(s1, ctxOf(s1), '2026')
  const cr2 = compteResultatMensuel(s2, ctxOf(s2), '2026')
  assert.equal(cr2.parMois['2026-11'].chargesHTCents, cr1.parMois['2026-11'].chargesHTCents - 57_700)
})

test('forecastGrid : cellules auto non éditables (dec_is inclus) et ajustement reflété', () => {
  const grid = forecastGrid(baseState([MORTE, VIVANTE]))
  const cell = (catId, ym) => grid.rows.find((r) => r.categoryId === catId).cells.find((c) => c.month === ym)
  for (const catId of ['dec_urssaf', 'dec_tva', 'dec_is']) {
    assert.equal(cell(catId, '2026-11').editable, false, `${catId} doit être non éditable`)
  }
  // cellule URSSAF de novembre = provision dérivée (675 EUR) + ajustement validé (577 EUR)
  assert.equal(cell('dec_urssaf', '2026-11').retainedCents, -(67_500 + 57_700))
})

test('resolveProposal : catégorie auto-gérée -> ligne séparée, la moyenne importée reste intacte', async () => {
  writeFileSync(path.join(DATA_DIR, 'company.json'), JSON.stringify(COMPANY))
  writeFileSync(path.join(DATA_DIR, 'categories.json'), JSON.stringify(CATEGORIES))
  writeFileSync(path.join(DATA_DIR, 'accounts.json'), JSON.stringify(ACCOUNTS))
  writeFileSync(path.join(DATA_DIR, 'transactions.json'), '[]')
  writeFileSync(path.join(DATA_DIR, 'invoices.json'), '[]')
  writeFileSync(path.join(DATA_DIR, 'scenarios.json'), '[]')
  writeFileSync(path.join(DATA_DIR, 'forecast.json'), JSON.stringify([MORTE]))
  writeFileSync(
    path.join(DATA_DIR, 'proposals.json'),
    JSON.stringify([
      {
        id: 'prop_test_urssaf',
        createdAt: '2026-07-15T10:00:00.000Z',
        status: 'pending',
        kind: 'forecast_line',
        payload: { kind: 'forecast_line', month: '2026-11', categoryId: 'dec_urssaf', amountCents: -57_700, label: 'Correction URSSAF T4' },
      },
      {
        id: 'prop_test_enc_1',
        createdAt: '2026-07-15T10:00:00.000Z',
        status: 'pending',
        kind: 'forecast_line',
        payload: { kind: 'forecast_line', month: '2026-12', categoryId: 'enc_p', amountCents: 100_000, label: 'Devis signé A' },
      },
      {
        id: 'prop_test_enc_2',
        createdAt: '2026-07-15T10:00:00.000Z',
        status: 'pending',
        kind: 'forecast_line',
        payload: { kind: 'forecast_line', month: '2026-12', categoryId: 'enc_p', amountCents: 50_000, label: 'Devis signé B' },
      },
    ]),
  )

  const { error } = await resolveProposal('prop_test_urssaf', 'confirm')
  assert.equal(error, undefined)
  let forecast = JSON.parse(await readFile(path.join(DATA_DIR, 'forecast.json'), 'utf8'))
  const morte = forecast.find((f) => f.id === 'fc_2026-11_dec_urssaf')
  assert.equal(morte.amountCents, -20_000, 'la moyenne importée ne doit pas être fusionnée')
  assert.equal(morte.source, 'indy-import')
  const vivante = forecast.find((f) => f.id === 'fc_2026-11_dec_urssaf_agent')
  assert.equal(vivante.amountCents, -57_700)
  assert.equal(vivante.source, 'agent')

  // catégorie normale : comportement historique (fusion additive dans la ligne du couple)
  await resolveProposal('prop_test_enc_1', 'confirm')
  await resolveProposal('prop_test_enc_2', 'confirm')
  forecast = JSON.parse(await readFile(path.join(DATA_DIR, 'forecast.json'), 'utf8'))
  const enc = forecast.find((f) => f.id === 'fc_2026-12_enc_p')
  assert.equal(enc.amountCents, 150_000)
  assert.equal(enc.source, 'agent')
  assert.equal(forecast.find((f) => f.id === 'fc_2026-12_enc_p_agent'), undefined)
})
