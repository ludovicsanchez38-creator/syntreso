import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatCentsPlain } from '@/lib/money'

interface ForecastCellProps {
  /** valeur affichée en centimes, déjà en valeur absolue pour les décaissements */
  displayCents: number | null
  /** la cellule est-elle un réalisé (plein) ou un prévu (atténué) */
  kind: 'actual' | 'forecast' | 'empty'
  editable: boolean
  note?: string | null
  onCommit: (absEuros: number) => void
  /** déplacement clavier : Tab / Shift+Tab gérés par le navigateur, Enter commit */
}

export function ForecastCell({ displayCents, kind, editable, note, onCommit }: ForecastCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const startEdit = () => {
    if (!editable) return
    setDraft(displayCents !== null ? String(Math.round(Math.abs(displayCents) / 100)) : '')
    setInvalid(false)
    setEditing(true)
  }

  /** fromKey : sur Entrée, une saisie invalide garde la cellule ouverte avec un signal visuel */
  const commit = (fromKey: boolean) => {
    const value = Number(draft.replace(/\s/g, '').replace(',', '.'))
    if (Number.isNaN(value) || value < 0) {
      if (fromKey) {
        setInvalid(true)
        return
      }
      setEditing(false)
      return
    }
    setEditing(false)
    const current = displayCents !== null ? Math.round(Math.abs(displayCents) / 100) : null
    if (value === current) return
    onCommit(value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        aria-invalid={invalid}
        className={cn(
          'tabular h-7 w-full rounded-sm border bg-background px-1.5 text-right text-xs outline-none',
          invalid ? 'border-destructive ring-1 ring-destructive/40' : 'border-primary',
        )}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setInvalid(false)
        }}
        onBlur={() => commit(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(true)
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  return (
    <button
      type="button"
      tabIndex={editable ? 0 : -1}
      onClick={startEdit}
      onFocus={(e) => {
        // navigation Tab : entrer en édition au focus clavier uniquement
        if (e.target.matches(':focus-visible')) startEdit()
      }}
      title={note ?? undefined}
      className={cn(
        'tabular block h-7 w-full rounded-sm px-1.5 text-right text-xs leading-7',
        kind === 'actual' && 'font-medium text-foreground',
        kind === 'forecast' && 'text-muted-foreground',
        kind === 'empty' && 'text-muted-foreground/40',
        editable && 'cursor-text hover:bg-primary/5 hover:ring-1 hover:ring-primary/30',
        !editable && 'cursor-default',
        note && 'underline decoration-dotted decoration-muted-foreground/50 underline-offset-2',
      )}
    >
      {displayCents !== null ? formatCentsPlain(displayCents) : '-'}
    </button>
  )
}
