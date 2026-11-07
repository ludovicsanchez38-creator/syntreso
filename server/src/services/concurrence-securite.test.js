import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withDataLock, writeJson, readJson } from './store.js'
import { createProposalFromPayload, resolveProposal } from './agent.js'
import scenarios from '../routes/scenarios.js'

beforeEach(() => {
  process.env.SYNTRESO_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-concurrence-'))
  const data = {
    company: { demoToday: '2026-10-15' },
    categories: [{ id: 'enc_prestations', direction: 'in' }],
    accounts: [], transactions: [], invoices: [], forecast: [], proposals: [],
    scenarios: [{ id: 's', active: false, params: { montant: 1, duree: 2 } }],
  }
  for (const [name, value] of Object.entries(data)) writeFileSync(path.join(process.env.SYNTRESO_DATA_DIR, `${name}.json`), JSON.stringify(value))
})

const payload = { kind: 'forecast_line', month: '2026-12', categoryId: 'enc_prestations', amountCents: 100_000, label: 'Test concurrence' }

test('F-5 : une création MCP concurrente ne ressuscite pas une proposition confirmée', async () => {
  await writeJson('proposals', [{ id: 'p', status: 'pending', kind: payload.kind, payload }])
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const held = withDataLock(() => gate)
  const confirmation = resolveProposal('p', 'confirm')
  const creation = createProposalFromPayload(payload)
  // Laisse les lectures libres se terminer pendant que la confirmation attend le verrou.
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await held
  assert.equal((await confirmation).proposal.status, 'confirmed')
  assert.ok((await creation).proposal)
  const list = await readJson('proposals')
  assert.equal(list.length, 2)
  assert.equal(list.find((p) => p.id === 'p').status, 'confirmed')
  assert.equal((await resolveProposal('p', 'confirm')).status, 409)
  assert.equal((await readJson('forecast'))[0].amountCents, 100_000)
})

function put(body) {
  const handler = scenarios.stack.find((layer) => layer.route?.methods.put).route.stack[0].handle
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(value) { resolve({ status: this.statusCode, value }) } }
    handler({ params: { id: 's' }, body }, res, reject)
  })
}

test('F-5 : deux PUT concurrents conservent les modifications distinctes du scénario', async () => {
  let release
  const held = withDataLock(() => new Promise((resolve) => { release = resolve }))
  await new Promise((resolve) => setImmediate(resolve))
  const first = put({ params: { montant: 10 } })
  const second = put({ params: { duree: 20 }, active: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await held
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [200, 200])
  const [scenario] = await readJson('scenarios')
  assert.deepEqual(scenario.params, { montant: 10, duree: 20 })
  assert.equal(scenario.active, true)
})
