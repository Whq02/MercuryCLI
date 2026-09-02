// ============================================================================
//  SurfaceExitChord — THE ONE EXIT LAW on every route surface (ledger L22):
//  ctrl+c twice inside the REPL composer's own window (EXIT_CHORD_WINDOW_MS)
//  closes Mercury from the concourse (every region, cards up or not), the
//  boot face, the split and the reduced stage — exactly as it does from the
//  main REPL's composer, whose chord (useTextInput) stays byte-identical:
//  the chat route mounts no surface host, so this owner is never there. A
//  screen the operator cannot leave is a bug class.
//
//  · ONE listener, mounted by the route host AHEAD of the surface subtree —
//    the ink emitter fires listeners in registration order, so it counts
//    every ctrl+c BEFORE a screen or a card can consume it (the concourse
//    clears a non-empty draft on its first press; a modal card owns its
//    keys): a card never imprisons the exit. The press is NEVER consumed
//    here — the surface's own first-press meaning survives after it.
//  · The first press ARMS the chord and the host paints the notice at the
//    bottom-left of the frame (ExitChordNotice — the REPL's exact words);
//    the window lapse disarms it (useDoublePress clears the pending state,
//    and the notice with it).
//  · The second press exits through the ONE graceful shutdown — sessions
//    park (quit-parks-all rides the shutdown cleanup), the daemon's posture
//    untouched — never a raw process.exit from a screen. ctrl+d keeps its
//    own rules where it has any; it is not this owner's key.
// ============================================================================

import React from 'react'
import { Box, useInput } from '../ink.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from '../hooks/useDoublePress.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { ExitChordNotice, exitChordNoticeText } from './PromptInput/ExitChordNotice.js'

/** The notice's indent — the surfaces' own bottom rows (the face's key-map
 *  row, the board's help rail) start two cells in. */
const NOTICE_INDENT = 2

export function SurfaceExitChord({ onPendingChange }: { onPendingChange: (pending: boolean) => void }): null {
  const press = useDoublePress(
    onPendingChange,
    () => {
      void gracefulShutdown(0, 'prompt_input_exit')
    },
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )
  useInput((input, key) => {
    // The REPL composer's own spelling of the key (useTextInput's ctrl
    // branch): ctrl+c, nothing else — and never consumed.
    if (key.ctrl && input === 'c') press()
  })
  return null
}

/** The host paints this AFTER the surface subtree (later siblings paint on
 *  top): one opaque row at the bottom-left, exactly the notice's width. */
export function SurfaceExitChordNotice({ pending }: { pending: boolean }): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  if (!pending) return null
  const width = Math.min(columns, NOTICE_INDENT + exitChordNoticeText('Ctrl-C').length)
  return (
    <Box
      position="absolute"
      top={Math.max(0, rows - 1)}
      left={0}
      width={width}
      height={1}
      paddingLeft={NOTICE_INDENT}
      overflow="hidden"
      opaque={true}
    >
      <ExitChordNotice keyName="Ctrl-C" />
    </Box>
  )
}
