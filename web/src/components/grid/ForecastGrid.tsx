import { useEffect, useRef } from 'react'
import type { ForecastGridResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatMonthShort } from '@/lib/dates'
import { formatCentsPlain } from '@/lib/money'
import { ForecastCell } from './ForecastCell'
import { MonthDetailPopover } from './MonthDetailPopover'

interface ForecastGridProps {
  grid: ForecastGridResponse
  thresholdCents: number
  onCellEdit: (month: string, categoryId: string, direction: 'in' | 'out', absEuros: number) => void
}

export function ForecastGrid({ grid, thresholdCents, onCellEdit }: ForecastGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // au montage : scroller pour amener le mois courant au centre
  useEffect(() => {
    const container = scrollRef.current
    const target = container?.querySelector<HTMLElement>('[data-current-month]')
    if (container && target) {
      container.scrollLeft = target.offsetLeft - container.clientWidth / 2
    }
  }, [grid.currentMonth])

  const inRows = grid.rows.filter((r) => r.direction === 'in')
  const outRows = grid.rows.filter((r) => r.direction === 'out')

  const totalsByMonth = (direction: 'in' | 'out') =>
    grid.months.map((ym) => {
      const rows = direction === 'in' ? inRows : outRows
      return rows.reduce((s, r) => s + (r.cells.find((c) => c.month === ym)?.retainedCents || 0), 0)
    })
  const totalsIn = totalsByMonth('in')
  const totalsOut = totalsByMonth('out')

  const headCell = (ym: string) => (
    <th
      key={ym}
      data-current-month={ym === grid.currentMonth ? '' : undefined}
      className={cn(
        'min-w-24 border-b px-1.5 pb-2 text-right text-[11px] font-medium',
        ym === grid.currentMonth ? 'text-primary' : ym > grid.currentMonth ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {formatMonthShort(ym)}
      {ym === grid.currentMonth && <div className="text-[9px] font-normal">en cours</div>}
      {ym > grid.currentMonth && <div className="text-[9px] font-normal">prévu</div>}
    </th>
  )

  const sectionRow = (label: string, totals: number[], tone: 'in' | 'out', rows: typeof grid.rows) => (
    <tr className="bg-muted/40">
      <td className="sticky left-0 z-10 border-b bg-muted px-3 py-1.5 text-xs font-semibold">{label}</td>
      {grid.months.map((ym, i) => (
        <td
          key={ym}
          className={cn(
            'tabular border-b px-1.5 py-1.5 text-right text-xs font-semibold',
            tone === 'in' ? 'text-positive' : 'text-foreground',
            ym === grid.currentMonth && 'bg-primary/5',
          )}
        >
          <MonthDetailPopover month={ym} currentMonth={grid.currentMonth} title={label} rows={rows} totalCents={totals[i]}>
            {formatCentsPlain(totals[i])}
          </MonthDetailPopover>
        </td>
      ))}
    </tr>
  )

  const categoryRows = (rows: typeof grid.rows) =>
    rows.map((row) => (
      <tr key={row.categoryId} className="group">
        <td title={row.label} className="sticky left-0 z-10 max-w-40 truncate border-b bg-card px-3 py-0.5 text-xs text-muted-foreground group-hover:text-foreground sm:max-w-56">
          {row.label}
        </td>
        {row.cells.map((cell) => {
          const isPast = cell.month < grid.currentMonth
          const display = isPast ? cell.actualCents : cell.month === grid.currentMonth ? cell.retainedCents : cell.forecastCents
          const kind = display === null || display === 0 ? 'empty' : isPast ? 'actual' : cell.month === grid.currentMonth ? 'actual' : 'forecast'
          return (
            <td key={cell.month} className={cn('border-b px-0.5 py-0.5', cell.month === grid.currentMonth && 'bg-primary/5')}>
              <ForecastCell
                displayCents={display}
                kind={kind}
                editable={cell.editable}
                note={cell.note}
                onCommit={(absEuros) => onCellEdit(cell.month, row.categoryId, row.direction, absEuros)}
              />
            </td>
          )
        })}
      </tr>
    ))

  return (
    <div ref={scrollRef} className="overflow-x-auto rounded-lg border">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 min-w-40 border-b bg-card sm:min-w-56 px-3 pb-2 text-left text-[11px] font-medium text-muted-foreground">
              Catégorie
            </th>
            {grid.months.map(headCell)}
          </tr>
        </thead>
        <tbody>
          {sectionRow('Encaissements', totalsIn, 'in', inRows)}
          {categoryRows(inRows)}
          {sectionRow('Décaissements', totalsOut, 'out', outRows)}
          {categoryRows(outRows)}
          <tr>
            <td className="sticky left-0 z-10 bg-card px-3 py-2 text-xs font-semibold">Solde fin de mois</td>
            {grid.closings.map((c) => (
              <td
                key={c.month}
                className={cn(
                  'tabular px-1.5 py-2 text-right text-xs font-semibold',
                  c.month === grid.currentMonth && 'bg-primary/5',
                  c.projected && 'text-muted-foreground',
                  c.closingCents < thresholdCents && 'text-destructive',
                )}
              >
                {(c.closingCents < 0 ? '-' : '') + formatCentsPlain(c.closingCents)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
