// Assistant Syntréso - Claude Agent SDK, outils branchés sur le moteur de calcul.
//
// - cwd = <données>/assistant/ : CLAUDE.md (system prompt) + DONNEES.md + MEMOIRE.md (@import)
// - accès : UNIQUEMENT la clé d'API Anthropic de l'utilisateur (ANTHROPIC_API_KEY). La
//   documentation de l'Agent SDK interdit aux logiciels tiers de proposer la connexion
//   claude.ai sans accord préalable d'Anthropic : aucune autre voie n'est lue ni transmise.
//   Le SDK lance le programme Claude Code qu'il embarque (ou CLAUDE_BIN si défini).
// - interrupteur : SYNTRESO_ASSISTANT=non (environnement) ou "assistant": { "actif": false }
//   (config/reglages.json) coupent tout. Coupé, le SDK n'est même pas chargé et aucun
//   appel ne part ; l'appli fonctionne entièrement sans assistant.
// - outils : serveur MCP IN-PROCESS (agent-tools.js) branché sur le moteur, lecture
//   seule + propositions validées par l'humain. Les outils builtin (Bash, Read...)
//   restent deny par agent-workspace/.claude/settings.json (settingSources: project)
//   ET absents de allowedTools (défense en profondeur).
// - conversation SUIVIE : le session_id est conservé (TTL 15 min) et repris via
//   `resume` -> « et 2 000 alors ? » garde le contexte. `newConversation` repart à zéro.
// - usage SOLO : un seul ask à la fois. Un sémaphore mémoire (askBusy) renvoie 429
//   si une génération est déjà en cours.

import { spawn } from 'node:child_process'
import { readJsonOr, writeJson, withDataLock, writeJsonBatchInLock, appendAuditInLock, updateJson, appendAudit } from './store.js'
import { loadState, monthOf, monthRange, todayFor } from './projection.js'
import { autoManagedCategoryIds } from './fiscal.js'
import { horizonEnd } from './horizon.js'
import { onDataChanged } from './events.js'
import { workspace } from './digest.js'
import { appendMemoire } from './memoire.js'
import { buildSyntresoServer } from './agent-tools.js'
import { lireReglages } from './reglages.js'

// ------------------------------------------------------------------ Activation
const SDK = '@anthropic-ai/claude-agent-sdk'
const NON = new Set(['non', 'off', '0', 'false', 'no'])
// « oui » est accepté pour compatibilité : il vaut « auto » (la clé reste exigée).
const AUTO = new Set(['auto', '', 'oui', 'on', '1', 'true', 'yes'])

/**
 * L'assistant est-il activé ? Ne contacte rien : lit seulement la configuration.
 * Retourne { available, raison }. Toute incertitude coupe l'assistant (valeur inconnue,
 * réglages illisibles) : il ne s'allume que sur une configuration claire.
 */
export function assistantStatus() {
  const mode = String(process.env.SYNTRESO_ASSISTANT ?? 'auto').trim().toLowerCase()
  if (NON.has(mode)) return { available: false, raison: "SYNTRESO_ASSISTANT=non dans l'environnement" }
  if (!AUTO.has(mode)) {
    return { available: false, raison: `valeur inconnue SYNTRESO_ASSISTANT=${mode.slice(0, 20)} (attendu : auto ou non)` }
  }
  let reglages
  try {
    reglages = lireReglages()
  } catch (err) {
    return { available: false, raison: `réglages illisibles, par précaution (${err.message})` }
  }
  if (reglages.assistant?.actif === false) {
    return { available: false, raison: 'réglage "assistant": { "actif": false } dans config/reglages.json' }
  }
  if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
    return { available: false, raison: "aucune clé : renseigner ANTHROPIC_API_KEY dans .env (clé d'API créée sur la console Anthropic)" }
  }
  return { available: true, raison: "clé d'API Anthropic présente" }
}

