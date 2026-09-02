import * as React from 'react'
import { PromptsPanel } from '../../components/prompts-panel/PromptsPanel.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

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
