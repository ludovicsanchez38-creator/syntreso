// Export « dossier banquier » : une page HTML print-ready (mise en page imprimable)
// avec plan de trésorerie 12 mois, courbe réalisé/projeté + seuil, bloc hypothèses et
// ratios (runway, point mort). PDF via impression navigateur (Ctrl+P) : AUCUNE
// dépendance lourde (pas de puppeteer/weasyprint). On génère du HTML+CSS+SVG inline.
//
// Tous les chiffres viennent du moteur (projection.js / fiscal.js) : ce service met en
// forme, il ne calcule jamais un solde. Les provisions TVA + cotisations sont déjà
// réelles (lot 2), donc le dossier est crédible.

import { project, kpis, monthOf, monthRange, addMonths, todayFor } from './projection.js'
import { horizonEnd as horizonEndOf } from './horizon.js'

// Palette du document imprimable.
const CHARTE = {
  cream: '#FAFAF7',
  ink: '#0F172A',
  blue: '#2451FF',
  cyan: '#0891B2',
  magenta: '#DB2777',
  positive: '#15803D',
  danger: '#DC2626',
  muted: '#64748B',
  line: '#E2E8F0',
}

const eur = (cents) =>
  `${Math.round(cents / 100).toLocaleString('fr-FR')} EUR`
