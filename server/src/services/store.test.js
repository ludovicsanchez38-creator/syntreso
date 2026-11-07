import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  withDataLock, writeJson, readJson, readJsonOr, updateJson,
  appendAudit, appendAuditInLock, readAudit, dataPath,
} from './store.js'

// Tous ces tests écrivent dans un dossier temporaire isolé (SYNTRESO_DATA_DIR), jamais
// dans le dossier de données réel (donnees/).
let dir
let prev
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'syntreso-store-'))
  prev = process.env.SYNTRESO_DATA_DIR
  process.env.SYNTRESO_DATA_DIR = dir
})
after(() => {
  if (prev === undefined) delete process.env.SYNTRESO_DATA_DIR
  else process.env.SYNTRESO_DATA_DIR = prev
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ Mutex / verrou
test('withDataLock : sérialise les opérations dans l\'ordre d\'arrivée', async () => {
  const order = []
  const p1 = withDataLock(async () => {
    await new Promise((r) => setTimeout(r, 30))
    order.push('a')
  })
  const p2 = withDataLock(async () => {
    order.push('b')
  })
  await Promise.all([p1, p2])
  // b ne doit PAS doubler a malgré son absence d'attente : la file est sérialisée
  assert.deepEqual(order, ['a', 'b'])
})

test('withDataLock : une opération qui throw ne bloque pas les suivantes', async () => {
  await assert.rejects(withDataLock(async () => { throw new Error('boom') }))
  const ok = await withDataLock(async () => 42)
  assert.equal(ok, 42)
})

test('updateJson : cycle read-modify-write atomique, lectures concurrentes cohérentes', async () => {
  await writeJson('counter', { n: 0 })
  // 50 incréments concurrents : sans verrou, on perdrait des incréments (last-write-wins).
  // Avec updateJson, chaque cycle lit la valeur à jour -> on doit retrouver 50.
  await Promise.all(
    Array.from({ length: 50 }, () =>
      updateJson('counter', (cur) => ({ n: (cur?.n || 0) + 1 })),
    ),
  )
  const final = await readJson('counter')
  assert.equal(final.n, 50)
})

test('updateJson : mutator renvoyant undefined -> aucune écriture (skipped)', async () => {
  await writeJson('thing', { v: 'initial' })
  const res = await updateJson('thing', () => undefined)
  assert.deepEqual(res, { skipped: true })
  assert.deepEqual(await readJson('thing'), { v: 'initial' })
})

test('updateJson : utilise le fallback si le fichier n\'existe pas', async () => {
  const res = await updateJson('absent', (cur) => {
    assert.deepEqual(cur, [])
    return [...cur, 'x']
  }, [])
  assert.deepEqual(res.value, ['x'])
})

// ------------------------------------------------------------------ Journal d'audit
test('appendAudit : append-only, normalise les champs, lit les dernières lignes', async () => {
  await appendAudit({ actor: 'user', action: 'forecast.upsert', target: 'fc_2026-08_x', before: null, after: { amountCents: 100 } })
  await appendAudit({ actor: 'agent', action: 'proposal.confirm', target: 'prop_1' })
  const entries = await readAudit({ limit: 10 })
  assert.equal(entries.length, 2)
  // ordre : plus récentes en dernier
  assert.equal(entries[0].action, 'forecast.upsert')
  assert.equal(entries[1].action, 'proposal.confirm')
  // champs normalisés (ts auto, before/after/meta par défaut)
  assert.ok(entries[0].ts)
  assert.equal(entries[1].before, null)
  assert.equal(entries[1].meta, null)
  // c'est bien dans le data dir, fichier audit.jsonl (pas un .json)
  assert.ok(existsSync(path.join(dir, 'audit.jsonl')))
})

test('appendAudit : append (ne réécrit pas), une ligne JSON par mutation', async () => {
  const before = (await readAudit({ limit: 1000 })).length
  await appendAudit({ actor: 'cron', action: 'import.run' })
  const raw = readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  assert.equal(lines.length, before + 1)
  // chaque ligne est un JSON valide
  for (const l of lines) JSON.parse(l)
})

test('appendAuditInLock : écrit aussi (variante sans verrou), même fichier', async () => {
  const before = (await readAudit({ limit: 1000 })).length
  await withDataLock(() => appendAuditInLock({ actor: 'system', action: 'test.inlock' }))
  const entries = await readAudit({ limit: 1000 })
  assert.equal(entries.length, before + 1)
  assert.equal(entries.at(-1).action, 'test.inlock')
})

beforeEach(() => {
  // chaque test peut écrire ; on garde le dossier d'un test à l'autre (audit cumulatif),
  // mais readAudit({limit}) borne ce qu'on lit, donc pas de couplage fort.
})

test('readJsonOr : fichier absent -> fallback, sans créer le fichier', async () => {
  assert.equal(existsSync(dataPath('jamais')), false)
  const v = await readJsonOr('jamais', { default: true })
  assert.deepEqual(v, { default: true })
  assert.equal(existsSync(dataPath('jamais')), false)
})
