import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncTwenty } from './twenty.js'
import { resolveProposal } from './agent.js'
import { readJson, writeJson, dataPath } from './store.js'

beforeEach(() => {
  process.env.SYNTRESO_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-twenty-securite-'))
  process.env.SYNTRESO_REGLAGES = path.join(process.env.SYNTRESO_DATA_DIR, 'reglages-absents.json')
  const data = { company: { demoToday: '2026-10-15' }, categories: [{ id: 'enc_prestations', direction: 'in' }], accounts: [], transactions: [], forecast: [], proposals: [], invoices: [], scenarios: [] }
  for (const [name, value] of Object.entries(data)) writeFileSync(dataPath(name), JSON.stringify(value))
})

const sync = (targetCents) => syncTwenty({
  baseUrl: 'http://twenty-factice', apiKey: 'cle-factice',
  fetchImpl: async () => ({ ok: true, json: async () => ({ data: { opportunities: [{ id: 'affaire', stage: 'WON', amount: { amountMicros: targetCents / 0.8 * 10_000 }, closeDate: '2026-12-15' }] } }) }),
})
const pending = async () => (await readJson('proposals')).filter((p) => p.status === 'pending')
const line = (amountCents) => [{ id: 'fc_2026-12_enc_prestations', month: '2026-12', categoryId: 'enc_prestations', amountCents, source: 'user' }]

test('F-7 : une cible Twenty de 1 500 remplace celle de 1 000 sans cumul des confirmations', async () => {
  await sync(100_000)
  const [old] = await pending()
  const report = await sync(150_000)
  const current = await pending()
  assert.equal(current.length, 1)
  assert.equal(current[0].payload.amountCents, 150_000)
  assert.equal(report.proposalsCreated, 1)
  assert.equal((await resolveProposal(old.id, 'confirm')).status, 409)
  assert.equal((await resolveProposal(current[0].id, 'confirm')).proposal.status, 'confirmed')
  assert.equal((await readJson('forecast'))[0].amountCents, 150_000)
})

test('F-7 : une modification du montant de départ rend la confirmation Twenty périmée', async () => {
  await sync(100_000)
  const [proposal] = await pending()
  await writeJson('forecast', line(20_000))
  const result = await resolveProposal(proposal.id, 'confirm')
  assert.equal(result.status, 409)
  assert.match(result.error, /périmée/)
  assert.equal((await readJson('forecast'))[0].amountCents, 20_000)
})

test('F-7 : un pipe disparu ou sous le seuil retire aussi les propositions devenues inutiles', async () => {
  for (const target of [0, 10_000]) {
    await sync(100_000)
    const [proposal] = await pending()
    await sync(target)
    assert.equal((await pending()).length, 0)
    assert.equal((await resolveProposal(proposal.id, 'confirm')).status, 409)
  }
})

test('F-7 : un delta identique avec une autre base remplace également l’ancienne proposition', async () => {
  await sync(100_000)
  const [old] = await pending()
  await writeJson('forecast', line(50_000))
  await sync(150_000)
  const [current] = await pending()
  assert.notEqual(current.id, old.id)
  assert.equal(current.context.currentCents, 50_000)
  assert.equal((await resolveProposal(old.id, 'confirm')).status, 409)
})

test('F-7 : changer le mois ne permet pas de contourner la base de calcul Twenty', async () => {
  await sync(100_000)
  const [proposal] = await pending()
  assert.equal((await resolveProposal(proposal.id, 'confirm', { month: '2027-01' })).status, 409)
  assert.deepEqual(await readJson('forecast'), [])
})