const eurSigned = (cents) => `${cents >= 0 ? '+' : '-'}${eur(Math.abs(cents))}`
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const MONTH_LABELS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`
}
function fmtDateFR(iso) {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/**
 * Courbe réalisé/projeté en SVG inline (pas de JS), avec ligne de seuil et point bas.
 * Échantillonne la série quotidienne pour rester léger (1 point ~ tous les N jours).
 */
function balanceChartSVG(series, thresholdCents, lowPoint) {
  const W = 720
  const H = 280
  const padL = 56
  const padR = 16
  const padT = 16
  const padB = 28
  const pts = series.filter((p) => p.actualCents !== null || p.projectedCents !== null)
  if (pts.length < 2) return ''
  // valeur de chaque point (réalisé prioritaire, sinon projeté).
  const valueOf = (p) => (p.actualCents !== null ? p.actualCents : p.projectedCents)
  const values = pts.map(valueOf).concat([thresholdCents, 0])
  const minV = Math.min(...values)
  const maxV = Math.max(...values)
  const span = maxV - minV || 1
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR)
  const y = (v) => padT + (1 - (v - minV) / span) * (H - padT - padB)

  // Tracé réalisé (trait plein) et projeté (pointillés), séparés au raccord.
  let actualPath = ''
  let projPath = ''
  pts.forEach((p, i) => {
    const px = x(i)
    if (p.actualCents !== null) {
      actualPath += `${actualPath ? 'L' : 'M'}${px.toFixed(1)},${y(p.actualCents).toFixed(1)}`
    }
    if (p.projectedCents !== null) {
      projPath += `${projPath ? 'L' : 'M'}${px.toFixed(1)},${y(p.projectedCents).toFixed(1)}`
    }
  })

  // Graduations Y (4 paliers) + libellés mois (tous les ~1 mois).
  const yTicks = []
  for (let t = 0; t <= 4; t++) {
    const v = minV + (span * t) / 4
    // libellé en k EUR : v est en CENTIMES -> EUR = v/100, k EUR = v/100000.
    const kEur = Math.round(v / 100_000)
    yTicks.push(`<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="${CHARTE.line}" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${CHARTE.muted}">${kEur} k</text>`)
  }
  const xTicks = []
  let lastMonth = ''
  pts.forEach((p, i) => {
    const ym = (p.date || '').slice(0, 7)
    if (ym && ym !== lastMonth && i % Math.ceil(pts.length / 12) === 0) {
      lastMonth = ym
      xTicks.push(`<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="${CHARTE.muted}">${monthLabel(ym)}</text>`)
    }
  })

  // Seuil + point bas.
  const thrY = y(thresholdCents).toFixed(1)
  const lowIdx = pts.findIndex((p) => p.date === lowPoint.date)
  const lowDot = lowIdx >= 0
    ? `<circle cx="${x(lowIdx).toFixed(1)}" cy="${y(lowPoint.cents).toFixed(1)}" r="4" fill="${lowPoint.cents < thresholdCents ? CHARTE.danger : CHARTE.magenta}"/>`
    : ''

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Courbe de trésorerie réalisée et projetée avec seuil de sécurité" xmlns="http://www.w3.org/2000/svg">
    ${yTicks.join('')}
    <line x1="${padL}" y1="${thrY}" x2="${W - padR}" y2="${thrY}" stroke="${CHARTE.danger}" stroke-width="1.5" stroke-dasharray="6 4"/>
    <text x="${W - padR}" y="${(Number(thrY) - 5).toFixed(1)}" text-anchor="end" font-size="10" fill="${CHARTE.danger}">Seuil de sécurité ${eur(thresholdCents)}</text>
    <path d="${actualPath}" fill="none" stroke="${CHARTE.blue}" stroke-width="2.5"/>
    <path d="${projPath}" fill="none" stroke="${CHARTE.cyan}" stroke-width="2" stroke-dasharray="5 3"/>
    ${lowDot}
    ${xTicks.join('')}
  </svg>`
}

/**
 * Construit le HTML print-ready du dossier banquier à partir de l'état complet.
 * @param state loadState()
 * @returns chaîne HTML autonome (à servir tel quel, impression Ctrl+P pour le PDF).
 */
export function buildDossierHTML(state) {
  const proj = project(state)
  const kpi = kpis(state, proj)
  const company = state.company
  const today = todayFor(company)
  const currentMonth = monthOf(today)
  const threshold = company.lowCashThresholdCents

  // Plan de trésorerie : 12 mois à partir du mois courant (ou jusqu'à l'horizon si < 12).
  const planEnd = monthRange(currentMonth, horizonEndOf(currentMonth)).slice(0, 12).at(-1)
  const planMonths = monthRange(currentMonth, planEnd)
  const byMonth = {}
  for (const m of proj.monthly) byMonth[m.month] = m
  const planRows = planMonths.map((ym) => {
    const m = byMonth[ym] || { openingCents: 0, inCents: 0, outCents: 0, closingCents: 0, projected: true }
    return { month: ym, ...m, underThreshold: m.closingCents < threshold }
  })

  // Ratios clés (runway, point mort, NET, résultat prévisionnel).
  const rp = kpi.resultatPrevisionnel
  const runwayTxt = kpi.runwayMonths === null || kpi.runwayMonths === undefined
    ? 'au-delà de l\'horizon (pas de consommation nette au rythme actuel)'
    : `${kpi.runwayMonths.toLocaleString('fr-FR')} mois`

  const chartSVG = balanceChartSVG(proj.series, threshold, proj.lowPoint)

  const sourceLabel = company.importedAt?.indy
    ? `Données comptables au ${fmtDateFR(company.importedAt.indy)}`
    : 'Données comptables (date d\'import inconnue)'

  // Hypothèses : provisions fiscales réelles + hypothèses métier saisies.
  const hypotheses = []
  if (company.fiscal?.tva?.autoCompute) {
    hypotheses.push(`TVA dérivée des flux (régime ${esc(company.fiscal.tvaRegime || 'réel')}), reversée le ${company.fiscal.tva.payDayOfMonth || 22} du mois suivant.`)
  }
  if (company.fiscal?.tns?.autoCompute) {
    const tns = company.fiscal.tns
    hypotheses.push(`Provision URSSAF/TNS = rémunération du gérant x ${tns.cotisationTauxPct}% (avec ACRE jusqu'à ${tns.acre?.finMois || '?'}, puis ${tns.cotisationTauxApresAcrePct ?? tns.cotisationTauxPct}%).`)
  }
  for (const h of company.businessAssumptions || []) hypotheses.push(esc(h))

  const css = `
    @page { size: A4; margin: 16mm 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: ${CHARTE.cream}; color: ${CHARTE.ink};
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { max-width: 800px; margin: 0 auto; padding: 28px; }
    h1, h2, h3 { font-family: 'Plus Jakarta Sans', 'Inter', sans-serif; color: ${CHARTE.ink}; margin: 0; }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
    h2 { font-size: 15px; font-weight: 600; margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 2px solid ${CHARTE.blue}; }
    .rainbow { height: 4px; border-radius: 2px; margin: 14px 0 18px;
      background: linear-gradient(90deg, ${CHARTE.blue}, ${CHARTE.cyan}, ${CHARTE.magenta}); }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .head .sub { color: ${CHARTE.muted}; font-size: 12px; margin-top: 4px; }
    .tag { display: inline-block; font-size: 10px; font-weight: 600; color: ${CHARTE.blue};
      border: 1px solid ${CHARTE.blue}; border-radius: 999px; padding: 2px 10px; }
    .ratios { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 6px 0 4px; }
    .ratio { border: 1px solid ${CHARTE.line}; border-radius: 10px; padding: 12px 14px; background: #fff; }
    .ratio .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: ${CHARTE.muted}; }
    .ratio .val { font-size: 18px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .ratio .val.danger { color: ${CHARTE.danger}; }
    .ratio .val.ok { color: ${CHARTE.positive}; }
    .chart { border: 1px solid ${CHARTE.line}; border-radius: 10px; padding: 12px; background: #fff; margin-top: 8px; }
    .legend { display: flex; gap: 18px; font-size: 11px; color: ${CHARTE.muted}; margin-top: 6px; }
    .legend i { display: inline-block; width: 18px; height: 0; border-top: 2px solid; vertical-align: middle; margin-right: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
    th, td { text-align: right; padding: 7px 8px; border-bottom: 1px solid ${CHARTE.line}; font-size: 11px; }
    th:first-child, td:first-child { text-align: left; }
    thead th { color: ${CHARTE.muted}; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.03em; }
    tr.under td { color: ${CHARTE.danger}; }
    tr.under td:first-child::after { content: ' (sous le seuil)'; font-size: 9px; }
    .pos { color: ${CHARTE.positive}; }
    .neg { color: ${CHARTE.danger}; }
    ul.hyp { margin: 6px 0; padding-left: 18px; }
    ul.hyp li { margin: 3px 0; }
    .foot { margin-top: 26px; padding-top: 12px; border-top: 1px solid ${CHARTE.line}; font-size: 10px; color: ${CHARTE.muted}; }
    .print-hint { background: ${CHARTE.blue}; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px;
      font-size: 12px; font-weight: 600; cursor: pointer; }
    @media print { .no-print { display: none !important; } body { background: #fff; } }
  `

  const ratioBlock = (lbl, val, cls = '') =>
    `<div class="ratio"><div class="lbl">${esc(lbl)}</div><div class="val ${cls}">${val}</div></div>`

  const planRowsHTML = planRows.map((r) => `
    <tr class="${r.underThreshold ? 'under' : ''}">
      <td>${monthLabel(r.month)}${r.projected ? '' : ' (réalisé)'}</td>
      <td>${eur(r.openingCents)}</td>
      <td class="pos">${eurSigned(r.inCents)}</td>
      <td class="neg">${eurSigned(r.outCents)}</td>
      <td><strong>${eur(r.closingCents)}</strong></td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Dossier de trésorerie - ${esc(company.name)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700&display=swap" rel="stylesheet"/>
  <style>${css}</style>
</head>
<body>
  <div class="page">
    <div class="head">
      <div>
        <h1>Dossier de trésorerie</h1>
        <div class="sub">${esc(company.name)}${company.sector ? ' - ' + esc(company.sector) : ''}${company.location ? ', ' + esc(company.location) : ''}</div>
        <div class="sub">${esc(sourceLabel)} - édité le ${fmtDateFR(today)}</div>
      </div>
      <div style="text-align:right">
        <span class="tag">Plan prévisionnel</span>
        <div class="no-print" style="margin-top:10px">
          <button class="print-hint" onclick="window.print()">Imprimer / Enregistrer en PDF</button>
        </div>
      </div>
    </div>
    <div class="rainbow"></div>

    <h2>Indicateurs clés</h2>
    <div class="ratios">
      ${ratioBlock('Solde disponible (net)', eur(kpi.netAvailableCents), kpi.netAvailableCents < threshold ? 'danger' : 'ok')}
      ${ratioBlock('Autonomie (runway)', runwayTxt)}
      ${ratioBlock('Point mort mensuel', eur(kpi.breakEvenHTCents) + ' HT')}
      ${ratioBlock('Point bas projeté', eur(proj.lowPoint.cents), proj.lowPoint.cents < threshold ? 'danger' : 'ok')}
    </div>
    <p style="font-size:11px;color:${CHARTE.muted};margin:8px 0 0">
      Solde brut au ${fmtDateFR(today)} : <strong>${eur(proj.balanceTodayCents)}</strong>${kpi.committedCents > 0 ? `, dont ${eur(kpi.committedCents)} de trésorerie engagée (TVA à reverser ${eur(kpi.vatDueCents)} + cotisations provisionnées ${eur(kpi.socialProvisionCents)}).` : '.'}
      Point bas attendu le ${fmtDateFR(proj.lowPoint.date)}.
    </p>

    <h2>Courbe de trésorerie (réalisé et projeté)</h2>
    <div class="chart">
      ${chartSVG}
      <div class="legend">
        <span><i style="border-color:${CHARTE.blue}"></i>Réalisé</span>
        <span><i style="border-color:${CHARTE.cyan};border-top-style:dashed"></i>Projeté</span>
        <span><i style="border-color:${CHARTE.danger};border-top-style:dashed"></i>Seuil de sécurité</span>
      </div>
    </div>

    <h2>Plan de trésorerie sur ${planRows.length} mois</h2>
    <table>
      <thead>
        <tr><th>Mois</th><th>Ouverture</th><th>Encaissements</th><th>Décaissements</th><th>Clôture</th></tr>
      </thead>
      <tbody>${planRowsHTML}</tbody>
    </table>

    ${rp ? `<h2>Résultat prévisionnel ${esc(rp.exerciseYear)} (rentabilité)</h2>
    <table>
      <tbody>
        <tr><td>Produits HT cumulés</td><td colspan="4"><strong>${eur(rp.productsHTCents)}</strong></td></tr>
        <tr><td>Charges HT cumulées</td><td colspan="4">${eur(rp.chargesHTCents)}</td></tr>
        <tr><td>Résultat avant IS</td><td colspan="4"><strong>${eur(rp.resultatAvantISCents)}</strong></td></tr>
        <tr><td>IS estimé</td><td colspan="4">${eur(-rp.isProvisionCents)}</td></tr>
        <tr><td>Résultat après IS</td><td colspan="4"><strong>${eur(rp.resultatApresISCents)}</strong></td></tr>
      </tbody>
    </table>
    <p style="font-size:10px;color:${CHARTE.muted};margin-top:4px">La trésorerie disponible ne se confond pas avec le bénéfice : la TVA collectée et les cotisations à reverser gonflent le solde sans être acquises.</p>` : ''}

    <h2>Hypothèses retenues</h2>
    <ul class="hyp">
      <li>Seuil de sécurité de trésorerie fixé à ${eur(threshold)} (comparé au solde net disponible).</li>
      ${hypotheses.map((h) => `<li>${h}</li>`).join('')}
    </ul>

    <div class="foot">
      Document généré par Syntréso à partir des données comptables de l'entreprise. Les montants
      projetés sont des estimations fondées sur le prévisionnel et les hypothèses ci-dessus, non
      un engagement. Document destiné à un échange avec un partenaire financier.
    </div>
  </div>
</body>
</html>`
}
