// Import des exports comptables Indy (grand livre + balance, fichiers CSV à séparateur
// point-virgule servis par le bouton « Excel » d'Indy).
//
// Ce que l'import fabrique, à partir de la compta :
//   - transactions.json : les mouvements bancaires réels, classés par catégorie
//     (règles de config/reglages.json, voir docs/REGLAGES.md) ;
//   - accounts.json     : la trésorerie consolidée (compte courant + sous-comptes), avec
//     le solde attendu relu dans la balance (contrôle de réconciliation) ;
//   - company.json      : date des données, dette de TVA réelle, compte courant d'associé,
//     réserves des sous-comptes. Le reste (nom, seuil, réglages fiscaux) est conservé ;
//   - forecast.json     : le prévisionnel « de base » (médiane des 6 derniers mois clos
//     par catégorie). Les lignes saisies à la main ou validées dans l'interface sont
//     conservées : seules les lignes posées par un import précédent sont remplacées.
//
// Le module est découpé en fonctions pures (lecture CSV, calcul) testables sans disque,
// et une fonction d'exécution qui écrit sous le verrou de données du serveur.

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { lireReglages } from './reglages.js'
import { robustMonthlyOut } from './charges.js'
import { addMonths, monthRange, todayISO, monthOf } from './dates.js'
import { horizonEnd } from './horizon.js'
import { withDataLock, writeJsonBatchInLock, appendAuditInLock, readJsonOr } from './store.js'

const SOURCE_IMPORT = 'indy-import'

