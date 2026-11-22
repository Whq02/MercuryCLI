import React, { useRef, useState } from 'react'
import { usePublish } from '../hooks/effects.js'
import { ExitHandoff, noteAskedAtExit } from './ExitHandoff.js'
import { WorktreeExitDialog } from './WorktreeExitDialog.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { farewellWithTesterDoor } from '../commands/feedback/testerDoor.js'
import { notBuilt } from '../pi/holes.js'

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

export function ExitFlow(arg0: {
  onDone: (message?: string) => void
  onCancel?: () => void
  showWorktree: boolean
}): React.ReactNode {
  return notBuilt('src/components/ExitFlow.tsx:28')
}

export default ExitFlow
