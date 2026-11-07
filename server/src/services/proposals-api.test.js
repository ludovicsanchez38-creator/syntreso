import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Propositions déposées par l'API (agent externe) : validées comme celles de l'assistant
// intégré, toujours en attente, jamais appliquées sans décision humaine.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const MODELE = path.join(ROOT, 'modeles', 'base-vide')
const DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-prop-api-'))
process.env.SYNTRESO_DATA_DIR = DIR
mkdirSync(DIR, { recursive: true })
const company = JSON.parse(readFileSync(path.join(MODELE, 'company.json'), 'utf8'))
company.demoToday = '2026-10-15'
writeFileSync(path.join(DIR, 'company.json'), JSON.stringify(company))
writeFileSync(path.join(DIR, 'categories.json'), readFileSync(path.join(MODELE, 'categories.json')))
writeFileSync(path.join(DIR, 'accounts.json'), JSON.stringify([{ id: 'acc_treso', openingBalanceCents: 1_000_000, openingDate: '2026-01-01' }]))
for (const n of ['transactions', 'forecast', 'invoices', 'scenarios', 'proposals']) writeFileSync(path.join(DIR, `${n}.json`), '[]')

const { createProposal, resolveProposal } = await import('./agent.js')
const lire = (n) => JSON.parse(readFileSync(path.join(DIR, `${n}.json`), 'utf8'))

test('POST /api/proposals : une écriture valide est créée en attente, rien au prévisionnel', async () => {
  const r = await createProposal({ kind: 'forecast_line', month: '2026-12', categoryId: 'enc_prestations', amountCents: 1_200_000, label: 'Devis signé', intrus: 'ignoré' }, { source: 'agent-api' })
  assert.equal(r.error, undefined)
  assert.equal(r.proposal.status, 'pending')
  assert.equal(r.proposal.source, 'agent-api')
  assert.equal(r.proposal.payload.intrus, undefined)
  assert.equal(lire('proposals').length, 1)
  assert.equal(lire('forecast').length, 0)
  // la décision humaine écrit
  await resolveProposal(r.proposal.id, 'confirm')
  assert.equal(lire('forecast')[0].amountCents, 1_200_000)
})

test('POST /api/proposals : mois passé, signe incohérent ou type inconnu refusés', async () => {
  assert.match((await createProposal({ kind: 'forecast_line', month: '2026-09', categoryId: 'enc_prestations', amountCents: 100, label: 'x' })).error, /mois passé/)
  assert.match((await createProposal({ kind: 'forecast_line', month: '2026-12', categoryId: 'dec_loyer', amountCents: 100, label: 'x' })).error, /positif sur un décaissement/)
  assert.match((await createProposal({ kind: 'ecriture_directe' })).error, /kind inconnu/)
})
