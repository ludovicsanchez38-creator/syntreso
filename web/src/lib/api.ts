import { useQuery } from '@tanstack/react-query'

// ----------------------------------------------------------------- Types
export interface Company {
  name: string
  sector: string
  location: string
  employees: number
  /** « Aujourd'hui » calculé SERVEUR (demoToday en démo, date réelle sinon). */
  today: string
  demoToday?: string
  /** Date de la dernière écriture comptable importée (données réelles). */
  dataAsOf?: string
  lowCashThresholdCents: number
  capitalSocialCents?: number
  importedAt?: Record<string, string>
  seasonality?: { enabled: boolean; monthly: number[] }
  fiscal?: {
    tva?: { autoCompute?: boolean; categoryId?: string }
    tns?: { autoCompute?: boolean; provisionCategoryId?: string }
    is?: { autoDecaissement?: boolean; categoryId?: string }
  }
  provisionsHeld?: { tvaCents?: number; urssafCents?: number; persoCents?: number }
}

export type FreshnessLevel = 'fresh' | 'warn' | 'stale' | 'unknown'

export interface SourceFreshness {
  date: string | null
  daysOld: number | null
  level: FreshnessLevel
}

// Fraîcheur des données par source (indy, twenty, ...) calculée serveur contre company.today.
export type DataFreshness = Record<string, SourceFreshness>

export interface Category {
  id: string
  label: string
  direction: 'in' | 'out'
  order: number
  vatRatePct?: number
  fixed?: boolean
}

export interface Invoice {
  id: string
  clientName: string
  label: string
  amountCents: number
  issueDate: string
  dueDate: string
  status: 'paid' | 'pending' | 'overdue'
  expectedPaymentDate: string | null
}

export interface ResultatPrevisionnel {
  exerciseYear: string
  productsHTCents: number
  chargesHTCents: number
  resultatAvantISCents: number
  isProvisionCents: number
  resultatApresISCents: number
}

export interface Kpis {
  balanceTodayCents: number
  deltaVs30dCents: number
  in30dCents: number
  out30dCents: number
  lowPoint: { date: string; cents: number }
  /** Point bas projeté des 90 prochains jours, aujourd'hui exclu. */
  lowPoint90: { date: string; cents: number } | null
  /** Trésorerie projetée à la clôture de décembre de l'année en cours. */
  yearEndProjected: { month: string; cents: number } | null
  /** Compte courant hors sous-comptes (relevé de la compta) - null si non importé. */
  currentAccountCents: number | null
  tvaDueDate?: string | null
  lowCashThresholdCents: number
  // Solde NET disponible (lot 2 coeur comptable). Noms figés par le contrat + alias FR.
  netAvailableCents: number
  committedCents: number
  vatDueCents: number
  socialProvisionCents: number
  provisionsHeldCents?: number
  persoReserveCents?: number
  resteAProvisionnerCents?: number
  soldeBrutCents: number
  tvaAReverserCents: number
  cotisationsProvisionneesCents: number
  soldeNetDisponibleCents: number
  committedWindowMonths: number
  // Aides à la décision (lot 2 décision). runwayMonths null = pas de descente détectée.
  runwayMonths: number | null
  runwayWorstCaseMonths: number | null
  monthlyBurnNetCents: number
  breakEvenHTCents: number
  /** Compte courant d'associé : solde réel Indy (comptes 455) si importé, sinon rému attribuée non versée. */
  cca: {
    sinceMonth: string | null
    untilMonth: string | null
    accruedCents: number
    projectedEndCents: number
    source: 'indy' | 'calcul'
    asOfDate?: string | null
  } | null
  /** Seuil de sécurité suggéré (1,5 mois de burn réel) - null sans burn détecté. */
  suggestedThresholdCents: number | null
  breakEvenLookbackMonths: number
  resultatPrevisionnel: ResultatPrevisionnel
}

export interface Alert {
  id: string
  kind: 'low_point' | 'overdue_invoice' | 'anomaly' | 'net_below_threshold' | 'reconciliation'
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  amountCents: number
  date?: string
  daysLate?: number
  invoiceId?: string
  committedCents?: number
}

