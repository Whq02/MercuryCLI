import type { PastedContent } from '../../utils/config.js'
import { notBuilt } from '../../pi/holes.js'

export function useMaybeTruncateInput(arg0: {
  input: string
  pastedContents: Record<number, PastedContent>
  onInputChange: (value: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (
    updater: (previous: Record<number, PastedContent>) => Record<number, PastedContent>,
  ) => void
}): void {
  return notBuilt('src/components/PromptInput/useMaybeTruncateInput.ts:7')
}
