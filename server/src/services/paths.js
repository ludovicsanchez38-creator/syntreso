// Emplacements de Syntréso, résolus À L'APPEL (jamais figés au chargement du module) :
// les tests et l'import pointent ailleurs via les variables d'environnement.
//
//   SYNTRESO_DATA_DIR      dossier des données (JSON, journal d'audit, archives, assistant)
//                          défaut : <racine>/donnees
//   SYNTRESO_REGLAGES      fichier de réglages (import Indy, prévisionnel, Twenty)
//                          défaut : <racine>/config/reglages.json
//   SYNTRESO_ENTREE_INDY   dossier où l'on dépose les exports Indy à importer
//                          défaut : <racine>/entree-indy
//
// Tout ce qui bouge vit dans le dossier de données : une sauvegarde de ce seul dossier
// (plus config/reglages.json) suffit à tout restaurer.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Racine du pack (dossier qui contient server/, web/, config/...). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Modèle de l'espace de travail de l'assistant (copié dans le dossier de données au démarrage). */
export const WORKSPACE_TEMPLATE = path.join(ROOT, 'agent-workspace')

export function dataDir() {
  return process.env.SYNTRESO_DATA_DIR ? path.resolve(process.env.SYNTRESO_DATA_DIR) : path.join(ROOT, 'donnees')
}

export function reglagesPath() {
  return process.env.SYNTRESO_REGLAGES ? path.resolve(process.env.SYNTRESO_REGLAGES) : path.join(ROOT, 'config', 'reglages.json')
}

export function entreeIndyDir() {
  return process.env.SYNTRESO_ENTREE_INDY ? path.resolve(process.env.SYNTRESO_ENTREE_INDY) : path.join(ROOT, 'entree-indy')
}

/** Espace de travail de l'assistant : CLAUDE.md + DONNEES.md (digest) + MEMOIRE.md. */
export function workspaceDir() {
  return path.join(dataDir(), 'assistant')
}