// Contrôle de réconciliation bancaire (lot 2 fiabilité) : solde reconstruit vs relevé.
export interface AccountReconciliation {
  accountId: string
  label?: string
  date?: string
  expectedCents?: number
  reconstructedCents?: number
  deltaCents?: number
  status: 'ok' | 'mismatch' | 'unknown'
}

export interface Reconciliation {
  status: 'ok' | 'mismatch' | 'unknown'
  expectedCents?: number
  reconstructedCents?: number
  deltaCents?: number
  date?: string
  toleranceCents: number
  perAccount: AccountReconciliation[]
}

export interface StateResponse {
  company: Company
  categories: Category[]
  invoices: Invoice[]
  kpis: Kpis
  alerts: Alert[]
  dataFreshness: DataFreshness
  reconciliation: Reconciliation
}

export interface SeriesPoint {
  date: string
  actualCents: number | null
  projectedCents: number | null
}

export interface MonthlyRow {
  month: string
  openingCents: number
  inCents: number
  outCents: number
  closingCents: number
  projected: boolean
}

export interface ProjectionResponse {
  today: string
  balanceTodayCents: number
  // Solde NET disponible et trésorerie engagée (lot 2). Présents quand la fiscalité
  // dérivée est active ; sinon committed = 0 et net = brut.
  netAvailableCents: number
  committedCents: number
  vatDueCents: number
  socialProvisionCents: number
  // Runway (lot 2 décision) : mois de réserve sur le NET, lissé sur le burn.
  runwayMonths: number | null
  runwayWorstCaseMonths: number | null
  monthlyBurnNetCents: number
  series: SeriesPoint[]
  monthly: MonthlyRow[]
  lowPoint: { date: string; cents: number }
  scenario: {
    ids: string[]
    series: SeriesPoint[]
    monthly: MonthlyRow[]
    lowPoint: { date: string; cents: number }
    // Champs « verdict d'impact » du scénario (lot 2 front). Le moteur les produit ;
    // le front ne fait que comparer base vs scénario.
    netAvailableCents: number
    runwayMonths: number | null
    runwayWorstCaseMonths: number | null
  } | null
}

// Réponse du feu vert « puis-je me verser X ? » (POST /api/projection/remuneration-check).
// Le verdict est calculé SERVEUR (jamais par le modèle). Le front n'a qu'à l'afficher.
export interface RemunerationCheckResponse {
  verdict: 'vert' | 'ambre' | 'rouge'
  requestedCents: number
  month: string
  horizonDays: number
  couplingCents: number
  couplingRatePct: number
  totalCostCents: number
  netBeforeCents: number
  netAfterCents: number
  thresholdCents: number
  lowPointNextCents: number
  lowPointNextDate: string
  runwayBeforeMonths: number | null
  runwayAfterMonths: number | null
  criteria: { netOk: boolean; lowOk: boolean; runwayOk: boolean }
}

// Helper d'appel du feu vert (overlay éphémère, ne persiste rien).
export async function checkRemuneration(
  montantCents: number,
  mois?: string,
  horizonJours?: number,
): Promise<RemunerationCheckResponse> {
  return sendJson<RemunerationCheckResponse>('/api/projection/remuneration-check', 'POST', {
    montantCents,
    mois,
    horizonJours,
  })
}

// Feu vert « puis-je me rembourser X du compte courant d'associé ? » (sans cotisations,
// plafonné par le CCA). Même forme de réponse que le contrôle de versement.
export interface CcaCheckResponse extends RemunerationCheckResponse {
  ccaAccruedCents: number
  ccaProjectedEndCents: number
  exceedsCap: boolean
}

export async function checkCcaRepayment(montantCents: number): Promise<CcaCheckResponse> {
  return sendJson<CcaCheckResponse>('/api/projection/cca-check', 'POST', { montantCents })
}

