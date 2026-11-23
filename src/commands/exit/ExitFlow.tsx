import React, { useRef, useState } from 'react'
import { usePublish } from '../../screen/effects/effects.js'
import { ExitHandoff, noteAskedAtExit } from './ExitHandoff.js'
import { WorktreeExitDialog } from './WorktreeExitDialog.js'
import { gracefulShutdown } from '../../platform/processes/gracefulShutdown.js'
import { farewellWithTesterDoor } from '../feedback/testerDoor.js'

const FAREWELLS = [
  'See you next time.',
  'Until next time.',
  'Happy shipping.',
  'Signing off.',
  'Take care.',
] as const

function farewell(message?: string): string {
  if (message !== undefined && message !== '') return message
  return FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)]!
}

function exitNow(message?: string): void {
  void gracefulShutdown(0, 'quit', {
    finalMessage: farewellWithTesterDoor(farewell(message)),
  })
}

export function ExitFlow({
  onDone,
  onCancel,
  showWorktree,
}: {
  onDone: (message?: string) => void
  onCancel?: () => void
  showWorktree: boolean
}): React.ReactNode {
  const [step, setStep] = useState<'worktree' | 'handoff' | 'exiting'>(
    showWorktree ? 'worktree' : 'exiting',
  )
  const pendingMessageRef = useRef<string | undefined>(undefined)
  const startedRef = useRef(false)

  const leave = (message?: string): void => {
    if (startedRef.current) return
    startedRef.current = true
    if (noteAskedAtExit()) {
      pendingMessageRef.current = message
      setStep('handoff')
      return
    }
    const finalText = farewell(message)
    onDone(finalText)
    exitNow(finalText)
  }

  usePublish(() => {
    if (!showWorktree) {
      leave()
    }
  }, [])

  if (step === 'worktree') {
    return (
      <WorktreeExitDialog
        onDone={result => leave(result)}
        onCancel={onCancel}
      />
    )
  }

  if (step === 'handoff') {
    return (
      <ExitHandoff
        onSettled={receipt => {
          const base = farewell(pendingMessageRef.current)
          const finalText =
            receipt.detail !== undefined && receipt.detail !== ''
              ? `${base}\n${receipt.detail}`
              : base
          onDone(finalText)
          exitNow(finalText)
        }}
      />
    )
  }

  return null
}

export default ExitFlow
