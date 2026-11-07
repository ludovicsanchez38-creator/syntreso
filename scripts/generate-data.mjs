// Générateur de données fictives Syntréso - Bâti Provence SARL (TPE BTP, Manosque)
// Sortie déterministe : PRNG seedé, date du jour figée. Relancer = mêmes fichiers.
//
// Période réalisé : 2025-04-01 -> 2026-06-10 (demoToday)
// Période prévisionnel : 2026-06 -> 2026-12
//
// Calage volontaire :
//  - solde au 2026-06-10 ~ 46 000 EUR
//  - point bas projeté ~ 9 800 EUR fin août 2026 (congés bâtiment), sous le seuil de 15 000 EUR
//  - facture inv_031 (38 400 EUR, Durance Logis) échue depuis le 15/05, encaissement attendu le 25/06
//  - anomalie : Logiciels & télécom passe de 480 à 960 EUR/mois en avril 2026

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from '../server/src/services/paths.js'

// Dossier cible : SYNTRESO_DATA_DIR, sinon le dossier de données du pack (donnees/).
// Préférer « npm run demo », qui refuse d'écraser une base réelle.
const DATA_DIR = dataDir()

// ---------------------------------------------------------------- PRNG seedé
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260610)
const between = (min, max) => min + rand() * (max - min)
const intBetween = (min, max) => Math.round(between(min, max))
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

// ---------------------------------------------------------------- Constantes
const TODAY = '2026-06-10'
const OPENING_BALANCE = 4_823_000 // 48 230 EUR au 2025-04-01
const LOW_CASH_THRESHOLD = 1_500_000 // 15 000 EUR
const TARGET_BALANCE_TODAY = 4_600_000 // ~46 000 EUR
const TARGET_LOW_POINT = 980_000 // ~9 800 EUR fin août

// Coefficients saisonniers BTP (janvier -> décembre)
const SEASON = [0.7, 0.7, 1.0, 1.05, 1.2, 1.25, 1.3, 0.5, 1.1, 1.1, 1.05, 0.8]

const REALIZED_MONTHS = [
  '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09',
  '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
  '2026-04', '2026-05', '2026-06',
]
const FORECAST_MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']

// vatRatePct : taux de TVA du flux (points de %), 0 = hors champ TVA.
// fixed : charge fixe au sens point mort (true) vs variable (false/absent).
// C'est vatRatePct qui tranche pour le calcul TVA, jamais une liste d'IDs en dur.
const CATEGORIES = [
  { id: 'enc_chantiers', label: 'Encaissements chantiers', direction: 'in', order: 1, vatRatePct: 20 },
  { id: 'enc_depannage', label: 'Petits travaux & dépannage', direction: 'in', order: 2, vatRatePct: 20 },
  { id: 'enc_divers', label: 'Autres encaissements', direction: 'in', order: 3, vatRatePct: 0 },
  { id: 'dec_salaires', label: 'Salaires nets', direction: 'out', order: 4, vatRatePct: 0, fixed: true },
  { id: 'dec_urssaf', label: 'Charges sociales (URSSAF)', direction: 'out', order: 5, vatRatePct: 0, fixed: true },
  { id: 'dec_materiaux', label: 'Fournisseurs matériaux', direction: 'out', order: 6, vatRatePct: 20, fixed: false },
  { id: 'dec_soustraitance', label: 'Sous-traitance', direction: 'out', order: 7, vatRatePct: 20, fixed: false },
  { id: 'dec_vehicules', label: 'Véhicules & carburant', direction: 'out', order: 8, vatRatePct: 20, fixed: false },
  { id: 'dec_leasing', label: 'Leasing matériel', direction: 'out', order: 9, vatRatePct: 20, fixed: true },
  { id: 'dec_loyer', label: 'Loyer dépôt & charges', direction: 'out', order: 10, vatRatePct: 20, fixed: true },
  { id: 'dec_assurances', label: 'Assurances & mutuelle', direction: 'out', order: 11, vatRatePct: 0, fixed: true },
  { id: 'dec_tva', label: 'TVA décaissée', direction: 'out', order: 12, vatRatePct: 0, fixed: false },
  { id: 'dec_abonnements', label: 'Logiciels & télécom', direction: 'out', order: 13, vatRatePct: 20, fixed: true },
  { id: 'dec_emprunts', label: "Échéances d'emprunt", direction: 'out', order: 14, vatRatePct: 0, fixed: true },
]

const MATERIAL_SUPPLIERS = ['Négoce Matériaux Durance', 'Matériaux du Grand Lubéron', 'Comptoir BTP Oraison', 'Bois & Matériaux de Vinon', 'Fixations Pro Sud', 'Tubes & Raccords Provence']
const FUEL_PARTIES = ['Relais Carburants Durance', 'Station du Lavoir', 'Garage du Vieux Pont', 'Station des Plaines']
const SMALL_CLIENTS = ['Mme Garcin', 'M. Bonnet', 'SCI Les Tilleuls', 'Camping Les Oliviers Bleus', 'M. et Mme Roux', 'Boulangerie du Cours', 'SARL Lou Soleu', 'Mairie de Villefranche-sur-Lauze', 'Dr Reynaud', 'M. Vidal']
const SUBCONTRACTORS = ['SARL Plâtrerie Imbert', 'Élec Bastide SARL', 'Carrelages Mancuso']

