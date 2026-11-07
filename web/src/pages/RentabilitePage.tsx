import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useCompteResultat, type CompteResultatLigne, type CompteResultatResponse } from '@/lib/api'
import { formatCents, formatCentsPlain } from '@/lib/money'
import { formatMonthShort } from '@/lib/dates'
import { cn } from '@/lib/utils'

// Cellule chiffrée (valeur absolue pour les lignes de produits/charges : le signe est
// porté par la section). Zéro -> tiret discret pour alléger la lecture du tableau.
function Cell({ cents, className }: { cents: number | undefined; className?: string }) {
  if (!cents) return <td className={cn('px-2 py-1.5 text-right text-muted-foreground/40', className)}>-</td>
  return <td className={cn('px-2 py-1.5 text-right tabular', className)}>{formatCentsPlain(cents)}</td>
}

function LigneRow({ ligne, months }: { ligne: CompteResultatLigne; months: string[] }) {
  return (
    <tr className="border-b border-border/40 last:border-0">
      <td className="sticky left-0 z-10 bg-card px-3 py-1.5 text-muted-foreground">{ligne.label}</td>
      {months.map((ym) => (
        <Cell key={ym} cents={ligne.parMois[ym]} />
      ))}
      <Cell cents={ligne.totalCents} className="bg-muted/30 font-medium text-foreground" />
    </tr>
  )
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'pos' | 'neg' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            'mt-1 text-2xl font-semibold tabular tracking-tight',
            tone === 'pos' && 'text-positive',
            tone === 'neg' && 'text-destructive',
          )}
        >
          {value}
        </div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

export default function RentabilitePage() {
  // L'exercice sélectionné est piloté par l'état LOCAL (pas par la donnée chargée, qui
  // est en retard pendant le fetch) : le sélecteur réagit instantanément au clic.
  const [year, setYear] = useState('')
  const cr = useCompteResultat(year || undefined)

  if (cr.isLoading || !cr.data) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    )
  }

  const d: CompteResultatResponse = cr.data
  const months = d.months
  const beneficiaire = d.resultatApresISCents >= 0
  const selectedYear = year || d.currentYear

  return (
    <div className="flex flex-col gap-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Rentabilité</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Compte de résultat : produits HT moins charges HT, hors TVA. C'est le bénéfice, à ne pas confondre avec
            le solde en banque (la TVA collectée et les cotisations provisionnées gonflent le cash sans être à vous).
          </p>
        </div>
        <Tabs value={selectedYear} onValueChange={setYear} className="shrink-0">
          <TabsList>
            {d.availableYears.map((y) => (
              <TabsTrigger key={y} value={y}>
                {y}
                {y === d.currentYear ? ' (en cours)' : ''}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label={`Résultat net ${d.exerciseYear}`}
          value={formatCents(d.resultatApresISCents)}
          hint="après IS"
          tone={beneficiaire ? 'pos' : 'neg'}
        />
        <Kpi label="Résultat avant IS" value={formatCents(d.resultatAvantISCents)} hint={`IS estimé : ${formatCents(d.isProvisionCents)}`} />
        <Kpi
          label="Taux de marge nette"
          value={d.ratios.tauxMargeNettePct === null ? '-' : `${d.ratios.tauxMargeNettePct} %`}
          hint="résultat net / produits HT"
        />
        <Kpi label="Point mort mensuel" value={formatCents(d.breakEvenHTCents)} hint="charges fixes à couvrir / mois HT" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Compte de résultat mensuel - exercice {d.exerciseYear}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Montants en euros HT. Mois passés : réalisé (banque). Mois à venir : projeté (prévisionnel). Les cotisations
            URSSAF sont comptées au taux dû sur la rémunération de chaque mois, pas au montant appelé. Les frais avancés et
            IK entrent en charge quand ils sont dus au compte courant d'associé ; leur remboursement n'est pas une charge.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">En euros HT</th>
                  {months.map((ym) => (
                    <th
                      key={ym}
                      className={cn(
                        'px-2 py-2 text-right font-medium',
                        d.parMois[ym]?.realized ? 'text-foreground' : 'italic text-muted-foreground',
                      )}
                    >
                      {formatMonthShort(ym)}
                    </th>
                  ))}
                  <th className="bg-muted/30 px-2 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={months.length + 2} className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Produits
                  </td>
                </tr>
                {d.produits.map((l) => (
                  <LigneRow key={l.categoryId} ligne={l} months={months} />
                ))}
                <tr className="border-y-2 border-border bg-muted/20 font-semibold">
                  <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1.5">Total produits HT</td>
                  {months.map((ym) => (
                    <Cell key={ym} cents={d.parMois[ym]?.produitsHTCents} className="font-semibold" />
                  ))}
                  <Cell cents={d.totalProduitsHTCents} className="bg-muted/40 font-bold" />
                </tr>

                <tr>
                  <td colSpan={months.length + 2} className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Charges
                  </td>
                </tr>
                {d.charges.map((l) => (
                  <LigneRow key={l.categoryId} ligne={l} months={months} />
                ))}
                <tr className="border-y-2 border-border bg-muted/20 font-semibold">
                  <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1.5">Total charges HT</td>
                  {months.map((ym) => (
                    <Cell key={ym} cents={d.parMois[ym]?.chargesHTCents} className="font-semibold" />
                  ))}
                  <Cell cents={d.totalChargesHTCents} className="bg-muted/40 font-bold" />
                </tr>

                <tr className="border-t-2 border-foreground/20">
                  <td className="sticky left-0 z-10 bg-card px-3 py-2 font-semibold">Résultat avant IS</td>
                  {months.map((ym) => {
                    const v = d.parMois[ym]?.resultatAvantISCents
                    return (
                      <td
                        key={ym}
                        className={cn('px-2 py-2 text-right tabular font-medium', v ? (v >= 0 ? 'text-positive' : 'text-destructive') : 'text-muted-foreground/40')}
                      >
                        {v ? formatCents(v) : '-'}
                      </td>
                    )
                  })}
                  <td className={cn('bg-muted/40 px-2 py-2 text-right tabular font-bold', d.resultatAvantISCents >= 0 ? 'text-positive' : 'text-destructive')}>
                    {formatCents(d.resultatAvantISCents)}
                  </td>
                </tr>
                <tr>
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5 text-muted-foreground">IS estimé ({d.isBracket})</td>
                  {months.map((ym) => (
                    <td key={ym} className="px-2 py-1.5 text-right text-muted-foreground/40">-</td>
                  ))}
                  <td className="bg-muted/30 px-2 py-1.5 text-right tabular">{d.isProvisionCents ? `-${formatCentsPlain(d.isProvisionCents)}` : '-'}</td>
                </tr>
                <tr className="border-t-2 border-foreground/20">
                  <td className="sticky left-0 z-10 bg-card px-3 py-2 text-sm font-bold">Résultat net</td>
                  <td colSpan={months.length} className="px-2 py-2 text-right text-xs text-muted-foreground">
                    après impôt sur les sociétés, calculé sur l'exercice entier
                  </td>
                  <td className={cn('bg-muted/40 px-2 py-2 text-right tabular text-sm font-bold', beneficiaire ? 'text-positive' : 'text-destructive')}>
                    {formatCents(d.resultatApresISCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
