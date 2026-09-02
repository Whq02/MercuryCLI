// ============================================================================
//  useCrossProjectFinishPings — the VISIBLE process's cross-project finish
//  watch (cross-project awareness, law 5), mounted beside the ping engine so
//  an agent finishing in ANOTHER project reaches the operator wherever they
//  are: the watch mints ONE needs-you obligation per finish through the
//  obligations owner's door (services/concourse/crossProjectPings), and the
//  estate does the rest — the ⚑ badge counts it, the engine rings it once,
//  the host toast names it, the rail rows it as a door. Seed-silent at
//  mount. ABSENT IN THE PLAIN WORLD: `--chat` and the concourse switched
//  off have no board to switch on (the strip's own fact gates it — one
//  predicate, no third flag). Workers never mount this hook.
// ============================================================================
import { useEffect } from 'react'
import { chatOnlyBoot } from '../context/surfaceRoute.js'
import { startCrossProjectFinishWatch } from '../services/concourse/crossProjectPings.js'

export function useCrossProjectFinishPings(): void {
  useEffect(() => {
    const handle = startCrossProjectFinishWatch({ enabled: () => !chatOnlyBoot() })
    return () => handle.dispose()
  }, [])
}
