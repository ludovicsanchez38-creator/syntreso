import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cents, lireGrandLivre, lireBalance, executerImport } from './import-indy.js'
import { dataPath } from './store.js'
import { loadState } from './projection.js'
import importRouter from '../routes/import.js'

const grandLivre = '512000;Banque;Debit;Credit;Solde\r\n\r\n01/01/2026;Débit corrompu;1234,5x;0;0\r\n02/01/2026;Autre mouvement;100,00;;100,00\r\nTotaux du poste 512000;;100,00;;100,00\r\n'
const balance = 'Compte;Intitulé;Débit;Crédit;Solde\n512000;Banque;100,00;;100,00\n'
const root = path.resolve(import.meta.dirname, '../../..')
let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'syntreso-csv-securite-'))
  process.env.SYNTRESO_DATA_DIR = path.join(dir, 'donnees')
  process.env.SYNTRESO_ENTREE_INDY = path.join(dir, 'entree')
  process.env.SYNTRESO_REGLAGES = path.join(dir, 'reglages-absents.json')
  mkdirSync(process.env.SYNTRESO_DATA_DIR)
  const base = (name) => JSON.parse(readFileSync(path.join(root, 'modeles/base-vide', `${name}.json`), 'utf8'))
  const data = { company: base('company'), categories: base('categories'), accounts: [], transactions: [], forecast: [], proposals: [], invoices: [], scenarios: [] }
  for (const [name, value] of Object.entries(data)) writeFileSync(dataPath(name), JSON.stringify(value))
})

test('F-9 : une cellule numérique non vide illisible est refusée, les cellules vides restent nulles', () => {
  for (const value of ['1234,5x', 'NaN', 'Infinity', '1e999']) assert.throws(() => cents(value), /montant illisible/i)
  assert.equal(cents(''), 0)
  assert.equal(cents('  '), 0)
  assert.equal(cents('-1 234,56'), -123456)
})

test('F-9 : le grand livre indique le fichier, la ligne physique et la colonne du débit invalide', () => {
  assert.throws(() => lireGrandLivre(grandLivre, 'grand-livre-corrompu.csv'), /grand-livre-corrompu\.csv.*ligne 3.*colonne.*Débit.*3/)
})

test('F-9 : le crédit et le solde du grand livre sont aussi contrôlés', () => {
  const valid = '512000;Banque;Debit;Credit;Solde\n01/01/2026;Mouvement;100,00;;100,00\n'
  assert.throws(() => lireGrandLivre(valid.replace('100,00;;100,00', '100,00;invalide;100,00'), 'livre.csv'), /livre\.csv.*ligne 2.*Crédit.*4/)
  assert.throws(() => lireGrandLivre(valid.replace('100,00;;100,00', '100,00;;invalide'), 'livre.csv'), /livre\.csv.*ligne 2.*Solde.*5/)
})

test('F-9 : les trois colonnes numériques de la balance sont contrôlées avec leur emplacement', () => {
  for (const [index, label] of [[2, 'Débit'], [3, 'Crédit'], [4, 'Solde']]) {
    const cells = ['512000', 'Banque', '100,00', '', '100,00']
    cells[index] = 'illisible'
    assert.throws(() => lireBalance(`Compte;Intitulé;Débit;Crédit;Solde\n${cells.join(';')}\n`, 'balance-corrompue.csv'), new RegExp(`balance-corrompue\\.csv.*ligne 2.*${label}.*${index + 1}`))
  }
})

test('F-9 : un import contenant un débit corrompu est refusé sans modifier les données métier', async () => {
  const gl = path.join(dir, 'grand-livre-corrompu.csv')
  const bal = path.join(dir, 'balance.csv')
  writeFileSync(gl, grandLivre)
  writeFileSync(bal, balance)
  const before = await loadState()
  await assert.rejects(executerImport({ grandsLivres: [gl], balance: bal, aujourdhui: '2026-10-05' }), /grand-livre-corrompu\.csv.*ligne 3.*Débit/)
  assert.deepEqual(await loadState(), before)
})

test('F-9 : le dépôt HTTP refuse le CSV corrompu avant son écriture', async () => {
  const handler = importRouter.stack.find((layer) => layer.route?.methods.put).route.stack.at(-1).handle
  const result = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(value) { resolve({ status: this.statusCode, value }) } }
    handler({ params: { nom: 'grand-livre-corrompu.csv' }, body: grandLivre }, res, reject)
  })
  assert.equal(result.status, 422)
  assert.match(result.value.error, /grand-livre-corrompu\.csv.*ligne 3.*Débit/)
  assert.equal(existsSync(path.join(process.env.SYNTRESO_ENTREE_INDY, 'grand-livre-corrompu.csv')), false)
})
