import { NavLink, Route, Routes } from 'react-router-dom'
import { LayoutDashboard, Table2, GitCompareArrows, Receipt, Scale } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { ThemeToggle } from '@/components/ThemeToggle'
import { cn } from '@/lib/utils'
import { AgentProvider } from '@/components/agent/AgentContext'
import { AgentPanel } from '@/components/agent/AgentPanel'
import { AgentFab } from '@/components/agent/AgentFab'
import { AgentCommandBar } from '@/components/agent/AgentCommandBar'
import { useAppState } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import DashboardPage from '@/pages/DashboardPage'
import ForecastPage from '@/pages/ForecastPage'
import DeciderPage from '@/pages/DeciderPage'
import RentabilitePage from '@/pages/RentabilitePage'
import ScenariosPage from '@/pages/ScenariosPage'

function SyntresoMark() {
  return (
    <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" className="fill-primary" />
      <path
        d="M6 21 C 10 21, 11 12, 16 12 S 22 18, 26 10"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="26" cy="10" r="2" fill="white" />
    </svg>
  )
}

const NAV = [
  { to: '/', label: 'Tableau de bord', icon: LayoutDashboard, end: true },
  { to: '/decider', label: 'Décider', icon: Scale, end: false },
  { to: '/previsionnel', label: 'Prévisionnel', icon: Table2, end: false },
  { to: '/rentabilite', label: 'Rentabilité', icon: Receipt, end: false },
  { to: '/scenarios', label: 'Scénarios', icon: GitCompareArrows, end: false },
]

// Identité de l'entreprise pilotée, lue depuis /api/state (jamais codée en dur :
// le même build sert la démo Maçonnerie des Trois Collines et les vraies données de l'entreprise).
function SidebarCompany() {
  const state = useAppState()
  const company = state.data?.company
  return (
    <div className="px-2 pt-2 text-[11px] leading-relaxed text-muted-foreground">
      {company ? company.name : '...'}
      <br />
      {company?.demoToday
        ? 'Démonstration - données fictives'
        : company?.dataAsOf
          ? `Données réelles - compta au ${formatDate(company.dataAsOf)}`
          : company
            ? 'Aucun import Indy pour le moment'
            : '...'}
      <br />
      <a href="/deconnexion" className="underline-offset-2 hover:text-foreground hover:underline">
        Se déconnecter
      </a>
    </div>
  )
}

function Layout() {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex items-center gap-2.5 px-4 py-5">
          <SyntresoMark />
          <div>
            <div className="font-heading text-base font-semibold leading-none tracking-tight">Syntréso</div>
            <div className="mt-1 text-[11px] text-muted-foreground">Pilotage de trésorerie</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1 px-2 pb-3">
          <ThemeToggle />
          <SidebarCompany />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barre de navigation mobile (sidebar masquée sous lg) */}
        <header className="flex items-center gap-2 border-b bg-sidebar px-3 py-2 lg:hidden">
          <SyntresoMark />
          <span className="font-heading text-sm font-semibold tracking-tight">Syntréso</span>
          <nav className="ml-auto flex items-center gap-1 overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={label}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs transition-colors',
                    isActive ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="min-w-0 flex-1 pb-24">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/decider" element={<DeciderPage />} />
            <Route path="/previsionnel" element={<ForecastPage />} />
            <Route path="/rentabilite" element={<RentabilitePage />} />
            <Route path="/scenarios" element={<ScenariosPage />} />
          </Routes>
        </main>
      </div>
      <AgentPanel />
      <AgentFab />
      <AgentCommandBar />
      <Toaster richColors position="bottom-right" />
    </div>
  )
}

export default function App() {
  return (
    <AgentProvider>
      <Layout />
    </AgentProvider>
  )
}