// Aperçu d'impact d'une écriture prévisionnelle (verdict d'impact d'une proposition).
// Le moteur applique un overlay éphémère et renvoie base vs après. Rien n'est écrit.
export interface ForecastImpactResponse {
  month: string
  categoryId: string
  amountCents: number
  thresholdCents: number
  runwayBeforeMonths: number | null
  runwayAfterMonths: number | null
  runwayDeltaMonths: number | null
  lowPointBeforeCents: number
  lowPointAfterCents: number
  lowPointAfterDate: string
  crossesThreshold: boolean
}

export async function previewForecastImpact(
  mois: string,
  categoryId: string,
  montantCents: number,
): Promise<ForecastImpactResponse> {
  return sendJson<ForecastImpactResponse>('/api/projection/impact', 'POST', {
    mois,
    categoryId,
    montantCents,
  })
}

// Comparateur rémunération vs dividendes (lot 3). Le calcul fiscal vit serveur
// (fiscal.js, taux 2026 paramétrables) ; le front n'affiche que.
export interface RemDivComparison {
  grossCostCents: number
  month: string | null
  capitalSocialCents: number
  seuil10Cents: number
  beneficeAvantISCents: number
  exerciseYear: string
  remuneration: {
    brutCents: number
    cotisationsCents: number
    cotisationRatePct: number
    isCents: number
    netAvantIRCents: number
    irModelise: boolean
  }
  dividendes: {
    isRatePct: number
    isCents: number
    dividendeBrutCents: number
    fractionSousSeuilCents: number
    fractionSurSeuilCents: number
    prelevementsSociauxCents: number
    prelevementsSociauxPct: number
    cotisationsTnsCents: number
    cotisationsTnsPct: number
    irCents: number
    irPct: number
    netCents: number
    irModelise: boolean
  }
  deltaNetDividendesMoinsRemAvantIRCents: number
  avertissements: string[]
}

export async function compareRemunerationDividendes(
  montantCents: number,
  mois?: string,
): Promise<RemDivComparison> {
  return sendJson<RemDivComparison>('/api/projection/dividendes-vs-remuneration', 'POST', {
    montantCents,
    mois,
  })
}

export interface ForecastDetailLine {
  label: string
  amountCents: number
  /** recu = déjà encaissé, facture = facturé et attendu, signe = signé à facturer, pipe = pondéré, hypothese */
  status: 'recu' | 'facture' | 'signe' | 'pipe' | 'hypothese'
}

export interface ActualDetailLine {
  date: string
  label: string
  amountCents: number
}

export interface ForecastCell {
  month: string
  actualCents: number | null
  forecastCents: number | null
  retainedCents: number
  note: string | null
  /** lignes nommées du prévisionnel */
  details?: ForecastDetailLine[] | null
  /** mouvements bancaires réels du mois (mois passés et en cours) */
  actualDetails?: ActualDetailLine[] | null
  editable: boolean
}

export interface ForecastRow {
  categoryId: string
  label: string
  direction: 'in' | 'out'
  cells: ForecastCell[]
}

export interface ForecastGridResponse {
  months: string[]
  currentMonth: string
  rows: ForecastRow[]
  closings: { month: string; closingCents: number; projected: boolean }[]
}

export interface Scenario {
  id: string
  label: string
  description: string
  active: boolean
  params: Record<string, string | number>
  sliders: {
    key: string
    label: string
    type: 'month' | 'amount' | 'days' | 'toggle'
    min?: number | string
    max?: number | string
    step?: number
    options?: string[]
  }[]
}

export interface Transaction {
  id: string
  date: string
  label: string
  categoryId: string
  amountCents: number
  counterparty: string | null
  invoiceId: string | null
  source: 'seed' | 'user' | 'agent'
}

// Échéancier des sorties datées (cash calendar 60-90 j, lot 2 fiabilité).
export interface Echeance {
  id: string
  label: string
  categoryId: string | null
  dueDate: string
  amountCents: number
  kind: 'tva' | 'urssaf' | 'is' | 'loyer' | 'assurance' | 'emprunt' | 'autre'
  recurrence: 'once' | 'monthly' | 'quarterly' | 'annual'
  source: 'derived' | 'manual' | 'agent'
  note: string | null
}

