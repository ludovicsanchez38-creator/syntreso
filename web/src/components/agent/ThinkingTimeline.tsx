import { useEffect, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = ['Lecture de l\'état de trésorerie', 'Analyse des flux sur 14 mois', 'Rédaction de la réponse']

// Masque la latence de démarrage du CLI : étapes honnêtes cochées sur un tempo fixe.
export function ThinkingTimeline() {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1500)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {STEPS.map((label, i) => (
        <div key={label} className={cn('flex items-center gap-2 text-xs', i <= step ? 'text-foreground' : 'text-muted-foreground/50')}>
          {i < step ? (
            <Check className="size-3.5 text-positive" />
          ) : i === step ? (
            <LoaderCircle className="size-3.5 animate-spin text-primary" />
          ) : (
            <span className="inline-block size-3.5" />
          )}
          {label}
        </div>
      ))}
    </div>
  )
}
