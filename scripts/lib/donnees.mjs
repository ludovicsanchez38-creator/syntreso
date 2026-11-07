// Outils communs aux scripts d'initialisation : dossier de données, mise de côté d'une
// base existante (jamais de suppression), signal au serveur.
import { existsSync, readdirSync, mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from '../../server/src/services/paths.js'

export { dataDir }

export function lireJson(fichier) {
  return JSON.parse(readFileSync(fichier, 'utf8'))
}

export function ecrireJson(dossier, nom, data) {
  mkdirSync(dossier, { recursive: true })
  writeFileSync(path.join(dossier, `${nom}.json`), JSON.stringify(data, null, 2) + '\n')
}

/** 'vide' | 'demo' | 'reelle' selon le contenu du dossier de données. */
export function natureBase(dossier = dataDir()) {
  const f = path.join(dossier, 'company.json')
  if (!existsSync(f)) return 'vide'
  try {
    return lireJson(f).demoToday ? 'demo' : 'reelle'
  } catch {
    return 'reelle'
  }
}

/**
 * Déplace le contenu actuel du dossier de données dans un sous-dossier
 * sauvegarde-AAAAMMJJ-HHMMSS (rien n'est supprimé). Retourne le chemin de la sauvegarde.
 */
export function mettreDeCote(dossier = dataDir()) {
  if (!existsSync(dossier)) return null
  const entrees = readdirSync(dossier).filter((n) => !n.startsWith('sauvegarde-'))
  if (!entrees.length) return null
  const horodatage = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const cible = path.join(dossier, `sauvegarde-${horodatage}`)
  mkdirSync(cible, { recursive: true })
  for (const n of entrees) renameSync(path.join(dossier, n), path.join(cible, n))
  return cible
}

/** Prévient le serveur (s'il tourne) que les données ont changé. Best effort. */
export async function prevenirServeur() {
  const jeton = process.env.SYNTRESO_JETON
  const port = Number(process.env.SYNTRESO_PORT) || 3900
  if (!jeton) return false
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent/digest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}` },
      signal: AbortSignal.timeout(5000),
    })
    return r.ok
  } catch {
    return false
  }
}