// ---------------------------------------------------------------- Utilitaires dates
const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}
const monthIndex = (ym) => Number(ym.split('-')[1]) - 1
const dateIn = (ym, day) => `${ym}-${String(Math.min(day, daysInMonth(ym))).padStart(2, '0')}`

let txnSeq = 0
const transactions = []
function addTxn({ date, label, categoryId, amountCents, counterparty = null, invoiceId = null }) {
  if (!Number.isInteger(amountCents)) throw new Error(`Montant non entier: ${label} ${amountCents}`)
  if (date > TODAY) return null // le réalisé s'arrête à aujourd'hui
  txnSeq += 1
  const txn = {
    id: `txn_${String(txnSeq).padStart(4, '0')}`,
    date,
    label,
    categoryId,
    amountCents,
    accountId: 'acc_ca',
    counterparty,
    invoiceId,
    source: 'seed',
  }
  transactions.push(txn)
  return txn
}

// ---------------------------------------------------------------- Chantiers scénarisés
// Échéanciers des 3 gros chantiers (acompte / situations / solde), TTC en centimes.
const invoices = []
function addInvoice({ id, clientName, label, amountCents, issueDate, dueDate, paidDate = null, expectedPaymentDate = null }) {
  const paid = paidDate !== null && paidDate <= TODAY
  const overdue = !paid && dueDate < TODAY
  const inv = {
    id,
    clientName,
    label,
    amountCents,
    issueDate,
    dueDate,
    status: paid ? 'paid' : overdue ? 'overdue' : 'pending',
    expectedPaymentDate: paid ? null : (expectedPaymentDate || dueDate),
  }
  invoices.push(inv)
  if (paid) {
    addTxn({
      date: paidDate, label, categoryId: 'enc_chantiers', amountCents,
      counterparty: clientName, invoiceId: id,
    })
  }
  return inv
}

// Chantier 1 - Villa Roche d'Espeil (96 000 EUR TTC, été-automne 2025, solde payé avec 25 j de retard)
addInvoice({ id: 'inv_011', clientName: "SCI Roche d'Espeil", label: "Acompte 30 % - Rénovation villa Roche d'Espeil", amountCents: 2_880_000, issueDate: '2025-05-02', dueDate: '2025-05-17', paidDate: '2025-05-12' })
addInvoice({ id: 'inv_012', clientName: "SCI Roche d'Espeil", label: "Situation n°1 - Villa Roche d'Espeil", amountCents: 2_412_000, issueDate: '2025-06-20', dueDate: '2025-07-20', paidDate: '2025-07-03' })
addInvoice({ id: 'inv_013', clientName: "SCI Roche d'Espeil", label: "Situation n°2 - Villa Roche d'Espeil", amountCents: 2_412_000, issueDate: '2025-08-08', dueDate: '2025-09-07', paidDate: '2025-08-28' })
addInvoice({ id: 'inv_014', clientName: "SCI Roche d'Espeil", label: "Solde - Villa Roche d'Espeil", amountCents: 1_896_000, issueDate: '2025-09-15', dueDate: '2025-10-15', paidDate: '2025-11-09' })

// Chantier 2 - Réhabilitation 6 logements Oraison (128 000 EUR TTC, hiver-printemps 2026, solde IMPAYÉ)
addInvoice({ id: 'inv_021', clientName: 'Durance Logis Promotion', label: 'Acompte 30 % - Réhabilitation 6 logements Oraison', amountCents: 3_840_000, issueDate: '2026-01-06', dueDate: '2026-02-05', paidDate: '2026-01-20' })
addInvoice({ id: 'inv_022', clientName: 'Durance Logis Promotion', label: 'Situation n°1 - Réhabilitation Oraison', amountCents: 2_560_000, issueDate: '2026-02-10', dueDate: '2026-03-12', paidDate: '2026-02-26' })
addInvoice({ id: 'inv_023', clientName: 'Durance Logis Promotion', label: 'Situation n°2 - Réhabilitation Oraison', amountCents: 2_560_000, issueDate: '2026-03-16', dueDate: '2026-04-15', paidDate: '2026-03-31' })
addInvoice({ id: 'inv_031', clientName: 'Durance Logis Promotion', label: 'Solde - Réhabilitation 6 logements Oraison', amountCents: 3_840_000, issueDate: '2026-04-15', dueDate: '2026-05-15', expectedPaymentDate: '2026-06-25' })

