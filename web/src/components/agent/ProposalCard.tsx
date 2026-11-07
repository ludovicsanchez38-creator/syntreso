import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleCheck, Copy, Pencil, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { previewForecastImpact, sendJson, useAppState, type ForecastImpactResponse } from '@/lib/api'
import { formatCents, formatMonthsDelta } from '@/lib/money'
import { formatMonth, formatDateShort } from '@/lib/dates'
import type { AgentProposal } from '@/lib/sse'

// Verdict d'impact d'une écriture proposée : delta de marge (runway) + passage sous le
// seuil. Le moteur calcule tout via /api/projection/impact (overlay éphémère, rien
// d'écrit). Discret tant que la proposition n'est pas tranchée.
function ImpactBadge({ month, categoryId, amountCents }: { month: string; categoryId: string; amountCents: number }) {
  const impact = useQuery<ForecastImpactResponse>({
    queryKey: ['impact', month, categoryId, amountCents],
    queryFn: () => previewForecastImpact(month, categoryId, amountCents),
    staleTime: 60_000,
  })
  if (impact.isLoading) {
    return <p className="mt-2 text-xs text-muted-foreground">Calcul de l'impact…</p>
  }
  if (!impact.data) return null
  const d = impact.data
  const delta = d.runwayDeltaMonths
  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-md border bg-background/60 p-2.5 text-xs">
      <div className="font-medium text-muted-foreground">Impact sur la trésorerie</div>
      <div
        className={cn(
          'flex items-center gap-1.5 font-medium',
          d.crossesThreshold ? 'text-destructive' : 'text-positive',
        )}
      >
        {d.crossesThreshold ? <TriangleAlert className="size-3.5" /> : <CircleCheck className="size-3.5" />}
        {d.crossesThreshold
          ? `Point bas sous le seuil le ${formatDateShort(d.lowPointAfterDate)}`
          : 'Reste au-dessus du seuil de sécurité'}
      </div>
      {delta !== null && delta !== 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Marge d'autonomie</span>
          <span className={cn('tabular font-semibold', delta >= 0 ? 'text-positive' : 'text-destructive')}>
            {formatMonthsDelta(delta)}
          </span>
        </div>
      )}
    </div>
  )
}

