// Charge le fichier .env de la racine du pack (installation Mac ou lancement manuel).
// À importer EN PREMIER : certains modules lisent l'environnement à leur chargement.
// Les variables déjà présentes dans l'environnement (Docker, launchd) restent prioritaires.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './services/paths.js'

const fichier = process.env.SYNTRESO_ENV_FILE || path.join(ROOT, '.env')
if (existsSync(fichier)) process.loadEnvFile(fichier)
