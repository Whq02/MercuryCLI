import React, { useEffect, useRef, useState } from 'react'
import { ExitHandoff, noteAskedAtExit } from './ExitHandoff.js'
import { WorktreeExitDialog } from './WorktreeExitDialog.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { farewellWithTesterDoor } from '../commands/feedback/testerDoor.js'

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
  const firedRef = useRef(false)
  const [note, setNote] = useState<{ message?: string } | null>(null)

  const leave = (message?: string): void => {
    if (firedRef.current) return
    firedRef.current = true
    if (noteAskedAtExit()) {
      setNote({ message })
      return
    }
    onDone(message)
    exitNow(message)
  }

  useEffect(() => {
    if (showWorktree) return
    leave()
  }, [showWorktree])

  if (note !== null) {
    return (
      <ExitHandoff
        onSettled={() => {
          onDone(note.message)
          exitNow(note.message)
        }}
      />
    )
  }

  if (!showWorktree) return null

  return <WorktreeExitDialog onDone={result => leave(result)} onCancel={onCancel} />
}

export default ExitFlow
