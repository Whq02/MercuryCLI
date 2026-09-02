import * as React from 'react'
import { PromptsPanel } from '../../components/prompts-panel/PromptsPanel.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /workbench — the prompts panel (the WORK panel retired in place: same
// route, same slot, the content is the three tabs). Closing with a saved
// prompt hands it into the COMPOSER (nextInput, never auto-submitted — the
// operator reviews first; the tabula insert pattern).
export const call: LocalJSXCommandCall = async onDone => {
  return (
    <PromptsPanel
      onClose={(nextInput?: string) =>
        nextInput !== undefined && nextInput.trim().length > 0
          ? onDone(undefined, { display: 'skip', nextInput })
          : onDone(undefined, { display: 'skip' })
      }
    />
  )
}
