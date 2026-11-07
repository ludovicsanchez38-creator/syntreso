#!/usr/bin/env node
// Régénère LICENCES-TIERCES.md : licences des composants tiers de Syntréso.
//
//   npm --prefix server ci && npm --prefix web ci     (dépendances installées)
//   node scripts/licences-tierces.mjs
//
// - Interface (web/dist, livrée construite dans le dépôt) : la liste exacte des paquets
//   embarqués est relevée en refaisant la construction en mémoire (rien n'est écrit dans
//   web/dist) ; leurs textes de licence sont reproduits en entier, comme le demandent
//   MIT, ISC, BSD et OFL pour une copie redistribuée.
// - Serveur : dépendances de production lues dans server/package-lock.json. Elles ne sont
//   pas dans le dépôt (npm les télécharge à l'installation) ; leur licence est indiquée.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const SERVER = path.join(ROOT, 'server')
const SORTIE = path.join(ROOT, 'LICENCES-TIERCES.md')

const lireJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

// Clé de lockfile (« node_modules/a/node_modules/@b/c ») d'un module construit.
function cleLockfile(id) {
  const rel = path.relative(WEB, id.replace(/^\0/, '').split('?')[0])
  const parties = rel.split(path.sep)
  const morceaux = []
  for (let i = 0; i < parties.length; i++) {
    if (parties[i] !== 'node_modules') continue
    const nom = parties[i + 1]?.startsWith('@') ? `${parties[i + 1]}/${parties[i + 2]}` : parties[i + 1]
    if (nom) morceaux.push(nom)
  }
  return morceaux.length ? morceaux.map((n) => `node_modules/${n}`).join('/') : null
}

async function paquetsEmbarques() {
  const requireWeb = createRequire(path.join(WEB, 'package.json'))
  const vite = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const cles = new Set()
  await vite.build({
    root: WEB,
    configFile: path.join(WEB, 'vite.config.ts'),
    logLevel: 'error',
    build: { write: false, outDir: path.join(WEB, 'dist-inventaire-non-ecrit') },
    plugins: [
      {
        name: 'inventaire-licences',
        // modules effectivement émis (après élimination du code mort) et fichiers importés
        // (polices) : exactement ce qui finit dans web/dist
        generateBundle(_options, bundle) {
          for (const sortie of Object.values(bundle)) {
            for (const id of Object.keys(sortie.modules || {})) {
              const cle = cleLockfile(id)
              if (cle) cles.add(cle)
            }
            for (const id of sortie.originalFileNames || []) {
              const cle = cleLockfile(path.join(WEB, id))
              if (cle) cles.add(cle)
            }
          }
        },
      },
    ],
  })
  return cles
}

const FICHIERS_LICENCE = /^(licen[cs]e|copying|notice|ofl)([-._].*)?$/i
function textesLicence(dossier) {
  if (!existsSync(dossier)) return []
  return readdirSync(dossier)
    .filter((f) => FICHIERS_LICENCE.test(f))
    .sort()
    .map((f) => ({ fichier: f, texte: readFileSync(path.join(dossier, f), 'utf8').trim() }))
}

function licenceDe(entree) {
  const l = entree.license
  return typeof l === 'string' ? l : l?.type || 'non déclarée'
}

const lockWeb = lireJson(path.join(WEB, 'package-lock.json'))
const lockServer = lireJson(path.join(SERVER, 'package-lock.json'))

const embarques = [...(await paquetsEmbarques())]
  .filter((cle) => lockWeb.packages[cle])
  .map((cle) => ({ cle, nom: cle.split('node_modules/').pop(), version: lockWeb.packages[cle].version, licence: licenceDe(lockWeb.packages[cle]) }))
  .sort((a, b) => a.nom.localeCompare(b.nom) || a.version.localeCompare(b.version))

const serveur = Object.entries(lockServer.packages)
  .filter(([cle, e]) => cle && !e.dev)
  .map(([cle, e]) => ({ cle, nom: cle.split('node_modules/').pop(), version: e.version, licence: licenceDe(e), optionnel: Boolean(e.optional) }))
  .sort((a, b) => a.nom.localeCompare(b.nom))

