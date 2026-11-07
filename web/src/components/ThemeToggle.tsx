import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

// Bascule clair/sombre par classe .dark sur <html> (tokens shadcn).
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={dark ? 'Passer en mode clair' : 'Passer en mode sombre'}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {dark ? 'Mode clair' : 'Mode sombre'}
    </button>
  )
}
