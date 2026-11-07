// Outils MCP in-process de l'assistant : l'agent passe de
// « paraphraseur de digest figé » à analyste outillé, SANS toucher à la doctrine -
// le moteur calcule, l'agent habille, l'humain valide.
//
// Tous les outils tournent DANS le process Express (createSdkMcpServer : zéro IPC,
// zéro process séparé) et appellent directement le moteur. Cinq outils en LECTURE
// SEULE + un outil de PROPOSITION (écrit uniquement une proposition `pending`,
// validée par l'humain dans l'UI - même circuit qu'avant).
//
// buildSyntresoServer est une factory à injection : `createProposalFromPayload` vit
// dans agent.js (avec la validation et le verrou) et `emit` pousse les événements
// proposal vers la génération SSE en cours - pas de cycle d'import. Elle charge le SDK
// à la demande : tant que l'assistant ne sert pas, le SDK n'est jamais importé.

import { z } from 'zod'
import { loadState, project, kpis, dataFreshness, reconciliation, monthOf, todayFor } from './projection.js'
import { forecastImpact, remunerationCheck, ccaRepaymentCheck } from './decision.js'
import { cashCalendar } from './echeances.js'

const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const asError = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export async function buildSyntresoServer({ createProposalFromPayload, emit }) {
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
  const tools = [
    tool(
      'get_kpis',
      "Indicateurs calculés par le moteur à l'instant T : soldes (brut, NET disponible), trésorerie engagée (TVA, URSSAF), point bas projeté, runway, point mort, résultat prévisionnel, réconciliation bancaire, fraîcheur des données. Source de vérité pour tout verdict.",
      {},
      async () => {
        const state = await loadState()
        const proj = project(state)
        return asText({
          today: todayFor(state.company),
          kpis: kpis(state, proj),
          reconciliation: reconciliation(state),
          dataFreshness: dataFreshness(state.company),
        })
      },
    ),
    tool(
      'get_projection',
      'Soldes projetés en fin de mois (clôtures mensuelles du prévisionnel actuel), du mois courant à l\'horizon. Optionnel : bornes fromMonth/toMonth (YYYY-MM).',
      {
        fromMonth: z.string().regex(MONTH_RE).optional().describe('Premier mois inclus (YYYY-MM)'),
        toMonth: z.string().regex(MONTH_RE).optional().describe('Dernier mois inclus (YYYY-MM)'),
      },
      async (args) => {
        const state = await loadState()
        const proj = project(state)
        const currentMonth = monthOf(todayFor(state.company))
        const rows = proj.monthly
          .filter((m) => m.month >= (args.fromMonth || currentMonth))
          .filter((m) => !args.toMonth || m.month <= args.toMonth)
          .map((m) => ({ month: m.month, closingCents: m.closingCents }))
        return asText({ currentMonth, lowCashThresholdCents: state.company.lowCashThresholdCents, monthly: rows })
      },
    ),
    tool(
      'simulate_forecast_impact',
      "Simule l'impact d'une écriture prévisionnelle (overlay éphémère, RIEN n'est écrit) : nouveau point bas, passage sous le seuil, delta de runway. À utiliser pour tout « et si... » chiffré avant de proposer une écriture.",
      {
        month: z.string().regex(MONTH_RE).describe("Mois d'impact (YYYY-MM)"),
        categoryId: z.string().describe('Catégorie (id de la liste du digest)'),
        amountCents: z.number().int().describe('Montant en centimes, positif = encaissement, négatif = décaissement'),
      },
      async (args) => {
        const state = await loadState()
        return asText(forecastImpact(state, args))
      },
    ),
    tool(
      'check_remuneration',
      'Feu vert / ambre / rouge du moteur pour « puis-je me verser X ? » : verdict tranché au centime (cotisations, échéances 60 j, runway). TOUJOURS appeler cet outil pour une question de versement, ne jamais calculer soi-même.',
      {
        amountCents: z.number().int().positive().describe('Montant brut envisagé, en centimes'),
        month: z.string().regex(MONTH_RE).optional().describe('Mois envisagé (défaut : mois courant)'),
      },
      async (args) => {
        const state = await loadState()
        return asText(remunerationCheck(state, args))
      },
    ),
    tool(
      'check_remboursement_cca',
      "Feu vert / ambre / rouge du moteur pour « puis-je me REMBOURSER X du compte courant d'associé ? ». Levier le plus efficace fiscalement : un remboursement de CCA sort SANS cotisations ni impôt (dette de la société envers le gérant), mais il est plafonné par le CCA réellement accumulé. TOUJOURS appeler cet outil pour une question de remboursement de compte courant.",
      {
        amountCents: z.number().int().positive().describe('Montant du remboursement envisagé, en centimes'),
        month: z.string().regex(MONTH_RE).optional().describe('Mois envisagé (défaut : mois courant)'),
      },
      async (args) => {
        const state = await loadState()
        return asText(ccaRepaymentCheck(state, args))
      },
    ),
    tool(
      'get_echeances',
      'Échéancier daté des sorties certaines à venir (TVA, URSSAF, échéances saisies) sur un horizon en jours (défaut 90).',
      {
        horizonDays: z.number().int().min(7).max(365).optional().describe('Horizon en jours (défaut 90)'),
      },
      async (args) => {
        const state = await loadState()
        const calendar = await cashCalendar(state, { horizonDays: args.horizonDays || 90 })
        return asText(calendar)
      },
    ),
    tool(
      'propose_forecast_line',
      "Propose une écriture prévisionnelle (devis signé, dépense à venir...). N'ÉCRIT RIEN : crée une proposition que l'utilisateur valide ou refuse dans l'interface. Une seule proposition par réponse. Toujours expliquer l'impact (via simulate_forecast_impact) AVANT de proposer. Sur les catégories fiscales pilotées par le moteur (TVA, provision URSSAF, IS), le montant est un AJUSTEMENT qui S'AJOUTE au montant auto-calculé : proposer le delta (ex. surcoût vs modèle), jamais le total.",
      {
        month: z.string().regex(MONTH_RE).describe("Mois d'impact (YYYY-MM) : date de l'événement + délai de paiement"),
        categoryId: z.string().describe('Catégorie (id de la liste du digest, cohérent avec la nature du flux)'),
        amountCents: z.number().int().describe('Montant en centimes, positif = encaissement, négatif = décaissement'),
        label: z.string().min(1).max(200).describe('Libellé court et clair'),
      },
      async (args) => {
        const outcome = await createProposalFromPayload({ kind: 'forecast_line', ...args })
        if (outcome.error) return asError(outcome.error)
        emit({ type: 'proposal', proposal: outcome.proposal })
        return asText({ ok: true, proposalId: outcome.proposal.id, message: "Proposition créée, en attente de validation par l'utilisateur dans l'interface. Ne pas la re-proposer." })
      },
    ),
    tool(
      'propose_invoice_reminder',
      "Propose un brouillon de relance pour une facture en retard (id de la section « Factures clients en cours » du digest). N'envoie rien : l'utilisateur copie le texte s'il valide.",
      {
        invoiceId: z.string().describe('Id de la facture (digest)'),
        draft: z.string().min(20).describe('Texte du mail de relance (courtois, vouvoiement, 4-8 lignes)'),
      },
      async (args) => {
        const outcome = await createProposalFromPayload({ kind: 'invoice_reminder', ...args })
        if (outcome.error) return asError(outcome.error)
        emit({ type: 'proposal', proposal: outcome.proposal })
        return asText({ ok: true, proposalId: outcome.proposal.id, message: 'Brouillon proposé, en attente côté interface.' })
      },
    ),
  ]

  return {
    server: createSdkMcpServer({ name: 'syntreso', version: '1.0.0', tools }),
    allowedTools: tools.map((t) => `mcp__syntreso__${t.name}`),
  }
}