// Variables transmises au processus Claude : une liste fermée (système, langue, proxy,
// certificats) plus la clé d'API. Ni les secrets de Syntréso (jeton, clé Twenty,
// Cloudflare), ni aucune autre forme d'accès (jeton d'abonnement, jeton de passerelle,
// fournisseur cloud) ne passent : la clé d'API est la seule authentification possible.
const ENV_TRANSMIS = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TMPDIR|TMP|TEMP|XDG_[A-Z_]+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy)$/
export function envPourAssistant() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_TRANSMIS.test(k) && v !== undefined) env[k] = v
  }
  env.ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim()
  // ni mise à jour automatique, ni télémétrie, ni rapport d'erreur (documentation Claude Code)
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'syntreso/1.0.0'
  return env
}

// Le SDK n'est chargé qu'au premier usage réel de l'assistant : coupé, il n'est jamais
// importé (et l'appli démarre même s'il n'est pas installé : npm ci --omit=optional).
let sdkPromise = null
function chargerSdk() {
  sdkPromise ??= import(SDK).catch((err) => {
    sdkPromise = null
    throw new Error(`module ${SDK} absent ou illisible (${err.code || err.message}) : réinstaller les dépendances sans --omit=optional`)
  })
  return sdkPromise
}
function sdkInstalle() {
  try {
    import.meta.resolve(SDK)
    return true
  } catch {
    return false
  }
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || ''
const MODEL = process.env.SYNTRESO_AGENT_MODEL || 'claude-sonnet-5-5'
// Avec des outils, il faut des tours : question -> get_kpis/simulate -> réponse.
const MAX_TURNS = Number(process.env.SYNTRESO_AGENT_MAX_TURNS) || 8
// Garde-fou serveur : delai max d'une generation avant interruption forcee
// (AbortController), independant d'une eventuelle deconnexion client.
const HARD_TIMEOUT_MS = Number(process.env.SYNTRESO_AGENT_TIMEOUT_MS) || 180_000

// ------------------------------------------------------------------ Outils MCP in-process
// Les handlers d'outils poussent leurs événements (proposal) ici ; la génération en
// cours draine ce buffer entre deux messages du stream. Sûr car mono-ask (sémaphore).
// Le serveur d'outils est construit au premier usage (il dépend du SDK, chargé à la demande).
const toolEvents = []
let outilsPromise = null
function outilsSyntreso() {
  outilsPromise ??= buildSyntresoServer({
    createProposalFromPayload,
    emit: (evt) => toolEvents.push(evt),
  }).catch((err) => {
    outilsPromise = null
    throw err
  })
  return outilsPromise
}

// ------------------------------------------------------------------ Session suivie
const SESSION_TTL_MS = 15 * 60_000
let currentSessionId = null
let sessionTouchedAt = 0

// ------------------------------------------------------------------ Sémaphore mono-ask
// Usage solo : une seule génération à la fois. askBusy passe à true le temps d'un
// ask et empêche d'en lancer un second (la route renvoie 429). Évite N process
// Claude concurrents (coûteux, inutile pour un dirigeant seul).
let askBusy = false

export function isAskBusy() {
  return askBusy
}

// ------------------------------------------------------------------ Streaming
/**
 * Pose une question à l'assistant et stream la réponse (Agent SDK).
 * Yields { type: 'chunk', text } | { type: 'proposal', proposal } |
 *        { type: 'proposal_error', message } | { type: 'done', usage } | { type: 'error', message }
 */
export async function* streamAgentResponse({ question, newConversation = false }) {
  // Filet : si deux ask passent malgré le check de la route (course très improbable),
  // le second est refusé proprement sans rien démarrer.
  if (askBusy) {
    yield { type: 'error', message: 'Assistant occupé : une réponse est déjà en cours de génération.' }
    return
  }
  const statut = assistantStatus()
  if (!statut.available) {
    yield { type: 'error', message: `Assistant indisponible : ${statut.raison}.` }
    return
  }
  askBusy = true
  toolEvents.length = 0

  const abort = new AbortController()
  let timedOut = false
  const hardTimer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, HARD_TIMEOUT_MS)
  hardTimer.unref()

  let stderrBuffer = ''
  let sawOutput = false
  let proposalEmitted = false
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }

  try {
    if (newConversation) currentSessionId = null
    const resume =
      currentSessionId && Date.now() - sessionTouchedAt < SESSION_TTL_MS ? currentSessionId : undefined

    const [{ query }, { server: syntresoServer, allowedTools: SYNTRESO_TOOLS }] = await Promise.all([chargerSdk(), outilsSyntreso()])
    const stream = query({
      prompt: question,
      options: {
        cwd: workspace(),
        model: MODEL,
        maxTurns: MAX_TURNS,
        abortController: abort,
        includePartialMessages: true,
        // isolation : ne charger QUE la config du workspace (pas le CLAUDE.md user de
        // la machine, pas les hooks globaux, pas les serveurs MCP user)
        settingSources: ['project'],
        strictMcpConfig: true,
        resume,
        mcpServers: { syntreso: syntresoServer },
        allowedTools: SYNTRESO_TOOLS,
        env: envPourAssistant(),
        stderr: (d) => {
          stderrBuffer += d
        },
        ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
      },
    })

    for await (const msg of stream) {
      // événements poussés par les handlers d'outils (propositions)
      while (toolEvents.length) {
        const evt = toolEvents.shift()
        if (evt.type === 'proposal') proposalEmitted = true
        yield evt
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        currentSessionId = msg.session_id
        sessionTouchedAt = Date.now()
      } else if (msg.type === 'stream_event') {
        const evt = msg.event
        if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          sawOutput = true
          yield { type: 'chunk', text: evt.delta.text }
        }
      } else if (msg.type === 'result') {
        if (msg.usage) {
          usage.input_tokens = msg.usage.input_tokens || 0
          usage.output_tokens = msg.usage.output_tokens || 0
          usage.cache_read_input_tokens = msg.usage.cache_read_input_tokens || 0
        }
        if (msg.is_error) {
          const reason = (msg.errors || []).join(' ; ') || msg.subtype || 'erreur inconnue'
          yield { type: 'error', message: `L'assistant n'a pas pu répondre : ${String(reason).slice(0, 300)}` }
          return
        }
      }
    }
    while (toolEvents.length) {
      const evt = toolEvents.shift()
      if (evt.type === 'proposal') proposalEmitted = true
      yield evt
    }

    if (timedOut) {
      yield { type: 'error', message: `L'assistant a dépassé le délai imparti (${Math.round(HARD_TIMEOUT_MS / 1000)} s) et a été interrompu.` }
      return
    }
    if (!sawOutput && !proposalEmitted) {
      const reason = stderrBuffer.trim().slice(0, 300) || 'aucune sortie'
      yield { type: 'error', message: `L'assistant n'a pas pu répondre : ${reason}` }
      return
    }

    yield { type: 'done', usage, hadProposal: proposalEmitted }
  } catch (err) {
    if (timedOut) {
      yield { type: 'error', message: `L'assistant a dépassé le délai imparti (${Math.round(HARD_TIMEOUT_MS / 1000)} s) et a été interrompu.` }
    } else {
      yield { type: 'error', message: `Erreur d'exécution : ${err.message}` }
    }
  } finally {
    clearTimeout(hardTimer)
    // client parti (iterator.return) ou fin de flux : on interrompt le CLI dans tous
    // les cas où il pourrait encore tourner. abort() est idempotent.
    abort.abort()
    askBusy = false
  }
}