// Chantier 3 - Extension cave Le Grand Plateau (64 000 EUR TTC, hiver 2025-2026, payé sans incident)
addInvoice({ id: 'inv_041', clientName: 'Cave coopérative Le Grand Plateau', label: 'Acompte 30 % - Extension cave Valensole', amountCents: 1_920_000, issueDate: '2025-11-10', dueDate: '2025-12-10', paidDate: '2025-11-24' })
addInvoice({ id: 'inv_042', clientName: 'Cave coopérative Le Grand Plateau', label: 'Situation n°1 - Extension cave Valensole', amountCents: 2_560_000, issueDate: '2025-12-18', dueDate: '2026-01-17', paidDate: '2026-01-09' })
addInvoice({ id: 'inv_043', clientName: 'Cave coopérative Le Grand Plateau', label: 'Solde - Extension cave Valensole', amountCents: 1_920_000, issueDate: '2026-01-26', dueDate: '2026-02-25', paidDate: '2026-02-20' })

// Factures en attente (à venir, pas en retard)
addInvoice({ id: 'inv_032', clientName: 'M. et Mme Delorme', label: 'Situation n°1 - Surélévation maison Volx', amountCents: 1_440_000, issueDate: '2026-06-05', dueDate: '2026-07-05', expectedPaymentDate: '2026-07-05' })
addInvoice({ id: 'inv_033', clientName: 'SCI Les Micocouliers', label: 'Remplacement toiture hangar - facture', amountCents: 216_000, issueDate: '2026-05-30', dueDate: '2026-06-30', expectedPaymentDate: '2026-06-30' })

// Encaissement chantier "ajustable" pour le calage du solde (situation de juin, montant recalculé plus bas)
const ADJUSTABLE = addTxn({
  date: '2026-06-05', label: 'Acompte 30 % - Surélévation maison Volx', categoryId: 'enc_chantiers',
  amountCents: 1_550_000, counterparty: 'M. et Mme Delorme',
})

// ---------------------------------------------------------------- Flux mensuels
const monthlyChantierScripted = {}
for (const t of transactions.filter((t) => t.categoryId === 'enc_chantiers')) {
  const ym = t.date.slice(0, 7)
  monthlyChantierScripted[ym] = (monthlyChantierScripted[ym] || 0) + t.amountCents
}

const CHANTIER_BASE = 6_700_000 // cible mensuelle moyenne d'encaissements chantiers (hors coefficient)
const DEPANNAGE_BASE = 1_500_000

