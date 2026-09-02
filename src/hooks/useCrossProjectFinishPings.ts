import { useEffect } from 'react'
import { chatOnlyBoot } from '../context/surfaceRoute.js'
import { startCrossProjectFinishWatch } from '../services/concourse/crossProjectPings.js'

export function useCrossProjectFinishPings(): void {
  useEffect(() => {
    const handle = startCrossProjectFinishWatch({ enabled: () => !chatOnlyBoot() })
    return () => handle.dispose()
  }, [])
}
