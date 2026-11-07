import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTwentyPipe, syncTwenty } from './twenty.js'
import { readJson, dataPath } from './store.js'

const opp = (id) => ({ id, stage: 'WON', amount: { amountMicros: 1_000_000_000 }, closeDate: '2026-12-15' })
const response = (opportunities, pageInfo, totalCount) => ({ ok: true, json: async () => ({ data: { opportunities }, pageInfo, totalCount }) })
const options = { baseUrl: 'http://twenty-factice', apiKey: 'cle-factice' }

test('F-8 : le connecteur parcourt toutes les pages Twenty avec leur curseur', async () => {
  const calls = []
  const pipe = await readTwentyPipe({ ...options, fetchImpl: async (url, init) => {
    calls.push(url)
    assert.equal(init.headers.Authorization, 'Bearer cle-factice')
    const cursor = new URL(url).searchParams.get('starting_after')
    return cursor === null
      ? response([opp('a')], { hasNextPage: true, endCursor: 'curseur+/=' }, 2)
      : response([opp('b')], { hasNextPage: false, endCursor: 'fin' }, 2)
  } })
  assert.deepEqual(pipe.map((o) => o.id), ['a', 'b'])
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1]).searchParams.get('starting_after'), 'curseur+/=')
})

test('F-8 : une deuxième page en erreur ne crée aucune proposition ni marqueur de fraîcheur', async () => {
  process.env.SYNTRESO_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'syntreso-pagination-'))
  process.env.SYNTRESO_REGLAGES = path.join(process.env.SYNTRESO_DATA_DIR, 'reglages-absents.json')
  const company = { demoToday: '2026-10-15', importedAt: { twenty: '2026-01-01' } }
  for (const [name, value] of Object.entries({ company, forecast: [], categories: [], proposals: [] })) writeFileSync(dataPath(name), JSON.stringify(value))
  let calls = 0
  await assert.rejects(syncTwenty({ ...options, fetchImpl: async () => ++calls === 1
    ? response([opp('a')], { hasNextPage: true, endCursor: 'suite' }, 2)
    : { ok: false, status: 503, statusText: 'panne simulée' },
  }), /Twenty API 503/)
  assert.deepEqual(await readJson('company'), company)
  assert.deepEqual(await readJson('proposals'), [])
  assert.deepEqual(await readJson('forecast'), [])
})

test('F-8 : une suite annoncée sans curseur est refusée', async () => {
  await assert.rejects(readTwentyPipe({ ...options, fetchImpl: async () => response([opp('a')], { hasNextPage: true }) }), /pagination.*curseur/i)
})

test('F-8 : un curseur répété est refusé au lieu de boucler ou compter deux fois', async () => {
  let calls = 0
  await assert.rejects(readTwentyPipe({ ...options, fetchImpl: async () => {
    assert.ok(++calls <= 2, 'pas de troisième requête sur le même curseur')
    return response([opp(String(calls))], { hasNextPage: true, endCursor: 'identique' })
  } }), /pagination.*curseur/i)
})

test('F-8 : une page pleine sans indication de fin est refusée comme incomplète', async () => {
  await assert.rejects(readTwentyPipe({ ...options, fetchImpl: async () => response(Array.from({ length: 200 }, (_, i) => opp(String(i)))) }), /pagination.*incomplète/i)
})

test('F-8 : un total supérieur aux affaires reçues interdit une synchronisation complète', async () => {
  await assert.rejects(readTwentyPipe({ ...options, fetchImpl: async () => response([opp('a')], { hasNextPage: false }, 2) }), /pagination.*incomplète/i)
})