for (const ym of REALIZED_MONTHS) {
  const coef = SEASON[monthIndex(ym)]
  const isCurrent = ym === '2026-06'
  const lastDay = isCurrent ? 10 : daysInMonth(ym)

  // --- Encaissements chantiers aléatoires (complément des chantiers scénarisés)
  const target = Math.round(CHANTIER_BASE * coef * between(0.92, 1.08))
  let remaining = target - (monthlyChantierScripted[ym] || 0)
  let guard = 0
  while (remaining > 800_000 && guard < 4) {
    guard += 1
    const part = guard === 4 ? remaining : Math.min(remaining, intBetween(400_000, 1_800_000))
    const day = intBetween(2, lastDay)
    addTxn({
      date: dateIn(ym, day),
      label: pick(['Situation travaux - ', 'Facture travaux - ', 'Acompte travaux - ']) + pick(SMALL_CLIENTS),
      categoryId: 'enc_chantiers',
      amountCents: Math.round(part / 1000) * 1000,
      counterparty: null,
    })
    remaining -= part
  }

  // --- Petits travaux & dépannage : 8-15 encaissements de 400 à 3 500 EUR
  const nDep = intBetween(8, 15)
  for (let i = 0; i < nDep; i++) {
    const day = intBetween(1, daysInMonth(ym))
    if (isCurrent && day > 10) continue
    addTxn({
      date: dateIn(ym, day),
      label: pick(['Dépannage fuite - ', 'Réfection enduit - ', 'Pose cloison - ', 'Petite maçonnerie - ', 'Reprise fissures - ']) + pick(SMALL_CLIENTS),
      categoryId: 'enc_depannage',
      amountCents: Math.round((intBetween(40_000, 350_000) * coef) / 500) * 500,
    })
  }

  // --- Encaissements divers (rare)
  if (rand() < 0.3) {
    addTxn({
      date: dateIn(ym, intBetween(5, lastDay)),
      label: pick(['Remboursement sinistre assurance', 'Vente bétonnière occasion', 'Avoir fournisseur', 'Remboursement trop-perçu URSSAF']),
      categoryId: 'enc_divers',
      amountCents: intBetween(500, 2000) * 100,
    })
  }

  // --- Salaires nets (le 29, hausse en mars 2026)
  const salaryBase = ym >= '2026-03' ? 2_930_000 : 2_850_000
  addTxn({
    date: dateIn(ym, 29),
    label: 'Salaires nets (10 salariés)',
    categoryId: 'dec_salaires',
    amountCents: -(salaryBase + intBetween(-3, 3) * 1000),
  })

  // --- URSSAF le 5 (charges du mois précédent)
  addTxn({
    date: dateIn(ym, 5),
    label: 'URSSAF PACA - cotisations',
    categoryId: 'dec_urssaf',
    amountCents: -(1_420_000 + intBetween(-35, 35) * 1000 + (ym >= '2026-04' ? 40_000 : 0)),
    counterparty: 'URSSAF PACA',
  })

  // --- Loyer le 3, leasing le 10, assurances le 15, abonnements le 8, emprunt le 12
  addTxn({ date: dateIn(ym, 3), label: 'Loyer dépôt + charges - ZA des Ateliers', categoryId: 'dec_loyer', amountCents: -240_000, counterparty: 'SCI des Ateliers' })
  addTxn({ date: dateIn(ym, 10), label: 'Leasing mini-pelle + fourgon', categoryId: 'dec_leasing', amountCents: -185_000, counterparty: 'Loc Engins Sud' })
  addTxn({ date: dateIn(ym, 15), label: 'Assurance décennale + flotte + mutuelle', categoryId: 'dec_assurances', amountCents: -132_000, counterparty: 'Assurances Bastide & Fils' })
  // Anomalie volontaire : le forfait télécom double en avril 2026 (480 -> 960 EUR)
  addTxn({ date: dateIn(ym, 8), label: 'Logiciels devis + forfaits télécom', categoryId: 'dec_abonnements', amountCents: ym >= '2026-04' ? -96_000 : -48_000, counterparty: 'Télécom Provence / DevisBat' })
  addTxn({ date: dateIn(ym, 12), label: 'Échéance prêt matériel - Banque du Val de Durance', categoryId: 'dec_emprunts', amountCents: -215_000, counterparty: 'Banque du Val de Durance' })

  // --- Véhicules & carburant : 3-5 transactions
  const nFuel = intBetween(3, 5)
  for (let i = 0; i < nFuel; i++) {
    const day = intBetween(1, daysInMonth(ym))
    if (isCurrent && day > 10) continue
    addTxn({
      date: dateIn(ym, day),
      label: pick(['Carburant chantiers', 'Gazole fourgons', 'Entretien fourgon', 'Pneus camion benne']),
      categoryId: 'dec_vehicules',
      amountCents: -intBetween(180, 750) * 100,
      counterparty: pick(FUEL_PARTIES),
    })
  }

  // --- Fournisseurs matériaux : ~30 % des encaissements du mois, 4-8 factures
  const monthIn = Math.round((CHANTIER_BASE + DEPANNAGE_BASE) * coef)
  let matRemaining = Math.round(monthIn * between(0.24, 0.3))
  const nMat = intBetween(4, 8)
  for (let i = 0; i < nMat && matRemaining > 50_000; i++) {
    const day = intBetween(1, daysInMonth(ym))
    if (isCurrent && day > 10) { continue }
    const part = i === nMat - 1 ? matRemaining : Math.min(matRemaining, intBetween(60_000, Math.max(120_000, Math.round(matRemaining / 2))))
    addTxn({
      date: dateIn(ym, day),
      label: 'Facture matériaux - ' + pick(MATERIAL_SUPPLIERS),
      categoryId: 'dec_materiaux',
      amountCents: -(Math.round(part / 100) * 100),
      counterparty: null,
    })
    matRemaining -= part
  }

  // --- Sous-traitance : seulement les mois chargés
  if (coef >= 1.05) {
    const n = intBetween(1, 2)
    for (let i = 0; i < n; i++) {
      const day = intBetween(8, lastDay)
      addTxn({
        date: dateIn(ym, day),
        label: 'Sous-traitance - ' + pick(SUBCONTRACTORS),
        categoryId: 'dec_soustraitance',
        amountCents: -intBetween(2_500, 7_500) * 100,
      })
    }
  }
}

// --- TVA mensuelle (CA3) le 22 : approximation depuis les flux du mois précédent
let byMonthCat = {}
function rebuildAgg() {
  byMonthCat = {}
  for (const t of transactions) {
    const ym = t.date.slice(0, 7)
    byMonthCat[ym] = byMonthCat[ym] || {}
    byMonthCat[ym][t.categoryId] = (byMonthCat[ym][t.categoryId] || 0) + t.amountCents
  }
}
rebuildAgg()
for (const ym of REALIZED_MONTHS) {
  const [y, m] = ym.split('-').map(Number)
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  const prevData = byMonthCat[prev]
  if (!prevData) continue // avril 2025 : pas de mois précédent généré
  const collected = ((prevData.enc_chantiers || 0) + (prevData.enc_depannage || 0)) / 1.2 * 0.2
  const deductible = (-((prevData.dec_materiaux || 0) + (prevData.dec_soustraitance || 0) + (prevData.dec_vehicules || 0))) / 1.2 * 0.2
  const tva = Math.max(20_000, Math.round((collected - deductible) / 100) * 100)
  addTxn({ date: dateIn(ym, 22), label: `TVA CA3 ${prev}`, categoryId: 'dec_tva', amountCents: -tva, counterparty: 'DGFiP' })
}