const compter = (liste) =>
  Object.entries(liste.reduce((acc, p) => ((acc[p.licence] = (acc[p.licence] || 0) + 1), acc), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} (${n})`)
    .join(', ')

const lignes = []
lignes.push('# Licences des composants tiers')
lignes.push('')
lignes.push("Syntréso est distribuée sous licence AGPL-3.0 (voir `LICENSE`). Elle s'appuie sur des composants tiers, chacun sous sa propre licence, listés ci-dessous. Fichier produit par `node scripts/licences-tierces.mjs` à partir des verrous `web/package-lock.json` et `server/package-lock.json`.")
lignes.push('')
lignes.push('## Le composant qui n\'est pas libre : le Claude Agent SDK')
lignes.push('')
lignes.push("`@anthropic-ai/claude-agent-sdk` (assistant IA facultatif) et ses programmes natifs par plateforme (`@anthropic-ai/claude-agent-sdk-*`) ne sont pas des logiciels libres : leur notice dit « © Anthropic PBC. All rights reserved » et renvoie aux conditions d'Anthropic (https://code.claude.com/docs/en/legal-and-compliance). Ils ne sont pas inclus dans ce dépôt : npm les télécharge à l'installation, comme dépendances **optionnelles**. Syntréso fonctionne entièrement sans eux (`npm --prefix server ci --omit=optional`, assistant alors indisponible) et ne charge jamais le SDK quand l'assistant est coupé.")
lignes.push('')
lignes.push(`## Interface web (\`web/dist\`, livrée construite) : ${embarques.length} paquets embarqués`)
lignes.push('')
lignes.push(`Licences : ${compter(embarques)}. Les textes complets suivent le tableau du serveur.`)
lignes.push('')
lignes.push('| Paquet | Version | Licence |')
lignes.push('|---|---|---|')
for (const p of embarques) lignes.push(`| ${p.nom} | ${p.version} | ${p.licence} |`)
lignes.push('')
lignes.push(`## Serveur : ${serveur.length} paquets de production (installés par npm, absents du dépôt)`)
lignes.push('')
lignes.push(`Licences : ${compter(serveur)}.`)
lignes.push('')
lignes.push('| Paquet | Version | Licence | Optionnel |')
lignes.push('|---|---|---|---|')
for (const p of serveur) lignes.push(`| ${p.nom} | ${p.version} | ${p.licence} | ${p.optionnel ? 'oui' : ''} |`)
lignes.push('')
lignes.push("Outils de développement (non distribués) : Vite, TypeScript, ESLint, Tailwind CSS et leurs dépendances, déclarés en `devDependencies`.")
lignes.push('')
lignes.push('## Textes des licences des paquets embarqués dans l\'interface')
lignes.push('')
const sansTexte = []
for (const p of embarques) {
  const textes = textesLicence(path.join(WEB, p.cle))
  lignes.push(`### ${p.nom} ${p.version} (${p.licence})`)
  lignes.push('')
  if (!textes.length) {
    sansTexte.push(p.nom)
    const meta = lireJson(path.join(WEB, p.cle, 'package.json'))
    const auteur = typeof meta.author === 'string' ? meta.author : meta.author?.name
    lignes.push(`Aucun fichier de licence dans le paquet publié. Licence déclarée : ${p.licence}${auteur ? ` ; auteur : ${auteur}` : ''}${meta.repository ? ` ; source : ${typeof meta.repository === 'string' ? meta.repository : meta.repository.url}` : ''}.`)
    lignes.push('')
    continue
  }
  for (const t of textes) {
    lignes.push(`\`${t.fichier}\` :`)
    lignes.push('')
    lignes.push('```text')
    lignes.push(t.texte.replace(/```/g, "'''"))
    lignes.push('```')
    lignes.push('')
  }
}

writeFileSync(SORTIE, lignes.join('\n'))
console.log(`${path.relative(ROOT, SORTIE)} : ${embarques.length} paquets embarqués dans l'interface, ${serveur.length} paquets serveur.`)
if (sansTexte.length) console.log(`Sans fichier de licence dans le paquet : ${sansTexte.join(', ')}`)
