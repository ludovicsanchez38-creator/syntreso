import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatCents } from '@/lib/money'
import { formatMonth } from '@/lib/dates'
import type { Scenario } from '@/lib/api'

interface LeverCardProps {
  scenario: Scenario
  onToggle: (active: boolean) => void
  onParamChange: (key: string, value: string | number) => void
}

/** Liste des mois entre deux bornes 'YYYY-MM' incluses. */
function monthSpan(min: string, max: string): string[] {
  const out: string[] = []
  let [y, m] = min.split('-').map(Number)
  const [maxY, maxM] = max.split('-').map(Number)
  while (y < maxY || (y === maxY && m <= maxM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

export function LeverCard({ scenario, onToggle, onParamChange }: LeverCardProps) {
  return (
    <Card className={cn('transition-opacity', !scenario.active && 'opacity-60')}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">{scenario.label}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{scenario.description}</p>
        </div>
        <Switch checked={scenario.active} onCheckedChange={onToggle} aria-label={`Activer ${scenario.label}`} />
      </CardHeader>
      {scenario.active && (
        <CardContent className="flex flex-col gap-4">
          {scenario.sliders.map((slider) => {
            const value = scenario.params[slider.key]
            if (slider.type === 'toggle') {
              return (
                <div key={slider.key} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{slider.label}</span>
                  <div className="flex gap-1">
                    {slider.options?.map((opt) => (
                      <Button
                        key={opt}
                        size="sm"
                        variant={value === opt ? 'default' : 'outline'}
                        onClick={() => onParamChange(slider.key, opt)}
                      >
                        {opt === 'cash' ? 'Comptant' : 'Leasing 36 mois'}
                      </Button>
                    ))}
                  </div>
                </div>
              )
            }
            if (slider.type === 'month') {
              const months = monthSpan(String(slider.min), String(slider.max))
              const idx = Math.max(0, months.indexOf(String(value)))
              return (
                <div key={slider.key}>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{slider.label}</span>
                    <span className="font-medium">{formatMonth(months[idx])}</span>
                  </div>
                  <Slider
                    value={[idx]}
                    min={0}
                    max={months.length - 1}
                    step={1}
                    onValueChange={([v]) => onParamChange(slider.key, months[v])}
                  />
                </div>
              )
            }
            // amount / days
            const numValue = Number(value)
            return (
              <div key={slider.key}>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{slider.label}</span>
                  <span className="tabular font-medium">
                    {slider.type === 'amount' ? formatCents(numValue) : `${numValue} jours`}
                  </span>
                </div>
                <Slider
                  value={[numValue]}
                  min={Number(slider.min)}
                  max={Number(slider.max)}
                  step={slider.step ?? 1}
                  onValueChange={([v]) => onParamChange(slider.key, v)}
                />
              </div>
            )
          })}
        </CardContent>
      )}
    </Card>
  )
}