// ------------------------------------------------------------------ Propositions
let proposalSeq = 0

async function validateProposal(payload) {
  const state = await loadState()
  if (payload.kind === 'forecast_line') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.month || '')) return 'mois invalide'
    if (payload.month < monthOf(todayFor(state.company))) return 'mois passé'
    // Horizon glissant dérivé du mois courant (centralisé dans horizon.js), plus de
    // borne figée à '2026-12'.
    const horizonEndMonth = horizonEnd(monthOf(todayFor(state.company)))
    if (payload.month > horizonEndMonth) return `mois au-delà de l'horizon de projection (${horizonEndMonth})`
    const cat = state.categories.find((c) => c.id === payload.categoryId)
    if (!cat) return `catégorie inconnue : ${payload.categoryId}`
    if (!Number.isInteger(payload.amountCents)) return 'montant non entier'
    if (Math.abs(payload.amountCents) > 100_000_000) return 'montant hors limites'
    if (cat.direction === 'in' && payload.amountCents <= 0) return 'montant négatif sur un encaissement'
    if (cat.direction === 'out' && payload.amountCents >= 0) return 'montant positif sur un décaissement'
    if (typeof payload.label !== 'string' || !payload.label.trim()) return 'libellé manquant'
    return null
  }
  if (payload.kind === 'invoice_reminder') {
    const inv = state.invoices.find((i) => i.id === payload.invoiceId)
    if (!inv) return `facture inconnue : ${payload.invoiceId}`
    if (inv.status === 'paid') return 'facture déjà payée'
    if (typeof payload.draft !== 'string' || !payload.draft.trim()) return 'brouillon manquant'
    return null
  }
  if (payload.kind === 'forecast_recalage') {
    // Recalage d'une charge sur le réalisé récent (recalage.js) : réécrit le montant
    // mensuel d'une catégorie de sortie sur une plage de mois futurs. monthlyCents=0
    // est légal (charge disparue -> lignes retirées).
    const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/
    const cat = state.categories.find((c) => c.id === payload.categoryId)
    if (!cat) return `catégorie inconnue : ${payload.categoryId}`
    if (cat.direction !== 'out') return 'recalage réservé aux catégories de sortie'
    if (!Number.isInteger(payload.monthlyCents)) return 'montant non entier'
    if (payload.monthlyCents > 0) return 'montant positif sur un décaissement'
    if (Math.abs(payload.monthlyCents) > 100_000_000) return 'montant hors limites'
    if (!monthRe.test(payload.fromMonth || '') || !monthRe.test(payload.toMonth || '')) return 'mois invalide'
    const cur = monthOf(todayFor(state.company))
    if (payload.fromMonth <= cur) return 'le recalage commence au mois prochain (jamais le réalisé)'
    if (payload.toMonth < payload.fromMonth) return 'plage de mois incohérente'
    if (payload.toMonth > horizonEnd(cur)) return `mois au-delà de l'horizon de projection (${horizonEnd(cur)})`
    if (typeof payload.label !== 'string' || !payload.label.trim()) return 'libellé manquant'
    return null
  }
  return `kind inconnu : ${payload.kind}`
}

