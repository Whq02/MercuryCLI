import { useMemo, useRef } from 'react'
import { usePublish } from '../effects/effects.js'
import { enqueueNotification } from '../notifications/notifications.js'
import { credentialWallLineForModel } from '../../models/roads/credentialWall.js'
import { useSetAppStateMaybe } from '../app-state/AppState.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { signInLedgerEpoch } from '../../models/sign-in/account-ledger/signInLedger.js'
import { invalidateOnDiskChange } from '../../models/sign-in/lifecycle/oauthLifecycle.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { promptBehindAuthWall, type AuthWallHold } from '../../engine/message-shapes/authWallHold.js'

type HeldPrompt = AuthWallHold & { epoch: number; model: string }

type ResendDoor = 'logins' | 'model'

type ResendFacts = {
  door: ResendDoor
  epoch: number
  model: string
  walled: boolean
  composerText: string
}

export function decideResend(hold: HeldPrompt | null, facts: ResendFacts): 'send' | 'keep' | 'none' {
  if (hold === null) return 'none'
  if (facts.walled) return 'keep'
  if (facts.door === 'logins' && facts.epoch === hold.epoch) return 'keep'
  if (facts.door === 'model' && facts.model === hold.model) return 'keep'
  if (facts.composerText.trim() !== hold.text.trim()) return 'keep'
  return 'send'
}

type Composer = {
  text: () => string
  restore: (text: string) => void
}

type AuthWallHoldHandle = {
  afterDoor: (door: ResendDoor, resend: (hold: HeldPrompt) => void) => void
  held: () => HeldPrompt | null
}

export function useAuthWallHold(
  messages: readonly Message[],
  composer: Composer,
  model: () => string,
): AuthWallHoldHandle {
  const heldRef = useRef<HeldPrompt | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const composerRef = useRef(composer)
  composerRef.current = composer
  const modelRef = useRef(model)
  modelRef.current = model
  const setAppState = useSetAppStateMaybe()
  const setAppStateRef = useRef(setAppState)
  setAppStateRef.current = setAppState

  usePublish(() => {
    const hold = promptBehindAuthWall(messages)
    if (hold === null || seenRef.current.has(hold.errorUuid)) return
    seenRef.current.add(hold.errorUuid)
    heldRef.current = { ...hold, epoch: signInLedgerEpoch(), model: modelRef.current() }
    if (composerRef.current.text().trim() === '') composerRef.current.restore(hold.text)
  }, [messages])

  return useMemo<AuthWallHoldHandle>(
    () => ({
      held: () => heldRef.current,
      afterDoor: (door, resend) => {
        const hold = heldRef.current
        if (hold === null) return
        try {
          invalidateOnDiskChange()
        } catch (error) {
          const detail = errorMessage(error)
          logForDebugging(`auth-wall-hold: sign-in refresh failed: ${detail}`, { level: 'error' })
          if (setAppStateRef.current !== null) {
            enqueueNotification(setAppStateRef.current, {
              key: 'auth-wall-hold',
              text: `Sign-in state could not be refreshed (${detail}) — press Enter to send your prompt.`,
              priority: 'high',
              color: 'warning',
            })
          }
          return
        }
        const current = modelRef.current()
        const verdict = decideResend(hold, {
          door,
          epoch: signInLedgerEpoch(),
          model: current,
          walled: credentialWallLineForModel(current) !== undefined,
          composerText: composerRef.current.text(),
        })
        if (verdict !== 'send') return
        heldRef.current = null
        resend(hold)
      },
    }),
    [],
  )
}
