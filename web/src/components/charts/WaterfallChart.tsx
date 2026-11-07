import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { MonthlyRow } from '@/lib/api'
import { formatCents, formatCentsCompact } from '@/lib/money'

interface WaterfallChartProps {
  month: MonthlyRow
  height?: number
}

// Waterfall en Recharts : barre socle invisible + barre valeur empilée.
// Le solde de clôture vient du moteur (month.closingCents), jamais recalculé au front.
export function WaterfallChart({ month, height = 240 }: WaterfallChartProps) {
  const closing = month.closingCents
  const data = [
    { name: 'Ouverture', base: 0, value: month.openingCents, color: 'var(--chart-3)' },
    { name: 'Entrées', base: month.openingCents, value: month.inCents, color: 'var(--chart-2)' },
    { name: 'Sorties', base: closing, value: -month.outCents, color: 'var(--chart-3)' },
    { name: 'Clôture', base: 0, value: closing, color: 'var(--chart-1)' },
  ]

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 24, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis
          tickFormatter={(v: number) => formatCentsCompact(v)}
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          width={64}
          axisLine={false}
          tickLine={false}
        />
        <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="value" stackId="wf" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
          <LabelList
            dataKey="value"
            position="top"
            formatter={(v) => formatCents(v as number)}
            className="tabular"
            fontSize={11}
            fill="var(--foreground)"
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
