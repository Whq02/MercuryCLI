import { useEffect, useMemo, useRef } from 'react'
import { credentialWallLineForModel } from '../services/providers/credentialWall.js'
import type { Message } from '../types/message.js'
import { signInLedgerEpoch } from '../utils/accounts/signInLedger.js'
import { invalidateOnDiskChange } from '../utils/auth.js'
import { promptBehindAuthWall, type AuthWallHold } from '../utils/messages/authWallHold.js'

export type HeldPrompt = AuthWallHold & { epoch: number; model: string }

export type ResendDoor = 'logins' | 'model'

export type ResendFacts = {
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

export type AuthWallHoldHandle = {
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

  useEffect(() => {
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
        } catch {
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