// ---------------------------------------------------------------- Calage du solde à aujourd'hui
transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
const sumAll = () => transactions.reduce((s, t) => s + t.amountCents, 0)
{
  const delta = TARGET_BALANCE_TODAY - (OPENING_BALANCE + sumAll())
  ADJUSTABLE.amountCents += Math.round(delta / 1000) * 1000
  if (ADJUSTABLE.amountCents < 400_000) {
    // garde-fou : si le calage rend l'acompte invraisemblable, répartir sur un 2e encaissement
    const fallback = transactions.find((t) => t.categoryId === 'enc_chantiers' && t.date.startsWith('2026-05') && t.id !== ADJUSTABLE.id)
    if (fallback) {
      fallback.amountCents += ADJUSTABLE.amountCents - 1_200_000
      ADJUSTABLE.amountCents = 1_200_000
    }
  }
}

// Les agrégats doivent inclure la TVA et le calage avant de servir au prévisionnel
rebuildAgg()

// ---------------------------------------------------------------- Prévisionnel
// Moyenne des réalisés par catégorie (12 derniers mois pleins) x coefficient saisonnier,
// flux fixes connus, encaissements attendus des factures en cours.
const forecast = []
function setForecast(month, categoryId, amountCents, note = null) {
  if (!Number.isInteger(amountCents)) throw new Error(`Prévision non entière: ${month} ${categoryId}`)
  forecast.push({ id: `fc_${month}_${categoryId}`, month, categoryId, amountCents, note, source: 'seed' })
}

const FULL_MONTHS = REALIZED_MONTHS.filter((m) => m >= '2025-06' && m <= '2026-05')
const avgCat = {}
for (const cat of CATEGORIES) {
  let total = 0
  for (const ym of FULL_MONTHS) total += (byMonthCat[ym]?.[cat.id] || 0)
  avgCat[cat.id] = total / FULL_MONTHS.length
}
const avgSeasonal = FULL_MONTHS.reduce((s, ym) => s + SEASON[monthIndex(ym)], 0) / FULL_MONTHS.length

for (const ym of FORECAST_MONTHS) {
  const coef = SEASON[monthIndex(ym)]
  for (const cat of CATEGORIES) {
    let v
    switch (cat.id) {
      case 'dec_salaires': v = -2_930_000; break
      case 'dec_urssaf': v = -1_460_000; break
      case 'dec_loyer': v = -240_000; break
      case 'dec_leasing': v = -185_000; break
      case 'dec_assurances': v = -132_000; break
      case 'dec_abonnements': v = -96_000; break
      case 'dec_emprunts': v = -215_000; break
      case 'enc_divers': v = 0; break
      case 'enc_chantiers': {
        // dé-saisonnaliser la moyenne puis réappliquer le coefficient du mois
        v = Math.round((avgCat.enc_chantiers / avgSeasonal) * coef / 100_000) * 100_000
        break
      }
      case 'enc_depannage':
        v = Math.round((avgCat.enc_depannage / avgSeasonal) * coef / 50_000) * 50_000
        break
      case 'dec_tva': {
        // la CA3 payée le 22 du mois M porte sur l'activité de M-1 :
        // le coefficient saisonnier à appliquer est celui du mois PRÉCÉDENT
        const prevCoef = SEASON[(monthIndex(ym) + 11) % 12]
        v = Math.round((avgCat.dec_tva / avgSeasonal) * prevCoef / 10_000) * 10_000
        break
      }
      default:
        // matériaux, sous-traitance, véhicules, TVA : moyenne dé-saisonnalisée x coefficient
        v = Math.round((avgCat[cat.id] / avgSeasonal) * coef / 10_000) * 10_000
    }
    if (v !== 0) setForecast(ym, cat.id, v)
  }
}

// Juin 2026 (mois courant) : la moyenne désaisonnalisée double-compterait les factures
// attendues. Prévision = réalisé à date + factures en cours + petite traîne de situations.
{
  const juin = forecast.find((f) => f.id === 'fc_2026-06_enc_chantiers')
  const realizedJune = byMonthCat['2026-06']?.enc_chantiers || 0
  juin.amountCents = realizedJune + 3_840_000 + 216_000 + 1_000_000 // inv_031 (25/06) + inv_033 (30/06) + traîne
  juin.note = 'Inclut solde Oraison 38 400 (attendu 25/06) et toiture hangar 2 160'
  const juil = forecast.find((f) => f.id === 'fc_2026-07_enc_chantiers')
  juil.amountCents += 1_440_000 // inv_032 Volx attendue le 05/07
  juil.note = 'Inclut situation Volx 14 400 (échéance 05/07)'
}

// Carnet de commandes d'automne : marché lotissement signé, situations de septembre à décembre.
// C'est ce qui fait remonter la courbe après le creux d'août (récit : creux conjoncturel, pas structurel).
{
  const AMANDIERS = { '2026-09': 1_200_000, '2026-10': 1_200_000, '2026-11': 1_000_000, '2026-12': 1_800_000 }
  for (const [ym, cents] of Object.entries(AMANDIERS)) {
    const line = forecast.find((f) => f.id === `fc_${ym}_enc_chantiers`)
    line.amountCents += cents
    line.note = 'Inclut marché lotissement Les Amandiers (signé, ordre de service reçu)'
  }
}

