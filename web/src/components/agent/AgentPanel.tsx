import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { BellRing, CornerDownLeft, Inbox, RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePendingProposals } from '@/lib/api'
import { useAgent } from './AgentContext'
import { AiActBanner } from './AiActBanner'
import { ThinkingTimeline } from './ThinkingTimeline'
import { ProposalCard } from './ProposalCard'

function AssistantText({ text }: { text: string }) {
  return (
    <div className="prose-sm flex flex-col gap-2 text-sm leading-relaxed [&_li]:ml-4 [&_li]:list-disc [&_strong]:font-semibold">
      <Markdown>{text}</Markdown>
    </div>
  )
}

export function AgentPanel() {
  const { open, setOpen, messages, busy, waitingFirstChunk, ask, resetConversation, proactive, available, unavailableReason } = useAgent()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // Propositions en attente côté serveur (jobs Twenty / recalage). Celles déjà
  // affichées dans le fil de chat de CETTE session sont exclues (pas de doublon).
  const pending = usePendingProposals()
  const inChat = new Set(messages.map((m) => m.proposal?.id).filter(Boolean))
  const pendingJobs = (pending.data ?? []).filter((p) => !inChat.has(p.id))

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, waitingFirstChunk])

  if (!open) return null

  const submit = () => {
    if (!draft.trim() || busy) return
    ask(draft.trim())
    setDraft('')
  }

  return (
    <aside className="fixed inset-0 z-50 flex flex-col bg-card shadow-xl sm:inset-auto sm:top-4 sm:bottom-4 sm:right-4 sm:w-[400px] sm:rounded-xl sm:border">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-semibold">Assistant Syntréso</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={resetConversation}
              disabled={busy}
              aria-label="Nouvelle conversation"
              title="Nouvelle conversation (le fil et le contexte repartent à zéro)"
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Fermer l'assistant">
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <AiActBanner />

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
        {!available && (
          <div className="rounded-lg border border-warning/50 bg-warning/5 p-3 text-xs">
            L'assistant IA est coupé{unavailableReason ? ` : ${unavailableReason}` : ''}. Aucune donnée n'est envoyée et le reste de l'application fonctionne normalement (voir le README, section assistant).
          </div>
        )}

        {proactive && (
          <div className="rounded-lg border border-warning/50 bg-warning/5 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <BellRing className="size-3.5 text-warning" />
              Alerte du jour
            </div>
            <div className="mt-2">
              <AssistantText text={proactive.text} />
            </div>
          </div>
        )}

        {pendingJobs.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Inbox className="size-3.5 text-primary" />
              Propositions en attente ({pendingJobs.length})
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Émises par les synchronisations automatiques (pipe Twenty, recalage des charges). Rien ne s'écrit sans
              votre validation.
            </p>
            {pendingJobs.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}

        {messages.length === 0 && !proactive && pendingJobs.length === 0 && (
          <div className="mt-6 flex flex-col items-center gap-2 text-center">
            <Sparkles className="size-6 text-muted-foreground/50" />
            <p className="max-w-60 text-xs leading-relaxed text-muted-foreground">
              Posez une question sur votre trésorerie ou annoncez un événement : « j'ai signé un devis de 12 000 EUR
              payable à 60 jours ».
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={cn(m.role === 'user' && 'self-end')}>
            {m.role === 'user' ? (
              <div className="max-w-72 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{m.text}</div>
            ) : (
              <div className={cn(m.error && 'rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive')}>
                {m.text ? <AssistantText text={m.text} /> : m.streaming ? null : null}
                {m.proposal && <ProposalCard proposal={m.proposal} />}
                {m.proposalError && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Je n'ai pas réussi à structurer cette écriture ({m.proposalError}). Reformulez avec un montant et un
                    délai précis.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}

        {waitingFirstChunk && <ThinkingTimeline />}
      </div>

      <div className="border-t p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={busy ? 'L\'assistant rédige...' : 'Votre question ou votre événement...'}
            rows={2}
            disabled={busy || !available}
            className="min-h-9 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          <Button size="icon" onClick={submit} disabled={busy || !draft.trim() || !available} aria-label="Envoyer">
            <CornerDownLeft className="size-4" />
          </Button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Les réponses sont des estimations générées par IA. Aucune écriture sans votre validation.
        </p>
      </div>
    </aside>
  )
}
