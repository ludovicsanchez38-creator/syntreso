// Consommation du flux SSE de POST /api/agent/ask via fetch + ReadableStream
// (EventSource ne supporte pas POST).

export interface AgentProposal {
  id: string
  status: string
  kind: 'forecast_line' | 'invoice_reminder' | 'forecast_recalage'
  payload: {
    kind: string
    month?: string
    categoryId?: string
    amountCents?: number
    label?: string
    invoiceId?: string
    draft?: string
    // forecast_recalage (recalage de charge sur le réalisé récent)
    monthlyCents?: number
    fromMonth?: string
    toMonth?: string
  }
  // contexte optionnel posé par les jobs (twenty-sync, recalage-charges)
  context?: Record<string, number | string>
}

export type AgentEvent =
  | { type: 'chunk'; text: string }
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'proposal_error'; message: string }
  | { type: 'done'; usage: Record<string, number> }
  | { type: 'error'; message: string }

export async function askAgent(
  question: string,
  onEvent: (evt: AgentEvent) => void,
  { newConversation = false }: { newConversation?: boolean } = {},
): Promise<void> {
  const res = await fetch('/api/agent/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, newConversation }),
  })
  if (res.status === 429) {
    onEvent({ type: 'error', message: 'Assistant occupé : une réponse est déjà en cours. Patientez avant de relancer.' })
    return
  }
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: `L'assistant est injoignable (${res.status}).` })
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const line = block.trim()
      if (!line.startsWith('data: ')) continue
      try {
        onEvent(JSON.parse(line.slice(6)) as AgentEvent)
      } catch {
        // bloc malformé ignoré
      }
    }
  }
}