export function ProposalCard({ proposal }: { proposal: AgentProposal }) {
  const queryClient = useQueryClient()
  const state = useAppState()
  const [status, setStatus] = useState(proposal.status)
  const [payload, setPayload] = useState(proposal.payload)
  const [editing, setEditing] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [amountEuros, setAmountEuros] = useState(String(Math.round(Math.abs(proposal.payload.amountCents ?? 0) / 100)))
  const [copied, setCopied] = useState(false)

  const resolve = useMutation({
    mutationFn: ({ action, amendments }: { action: 'confirm' | 'reject'; amendments?: Record<string, unknown> }) =>
      sendJson<AgentProposal>(`/api/proposals/${proposal.id}/${action}`, 'POST', { amendments }),
    onSuccess: (fresh) => {
      setStatus(fresh.status)
      setPayload(fresh.payload) // le montant éventuellement amendé fait foi
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['forecast'] })
      queryClient.invalidateQueries({ queryKey: ['projection'] })
      queryClient.invalidateQueries({ queryKey: ['state'] })
      queryClient.invalidateQueries({ queryKey: ['proposals'] }) // compteur « en attente »
    },
  })

  const categoryLabel =
    state.data?.categories.find((c) => c.id === payload.categoryId)?.label ?? payload.categoryId

  // Catégorie fiscale pilotée par le moteur (miroir de autoManagedCategoryIds côté
  // serveur) : l'écriture validée est un AJUSTEMENT par-dessus le montant auto-calculé.
  const fiscal = state.data?.company?.fiscal
  const autoIds = new Set<string>()
  if (fiscal?.tva?.autoCompute === true) autoIds.add(fiscal.tva.categoryId ?? 'dec_tva')
  if (fiscal?.tns?.autoCompute === true && fiscal.tns.provisionCategoryId) autoIds.add(fiscal.tns.provisionCategoryId)
  if (fiscal?.is?.autoDecaissement === true) autoIds.add(fiscal.is.categoryId ?? 'dec_is')
  const isAutoCat = payload.categoryId ? autoIds.has(payload.categoryId) : false

  // ----------------------------------------------------------- relance (brouillon)
  if (proposal.kind === 'invoice_reminder') {
    return (
      <div className="mt-2 rounded-lg border bg-muted/40 p-3">
        <div className="text-xs font-medium">Brouillon de relance</div>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
          {payload.draft}
        </pre>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            navigator.clipboard.writeText(payload.draft ?? '')
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copié' : 'Copier le mail'}
        </Button>
      </div>
    )
  }

  const confirmed = status === 'confirmed'
  const rejected = status === 'rejected'

  // ----------------------------------------------------------- recalage de charge
  // Émis par le job recalage-charges : réécrit le montant mensuel d'une catégorie de
  // sortie sur une plage de mois futurs (médiane 6 mois du réalisé). Amendable : le
  // montant mensuel uniquement.
  if (proposal.kind === 'forecast_recalage') {
    return (
      <div className={cn('mt-2 rounded-lg border p-3', confirmed ? 'border-positive/40 bg-positive/5' : 'bg-muted/40')}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">
            {confirmed ? 'Prévisionnel recalé' : rejected ? 'Recalage refusé' : 'Recalage de charge proposé'}
          </span>
          {confirmed && <Check className="size-4 text-positive" />}
        </div>
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Catégorie</span>
            <span className="font-medium">{categoryLabel}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Période</span>
            <span className="font-medium">
              {payload.fromMonth ? formatMonth(payload.fromMonth) : '-'} - {payload.toMonth ? formatMonth(payload.toMonth) : '-'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Montant mensuel</span>
            {editing ? (
              <Input
                value={amountEuros}
                onChange={(e) => setAmountEuros(e.target.value)}
                className="tabular h-6 w-28 text-right text-xs"
                inputMode="numeric"
                autoFocus
              />
            ) : (
              <span className="tabular font-semibold">-{formatCents(Math.abs(payload.monthlyCents ?? 0))}</span>
            )}
          </div>
          {payload.label && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{payload.label}</p>}
        </div>
        {!confirmed && !rejected && (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={resolve.isPending}
              onClick={() => {
                let amendments: Record<string, unknown> | undefined
                if (editing) {
                  const euros = Number(amountEuros.replace(/\s/g, '').replace(',', '.'))
                  if (Number.isNaN(euros) || euros < 0) {
                    setEditError('Montant invalide : saisissez un nombre positif (ou 0 pour retirer la charge).')
                    return
                  }
                  amendments = { monthlyCents: -Math.round(euros * 100) }
                }
                setEditError(null)
                resolve.mutate({ action: 'confirm', amendments })
              }}
            >
              <Check className="size-3.5" />
              Valider
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAmountEuros(String(Math.round(Math.abs(payload.monthlyCents ?? 0) / 100)))
                setEditing((e) => !e)
              }}
            >
              <Pencil className="size-3.5" />
              {editing ? 'Annuler la modification' : 'Modifier'}
            </Button>
            <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'reject' })}>
              <X className="size-3.5" />
              Refuser
            </Button>
          </div>
        )}
        {editError && <p className="mt-2 text-xs text-destructive">{editError}</p>}
        {resolve.isError && <p className="mt-2 text-xs text-destructive">{resolve.error.message}</p>}
        {confirmed && <p className="mt-2 text-xs text-muted-foreground">Le prévisionnel est recalé sur toute la période.</p>}
      </div>
    )
  }

  // ----------------------------------------------------------- écriture prévisionnelle
  const isIn = (payload.amountCents ?? 0) >= 0

  return (
    <div className={cn('mt-2 rounded-lg border p-3', confirmed ? 'border-positive/40 bg-positive/5' : 'bg-muted/40')}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{confirmed ? 'Écriture créée' : rejected ? 'Proposition refusée' : 'Écriture proposée'}</span>
        {confirmed && <Check className="size-4 text-positive" />}
      </div>
      <div className="mt-2 flex flex-col gap-1 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Libellé</span>
          <span className="text-right font-medium">{payload.label}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Catégorie</span>
          <span className="font-medium">{categoryLabel}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Mois d'impact</span>
          <span className="font-medium">{payload.month ? formatMonth(payload.month) : '-'}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Montant</span>
          {editing ? (
            <Input
              value={amountEuros}
              onChange={(e) => setAmountEuros(e.target.value)}
              className="tabular h-6 w-28 text-right text-xs"
              inputMode="numeric"
              autoFocus
            />
          ) : (
            <span className={cn('tabular font-semibold', isIn ? 'text-positive' : 'text-foreground')}>
              {isIn ? '+' : '-'}
              {formatCents(Math.abs(payload.amountCents ?? 0))}
            </span>
          )}
        </div>
      </div>
      {!confirmed && !rejected && !editing && payload.month && payload.categoryId && payload.amountCents !== undefined && (
        <ImpactBadge month={payload.month} categoryId={payload.categoryId} amountCents={payload.amountCents} />
      )}
      {!confirmed && !rejected && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={resolve.isPending}
            onClick={() => {
              let amendments: Record<string, unknown> | undefined
              if (editing) {
                const euros = Number(amountEuros.replace(/\s/g, '').replace(',', '.'))
                if (Number.isNaN(euros) || euros <= 0) {
                  setEditError('Montant invalide : saisissez un nombre positif.')
                  return
                }
                amendments = { amountCents: (isIn ? 1 : -1) * Math.round(euros * 100) }
              }
              setEditError(null)
              resolve.mutate({ action: 'confirm', amendments })
            }}
          >
            <Check className="size-3.5" />
            Valider
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((e) => !e)}>
            <Pencil className="size-3.5" />
            {editing ? 'Annuler la modification' : 'Modifier'}
          </Button>
          <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'reject' })}>
            <X className="size-3.5" />
            Refuser
          </Button>
        </div>
      )}
      {editError && <p className="mt-2 text-xs text-destructive">{editError}</p>}
      {resolve.isError && <p className="mt-2 text-xs text-destructive">{resolve.error.message}</p>}
      {confirmed && (
        <p className="mt-2 text-xs text-muted-foreground">
          {payload.month ? `Appliquée sur ${formatMonth(payload.month)}` : 'Appliquée'}
          {isAutoCat ? ', en ajustement par-dessus le montant auto-calculé (TVA/URSSAF/IS)' : ''} - la courbe et le
          prévisionnel sont à jour.
        </p>
      )}
    </div>
  )
}
