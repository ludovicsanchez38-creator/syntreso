import { readFile, writeFile, rename, mkdir, appendFile, open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { dataDir } from './paths.js'

// Dossier de données résolu à l'appel (paths.js) : SYNTRESO_DATA_DIR permet de pointer
// vers un jeu isolé (tests, démo, données réelles). Par défaut : <racine>/donnees.

// Mutex applicatif UNIQUE : une seule file partagée sérialise TOUTES les opérations
// sur les JSON métier (écritures simples ET cycles lire->modifier->réécrire). Un seul
// process Node : une promise-chain en mémoire suffit à tuer la perte silencieuse
// last-write-wins (deux confirmations concurrentes, un PATCH forecast pendant un
// resolveProposal, un import). Toute mutation passe par cette file.
let opChain = Promise.resolve()
const lockContext = new AsyncLocalStorage()

// Sérialise une opération asynchrone arbitraire sur les données. La file ignore les
// rejets précédents (catch interne) pour qu'une erreur sur une opération ne bloque
// pas définitivement les suivantes. Retourne la valeur (ou la rejection) de `fn`.
export function withDataLock(fn) {
  const run = opChain.then(() => lockContext.run(true, fn))
  opChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// Une lecture groupée attend les mutations ; dans une mutation déjà verrouillée,
// elle réutilise la section critique (validation et listeners de l'assistant).
export function withDataSnapshot(fn) {
  return lockContext.getStore() ? fn() : withDataLock(fn)
}

export function dataPath(name) {
  return path.join(dataDir(), `${name}.json`)
}

export async function readJson(name) {
  const journal = path.join(dataDir(), 'mutations.sqlite')
  if (existsSync(journal)) {
    const db = new DatabaseSync(journal, { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM documents WHERE name = ?').get(name)
      if (row) return JSON.parse(row.value)
    } finally {
      db.close()
    }
  }
  const raw = await readFile(dataPath(name), 'utf8')
  return JSON.parse(raw)
}

export async function readJsonOr(name, fallback) {
  try {
    return await readJson(name)
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

/**
 * Commit durable d'un ensemble de documents, DÉJÀ sous withDataLock.
 * SQLite garde les valeurs validées tant que leur copie JSON n'est pas complète.
 * En cas de panne ou d'arrêt entre deux renommages, readJson lit ce journal ; la
 * prochaine écriture reprend toutes les copies en attente avant de vider le journal.
 * Une panne de copie APRÈS COMMIT ne transforme donc pas un succès métier en échec.
 */
export async function writeJsonBatchInLock(documents) {
  if (!lockContext.getStore()) throw new Error('écriture coordonnée hors verrou')
  const entries = Object.entries(documents).map(([name, value]) => [name, JSON.stringify(value, null, 2) + '\n'])
  await mkdir(dataDir(), { recursive: true })
  const db = new DatabaseSync(path.join(dataDir(), 'mutations.sqlite'))
  try {
    db.exec('PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('BEGIN IMMEDIATE')
    try {
      const put = db.prepare('INSERT OR REPLACE INTO documents (name, value) VALUES (?, ?)')
      for (const [name, value] of entries) put.run(name, value)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    try {
      for (const { name, value } of db.prepare('SELECT name, value FROM documents').all()) {
        const target = dataPath(name)
        await writeFile(`${target}.tmp`, value, 'utf8')
        const file = await open(`${target}.tmp`, 'r+')
        try { await file.sync() } finally { await file.close() }
        await rename(`${target}.tmp`, target)
      }
      const directory = await open(dataDir(), 'r')
      try { await directory.sync() } finally { await directory.close() }
      db.exec('DELETE FROM documents')
    } catch (err) {
      console.error('[données] commit conservé dans mutations.sqlite, copie JSON à reprendre :', err.message)
    }
  } finally {
    db.close()
  }
}

// Écriture atomique (tmp + rename), sérialisée sur la file unique. Conserve la
// signature historique (writeJson(name, data) -> Promise).
export function writeJson(name, data) {
  return withDataLock(async () => {
    await writeJsonBatchInLock({ [name]: data })
    return data
  })
}

// ------------------------------------------------------------------ Cycle read-modify-write verrouillé
/**
 * Lit un fichier JSON, applique `mutator` (qui reçoit la valeur lue, renvoie la
 * nouvelle valeur OU `undefined` pour ne rien écrire), puis réécrit atomiquement — le
 * TOUT dans une seule section critique de la file unique. C'est le rempart contre le
 * last-write-wins : entre la lecture et l'écriture, aucune autre opération ne
 * s'intercale. `fallback` est utilisé si le fichier n'existe pas encore.
 *
 * Retourne { value } (la valeur écrite) ou { skipped: true } si le mutator a renvoyé
 * `undefined` (aucune écriture).
 */
export function updateJson(name, mutator, fallback = null) {
  return withDataLock(async () => {
    const current = await readJsonOr(name, fallback)
    const next = await mutator(current)
    if (next === undefined) return { skipped: true }
    await writeJsonBatchInLock({ [name]: next })
    return { value: next }
  })
}

// ------------------------------------------------------------------ Journal d'audit (JSONL)
// Trace légère de ce que l'agent, l'utilisateur ou un import a touché (confort et
// traçabilité, PAS conformité). Append-only, une ligne JSON par mutation, dans le
// dossier de données (SYNTRESO_DATA_DIR).
//
// Schéma d'une ligne :
//   { ts, actor, action, target, before, after, meta }
// - ts     : ISO 8601 UTC (auto si absent)
// - actor  : 'agent' | 'user' | 'cron' | 'import' | 'system'
// - action : '<entité>.<verbe>' (forecast.upsert, proposal.confirm, ...)
// - target : id de l'objet muté
// - before/after : extraits MINIMAUX des champs modifiés (null sur création)
// - meta   : libre, court
const AUDIT_FILE = 'audit.jsonl'

function normalizeAuditEntry(entry) {
  return {
    ts: entry.ts || new Date().toISOString(),
    actor: entry.actor || 'system',
    action: entry.action || 'unknown',
    target: entry.target ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? null,
  }
}

// Écriture brute (sans verrou) du journal. À n'appeler QUE depuis une section critique
// déjà sous withDataLock (sinon utiliser appendAudit, qui prend le verrou). Best effort :
// une erreur d'audit ne fait jamais échouer la mutation métier.
async function writeAuditLine(line) {
  try {
    await mkdir(dataDir(), { recursive: true })
    await appendFile(path.join(dataDir(), AUDIT_FILE), JSON.stringify(line) + '\n', 'utf8')
    return line
  } catch (err) {
    console.error('[audit] écriture journal échouée :', err.message)
    return null
  }
}

/**
 * Ajoute une ligne au journal d'audit, en PRENANT le verrou de données (pas
 * d'interleaving avec les écritures). À utiliser hors section critique. Dans une
 * section déjà verrouillée (ex. resolveProposal), utiliser `appendAuditInLock`.
 */
export function appendAudit(entry) {
  const line = normalizeAuditEntry(entry)
  return withDataLock(() => writeAuditLine(line))
}

/**
 * Variante d'audit SANS verrou : à appeler uniquement depuis une opération déjà
 * exécutée sous withDataLock (sinon réentrance -> deadlock). Le verrou parent garantit
 * déjà l'absence d'interleaving.
 */
export function appendAuditInLock(entry) {
  return writeAuditLine(normalizeAuditEntry(entry))
}

/** Lit les N dernières lignes du journal d'audit (les plus récentes en dernier). */
export async function readAudit({ limit = 100 } = {}) {
  const file = path.join(dataDir(), AUDIT_FILE)
  if (!existsSync(file)) return []
  const raw = await readFile(file, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  const slice = limit ? lines.slice(-limit) : lines
  const out = []
  for (const l of slice) {
    try {
      out.push(JSON.parse(l))
    } catch {
      // ligne corrompue (interruption disque) : on l'ignore, le journal reste lisible
    }
  }
  return out
}