/**
 * Crée une proposition `pending` depuis un payload DÉJÀ STRUCTURÉ (tool call du
 * serveur MCP : le schéma d'entrée a validé les types, validateProposal valide le
 * métier). Remplace l'ancien createProposal(rawJson) du protocole de marqueurs.
 */
export async function createProposalFromPayload(payload) {
  const invalid = await validateProposal(payload)
  if (invalid) return { error: `proposition rejetée : ${invalid}` }

  proposalSeq += 1
  const proposal = {
    id: `prop_${Date.now().toString(36)}_${proposalSeq}`,
    createdAt: new Date().toISOString(),
    status: 'pending',
    kind: payload.kind,
    payload,
  }
  await updateJson('proposals', (proposals) => [...proposals, proposal], [])
  return { proposal }
}

/**
 * Proposition déposée par l'API (agent externe, script) : mêmes règles de validation que
 * l'assistant intégré, et toujours `pending` : seul l'humain la valide ou la rejette.
 * Seuls les champs utiles de chaque type sont conservés.
 */
const CHAMPS_PROPOSITION = {
  forecast_line: ['month', 'categoryId', 'amountCents', 'label'],
  forecast_recalage: ['categoryId', 'monthlyCents', 'fromMonth', 'toMonth', 'label'],
  invoice_reminder: ['invoiceId', 'draft'],
}
export async function createProposal(body, { source = 'api' } = {}) {
  const champs = CHAMPS_PROPOSITION[body?.kind]
  if (!champs) return { error: `kind inconnu : ${body?.kind} (forecast_line, forecast_recalage ou invoice_reminder)`, status: 400 }
  const payload = { kind: body.kind }
  for (const c of champs) if (body[c] !== undefined) payload[c] = body[c]
  if (typeof payload.label === 'string') payload.label = payload.label.slice(0, 200)
  const invalid = await validateProposal(payload)
  if (invalid) return { error: `proposition rejetée : ${invalid}`, status: 400 }
  proposalSeq += 1
  const proposal = {
    id: `prop_api_${Date.now().toString(36)}_${proposalSeq}`,
    createdAt: new Date().toISOString(),
    status: 'pending',
    source,
    kind: payload.kind,
    payload,
  }
  await updateJson('proposals', (list) => [...(Array.isArray(list) ? list : []), proposal], [])
  await appendAudit({ actor: 'agent', action: 'proposal.create', target: proposal.id, meta: { kind: proposal.kind, source } })
  return { proposal }
}

