import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { SeriesPoint } from '@/lib/api'
import { formatCents, formatCentsCompact } from '@/lib/money'
import { formatDateShort, formatDate } from '@/lib/dates'

interface BalanceChartProps {
  series: SeriesPoint[]
  /** série du scénario actif (pointillés ambre), optionnelle */
  scenarioSeries?: SeriesPoint[]
  today: string
  thresholdCents: number
  /** point bas projeté (pour la pastille de danger). Optionnel. */
  lowPoint?: { date: string; cents: number }
  height?: number
}

interface TooltipPayloadEntry {
  dataKey: string
  value: number | null
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadEntry[]; label?: string }) {
  if (!active || !payload?.length || !label) return null
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined)
  if (!rows.length) return null
  const LABELS: Record<string, string> = {
    actualCents: 'Réalisé',
    projectedCents: 'Projeté',
    scenarioCents: 'Scénario',
  }
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium">{formatDate(label)}</div>
      {rows.map((r) => (
        <div key={r.dataKey} className="tabular mt-0.5 flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{LABELS[r.dataKey] ?? r.dataKey}</span>
          <span className="font-medium">{formatCents(r.value as number)}</span>
        </div>
      ))}
    </div>
  )
}

export function BalanceChart({ series, scenarioSeries, today, thresholdCents, lowPoint, height = 320 }: BalanceChartProps) {
  // fusion base + scénario sur l'axe des dates (le scénario ne diverge que dans le futur)
  const scenarioByDate = new Map(scenarioSeries?.map((p) => [p.date, p.projectedCents]) ?? [])
  // Segment de DANGER : la part de la courbe projetée qui passe sous le seuil de
  // sécurité, dessinée en rouge par-dessus. On garde le dernier point AU-DESSUS du
  // seuil (point de bascule) pour que le segment rouge se raccorde proprement à la
  // courbe normale, sans trou visuel.
  const projected = series.map((p) => p.projectedCents)
  const data = series.map((p, i) => {
    const cur = p.projectedCents
    const prev = i > 0 ? projected[i - 1] : null
    let dangerCents: number | null = null
    if (cur !== null && cur <= thresholdCents) dangerCents = cur
    // point de jointure : ce point est au-dessus du seuil mais le suivant plonge dessous
    else if (cur !== null && prev !== null && prev <= thresholdCents) dangerCents = cur
    return {
      ...p,
      scenarioCents: scenarioSeries ? (scenarioByDate.get(p.date) ?? null) : null,
      dangerCents,
    }
  })

  // Borne basse de la zone de danger : sans y1, Recharts étire la zone jusqu'en haut
  // du graphique et tout le fond passe en rouge (cas déjà rencontré).
  const dangerFloorCents = Math.min(
    0,
    ...data.flatMap((p) => [p.actualCents, p.projectedCents, p.scenarioCents]).filter((v): v is number => v !== null),
  )

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={formatDateShort}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          minTickGap={48}
          axisLine={{ stroke: 'var(--border)' }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => formatCentsCompact(v)}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          width={64}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<ChartTooltip />} />
        {/* Zone de danger : tout ce qui passe SOUS le seuil de sécurité, en rouge
            translucide. ifOverflow="hidden" pour ne pas déborder hors du domaine. */}
        <ReferenceArea
          y1={dangerFloorCents}
          y2={thresholdCents}
          fill="var(--destructive)"
          fillOpacity={0.07}
          ifOverflow="hidden"
        />
        <ReferenceLine
          y={thresholdCents}
          stroke="var(--destructive)"
          strokeDasharray="4 4"
          strokeOpacity={0.9}
          label={{ value: 'Seuil de sécurité', position: 'insideBottomLeft', fontSize: 10, fill: 'var(--destructive)' }}
        />
        <ReferenceLine
          x={today}
          stroke="var(--muted-foreground)"
          strokeDasharray="2 3"
          label={{ value: "Aujourd'hui", position: 'insideTopRight', fontSize: 10, fill: 'var(--muted-foreground)' }}
        />
        <Line
          type="monotone"
          dataKey="actualCents"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="projectedCents"
          stroke="var(--chart-1)"
          strokeWidth={2}
          strokeDasharray="6 4"
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        {/* Segment de courbe projetée passant sous le seuil : rouge par-dessus. */}
        <Line
          type="monotone"
          dataKey="dangerCents"
          stroke="var(--destructive)"
          strokeWidth={2.5}
          strokeDasharray="6 4"
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        {scenarioSeries && (
          <Line
            type="monotone"
            dataKey="scenarioCents"
            stroke="var(--chart-4)"
            strokeWidth={2}
            strokeDasharray="3 3"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        )}
        {/* Pastille sur le point bas projeté, avec montant + date. Rouge si sous le
            seuil de sécurité, neutre sinon. */}
        {lowPoint && (
          <ReferenceDot
            x={lowPoint.date}
            y={lowPoint.cents}
            r={4}
            fill={lowPoint.cents < thresholdCents ? 'var(--destructive)' : 'var(--chart-1)'}
            stroke="var(--background)"
            strokeWidth={2}
            ifOverflow="extendDomain"
            label={{
              value: `Point bas ${formatCents(lowPoint.cents)} - ${formatDateShort(lowPoint.date)}`,
              position: 'top',
              fontSize: 10,
              fill: lowPoint.cents < thresholdCents ? 'var(--destructive)' : 'var(--muted-foreground)',
            }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
