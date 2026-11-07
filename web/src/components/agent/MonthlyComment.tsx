import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import { Check, Copy, FileText, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Le livrable de la séance de pilotage : commentaire du mois généré par l'agent,
// pré-généré au boot du serveur (cache) pour un affichage instantané en démo.
export function MonthlyComment() {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const comment = useQuery({
    queryKey: ['agent-comment'],
    queryFn: async () => {
      const res = await fetch('/api/agent/comment')
      if (!res.ok) throw new Error('génération impossible')
      return (await res.json()) as { text: string; generatedAt: string }
    },
    enabled: open,
    staleTime: Infinity,
    retry: false,
  })

  const refresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/agent/comment?refresh=1')
      await comment.refetch()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileText className="size-3.5" />
        Commentaire du mois
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Commentaire de trésorerie du mois</DialogTitle>
            <DialogDescription>
              Généré par l'assistant IA à partir des chiffres du mois - à vérifier avant diffusion.
            </DialogDescription>
          </DialogHeader>
          {comment.isLoading || refreshing ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Rédaction en cours...
            </div>
          ) : comment.isError ? (
            <p className="py-6 text-sm text-destructive">L'assistant n'a pas pu générer le commentaire.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border bg-muted/30 p-4 text-sm leading-relaxed [&_li]:ml-4 [&_li]:list-disc [&_strong]:font-semibold">
              <Markdown>{comment.data?.text ?? ''}</Markdown>
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={comment.isLoading || refreshing}>
              <RefreshCw className="size-3.5" />
              Régénérer
            </Button>
            <Button
              size="sm"
              disabled={!comment.data}
              onClick={() => {
                navigator.clipboard.writeText(comment.data?.text ?? '')
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copié' : 'Copier pour le compte rendu'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
