import * as React from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { MinervaRoom } from '../../components/tabula/MinervaRoom.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /tabula — Minerva's room (self-contained <View onClose>, the /cards
// pattern). You talk to Minerva; it refines your saved prompts when asked.
// Closing with a refined prompt hands it into the COMPOSER (nextInput,
// never auto-submitted — the operator reviews first; the workbench's exact
// contract): the room's s key is the one gesture that descends a landed
// refinement (COORDKEYS item 4).
export const call: LocalJSXCommandCall = async onDone => {
  return (
    <MinervaRoom
      cwd={getOriginalCwd()}
      onClose={(nextInput?: string) =>
        nextInput !== undefined && nextInput.trim().length > 0
          ? onDone(undefined, { display: 'skip', nextInput })
          : onDone(undefined, { display: 'skip' })
      }
    />
  )
}