// ---------------------------------------------------------------- Projection de contrôle
// Même règle que le moteur serveur :
//  mois passé = réalisé ; mois courant = réalisé + max(0, prévu - réalisé) par catégorie ; mois futur = prévu.
function retainedMonth(ym) {
  const real = byMonthCat[ym] || {}
  const fc = {}
  for (const f of forecast.filter((f) => f.month === ym)) fc[f.categoryId] = f.amountCents
  let total = 0
  for (const cat of CATEGORIES) {
    const r = real[cat.id] || 0
    const p = fc[cat.id] || 0
    if (ym < '2026-06') total += r
    else if (ym === '2026-06') total += cat.direction === 'in' ? r + Math.max(0, p - r) : r + Math.min(0, p - r)
    else total += p
  }
  return total
}

function projectionSeries() {
  let balance = OPENING_BALANCE
  const series = []
  for (const ym of REALIZED_MONTHS.slice(0, -1)) {
    balance += retainedMonth(ym)
    series.push({ month: ym, endBalance: balance })
  }
  for (const ym of FORECAST_MONTHS) {
    balance += retainedMonth(ym)
    series.push({ month: ym, endBalance: balance })
  }
  return series
}

// Calage du point bas de fin août : on ajuste l'encaissement chantiers prévisionnel d'août
{
  const series = projectionSeries()
  const aug = series.find((s) => s.month === '2026-08')
  const delta = aug.endBalance - TARGET_LOW_POINT
  const augLine = forecast.find((f) => f.id === 'fc_2026-08_enc_chantiers')
  augLine.amountCents -= Math.round(delta / 100_000) * 100_000
  if (augLine.amountCents < 500_000) {
    // répartir sur juillet si août devient invraisemblable
    const juil = forecast.find((f) => f.id === 'fc_2026-07_enc_chantiers')
    juil.amountCents += augLine.amountCents - 1_000_000
    augLine.amountCents = 1_000_000
  }
  augLine.note = 'Congés bâtiment : très peu de situations encaissées'
}

// ---------------------------------------------------------------- Scénarios
const scenarios = [
  {
    id: 'sc_embauche',
    label: 'Embaucher un ouvrier qualifié',
    description: 'Coût chargé mensuel + équipement initial, à partir du mois choisi.',
    active: false,
    params: { startMonth: '2026-09', monthlyCostCents: 340_000, oneOffCents: 250_000 },
    sliders: [
      { key: 'startMonth', label: 'Mois d\'embauche', type: 'month', min: '2026-07', max: '2026-12' },
      { key: 'monthlyCostCents', label: 'Coût chargé / mois', type: 'amount', min: 280_000, max: 420_000, step: 10_000 },
    ],
  },
  {
    id: 'sc_invest',
    label: 'Acheter une mini-pelle',
    description: 'Achat comptant ou passage en leasing 36 mois.',
    active: false,
    params: { month: '2026-08', amountCents: 4_200_000, mode: 'cash' },
    sliders: [
      { key: 'month', label: 'Mois d\'achat', type: 'month', min: '2026-07', max: '2026-12' },
      { key: 'amountCents', label: 'Prix d\'achat', type: 'amount', min: 1_500_000, max: 6_000_000, step: 100_000 },
      { key: 'mode', label: 'Financement', type: 'toggle', options: ['cash', 'leasing'] },
    ],
  },
  {
    id: 'sc_retard',
    label: 'Retard de paiement - Durance Logis',
    description: 'Le solde de 38 400 EUR attendu le 25/06 glisse de N jours.',
    active: false,
    params: { invoiceId: 'inv_031', delayDays: 30 },
    sliders: [
      { key: 'delayDays', label: 'Jours de retard supplémentaires', type: 'days', min: 0, max: 90, step: 15 },
    ],
  },
  {
    id: 'sc_arret_maladie',
    label: 'Arrêt maladie du dirigeant',
    description: "Le dirigeant s'arrête N mois : zéro facturation sur la période, indemnités journalières TNS faibles ou nulles. Le vrai stress test d'un solo.",
    active: false,
    params: { startMonth: '2026-07', durationMonths: 2, dailyAllowanceCents: 0, waitingDays: 3 },
    sliders: [
      { key: 'startMonth', label: "Mois de début d'arrêt", type: 'month', min: '2026-07', max: '2026-12' },
      { key: 'durationMonths', label: "Durée de l'arrêt (mois)", type: 'amount', min: 1, max: 6, step: 1 },
      { key: 'dailyAllowanceCents', label: 'Indemnité journalière (centimes)', type: 'amount', min: 0, max: 6584, step: 500 },
    ],
  },
  {
    id: 'sc_dividendes',
    label: 'Se verser des dividendes',
    description: 'Sortir une enveloppe de trésorerie de la société en dividendes (après IS). Le comparateur rémunération vs dividendes chiffre le net en poche.',
    active: false,
    params: { month: '2026-12', grossCostCents: 1_500_000 },
    sliders: [
      { key: 'month', label: 'Mois de distribution', type: 'month', min: '2026-07', max: '2026-12' },
      { key: 'grossCostCents', label: 'Enveloppe sortie société', type: 'amount', min: 500_000, max: 5_000_000, step: 100_000 },
    ],
  },
]

