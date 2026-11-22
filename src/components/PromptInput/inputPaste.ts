import type { PastedContent } from '../../utils/config.js'
import { getPastedTextRefNumLines } from '../../history.js'
import { notBuilt } from '../../pi/holes.js'

const TRUNCATE_THRESHOLD = 10_000
const KEEP_EACH_SIDE = 500

export function maybeTruncateInput(
  text: string,
  pastes: Record<number, PastedContent>,
): {
  newInput: string
  newPastedContents: Record<number, PastedContent>
} {
  return notBuilt('src/components/PromptInput/inputPaste.ts:29')
}
