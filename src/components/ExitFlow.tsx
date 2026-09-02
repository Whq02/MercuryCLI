// The prompt-input exit path: renders the worktree exit dialog when
// applicable, otherwise nothing. Exiting reports a farewell — the caller's
// own message when supplied, else one drawn from a small pool — then shuts
// down gracefully with code 0 under the prompt-input exit reason.

import React, { useEffect, useRef } from 'react'
import { WorktreeExitDialog } from './WorktreeExitDialog.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'

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
  void gracefulShutdown(0, 'prompt_input_exit', {
    finalMessage: farewell(message),
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
  const firedRef = useRef(false)

  // No worktree dialog to show: the flow exits immediately on mount.
  useEffect(() => {
    if (showWorktree || firedRef.current) return
    firedRef.current = true
    onDone()
    exitNow()
  }, [showWorktree, onDone])

  if (!showWorktree) return null

  return (
    <WorktreeExitDialog
      onDone={result => {
        if (firedRef.current) return
        firedRef.current = true
        onDone(result)
        exitNow(result)
      }}
      onCancel={onCancel}
    />
  )
}

export default ExitFlow
