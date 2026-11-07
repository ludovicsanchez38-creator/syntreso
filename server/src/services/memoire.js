// MEMOIRE.md : journal des décisions du dirigeant, lu par l'agent en
// @import (comme DONNEES.md). Le SERVEUR écrit, jamais l'agent : une ligne datée par
// événement notable (proposition confirmée/rejetée...). C'est ce qui donne à
// l'assistant la continuité entre deux séances (« le mois dernier vous aviez
// rejeté X, le sujet peut être rouvert ») sans base de données.
//
// Plafond glissant : seules les MAX_LINES dernières lignes sont conservées, le
// fichier ne grossit jamais (il est chargé à CHAQUE question de l'agent).
// Fail-soft : une mémoire indisponible ne doit jamais faire échouer la mutation
// métier appelante -> les erreurs sont avalées avec un warn.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { workspaceDir } from './paths.js'
import { todayISO } from './dates.js'

const memoirePath = () => path.join(workspaceDir(), 'MEMOIRE.md')
const MAX_LINES = 50

const HEADER = `# Mémoire des décisions passées

> Journal écrit par le serveur Syntréso à chaque décision (proposition confirmée ou
> rejetée...). ${MAX_LINES} entrées maximum, les plus récentes en bas.
`

/** Crée le fichier s'il n'existe pas (appelé au boot : l'@import ne doit pas pointer dans le vide). */
export async function ensureMemoire(filePath = memoirePath()) {
  try {
    await readFile(filePath, 'utf8')
  } catch {
    await writeAtomic(filePath, `${HEADER}\n`)
  }
}

/** Appende une entrée datée, tronque au plafond. N'échoue jamais (fail-soft). */
export async function appendMemoire(line, filePath = memoirePath()) {
  try {
    let existing = ''
    try {
      existing = await readFile(filePath, 'utf8')
    } catch {
      /* premier append : fichier créé ci-dessous */
    }
    const entries = existing.split('\n').filter((l) => l.startsWith('- '))
    entries.push(`- ${todayISO()} : ${String(line).replace(/[\r\n]+/g, ' ').trim()}`)
    const kept = entries.slice(-MAX_LINES)
    await writeAtomic(filePath, `${HEADER}\n${kept.join('\n')}\n`)
  } catch (err) {
    console.warn('[memoire] append impossible :', err.message)
  }
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}
