/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { askAgent, type AgentProposal } from '@/lib/sse'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  proposal?: AgentProposal
  proposalError?: string
  error?: boolean
  streaming?: boolean
}

interface AgentContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  messages: ChatMessage[]
  busy: boolean
  /** vrai tant qu'aucun texte n'est arrivé (affiche la timeline d'attente) */
  waitingFirstChunk: boolean
  /** retourne false si l'assistant est déjà occupé (question non envoyée) */
  ask: (question: string, opts?: { newConversation?: boolean }) => boolean
  /** vide le fil et repart sur une session neuve côté serveur au prochain ask */
  resetConversation: () => void
  proactive: { text: string; generatedAt: string } | undefined
  proactiveSeen: boolean
  markProactiveSeen: () => void
  available: boolean
  /** raison affichée quand l'assistant est désactivé (pas de clé, SYNTRESO_ASSISTANT=non) */
  unavailableReason: string | null
}

const AgentContext = createContext<AgentContextValue | null>(null)

let nextId = 1

export function AgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpenRaw] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [waitingFirstChunk, setWaitingFirstChunk] = useState(false)
  const [proactiveSeen, setProactiveSeen] = useState(false)
  const busyRef = useRef(false)

  const status = useQuery({
    queryKey: ['agent-status'],
    queryFn: async () => (await fetch('/api/agent/status')).json() as Promise<{ available: boolean; raison?: string }>,
    staleTime: Infinity,
  })

  const proactive = useQuery({
    queryKey: ['agent-proactive'],
    queryFn: async () => {
      const res = await fetch('/api/agent/proactive')
      if (!res.ok) return undefined
      return (await res.json()) as { text: string; generatedAt: string }
    },
    // assistant désactivé : pas d'appel (il répondrait 503)
    enabled: status.data?.available === true,
    staleTime: Infinity,
    retry: false,
  })

  const setOpen = useCallback((value: boolean) => {
    setOpenRaw(value)
    if (value) {
      setProactiveSeen(true) // ouvrir le panneau = lire l'alerte du jour
    }
  }, [])

  // au prochain ask après reset, le serveur repart sur une session neuve
  const freshRef = useRef(false)

  const resetConversation = useCallback(() => {
    setMessages([])
    freshRef.current = true
  }, [])

  const ask = useCallback(
    (question: string, opts?: { newConversation?: boolean }): boolean => {
      if (busyRef.current || !question.trim()) return false
      busyRef.current = true
      setBusy(true)
      setWaitingFirstChunk(true)
      setOpenRaw(true)

      const userMsg: ChatMessage = { id: nextId++, role: 'user', text: question }
      const assistantId = nextId++
      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', text: '', streaming: true }])

      const update = (patch: Partial<ChatMessage>) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)))

      const newConversation = Boolean(opts?.newConversation) || freshRef.current
      freshRef.current = false
      let text = ''
      askAgent(question, (evt) => {
        if (evt.type === 'chunk') {
          text += evt.text
          setWaitingFirstChunk(false)
          update({ text })
        } else if (evt.type === 'proposal') {
          setWaitingFirstChunk(false)
          update({ proposal: evt.proposal })
        } else if (evt.type === 'proposal_error') {
          update({ proposalError: evt.message })
        } else if (evt.type === 'error') {
          update({ text: evt.message, error: true, streaming: false })
        } else if (evt.type === 'done') {
          update({ streaming: false })
        }
      }, { newConversation })
        .catch((err) => update({ text: String(err.message || err), error: true, streaming: false }))
        .finally(() => {
          busyRef.current = false
          setBusy(false)
          setWaitingFirstChunk(false)
          update({ streaming: false })
        })
      return true
    },
    [],
  )

  return (
    <AgentContext.Provider
      value={{
        open,
        setOpen,
        messages,
        busy,
        waitingFirstChunk,
        ask,
        resetConversation,
        proactive: proactive.data,
        proactiveSeen,
        markProactiveSeen: () => setProactiveSeen(true),
        available: status.data?.available ?? true,
        unavailableReason: status.data?.available === false ? status.data.raison ?? null : null,
      }}
    >
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent doit être utilisé sous AgentProvider')
  return ctx
}