// ---------------------------------------------------------------- Fichiers de sortie
const company = {
  name: 'Bâti Provence SARL',
  sector: 'BTP - gros œuvre et rénovation',
  location: 'Manosque (04)',
  employees: 10,
  demoToday: TODAY,
  lowCashThresholdCents: LOW_CASH_THRESHOLD,
  // Capital social (libéré) : seuil de 10% au-delà duquel les dividendes du gérant
  // majoritaire TNS sont soumis à cotisations sociales (lot 3 arbitrage rému/dividendes).
  capitalSocialCents: 500_000, // 5 000 EUR
  // Date du dernier import par source. Démo : données fictives « fraîches » (= demoToday).
  // Le bandeau « données au JJ/MM » du front lit ce champ (seuils orange/rouge calculés
  // serveur contre demoToday).
  importedAt: { indy: TODAY, twenty: TODAY },
  // Bloc fiscal complet (lot 2). Démo BTP : TVA dérivée des flux activée (réel normal
  // mensuel), provision TNS DÉSACTIVÉE (10 salariés chargés classiques, pas un gérant
  // TNS solo -> dec_urssaf reste le flux saisi). C'est vatRatePct (catégories) qui
  // tranche la TVA, jamais une liste d'IDs.
  fiscal: {
    tvaRegime: 'réel normal mensuel',
    vatRatePct: 20,
    amountsAreTTC: true,
    tva: { autoCompute: true, payDayOfMonth: 22 },
    tns: {
      autoCompute: false,
      remunerationCategoryId: 'dec_remuneration',
      provisionCategoryId: 'dec_urssaf',
      cotisationTauxPct: 40,
      cotisationTauxApresAcrePct: 45,
      acre: { actif: true, tauxPct: 25, finMois: '2026-09' },
      passAnnuelCents: 4_806_000,
      assietteAbattementPct: 26,
      // Cotisations TNS sur la fraction de dividendes > 10% du capital social (lot 3).
      // ~45% (taux TNS hors ACRE, l'ACRE n'exonère pas les dividendes). A_CONFIRMER.
      dividendesTauxPct: 45,
      // IJ maladie TNS (lot 3, scénario arrêt) : 0 par défaut (prudent, RAAM faible).
      indemniteJournaliereCents: 0,
    },
    is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 },
    flatTaxPct: 31.4, // PFU 2026 = 12,8% IR + 18,6% prélèvements sociaux (hausse CSG 01/01/2026)
  },
  // Profil saisonnier de l'activité (lot 3). Désactivé sur la démo : le forecast seedé
  // porte déjà sa saisonnalité (SEASON), l'activer doublerait l'effet. base 1 = neutre.
  seasonality: { enabled: false, monthly: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  businessAssumptions: [
    "Coût chargé d'un ouvrier qualifié BTP : environ 3 400 EUR/mois + 2 500 EUR d'équipement initial",
    'Délais de paiement usuels BTP : 30 à 60 jours, retards fréquents sur les promoteurs',
    'Congés bâtiment en août : activité et encaissements au plus bas, charges fixes inchangées',
  ],
}

// Solde de relevé bancaire attendu = solde reconstruit au jour J (démo « propre » :
// l'import colle au relevé, le contrôle de réconciliation passe en 'ok'). Sur des données
// réelles, l'import Indy pose expectedBalanceCents/Date d'après la balance et un écart
// avec le reconstruit lève l'alerte de réconciliation.
const EXPECTED_BALANCE = OPENING_BALANCE + transactions.reduce((s, t) => (t.date <= TODAY ? s + t.amountCents : s), 0)
const accounts = [
  {
    id: 'acc_ca',
    label: 'Compte courant - Banque du Val de Durance',
    openingBalanceCents: OPENING_BALANCE,
    openingDate: '2025-04-01',
    expectedBalanceCents: EXPECTED_BALANCE,
    expectedBalanceDate: TODAY,
  },
]

