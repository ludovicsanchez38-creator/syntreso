import { useEffect, useState } from 'react'
import { MessageCircleQuestion, Sparkles } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useAgent } from './AgentContext'

const SUGGESTIONS = [
  'Quelle a été ma plus grosse dépense des 12 derniers mois ?',
  'Est-ce que je peux embaucher un ouvrier qualifié en septembre ?',
  'Pourquoi mon abonnement logiciels & télécom a-t-il augmenté ?',
  'Où en est la facture Durance Logis ?',
]

// cmd+K : barre universelle, navigation + question en langage naturel.
export function AgentCommandBar() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busyHint, setBusyHint] = useState(false)
  const { ask } = useAgent()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const send = (question: string) => {
    // si l'assistant rédige déjà, on garde le dialog ouvert et on prévient au lieu
    // de jeter silencieusement la question
    if (!ask(question)) {
      setBusyHint(true)
      return
    }
    setBusyHint(false)
    setOpen(false)
    setValue('')
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Assistant Syntréso" description="Posez votre question">
      <CommandInput
        placeholder="Posez une question à votre trésorerie..."
        value={value}
        onValueChange={setValue}
      />
      {busyHint && (
        <p className="border-b px-4 py-2 text-xs text-destructive">
          L'assistant rédige déjà une réponse : attendez la fin avant d'envoyer une nouvelle question.
        </p>
      )}
      <CommandList>
        <CommandEmpty>Appuyez sur Entrée pour envoyer votre question.</CommandEmpty>
        {value.trim() && (
          <CommandGroup heading="Votre question">
            <CommandItem onSelect={() => send(value.trim())} value={`ask-${value}`}>
              <Sparkles className="size-4 text-primary" />
              {value.trim()}
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Suggestions">
          {SUGGESTIONS.map((s) => (
            <CommandItem key={s} onSelect={() => send(s)} value={s}>
              <MessageCircleQuestion className="size-4 text-muted-foreground" />
              {s}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