// ------------------------------------------------------------------ Lecture CSV
/** Découpe une ligne CSV `;` en respectant les guillemets éventuels. */
export function splitCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** Texte sans accents, en minuscules : base de comparaison des libellés et en-têtes. */
export function normaliser(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** « 1 234,56 » (espaces fines ou insécables possibles) -> 123456 centimes. */
export function cents(s) {
  const t = String(s ?? '').replace(/[\s  ]/g, '').replace(',', '.')
  if (!t) return 0
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** « 05/10/2026 » -> « 2026-10-05 », sinon null. */
export function isoDate(s) {
  const m = String(s ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

function lignes(texte) {
  return String(texte).replace(/^﻿/, '').split(/\r?\n/)
}

/**
 * Grand livre Indy -> { comptes: { [numero]: { intitule, lignes: [...] } }, premiereDate, derniereDate }.
 * Structure attendue : une ligne d'en-tête par compte « numéro;intitulé;Debit;Credit;Solde »,
 * puis les écritures « JJ/MM/AAAA;libellé;débit;crédit;... », puis « Totaux du poste ... ».
 */
export function lireGrandLivre(texte) {
  const comptes = {}
  let cur = null
  let premiereDate = null
  let derniereDate = null
  for (const brut of lignes(texte)) {
    const c = splitCsvLine(brut)
    if (c.length < 4) continue
    if (normaliser(c[2]) === 'debit' && normaliser(c[3]) === 'credit') {
      cur = c[0].trim()
      if (cur && !comptes[cur]) comptes[cur] = { intitule: (c[1] || '').trim(), lignes: [] }
      continue
    }
    if (normaliser(c[0]).startsWith('totaux du poste')) {
      cur = null
      continue
    }
    if (!cur) continue
    const date = isoDate(c[0])
    if (!date) continue
    comptes[cur].lignes.push({ date, label: (c[1] || '').trim(), debitCents: cents(c[2]), creditCents: cents(c[3]) })
    if (!premiereDate || date < premiereDate) premiereDate = date
    if (!derniereDate || date > derniereDate) derniereDate = date
  }
  return { comptes, premiereDate, derniereDate }
}

/** Balance Indy -> { [numero]: solde en centimes (débiteur positif, créditeur négatif) }. */
export function lireBalance(texte) {
  const soldes = {}
  for (const brut of lignes(texte)) {
    const c = splitCsvLine(brut)
    if (c.length < 5) continue
    const compte = c[0].trim()
    if (!/^\d{3,}$/.test(compte)) continue
    soldes[compte] = cents(c[4])
  }
  return soldes
}

/** Reconnaît la nature d'un export : 'grand-livre' | 'balance' | null. */
export function natureExport(texte) {
  let enTetes = 0
  let datees = 0
  let comptesNumerotes = 0
  for (const brut of lignes(texte).slice(0, 4000)) {
    const c = splitCsvLine(brut)
    if (c.length < 4) continue
    if (normaliser(c[2]) === 'debit' && normaliser(c[3]) === 'credit' && /^\d{3,}$/.test(c[0].trim())) enTetes++
    if (isoDate(c[0])) datees++
    if (/^\d{3,}$/.test(c[0].trim()) && c.length >= 5) comptesNumerotes++
  }
  if (enTetes > 0 && datees > 0) return 'grand-livre'
  if (comptesNumerotes > 0 && datees === 0) return 'balance'
  return null
}

// ------------------------------------------------------------------ Règles
const prefixeDe = (liste) => (compte) => (liste || []).some((p) => String(compte).startsWith(String(p)))

function compilerRegles(reglages) {
  const ignores = (reglages.indy.libellesIgnores || []).map((m) => new RegExp(m, 'i'))
  const regles = (reglages.indy.reglesCategories || []).map((r) => ({ ...r, re: new RegExp(r.motif, 'i') }))
  return { ignores, regles }
}

function categoriePourLibelle(label, montantCents, compiled, reglages) {
  const l = normaliser(label)
  const sens = montantCents > 0 ? 'entree' : 'sortie'
  for (const r of compiled.regles) {
    if (r.sens && r.sens !== 'tous' && r.sens !== sens) continue
    if (r.re.test(l)) return { categorie: r.categorie, parDefaut: false }
  }
  return { categorie: reglages.indy.categorieParDefaut[sens], parDefaut: true }
}

// ------------------------------------------------------------------ Calcul (pur)
/**
 * Construit les données Syntréso à partir des exports lus. Fonction pure.
 *
 * @param grandsLivres [{ nom, texte }] un ou plusieurs exercices
 * @param balance      { nom, texte } la balance la plus récente
 * @param reglages     réglages effectifs (lireReglages)
 * @param existant     { company, categories, forecast } données actuelles (peuvent manquer)
 * @param options      { aujourdhui: 'YYYY-MM-DD', reinitialiserPrevisionnel: bool }
 * @returns { transactions, accounts, company, forecast, rapport }
 */
export function construireImport({ grandsLivres, balance, reglages, existant = {}, options = {} }) {
  if (!grandsLivres?.length) throw new Error('aucun grand livre fourni')
  if (!balance) throw new Error('aucune balance fournie')
  const aujourdhui = options.aujourdhui || todayISO()
  const cfg = reglages.indy
  const compiled = compilerRegles(reglages)
  const categories = existant.categories || []
  const catIds = new Set(categories.map((c) => c.id))

  // Catégories citées par les règles mais absentes de categories.json : erreur franche
  // (sinon des montants disparaîtraient en silence de la grille).
  const citees = new Set([
    cfg.categorieParDefaut.entree,
    cfg.categorieParDefaut.sortie,
    ...(cfg.reglesCategories || []).map((r) => r.categorie),
    ...(cfg.contreparties || []).map((r) => r.categorie),
  ])
  const manquantes = [...citees].filter((id) => !catIds.has(id))
  if (manquantes.length) {
    throw new Error(`catégories citées dans les réglages mais absentes de categories.json : ${manquantes.join(', ')}`)
  }

  const sousComptes = cfg.comptesBancaires.sousComptes || []
  const roleDe = Object.fromEntries(sousComptes.map((s) => [String(s.compte), s.role || 'autre']))
  const estSousCompte = (n) => Object.hasOwn(roleDe, n)
  const estCourant = prefixeDe(cfg.comptesBancaires.courant)
  const estBanque = (n) => estSousCompte(n) || estCourant(n)
  const estCca = prefixeDe(cfg.compteCourantAssocie?.comptes)
  const contrepartieDe = (n) => (cfg.contreparties || []).find((r) => String(n).startsWith(String(r.compte)))

  // Exercices dans l'ordre chronologique : le plus ancien porte le solde d'ouverture.
  const livres = grandsLivres
    .map((g) => ({ nom: g.nom, ...lireGrandLivre(g.texte) }))
    .filter((g) => g.premiereDate)
    .sort((a, b) => (a.premiereDate < b.premiereDate ? -1 : 1))
  if (!livres.length) throw new Error('grand livre illisible : aucune écriture datée trouvée (export Indy « Excel » attendu)')

  const transactions = []
  const contreparties = new Map() // `${date}|${montant}` -> catégorie (débits des comptes de contrepartie)
  const debits64 = new Set() // `${date}|${montant}` des charges de personnel (rému passée au compte courant)
  const creditsCca = [] // { date, montantCents, label }
  let ouverture = 0
  let dateOuverture = null
  const comptesBancairesVus = new Set()
  const OUVERTURE_RE = /od d.extourne en debut/

  livres.forEach((livre, idx) => {
    for (const [numero, compte] of Object.entries(livre.comptes)) {
      const contrepartie = contrepartieDe(numero)
      for (const l of compte.lignes) {
        if (contrepartie && l.debitCents > 0) contreparties.set(`${l.date}|${l.debitCents}`, contrepartie.categorie)
        if (numero.startsWith('64') && l.debitCents > 0) debits64.add(`${l.date}|${l.debitCents}`)
        if (estCca(numero) && l.creditCents > 0) creditsCca.push({ date: l.date, montantCents: l.creditCents, label: l.label })
      }
      if (!estBanque(numero)) continue
      comptesBancairesVus.add(numero)
      for (const l of compte.lignes) {
        const label = normaliser(l.label)
        // Solde d'ouverture : ligne d'extourne de début d'exercice du PLUS ANCIEN grand livre
        // (sur les exercices suivants, elle doublerait les mouvements déjà importés).
        if (cfg.ouverture === 'auto' && OUVERTURE_RE.test(label)) {
          if (idx === 0) {
            ouverture += l.debitCents - l.creditCents
            if (!dateOuverture || l.date < dateOuverture) dateOuverture = l.date
          }
          continue
        }
        if (compiled.ignores.some((re) => re.test(label))) continue
        const montant = l.debitCents - l.creditCents
        if (!montant) continue
        transactions.push({ date: l.date, label: l.label, montantCents: montant, compte: numero })
      }
    }
  })
  if (typeof cfg.ouverture === 'number' && Number.isInteger(cfg.ouverture)) ouverture = cfg.ouverture
  if (!transactions.length) {
    throw new Error(`aucun mouvement bancaire trouvé : vérifiez indy.comptesBancaires.courant (actuellement ${JSON.stringify(cfg.comptesBancaires.courant)}) dans config/reglages.json`)
  }

  // Classement : contrepartie comptable d'abord, puis règles de libellé, puis défaut.
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  let parDefaut = 0
  const txs = transactions.map((t, i) => {
    let categorie = null
    if (t.montantCents < 0) categorie = contreparties.get(`${t.date}|${-t.montantCents}`) || null
    if (!categorie) {
      const r = categoriePourLibelle(t.label, t.montantCents, compiled, reglages)
      categorie = r.categorie
      if (r.parDefaut) parDefaut++
    }
    return {
      id: `txn_${String(i + 1).padStart(4, '0')}`,
      date: t.date,
      label: t.label,
      categoryId: categorie,
      amountCents: t.montantCents,
      accountId: 'acc_treso',
      counterparty: null,
      invoiceId: null,
      source: 'indy',
    }
  })
  const derniereDate = txs[txs.length - 1].date
  const premiereDate = dateOuverture && dateOuverture < txs[0].date ? dateOuverture : txs[0].date

  // --- Balance : soldes réels (réconciliation, réserves, TVA, compte courant d'associé)
  const soldes = lireBalance(balance.texte)
  const somme = (pred) => Object.entries(soldes).reduce((s, [n, v]) => (pred(n) ? s + v : s), 0)
  const present = (pred) => Object.keys(soldes).some(pred)
  const courantCents = somme((n) => estCourant(n) && !estSousCompte(n))
  const reserve = (role) => somme((n) => roleDe[n] === role)
  const consolideCents = somme(estBanque)
  const reconstruitCents = ouverture + txs.reduce((s, t) => s + t.amountCents, 0)

  const accounts = [{
    id: 'acc_treso',
    label: sousComptes.length ? 'Trésorerie consolidée (courant + sous-comptes)' : 'Trésorerie (compte bancaire)',
    openingBalanceCents: ouverture,
    openingDate: premiereDate,
    currentAccountCents: courantCents,
    expectedBalanceCents: consolideCents,
    expectedBalanceDate: derniereDate,
    _expectedBalanceSource: `Solde des comptes bancaires de la balance Indy (${balance.nom}), mouvements jusqu'au ${derniereDate}.`,
  }]

  // --- company.json : on conserve tout ce qui est saisi, on met à jour ce que dit la compta
  const company = structuredClone(existant.company || {})
  delete company.demoToday // données réelles : le moteur raisonne à la vraie date du jour
  company.dataAsOf = derniereDate
  company.importedAt = { ...(company.importedAt || {}), indy: derniereDate }
  if (!company.importedAt.twenty) delete company.importedAt.twenty

  if (sousComptes.length) {
    company.provisionsHeld = {
      tvaCents: reserve('tva'),
      urssafCents: reserve('urssaf'),
      persoCents: reserve('perso'),
      _source: `Soldes des sous-comptes déclarés dans config/reglages.json (balance Indy, ${derniereDate}).`,
    }
  } else {
    delete company.provisionsHeld
  }

  // Compte courant d'associé : solde créditeur = ce que la société doit au dirigeant.
  if (present(estCca)) {
    const ccaCents = -somme(estCca)
    company.ccaActual = { cents: ccaCents, asOf: derniereDate, _source: `Solde des comptes ${cfg.compteCourantAssocie.comptes.join(', ')} (balance Indy).` }
    if (cfg.compteCourantAssocie.fraisSansFluxBancaire) {
      // Frais avancés et indemnités kilométriques : crédits du compte courant SANS ligne
      // bancaire en face (un apport en espèces a une ligne bancaire, une rémunération
      // passée au compte courant a un débit 64x en face : ni l'un ni l'autre n'est un frais).
      const entrees = new Set(txs.filter((t) => t.amountCents > 0).map((t) => `${t.date}|${t.amountCents}`))
      const parMois = {}
      for (const c of creditsCca) {
        const cle = `${c.date}|${c.montantCents}`
        if (entrees.has(cle) || debits64.has(cle)) continue
        if (compiled.ignores.some((re) => re.test(normaliser(c.label)))) continue
        const ym = monthOf(c.date)
        parMois[ym] = (parMois[ym] || 0) + c.montantCents
      }
      company.fraisCCA = { ...(company.fraisCCA || {}), reelParMoisCents: Object.fromEntries(Object.entries(parMois).sort()) }
    }
  } else {
    delete company.ccaActual
  }

  // Dette de TVA réelle = collectée - déductible - crédit reporté + TVA déjà déclarée à payer.
  const tva = cfg.comptesTva || {}
  const estTva = prefixeDe([...(tva.collectee || []), ...(tva.deductible || []), ...(tva.credit || []), ...(tva.aDecaisser || [])])
  if (present(estTva)) {
    const collectee = -somme(prefixeDe(tva.collectee))
    const deductible = somme(prefixeDe(tva.deductible))
    const credit = somme(prefixeDe(tva.credit))
    const aDecaisser = -somme(prefixeDe(tva.aDecaisser))
    company.fiscal = company.fiscal || {}
    company.fiscal.vatDueActualCents = Math.max(0, collectee - deductible - credit + aDecaisser)
    company.fiscal._vatDueActualSource = `Balance Indy au ${derniereDate} : collectée ${collectee / 100} - déductible ${deductible / 100} - crédit ${credit / 100} + à décaisser ${aDecaisser / 100}.`
  } else if (company.fiscal) {
    delete company.fiscal.vatDueActualCents
    delete company.fiscal._vatDueActualSource
  }

  // --- Prévisionnel de base
  const forecast = construirePrevisionnel({ txs, derniereDate, aujourdhui, reglages, company, categories, existant: existant.forecast || [], reinitialiser: options.reinitialiserPrevisionnel === true })

  // --- Rapport lisible
  const parCategorie = {}
  for (const t of txs) parCategorie[t.categoryId] = (parCategorie[t.categoryId] || 0) + 1
  const delta = reconstruitCents - consolideCents
  const rapport = {
    grandsLivres: livres.map((l) => ({ nom: l.nom, du: l.premiereDate, au: l.derniereDate })),
    balance: balance.nom,
    transactions: txs.length,
    periode: { du: txs[0].date, au: derniereDate },
    comptesBancaires: [...comptesBancairesVus].sort(),
    ouvertureCents: ouverture,
    soldeCourantCents: courantCents,
    soldeConsolideCents: consolideCents,
    soldeReconstruitCents: reconstruitCents,
    reconciliation: { deltaCents: delta, statut: Math.abs(delta) < 100 ? 'ok' : 'ecart' },
    classeesParDefaut: parDefaut,
    parCategorie,
    lignesPrevisionnel: forecast.filter((f) => f.source === SOURCE_IMPORT).length,
    dateDesDonnees: derniereDate,
  }
  return { transactions: txs, accounts, company, forecast, rapport }
}

/**
 * Prévisionnel de base, du premier mois non clos jusqu'à l'horizon du moteur.
 * Charge (ou encaissement) mensuelle = médiane des mois où elle apparaît sur les N derniers
 * mois clos, x fréquence de présence (même méthode que charges.js). Les catégories
 * calculées par le moteur (TVA, provision URSSAF pilotée) et les opérations hors résultat
 * (apports, investissements) ne sont pas projetées.
 */
export function construirePrevisionnel({ txs, derniereDate, aujourdhui, reglages, company, categories, existant, reinitialiser }) {
  const prev = reglages.previsionnel
  const fenetre = prev.fenetreMedianeMois || 6
  const dernierMois = derniereDate.slice(0, 7)
  // Dernier mois CLOS : celui de la dernière écriture s'il est (presque) terminé.
  const moisClos = Number(derniereDate.slice(8, 10)) >= 28 ? dernierMois : addMonths(dernierMois, -1)
  const premierMois = addMonths(moisClos, 1)
  const fin = horizonEnd(monthOf(aujourdhui))
  const mois = premierMois <= fin ? monthRange(premierMois, fin) : []

  const actuals = {}
  for (const t of txs) {
    const ym = t.date.slice(0, 7)
    actuals[ym] = actuals[ym] || {}
    actuals[ym][t.categoryId] = (actuals[ym][t.categoryId] || 0) + t.amountCents
  }
  // robustMonthlyOut travaille sur les sorties ; pour les entrées on inverse le sens.
  const etat = { categories, company }
  const sorties = robustMonthlyOut(etat, actuals, premierMois, { lookbackMonths: fenetre })
  const etatEntrees = { categories: categories.map((c) => ({ ...c, direction: c.direction === 'in' ? 'out' : 'in' })), company }
  const entrees = robustMonthlyOut(etatEntrees, actuals, premierMois, { lookbackMonths: fenetre })

  const fiscal = company.fiscal || {}
  const tns = fiscal.tns || {}
  const exclues = new Set([fiscal.tva?.categoryId || 'dec_tva'])
  if (tns.autoCompute && tns.provisionCategoryId) exclues.add(tns.provisionCategoryId)
  if (fiscal.is?.autoDecaissement) exclues.add(fiscal.is.categoryId || 'dec_is')
  for (const c of categories) if (c.excludeFromResultat) exclues.add(c.id)

  const lignes = []
  const poser = (ym, categoryId, montant, note) => {
    if (!montant) return
    lignes.push({ id: `fc_${ym}_${categoryId}`, month: ym, categoryId, amountCents: montant, note, source: SOURCE_IMPORT })
  }

  const remCat = prev.remunerationGerant?.categorie || 'dec_remuneration'
  const paliersRem = [...(prev.remunerationGerant?.paliers || [])].sort((a, b) => (a.depuis < b.depuis ? -1 : 1))
  const encCfg = prev.encaissements || {}

  for (const cat of categories) {
    if (exclues.has(cat.id)) continue
    const estEntree = cat.direction === 'in'
    if (cat.id === remCat && paliersRem.length) {
      // Rémunération du dirigeant par paliers ; pendant la fenêtre « rémunération au
      // compte courant d'associé » (company.fiscal.tns), rien ne sort de la banque.
      for (const ym of mois) {
        if (tns.remunerationEnCcaJusquau && ym <= tns.remunerationEnCcaJusquau && (!tns.remunerationEnCcaDepuis || ym >= tns.remunerationEnCcaDepuis)) continue
        let montant = 0
        for (const p of paliersRem) if (ym >= p.depuis) montant = p.montantCents
        poser(ym, cat.id, -Math.abs(montant), 'rémunération (palier des réglages)')
      }
      continue
    }
    if (estEntree && encCfg.mode === 'aucun') continue
    if (estEntree && encCfg.mode === 'paliers') {
      if (cat.id !== (encCfg.categorie || 'enc_prestations')) continue
      const paliers = [...(encCfg.paliersHT || [])].sort((a, b) => (a.depuis < b.depuis ? -1 : 1))
      const taux = Number(encCfg.tauxTvaPct) || 0
      for (const ym of mois) {
        let palier = null
        for (const p of paliers) if (ym >= p.depuis) palier = p
        if (!palier) continue
        const n = monthRange(palier.depuis, ym).length - 1
        const ht = Math.round(palier.montantHTCents * (1 + (Number(palier.croissanceMensuellePct) || 0) / 100) ** n)
        poser(ym, cat.id, Math.round(ht * (1 + taux / 100)), 'hypothèse de chiffre d\'affaires (réglages, TTC)')
      }
      continue
    }
    const r = estEntree ? entrees[cat.id] : sorties[cat.id]
    if (!r?.monthlyCents) continue
    const note = `médiane ${fenetre} mois (présent ${r.presence}/${fenetre})`
    for (const ym of mois) poser(ym, cat.id, estEntree ? r.monthlyCents : -r.monthlyCents, note)
  }

  if (reinitialiser) return lignes
  // Fusion : on retire les lignes d'un import précédent, on garde tout le reste
  // (saisies, propositions validées, recalages). Une saisie l'emporte sur l'import.
  const gardees = (existant || []).filter((f) => f.source !== SOURCE_IMPORT)
  const prises = new Set(gardees.map((f) => f.id))
  return [...gardees, ...lignes.filter((l) => !prises.has(l.id))]
}

// ------------------------------------------------------------------ Fichiers
/**
 * Repère les exports dans un dossier : tous les grands livres (un par exercice, le plus
 * récent l'emporte si un exercice est déposé deux fois) et la balance la plus récente.
 */
export async function reperer(dossier) {
  if (!existsSync(dossier)) throw new Error(`dossier d'entrée introuvable : ${dossier}`)
  const noms = (await readdir(dossier)).filter((n) => /\.csv$/i.test(n))
  const livres = new Map() // exercice -> { nom, texte, mtime }
  let balance = null
  const ignores = []
  for (const nom of noms) {
    const chemin = path.join(dossier, nom)
    const texte = await readFile(chemin, 'utf8')
    const { mtimeMs } = await stat(chemin)
    const nature = natureExport(texte)
    if (nature === 'grand-livre') {
      const { derniereDate } = lireGrandLivre(texte)
      const exercice = derniereDate ? derniereDate.slice(0, 4) : nom
      const actuel = livres.get(exercice)
      if (!actuel || mtimeMs > actuel.mtime || (mtimeMs === actuel.mtime && nom > actuel.nom)) {
        if (actuel) ignores.push(`${actuel.nom} (remplacé par ${nom})`)
        livres.set(exercice, { nom, texte, mtime: mtimeMs })
      } else {
        ignores.push(`${nom} (remplacé par ${actuel.nom})`)
      }
    } else if (nature === 'balance') {
      if (!balance || mtimeMs > balance.mtime || (mtimeMs === balance.mtime && nom > balance.nom)) {
        if (balance) ignores.push(`${balance.nom} (balance plus ancienne)`)
        balance = { nom, texte, mtime: mtimeMs }
      } else {
        ignores.push(`${nom} (balance plus ancienne)`)
      }
    } else {
      ignores.push(`${nom} (format non reconnu)`)
    }
  }
  return { grandsLivres: [...livres.values()], balance, ignores }
}

/**
 * Exécute l'import : lit les fichiers, calcule, et (hors simulation) écrit les données
 * sous le verrou du serveur. Retourne le rapport.
 *
 * options : { dossier, grandsLivres: [chemins], balance: chemin, simulation, reinitialiserPrevisionnel, aujourdhui }
 */
export async function executerImport(options = {}) {
  let entrees
  if (options.grandsLivres?.length || options.balance) {
    const lire = async (chemin) => ({ nom: path.basename(chemin), texte: await readFile(chemin, 'utf8') })
    entrees = {
      grandsLivres: await Promise.all((options.grandsLivres || []).map(lire)),
      balance: options.balance ? await lire(options.balance) : null,
      ignores: [],
    }
  } else {
    entrees = await reperer(options.dossier)
  }
  if (!entrees.grandsLivres.length) throw new Error('aucun grand livre trouvé (export Indy « Grand livre », format Excel/CSV)')
  if (!entrees.balance) throw new Error('aucune balance trouvée (export Indy « Balance », format Excel/CSV)')

  const reglages = lireReglages()
  return withDataLock(async () => {
    const existant = {
      company: await readJsonOr('company', null),
      categories: await readJsonOr('categories', null),
      forecast: await readJsonOr('forecast', []),
    }
    if (!existant.company || !existant.categories) {
      throw new Error('base non initialisée : lancez d\'abord "npm run init" (company.json et categories.json requis)')
    }
    const resultat = construireImport({
      grandsLivres: entrees.grandsLivres,
      balance: entrees.balance,
      reglages,
      existant,
      options: { aujourdhui: options.aujourdhui, reinitialiserPrevisionnel: options.reinitialiserPrevisionnel },
    })
    const rapport = { ...resultat.rapport, fichiersIgnores: entrees.ignores, simulation: Boolean(options.simulation) }
    if (options.simulation) return rapport

    const documents = { transactions: resultat.transactions, accounts: resultat.accounts, company: resultat.company, forecast: resultat.forecast }
    for (const nom of ['invoices', 'proposals', 'scenarios', 'echeances']) {
      if (await readJsonOr(nom, null) === null) documents[nom] = []
    }
    await writeJsonBatchInLock(documents)
    await appendAuditInLock({
      actor: 'import',
      action: 'import.run',
      target: 'indy',
      meta: { transactions: rapport.transactions, au: rapport.dateDesDonnees, reconciliation: rapport.reconciliation.statut },
    })
    return rapport
  })
}

/** Rapport en texte, pour la ligne de commande. */
export function rapportTexte(r) {
  const eur = (c) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`
  const l = []
  l.push(r.simulation ? 'SIMULATION (rien n\'a été écrit)' : 'Import terminé')
  for (const g of r.grandsLivres) l.push(`  grand livre : ${g.nom} (du ${g.du} au ${g.au})`)
  l.push(`  balance     : ${r.balance}`)
  for (const f of r.fichiersIgnores || []) l.push(`  ignoré      : ${f}`)
  l.push(`Mouvements bancaires importés : ${r.transactions} (du ${r.periode.du} au ${r.periode.au})`)
  l.push(`Comptes bancaires lus : ${r.comptesBancaires.join(', ')}`)
  l.push(`Solde d'ouverture retenu : ${eur(r.ouvertureCents)}`)
  l.push(`Solde des comptes bancaires (balance) : ${eur(r.soldeConsolideCents)}`)
  l.push(`Solde reconstruit (ouverture + mouvements) : ${eur(r.soldeReconstruitCents)}`)
  l.push(`Réconciliation : écart ${eur(r.reconciliation.deltaCents)} -> ${r.reconciliation.statut === 'ok' ? 'OK' : 'ÉCART À EXAMINER (voir docs/REGLAGES.md, section ouverture)'}`)
  l.push(`Mouvements classés dans la catégorie par défaut : ${r.classeesParDefaut} (à affiner dans config/reglages.json si nombreux)`)
  l.push(`Lignes de prévisionnel posées par l'import : ${r.lignesPrevisionnel}`)
  return l.join('\n')
}
