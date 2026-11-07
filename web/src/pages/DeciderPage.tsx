import { HandCoins, Scale, Wallet } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppState } from '@/lib/api'
import { ProvisionsCard } from '@/components/kpi/ProvisionsCard'
import { RemunerationCheck } from '@/components/decision/RemunerationCheck'
import { RemDivComparator } from '@/components/decision/RemDivComparator'
import { CcaCheck } from '@/components/decision/CcaCheck'

// Page « Décider » : les questions de dirigeant sorties du tableau de
// bord - me verser, me rembourser, arbitrer rému / dividendes, provisions.
export default function DeciderPage() {
  const state = useAppState()
  if (state.isLoading || !state.data) {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  const { company, kpis } = state.data
  const tns = company.fiscal?.tns?.autoCompute

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Décider</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Les questions de dirigeant : me verser, me rembourser, arbitrer. Rien n'est enregistré, le moteur simule et rend
          un verdict.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {kpis.cca && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HandCoins className="size-4 text-primary" />
                Compte courant d'associé
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Ce que la société vous doit.</p>
            </CardHeader>
            <CardContent>
              <CcaCheck cca={kpis.cca} />
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4 text-primary" />
              Puis-je me verser ?
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RemunerationCheck />
          </CardContent>
        </Card>
        {/* Comparateur rému/dividendes : pertinent pour un gérant TNS (masqué sur la démo BTP). */}
        {tns && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Scale className="size-4 text-primary" />
                Rémunération ou dividendes ?
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RemDivComparator />
            </CardContent>
          </Card>
        )}
        <ProvisionsCard company={company} kpis={kpis} showCca={false} />
      </div>
    </div>
  )
}
