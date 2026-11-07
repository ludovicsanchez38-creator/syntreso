import { useRef, useState, type ReactNode } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import type { ForecastDetailLine, ForecastRow } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatMonth } from '@/lib/dates'
import { formatCentsPlain } from '@/lib/money'

// Détail d'un mois au survol (ordinateur) ou à l'appui (téléphone) : lignes nommées du
// prévisionnel et mouvements bancaires réels derrière chaque montant.
// Pour chaque catégorie du mois : les mouvements bancaires réels (mois passés et en cours)
// et les lignes nommées du prévisionnel (mois en cours et à venir), avec leur statut.

const STATUS_LABEL: Record<ForecastDetailLine['status'], string> = {
  recu: 'reçu',
  facture: 'facturé',
  signe: 'signé',
  pipe: 'pipe',
  hypothese: 'hypothèse',
}

const STATUS_CLASS: Record<ForecastDetailLine['status'], string> = {
  recu: 'bg-positive/15 text-positive',
  facture: 'bg-primary/15 text-primary',
  signe: 'bg-primary/10 text-primary',
  pipe: 'bg-warning/15 text-warning',
  hypothese: 'bg-muted text-muted-foreground',
}

function money(cents: number) {
  return (cents < 0 ? '-' : '') + formatCentsPlain(Math.abs(cents)) + ' €'
}

/** espaces insécables dans les nombres et devant €, pour qu'un montant ne se coupe pas */
function nb(text: string) {
  return text.replace(/(\d) (?=\d{3}\b)/g, '$1\u00a0').replace(/ (€|%)/g, '\u00a0$1')
}

function shortDate(iso: string) {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

interface MonthDetailPopoverProps {
  month: string
  currentMonth: string
  title: string
  rows: ForecastRow[]
  totalCents: number
  children: ReactNode
}

export function MonthDetailPopover({ month, currentMonth, title, rows, totalCents, children }: MonthDetailPopoverProps) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const isFuture = month > currentMonth
  const isPast = month < currentMonth

  const cancelClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 150)
  }

  const lines = rows
    .map((row) => ({ row, cell: row.cells.find((c) => c.month === month) }))
    .filter(({ cell }) => cell && (cell.retainedCents !== 0 || (cell.actualDetails && cell.actualDetails.length)))

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="w-full cursor-help text-right underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
        >
          {children}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 max-h-[70vh] w-[min(26rem,calc(100vw-24px))] overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="mb-2 flex items-baseline justify-between gap-3 border-b pb-2">
            <div className="text-xs font-semibold">
              {title} · {formatMonth(month)}
              <span className="ml-1 font-normal text-muted-foreground">{isPast ? '(réalisé)' : isFuture ? '(prévu)' : '(en cours)'}</span>
            </div>
            <div className="tabular text-xs font-semibold">{money(totalCents)}</div>
          </div>
          {lines.length === 0 && <p className="text-xs text-muted-foreground">Rien ce mois-ci.</p>}
          <div className="space-y-3">
            {lines.map(({ row, cell }) => {
              if (!cell) return null
              const allDetails = !isPast ? cell.details || [] : []
              // mois en cours : ce qui est déjà reçu apparaît une seule fois, dans « Déjà reçu »
              const details = !isFuture ? allDetails.filter((d) => d.status !== 'recu') : allDetails
              const actual = !isFuture ? cell.actualDetails || [] : []
              const forecast = cell.forecastCents ?? 0
              const detailSum = allDetails.reduce((s, d) => s + d.amountCents, 0)
              const rest = allDetails.length ? Math.abs(forecast) - detailSum : 0
              return (
                <div key={row.categoryId}>
                  <div className="flex items-baseline justify-between gap-3 text-xs font-medium">
                    <span>{row.label}</span>
                    <span className="tabular">{money(Math.abs(cell.retainedCents))}</span>
                  </div>
                  {actual.length > 0 && !isPast && <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Déjà reçu</div>}
                  {actual.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {actual.slice(0, 10).map((a, i) => (
                        <li key={`a${i}`} className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
                          <span className="min-w-0 truncate">
                            <span className="tabular mr-1.5">{shortDate(a.date)}</span>
                            {nb(a.label)}
                          </span>
                          <span className="tabular shrink-0 text-foreground">{money(Math.abs(a.amountCents))}</span>
                        </li>
                      ))}
                      {actual.length > 10 && <li className="text-[11px] text-muted-foreground">et {actual.length - 10} autres mouvements</li>}
                    </ul>
                  )}
                  {details.length > 0 && !isFuture && actual.length > 0 && (
                    <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Attendu</div>
                  )}
                  {(details.length > 0 || rest !== 0) && (
                    <ul className="mt-1 space-y-1">
                      {details.map((d, i) => (
                        <li key={`d${i}`} className="flex items-start justify-between gap-3 text-[11px]">
                          <span className="min-w-0">
                            <span className={cn('mr-1.5 inline-block rounded px-1 py-px text-[10px] font-medium', STATUS_CLASS[d.status])}>
                              {STATUS_LABEL[d.status]}
                            </span>
                            {nb(d.label)}
                          </span>
                          <span className="tabular shrink-0">{money(d.amountCents)}</span>
                        </li>
                      ))}
                      {rest > 0 && (
                        <li className="flex items-start justify-between gap-3 text-[11px] text-muted-foreground">
                          <span>
                            <span className={cn('mr-1.5 inline-block rounded px-1 py-px text-[10px] font-medium', STATUS_CLASS.hypothese)}>hypothèse</span>
                            Reste de ton montant, pas encore signé
                          </span>
                          <span className="tabular shrink-0">{money(rest)}</span>
                        </li>
                      )}
                      {rest < 0 && (
                        <li className="text-[11px] text-warning">
                          Le détail dépasse ton montant de {money(-rest)}.
                        </li>
                      )}
                    </ul>
                  )}
                  {!isPast && details.length === 0 && actual.length === 0 && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{cell.note ? cell.note : 'Montant saisi, sans détail.'}</p>
                  )}
                </div>
              )
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
