import { Sparkles } from 'lucide-react'
import { usePendingProposals } from '@/lib/api'
import { useAgent } from './AgentContext'

// Bouton de chat flottant (style « Bibliothécaire ») : point d'entrée unique de
// l'assistant, en bas à droite. Masqué quand la fenêtre est ouverte (elle a son propre
// bouton fermer). Couleur unie (pas de dégradé), pastille si alerte du jour non lue
// OU si des propositions attendent une validation (jobs Twenty / recalage).
export function AgentFab() {
  const { open, setOpen, proactive, proactiveSeen } = useAgent()
  const pending = usePendingProposals()
  const pendingCount = pending.data?.length ?? 0
  if (open) return null
  const showDot = (proactive && !proactiveSeen) || pendingCount > 0
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Ouvrir l'assistant"
      title="Assistant (Cmd+K)"
      className="fixed bottom-4 right-4 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:brightness-110"
    >
      <Sparkles className="size-6" />
      {showDot && (
        <span
          className="absolute right-1 top-1 size-3 rounded-full bg-destructive ring-2 ring-card"
          aria-label={pendingCount > 0 ? `${pendingCount} proposition(s) en attente` : 'Alerte du jour non lue'}
        />
      )}
    </button>
  )
}