export async function listProposals() {
  return readJsonOr('proposals', [])
}

/**
 * Applique (ou rejette) une proposition. `amendments` permet d'ajuster montant/mois
 * avant validation. Tout le cycle (lire les propositions, valider, muter le forecast,
 * réécrire) tient dans UNE section critique de la file de données partagée (withDataLock)
 * pour qu'aucune autre écriture (PATCH forecast, autre confirmation) ne s'intercale entre
 * la lecture et l'écriture. Remplace l'ancien `resolveChain` local, qui ne protégeait que
 * contre deux confirmations concurrentes mais pas contre un PATCH forecast simultané.
 */
export function resolveProposal(id, action, amendments = {}) {
  return withDataLock(() => doResolveProposal(id, action, amendments))
}

// Déjà sous withDataLock : le commit coordonné réutilise le verrou parent.
async function doResolveProposal(id, action, amendments = {}) {
  const proposals = await readJsonOr('proposals', [])
  const proposal = proposals.find((p) => p.id === id)
  if (!proposal) return { error: 'proposition inconnue', status: 404 }
  if (proposal.status !== 'pending') return { error: `proposition déjà ${proposal.status}`, status: 409 }

  if (action === 'reject') {
    proposal.status = 'rejected'
    await writeJsonBatchInLock({ proposals })
    await appendAuditInLock({
      actor: 'user',
      action: 'proposal.reject',
      target: proposal.id,
      meta: { kind: proposal.kind },
    })
    await appendMemoire(`Proposition REJETÉE : ${describeProposal(proposal)}`)
    return { proposal }
  }

  let forecast
  let mutationAudit
  if (proposal.kind === 'forecast_line') {
    // seuls le montant et le mois sont amendables (jamais kind/categoryId via l'API)
    const allowed = {}
    if ('amountCents' in amendments) allowed.amountCents = amendments.amountCents
    if ('month' in amendments) allowed.month = amendments.month
    const payload = { ...proposal.payload, ...allowed }
    const invalid = await validateProposal(payload)
    if (invalid) return { error: invalid, status: 400 }

    forecast = await readJsonOr('forecast', [])
    if (proposal.source === 'twenty-sync') {
      const currentCents = forecast
        .filter((f) => f.month === payload.month && f.categoryId === payload.categoryId)
        .reduce((sum, f) => sum + f.amountCents, 0)
      if (payload.month !== proposal.payload.month || !Number.isInteger(proposal.context?.currentCents) || currentCents !== proposal.context.currentCents) {
        return { error: 'proposition Twenty périmée : relancez la synchronisation', status: 409 }
      }
    }
    // Catégorie pilotée par le moteur (TVA/URSSAF/IS dérivées) : l'ajustement validé
    // vit dans SA propre ligne (suffixe _agent), jamais fusionné avec la moyenne
    // importée - sinon le moteur ne peut plus distinguer le mort (neutralisé) du
    // vivant (additif). Cf. autoManagedCategoryIds / derivedFiscalDeltas.
    const company = await readJsonOr('company', {})
    const isAuto = autoManagedCategoryIds(company).has(payload.categoryId)
    const fcId = isAuto ? `fc_${payload.month}_${payload.categoryId}_agent` : `fc_${payload.month}_${payload.categoryId}`
    const existing = forecast.find((f) => f.id === fcId)
    const before = existing ? { amountCents: existing.amountCents } : null
    if (existing) {
      existing.amountCents += payload.amountCents
      existing.note = existing.note ? `${existing.note} + ${payload.label}` : payload.label
      existing.source = 'agent'
    } else {
      forecast.push({ id: fcId, month: payload.month, categoryId: payload.categoryId, amountCents: payload.amountCents, note: payload.label, source: 'agent' })
    }
    proposal.payload = payload
    mutationAudit = {
      actor: 'agent',
      action: 'forecast.upsert',
      target: fcId,
      before,
      after: { amountCents: existing ? existing.amountCents : payload.amountCents },
      meta: { proposalId: proposal.id, label: payload.label },
    }
  }

  if (proposal.kind === 'forecast_recalage') {
    // seul le montant mensuel est amendable (jamais la catégorie ni la plage via l'API)
    const allowed = {}
    if ('monthlyCents' in amendments) allowed.monthlyCents = amendments.monthlyCents
    const payload = { ...proposal.payload, ...allowed }
    const invalid = await validateProposal(payload)
    if (invalid) return { error: invalid, status: 400 }

    forecast = await readJsonOr('forecast', [])
    for (const mo of monthRange(payload.fromMonth, payload.toMonth)) {
      const fcId = `fc_${mo}_${payload.categoryId}`
      const idx = forecast.findIndex((f) => f.id === fcId)
      if (payload.monthlyCents === 0) {
        if (idx !== -1) forecast.splice(idx, 1)
      } else if (idx !== -1) {
        forecast[idx].amountCents = payload.monthlyCents
        forecast[idx].note = payload.label
        forecast[idx].source = 'recalage'
      } else {
        forecast.push({ id: fcId, month: mo, categoryId: payload.categoryId, amountCents: payload.monthlyCents, note: payload.label, source: 'recalage' })
      }
    }
    proposal.payload = payload
    mutationAudit = {
      actor: 'agent',
      action: 'forecast.recalage',
      target: payload.categoryId,
      meta: { proposalId: proposal.id, monthlyCents: payload.monthlyCents, fromMonth: payload.fromMonth, toMonth: payload.toMonth },
    }
  }

  proposal.status = 'confirmed'
  proposal.resolvedAt = new Date().toISOString()
  await writeJsonBatchInLock({ ...(forecast ? { forecast } : {}), proposals })
  if (mutationAudit) {
    await appendAuditInLock(mutationAudit)
    await onDataChanged()
  }
  await appendAuditInLock({
    actor: 'user',
    action: 'proposal.confirm',
    target: proposal.id,
    meta: { kind: proposal.kind },
  })
  await appendMemoire(`Proposition CONFIRMÉE : ${describeProposal(proposal)}`)
  return { proposal }
}

