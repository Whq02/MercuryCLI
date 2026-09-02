// THE EXIT CHORD'S ONE NOTICE (ledger L22): the main REPL composer's own
// words, in one component. The footer's left cluster paints it while the
// composer's chord is armed; every route surface — the concourse (cards up
// or not), the boot face, the split and the reduced stage — paints the SAME
// component at the bottom-left of the frame through the route host's exit
// chord (SurfaceExitChord). One owner of the spelling, never a second.

import React from 'react'
import { Text } from '../../ink.js'

/** The notice's bytes — the surfaces size their one-row box from it. */
export function exitChordNoticeText(keyName: string | null): string {
  return `press ${keyName === 'Ctrl-D' ? 'ctrl+d' : 'ctrl+c'} twice to close Mercury`
}

export function ExitChordNotice({ keyName }: { keyName: string | null }): React.ReactNode {
  return <Text dimColor>{exitChordNoticeText(keyName)}</Text>
}
