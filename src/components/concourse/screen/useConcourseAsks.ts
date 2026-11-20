import { useRef, useState } from 'react'
import { CONTRACT_CARD_MIN_ROWS } from '../ContractOfferCard.js'
import { useLoad } from '../../../hooks/effects.js'
import { isPathTrusted, setPathTrusted } from '../../../utils/config.js'
import { getCwd } from '../../../utils/cwd.js'
import { errorMessage } from '../../../utils/errors.js'
import { logError } from '../../../utils/log.js'
import { basename } from 'node:path'
import type { Draft, Panes, ScreenProps } from './state.js'

export function useConcourseAsks({ callbacks, setGroundPickerOpen, setNote }: Pick<ScreenProps, 'callbacks'> & Pick<Panes, 'setGroundPickerOpen'> & Pick<Draft, 'setNote'>) {
  const [contractAsk, setContractAsk] = useState(false)
  const contractAskRef = useRef(contractAsk)
  contractAskRef.current = contractAsk
  const compactCardRows = contractAsk ? CONTRACT_CARD_MIN_ROWS : 0
  const armContractAsk = (): void => {
    setContractAsk(true)
  }
  const answerContractAsk = (contractText: string | null): void => {
    setContractAsk(false)
    if (contractText === null) {
      callbacks.newSession?.()
      return
    }
    callbacks.newSession?.({ contractText })
  }

  const [capacityAsk, setCapacityAsk] = useState(false)
  const capacityAskRef = useRef(false)
  useLoad(() => {
    let alive = true
    void import('../../../services/switchboard/capacityCheck.js')
      .then(m => {
        if (alive && m.needsCapacityAsk()) {
          capacityAskRef.current = true
          setCapacityAsk(true)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const [trustAsk, setTrustAsk] = useState<{ dir: string } | null>(null)
  const trustAskRef = useRef<{ dir: string } | null>(null)
  trustAskRef.current = trustAsk
  const applyGround = (dir: string | null): void => {
    callbacks.setDraftSeed({ projectDir: dir })
    setNote({
      tone: 'muted',
      text:
        dir === null
          ? 'repo → the boot folder — new sessions launch there'
          : `repo → ${basename(dir)} — new sessions launch there`,
    })
  }
  const pickGround = (dir: string | null): void => {
    setGroundPickerOpen(false)
    if (dir !== null && !isPathTrusted(dir)) {
      setTrustAsk({ dir })
      return
    }
    applyGround(dir)
  }
  const answerTrustAsk = (trusted: boolean): void => {
    const ask = trustAskRef.current
    setTrustAsk(null)
    if (ask === null) return
    if (!trusted) {
      setNote({
        tone: 'muted',
        text: `kept on ${basename(getCwd()) || getCwd()} — ${basename(ask.dir)} stays untrusted`,
      })
      return
    }
    setPathTrusted(ask.dir)
    applyGround(ask.dir)
  }
  const answerCapacityAsk = (allowed: boolean): void => {
    capacityAskRef.current = false
    setCapacityAsk(false)
    void import('../../../services/switchboard/capacityCheck.js')
      .then(m => m.recordCapacityDecision(allowed))
      .then(async r => {
        const { capacityDecisionReceipt } = await import('../../../services/switchboard/capacityCheck.js')
        setNote({
          tone: 'muted',
          text: capacityDecisionReceipt(allowed, r.recommendedSeats),
        })
      })
      .catch((error: unknown) => {
        const why = error instanceof SyntaxError ? 'a config file is not valid JSON' : errorMessage(error)
        logError(new Error(`the capacity answer could not be saved: ${why}`))
        setNote({
          tone: 'warning',
          text: `capacity answer not saved (${why}) — the board asks again next time`,
        })
      })
  }
  return { contractAsk, contractAskRef, compactCardRows, armContractAsk, answerContractAsk, capacityAsk, capacityAskRef, trustAsk, trustAskRef, applyGround, pickGround, answerTrustAsk, answerCapacityAsk }
}
