import { AlertTriangle, CircleCheck, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateShort } from '@/lib/dates'
import type { DataFreshness, FreshnessLevel } from '@/lib/api'

// Libellés lisibles par source de données. Toute source inconnue retombe sur sa clé brute.
const SOURCE_LABELS: Record<string, string> = {
  indy: 'Compta (Indy)',
  twenty: 'Pipe commercial (Twenty)',
}

function sourceLabel(key: string): string {
  return SOURCE_LABELS[key] ?? key
}

// Couleur du pictogramme par niveau. Le bandeau lui-même reste sobre : seules les
// sources en alerte (warn/stale) tirent l'œil (ambre / rouge), conformément à la
// règle « rouge = vraies alertes ».
const LEVEL_CLASS: Record<FreshnessLevel, string> = {
  fresh: 'text-positive',
  warn: 'text-warning',
  stale: 'text-destructive',
  unknown: 'text-muted-foreground',
}

function LevelIcon({ level }: { level: FreshnessLevel }) {
  if (level === 'stale' || level === 'warn') return <AlertTriangle className={cn('size-3', LEVEL_CLASS[level])} />
  if (level === 'unknown') return <Clock className={cn('size-3', LEVEL_CLASS[level])} />
  return <CircleCheck className={cn('size-3', LEVEL_CLASS[level])} />
}

/**
 * Bandeau « données au JJ/MM par source ». Les niveaux (orange > 10 j, rouge > 30 j)
 * sont calculés SERVEUR contre demoToday (cf. dataFreshness dans projection.js) :
 * le front ne fait qu'afficher.
 */
export function DataFreshnessBanner({ freshness }: { freshness: DataFreshness }) {
  const entries = Object.entries(freshness)
  if (!entries.length) return null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {entries.map(([source, info]) => {
        const label = sourceLabel(source)
        let text: string
        if (info.level === 'unknown' || !info.date) {
          text = `${label} : date d'import inconnue`
        } else if (info.daysOld !== null && info.daysOld <= 0) {
          text = `${label} : à jour`
        } else {
          const age = info.daysOld === 1 ? '1 jour' : `${info.daysOld} jours`
          text = `${label} : au ${formatDateShort(info.date)} (${age})`
        }
        return (
          <span
            key={source}
            className={cn('inline-flex items-center gap-1', (info.level === 'warn' || info.level === 'stale') && 'font-medium', LEVEL_CLASS[info.level])}
          >
            <LevelIcon level={info.level} />
            <span className={info.level === 'fresh' || info.level === 'unknown' ? 'text-muted-foreground' : undefined}>{text}</span>
          </span>
        )
      })}
    </div>
  )
}
