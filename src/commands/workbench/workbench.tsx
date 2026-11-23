import { PromptsPanel } from '../../screen/prompts-panel/PromptsPanel.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

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
