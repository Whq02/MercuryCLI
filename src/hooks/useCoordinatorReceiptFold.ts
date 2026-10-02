import { useEffect } from 'react'
import { logForDebugging } from '../utils/debug.js'
import {
  foldJournaledCoordinatorReceipts,
  subscribeCoordinatorReceiptJournal,
} from '../services/concourse/coordinatorReceipts.js'

const POLL_MS = 15_000

export function useCoordinatorReceiptFold(): void {
  useEffect(() => {
    let folding = false
    const fold = (): void => {
      if (folding) return
      folding = true
      void (async () => {
        try {
          await foldJournaledCoordinatorReceipts()
        } catch (e) {
          logForDebugging(`[coordinator-receipts] fold failed: ${e}`)
        } finally {
          folding = false
        }
      })()
    }
    fold()
    const unsub = subscribeCoordinatorReceiptJournal(fold)
    const timer = setInterval(fold, POLL_MS)
    timer.unref?.()
    return () => {
      unsub()
      clearInterval(timer)
    }
  }, [])
}