export interface CashCalendar {
  fromDate: string
  toDate: string
  horizonDays: number
  items: Echeance[]
  totalOutCents: number
  byMonth: Record<string, { outCents: number; inCents: number; count: number }>
}

// Compte de résultat mensuel (onglet Rentabilité) : produits/charges HT par mois + total.
export interface CompteResultatLigne {
  categoryId: string
  label: string
  direction: 'in' | 'out'
  parMois: Record<string, number>
  totalCents: number
}

export interface CompteResultatMois {
  produitsHTCents: number
  chargesHTCents: number
  resultatAvantISCents: number
  realized: boolean
}

export interface CompteResultatResponse {
  exerciseYear: string
  months: string[]
  currentMonth: string
  produits: CompteResultatLigne[]
  charges: CompteResultatLigne[]
  parMois: Record<string, CompteResultatMois>
  totalProduitsHTCents: number
  totalChargesHTCents: number
  resultatAvantISCents: number
  isProvisionCents: number
  resultatApresISCents: number
  isBracket: string
  ratios: { tauxMargeNettePct: number | null; tauxResultatAvantISPct: number | null }
  breakEvenHTCents: number
  availableYears: string[]
  currentYear: string
}

// ----------------------------------------------------------------- Fetch
// Session expirée ou cookie absent : retour à la page de connexion du serveur.
function redirectIfUnauthorized(res: Response) {
  if (res.status === 401) window.location.assign('/connexion')
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  redirectIfUnauthorized(res)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

export async function sendJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  redirectIfUnauthorized(res)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || `${url} -> ${res.status}`)
  }
  return res.json()
}

// ----------------------------------------------------------------- Hooks
export function useAppState() {
  return useQuery({ queryKey: ['state'], queryFn: () => getJson<StateResponse>('/api/state') })
}

// Propositions en attente (émises par l'agent OU par les jobs : sync Twenty, recalage
// des charges). Avant ce hook, les propositions créées en tâche de fond n'apparaissaient
// nulle part dans l'UI - elles dormaient dans proposals.json.
export function usePendingProposals() {
  return useQuery({
    queryKey: ['proposals'],
    queryFn: () => getJson<import('./sse').AgentProposal[]>('/api/proposals'),
    select: (all) => all.filter((p) => p.status === 'pending'),
    refetchInterval: 60_000,
  })
}

export function useProjection(range: string, scenarios: string[] = []) {
  const qs = new URLSearchParams()
  if (range) qs.set('range', range)
  if (scenarios.length) qs.set('scenarios', scenarios.join(','))
  return useQuery({
    queryKey: ['projection', range, scenarios.join(',')],
    queryFn: () => getJson<ProjectionResponse>(`/api/projection?${qs}`),
  })
}

export function useForecastGrid() {
  return useQuery({ queryKey: ['forecast'], queryFn: () => getJson<ForecastGridResponse>('/api/forecast') })
}

export function useScenarios() {
  return useQuery({ queryKey: ['scenarios'], queryFn: () => getJson<Scenario[]>('/api/scenarios') })
}

export function useCashCalendar(jours = 90) {
  return useQuery({
    queryKey: ['echeances', jours],
    queryFn: () => getJson<CashCalendar>(`/api/echeances?jours=${jours}`),
  })
}

export function useTransactions(filters: { month?: string; categoryId?: string; limit?: number }) {
  const qs = new URLSearchParams()
  if (filters.month) qs.set('month', filters.month)
  if (filters.categoryId) qs.set('categoryId', filters.categoryId)
  if (filters.limit) qs.set('limit', String(filters.limit))
  return useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => getJson<Transaction[]>(`/api/transactions?${qs}`),
  })
}

export function useCompteResultat(year?: string) {
  return useQuery({
    queryKey: ['compte-resultat', year ?? 'current'],
    queryFn: () => getJson<CompteResultatResponse>(`/api/compte-resultat${year ? `?year=${year}` : ''}`),
  })
}