// Échéancier des sorties datées (lot 2 fiabilité). COUCHE D'AFFICHAGE : ces lignes
// servent le « cash calendar 60-90 j », elles NE touchent PAS la projection mensuelle
// (le moteur reste mensuel). On date seulement les grosses sorties certaines saisies à
// la main ; la TVA et les cotisations sont DÉRIVÉES des flux par le service echeances.js
// (pas saisies ici, pour éviter le double comptage). categoryId null = échéance sans
// catégorie naturelle (CFE, acompte IS).
const echeances = [
  { id: 'ech_2026-06_emprunt', label: 'Échéance prêt matériel - Banque du Val de Durance', categoryId: 'dec_emprunts', dueDate: '2026-06-12', amountCents: -215_000, kind: 'emprunt', recurrence: 'monthly', source: 'manual', note: 'Mensualité fixe prêt matériel, prélevée le 12' },
  { id: 'ech_2026-07_emprunt', label: 'Échéance prêt matériel - Banque du Val de Durance', categoryId: 'dec_emprunts', dueDate: '2026-07-12', amountCents: -215_000, kind: 'emprunt', recurrence: 'monthly', source: 'manual', note: 'Mensualité fixe prêt matériel, prélevée le 12' },
  { id: 'ech_2026-08_emprunt', label: 'Échéance prêt matériel - Banque du Val de Durance', categoryId: 'dec_emprunts', dueDate: '2026-08-12', amountCents: -215_000, kind: 'emprunt', recurrence: 'monthly', source: 'manual', note: 'Mensualité fixe prêt matériel, prélevée le 12' },
  { id: 'ech_2026-09_is', label: 'Acompte IS - 3e échéance', categoryId: 'dec_tva', dueDate: '2026-09-15', amountCents: -180_000, kind: 'is', recurrence: 'quarterly', source: 'manual', note: "Acompte trimestriel d'impôt sur les sociétés (estimation)" },
  { id: 'ech_2026-12_cfe', label: 'CFE - cotisation foncière des entreprises', categoryId: null, dueDate: '2026-12-15', amountCents: -142_000, kind: 'autre', recurrence: 'annual', source: 'manual', note: 'CFE annuelle, échéance au 15 décembre (hors fenêtre 90 j par défaut)' },
]

transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
invoices.sort((a, b) => (a.issueDate < b.issueDate ? -1 : 1))
forecast.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.categoryId < b.categoryId ? -1 : 1))

mkdirSync(DATA_DIR, { recursive: true })
const write = (name, data) => writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2) + '\n')
write('company', company)
write('accounts', accounts)
write('categories', CATEGORIES)
write('transactions', transactions)
write('invoices', invoices)
write('forecast', forecast)
write('scenarios', scenarios)
write('echeances', echeances)

// proposals.json : ne pas écraser s'il existe (état runtime), mais créer vide si absent
import { existsSync } from 'node:fs'
if (!existsSync(path.join(DATA_DIR, 'proposals.json'))) write('proposals', [])

// ---------------------------------------------------------------- Rapport de contrôle
const finalBalance = OPENING_BALANCE + sumAll()
const series = projectionSeries()
const future = series.filter((s) => s.month >= '2026-06')
const lowPoint = future.reduce((min, s) => (s.endBalance < min.endBalance ? s : min), future[0])

const fmt = (c) => (c / 100).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' EUR'
console.log('=== Syntréso - rapport de génération ===')
console.log(`Transactions : ${transactions.length} | Factures : ${invoices.length} | Lignes prévisionnel : ${forecast.length}`)
console.log(`Solde au ${TODAY} : ${fmt(finalBalance)} (cible ${fmt(TARGET_BALANCE_TODAY)})`)
console.log(`Point bas projeté : ${fmt(lowPoint.endBalance)} fin ${lowPoint.month} (cible ${fmt(TARGET_LOW_POINT)}, seuil ${fmt(LOW_CASH_THRESHOLD)})`)
console.log('Soldes projetés fin de mois :')
for (const s of future) console.log(`  ${s.month} : ${fmt(s.endBalance)}`)

// Invariants
const errors = []
if (transactions.some((t) => !Number.isInteger(t.amountCents))) errors.push('montants non entiers')
if (Math.abs(finalBalance - TARGET_BALANCE_TODAY) > 200_000) errors.push(`solde trop loin de la cible: ${fmt(finalBalance)}`)
if (Math.abs(lowPoint.endBalance - TARGET_LOW_POINT) > 250_000) errors.push(`point bas trop loin de la cible: ${fmt(lowPoint.endBalance)}`)
if (lowPoint.endBalance >= LOW_CASH_THRESHOLD) errors.push('le point bas ne passe pas sous le seuil d\'alerte')
if (transactions.some((t) => t.date > TODAY)) errors.push('transaction dans le futur')
const abo202603 = byMonthCat['2026-03']?.dec_abonnements || 0
const abo202604 = byMonthCat['2026-04']?.dec_abonnements || 0
if (Math.abs(abo202604) < Math.abs(abo202603) * 1.8) errors.push('anomalie abonnements absente')
if (errors.length) {
  console.error('ÉCHEC INVARIANTS :', errors.join(' ; '))
  process.exit(1)
}
console.log('Invariants OK.')

// si le serveur tourne, resynchroniser le digest de l'agent (sinon il resterait
// sur les anciennes données jusqu'au prochain restart ou mutation)
try {
  await fetch('http://localhost:3001/api/agent/digest', { method: 'POST' })
  console.log('Digest agent resynchronisé.')
} catch {
  // serveur arrêté : le digest sera régénéré au boot
}