/** Ligne humaine pour MEMOIRE.md (jamais le JSON brut). */
function describeProposal(proposal) {
  const p = proposal.payload || {}
  if (proposal.kind === 'forecast_line') {
    const eur = `${Math.round((p.amountCents || 0) / 100).toLocaleString('fr-FR')} EUR`
    return `${p.label || 'écriture prévisionnelle'} (${p.categoryId}, ${p.month}, ${eur})`
  }
  if (proposal.kind === 'invoice_reminder') {
    return `brouillon de relance facture ${p.invoiceId || '?'}`
  }
  if (proposal.kind === 'forecast_recalage') {
    const eur = `${Math.round(Math.abs(p.monthlyCents || 0) / 100).toLocaleString('fr-FR')} EUR/mois`
    return `${p.label || 'recalage de charge'} (${p.categoryId}, ${p.fromMonth} -> ${p.toMonth}, ${eur})`
  }
  return proposal.kind
}

// ------------------------------------------------------------------ Contenus pré-générés (alerte proactive, commentaire du mois)
async function generateOnce(question) {
  let text = ''
  for await (const evt of streamAgentResponse({ question })) {
    if (evt.type === 'chunk') text += evt.text
    if (evt.type === 'error') throw new Error(evt.message)
  }
  return text.trim()
}

const PROACTIVE_PROMPT = `À partir des alertes actives du digest, rédige le message d'alerte proactive du jour pour le dirigeant (celui qu'il recevrait sur son téléphone).
Structure : 2-3 phrases max sur la situation (point bas projeté + facture en retard, avec montants et dates exacts du digest), puis une ligne "**Brouillon de relance :**" suivie d'un court mail de relance courtois (4-6 lignes, vouvoiement, prêt à copier-coller, signé "Le dirigeant" suivi du nom de l'entreprise tel qu'il figure en tête du digest).
Mentionne aussi en une phrase l'anomalie de charges si elle est dans les alertes. N'utilise PAS les outils de proposition ici (pas de propose_forecast_line ni propose_invoice_reminder).`

