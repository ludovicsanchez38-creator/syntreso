import { useState } from 'react'
import { Info } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppState } from '@/lib/api'

// Transparence IA Act art. 50 : information claire dès la première interaction.
export function AiActBanner() {
  const [open, setOpen] = useState(false)
  const company = useAppState().data?.company
  const companyName = company?.name
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 border-b bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="size-3" />
        Vous échangez avec un assistant IA - en savoir plus
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>À propos de cet assistant</DialogTitle>
            <DialogDescription>Transparence conforme à l'article 50 du règlement européen sur l'IA.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <p>
              Cet assistant est un système d'intelligence artificielle (modèle Claude d'Anthropic). Ses réponses sont
              générées automatiquement à partir des seules données de trésorerie de votre entreprise.
            </p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
              <li>Aucune écriture n'est créée sans votre validation explicite.</li>
              <li>Les projections sont des estimations, pas des garanties. La décision reste humaine.</li>
              <li>Vos données ne sont pas utilisées pour entraîner les modèles.</li>
              <li>Les hypothèses derrière chaque réponse chiffrée sont affichées.</li>
            </ul>
            <p className="text-xs text-muted-foreground">
              {company?.demoToday
                ? `Prototype de démonstration : les données affichées sont fictives${companyName ? ` (${companyName})` : ''}.`
                : `Données réelles${companyName ? ` de ${companyName}` : ''}, importées depuis la comptabilité.`}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
