#!/usr/bin/env node
// Charge les données de DÉMONSTRATION (entreprise fictive « Bâti Provence SARL », TPE du
// bâtiment, date figée au 10/06/2026). Pratique pour découvrir l'appli avant d'importer
// sa propre compta.
//
//   npm run demo             refuse si une base réelle existe déjà
//   npm run demo -- --forcer met la base existante de côté (sous-dossier sauvegarde-...), puis charge la démo
import '../server/src/env.js'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, ecrireJson, natureBase, mettreDeCote, prevenirServeur } from './lib/donnees.mjs'

const forcer = process.argv.includes('--forcer')
const dossier = dataDir()
const nature = natureBase(dossier)

if (nature === 'reelle' && !forcer) {
  console.error(`Une base réelle existe dans ${dossier} : la démo ne l'écrase pas.`)
  console.error('Relancez avec --forcer pour la mettre de côté (sous-dossier sauvegarde-...) et charger la démo.')
  process.exit(1)
}
if (nature === 'reelle') {
  console.log(`Base réelle mise de côté dans ${mettreDeCote(dossier)}`)
}

const generateur = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate-data.mjs')
execFileSync(process.execPath, [generateur], { env: { ...process.env, SYNTRESO_DATA_DIR: dossier }, stdio: 'inherit' })
// état initial de démo : aucune proposition en attente, pas de contenu IA en cache
ecrireJson(dossier, 'proposals', [])
ecrireJson(dossier, 'agent-cache', {})
console.log(`Démo chargée dans ${dossier}.`)
if (await prevenirServeur()) console.log('Serveur prévenu.')