const COMMENT_PROMPT = `Rédige le commentaire de trésorerie du mois pour le point de pilotage mensuel du dirigeant (à partager si besoin avec son expert-comptable).
8 à 12 lignes en markdown : situation actuelle (solde, variation), faits marquants du mois (chiffres exacts du digest), risques (point bas projeté, facture en retard, anomalie), et 2-3 actions recommandées. Factuel, aucun chiffre hors digest. N'utilise PAS les outils de proposition ici.`

// Contradicteur de la revue mensuelle (pattern jury appliqué au produit) : un second
// passage qui ATTAQUE le commentaire au lieu de le paraphraser. Même modèle, prompt
// adverse ; les chiffres viennent du digest et des outils lecture seule.
const CHALLENGE_PROMPT = (commentText) => `Voici le commentaire de trésorerie du mois généré pour le dirigeant :
---
${commentText}
---
Ton rôle ici : CONTRADICTEUR. En t'appuyant UNIQUEMENT sur le digest et tes outils de lecture, trouve LA faille principale de ce commentaire : hypothèse fragile, angle mort, chiffre à vérifier, risque minimisé. 3-4 phrases max, factuel, cite les montants exacts. Ne re-décris pas la situation : attaque le commentaire. N'utilise PAS les outils de proposition.`

/**
 * Revue mensuelle « challengée » : le commentaire du mois + sa contre-lecture.
 * Cache dans agent-cache (clés comment / comment_challenge) ; refresh régénère les
 * DEUX séquentiellement (le challenge dépend du commentaire). Sert l'endpoint
 * /api/agent/revue-mensuelle.
 */
export async function getMonthlyReview({ refresh = false } = {}) {
  const comment = await getCachedContent('comment', { refresh })
  const cache = await readJsonOr('agent-cache', {})
  let challenge = cache.comment_challenge
  if (refresh || !challenge?.text || (comment.generatedAt && challenge.forGeneratedAt !== comment.generatedAt)) {
    const text = await generateOnce(CHALLENGE_PROMPT(comment.text))
    challenge = { text, generatedAt: new Date().toISOString(), forGeneratedAt: comment.generatedAt }
    const fresh = await readJsonOr('agent-cache', {})
    fresh.comment_challenge = challenge
    await writeJson('agent-cache', fresh)
  }
  return { comment, challenge }
}

export async function getCachedContent(key, { refresh = false } = {}) {
  const cache = await readJsonOr('agent-cache', {})
  if (!refresh && cache[key]?.text) return { ...cache[key], cached: true }
  const statut = assistantStatus()
  if (!statut.available) {
    const err = new Error(`Assistant indisponible : ${statut.raison}`)
    err.status = 503
    throw err
  }

  const prompt = key === 'proactive' ? PROACTIVE_PROMPT : COMMENT_PROMPT
  const text = await generateOnce(prompt)
  cache[key] = { text, generatedAt: new Date().toISOString() }
  await writeJson('agent-cache', cache)
  return { ...cache[key], cached: false }
}

export async function pregenerateContent() {
  for (const key of ['proactive', 'comment']) {
    try {
      const result = await getCachedContent(key)
      console.log(`[agent] contenu "${key}" ${result.cached ? 'déjà en cache' : 'pré-généré'}`)
    } catch (err) {
      console.error(`[agent] pré-génération "${key}" échouée : ${err.message}`)
    }
  }
}

export async function checkClaudeAvailable() {
  if (!assistantStatus().available) return false
  if (!sdkInstalle()) return false
  // CLAUDE_BIN non défini -> le SDK utilise son exécutable embarqué (node_modules),
  // toujours présent après npm install : disponible. Sinon, vérifier le binaire.
  if (!CLAUDE_BIN) return true
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: envPourAssistant() })
    proc.on('error', () => resolve(false))
    proc.on('exit', (code) => resolve(code === 0))
  })
}
