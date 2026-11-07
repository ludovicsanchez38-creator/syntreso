import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { resolveProposal } from './agent.js'
import { executerImport } from './import-indy.js'
import { readJson, dataPath, writeJson, updateJson } from './store.js'
import { loadState } from './projection.js'

const root = path.resolve(import.meta.dirname, '../../..')
const payload = { kind: 'forecast_line', month: '2026-12', categoryId: 'enc_prestations', amountCents: 100_000, label: 'Test panne' }
beforeEach(() => {
  process.env.SYNTRESO_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-atomicite-'))
  process.env.SYNTRESO_REGLAGES = path.join(process.env.SYNTRESO_DATA_DIR, 'reglages-absents.json')
  const company = JSON.parse(readFileSync(path.join(root, 'modeles/base-vide/company.json'), 'utf8'))
  company.demoToday = '2026-10-15'
  const categories = JSON.parse(readFileSync(path.join(root, 'modeles/base-vide/categories.json'), 'utf8'))
  const data = { company, categories, accounts: [], transactions: [], invoices: [], forecast: [], scenarios: [], proposals: [{ id: 'p', kind: payload.kind, status: 'pending', payload }] }
  for (const [name, value] of Object.entries(data)) writeFileSync(dataPath(name), JSON.stringify(value))
})

function panneRenommage(t, name) {
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === dataPath(name)) throw new Error('panne disque simulée')
    return rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test('F-6 : une panne sur les propositions ne laisse ni ajout partiel ni double confirmation', async (t) => {
  panneRenommage(t, 'proposals')
  let error
  try { await resolveProposal('p', 'confirm') } catch (err) { error = err }
  const status = (await readJson('proposals'))[0].status
  const amount = (await readJson('forecast'))[0]?.amountCents || 0
  assert.deepEqual([status, amount], error ? ['pending', 0] : ['confirmed', 100_000])
  t.mock.restoreAll()
  syncBuiltinESMExports()
  const retry = await resolveProposal('p', 'confirm')
  assert.ok(retry.proposal?.status === 'confirmed' || retry.status === 409)
  assert.equal((await readJson('forecast'))[0].amountCents, 100_000)
})

const importOptions = () => ({
  grandsLivres: [path.join(root, 'exemples/indy-fictif/grand-livre-2025.csv'), path.join(root, 'exemples/indy-fictif/grand-livre-2026.csv')],
  balance: path.join(root, 'exemples/indy-fictif/balance-2026.csv'),
  aujourdhui: '2026-10-05',
})

test('F-6 : une panne au milieu de l’import Indy conserve un état métier complet', async (t) => {
  const before = await loadState()
  panneRenommage(t, 'accounts')
  let error
  try { await executerImport(importOptions()) } catch (err) { error = err }
  const after = await loadState()
  if (error) assert.deepEqual(after, before)
  else {
    assert.ok(after.transactions.length > 0)
    assert.ok(after.accounts.length > 0)
    assert.equal(after.company.dataAsOf, '2026-09-28')
    assert.ok(after.forecast.length > 0)
  }
})

test('F-6 : une lecture groupée pendant l’import ne mélange pas deux générations', async (t) => {
  let signal
  let release
  const reached = new Promise((resolve) => { signal = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === dataPath('transactions')) { signal(); await gate }
  })
  syncBuiltinESMExports()
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports() })
  const importing = executerImport(importOptions())
  await reached
  let finished = false
  const reading = loadState().then((state) => { finished = true; return state })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const mixed = finished
  release()
  await importing
  const state = await reading
  assert.equal(mixed, false, 'la lecture doit attendre la fin de la mutation coordonnée')
  assert.ok(state.transactions.length > 0 && state.accounts.length > 0)
  assert.equal(state.company.dataAsOf, '2026-09-28')
})

test('F-6 : un échec SQLite annule ensemble le prévisionnel et la confirmation', async () => {
  await writeJson('forecast', [])
  const db = new DatabaseSync(path.join(process.env.SYNTRESO_DATA_DIR, 'mutations.sqlite'))
  db.exec("CREATE TRIGGER panne BEFORE INSERT ON documents WHEN NEW.name = 'proposals' BEGIN SELECT RAISE(ABORT, 'panne SQLite simulée'); END")
  db.close()
  await assert.rejects(resolveProposal('p', 'confirm'), /panne SQLite simulée/)
  assert.deepEqual(await readJson('forecast'), [])
  assert.equal((await readJson('proposals'))[0].status, 'pending')
  const recovered = new DatabaseSync(path.join(process.env.SYNTRESO_DATA_DIR, 'mutations.sqlite'))
  recovered.exec('DROP TRIGGER panne')
  recovered.close()
  await resolveProposal('p', 'confirm')
  assert.equal((await readJson('forecast'))[0].amountCents, 100_000)
})

test('F-6 : le journal survit au redémarrage et les écritures suivantes reprennent les copies JSON', async (t) => {
  panneRenommage(t, 'proposals')
  await resolveProposal('p', 'confirm')
  const source = `import { readJson } from ${JSON.stringify(new URL('./store.js', import.meta.url).href)}; console.log(JSON.stringify({ proposals: await readJson('proposals'), forecast: await readJson('forecast') }))`
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(restarted.proposals[0].status, 'confirmed')
  assert.equal(restarted.forecast[0].amountCents, 100_000)
  t.mock.restoreAll()
  syncBuiltinESMExports()
  await updateJson('forecast', (forecast) => { forecast[0].amountCents += 500; return forecast })
  assert.equal((await readJson('forecast'))[0].amountCents, 100_500)
  assert.equal(JSON.parse(readFileSync(dataPath('proposals'), 'utf8'))[0].status, 'confirmed')
  assert.equal(JSON.parse(readFileSync(dataPath('forecast'), 'utf8'))[0].amountCents, 100_500)
})
