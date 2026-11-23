import { useInput } from '../../themedRenderer.js'
import type { KeysArgs } from './state.js'
import { modalKeys } from './keys/modalKeys.js'
import { tabFilterKeys } from './keys/filterKeys.js'
import { wheelEscapeKeys } from './keys/escapeKeys.js'
import { railKeys } from './keys/railKeys.js'
import { listKeys } from './keys/listKeys.js'
import { chatChordKeys } from './keys/chordKeys.js'
import { liveComposerKeys } from './keys/liveKeys.js'

export function useConcourseKeys(args: KeysArgs) {
  const { olderListRef, setOlderList, composeContextRef, degraded, callbacks, reducedStage, region } = args
  const olderNavConsumed = (
    key: { upArrow: boolean; downArrow: boolean },
    event: { stopImmediatePropagation: () => void },
  ): boolean => {
    const open = olderListRef.current
    if (open === null || !(key.upArrow || key.downArrow)) return false
    event.stopImmediatePropagation()
    const at = Math.min(open.entries.length - 1, Math.max(0, open.at + (key.downArrow ? 1 : -1)))
    if (at !== open.at) setOlderList({ ...open, at })
    return true
  }

  useInput((input, key, event) => {
    if (modalKeys(input, key, event, args)) return
    const ctx = composeContextRef.current
    if (tabFilterKeys(input, key, event, args)) return
    if (wheelEscapeKeys(input, key, event, args, ctx)) return
    if (degraded && key.ctrl && input === 'r') {
      event.stopImmediatePropagation()
      callbacks.retrySnapshot?.()
      return
    }
    if (railKeys(input, key, event, args)) return
    if (listKeys(input, key, event, args, olderNavConsumed)) return
    if (chatChordKeys(input, key, event, args, olderNavConsumed)) return
    if (reducedStage) {
      return
    }
    if (region === 'chat') {
      return
    }
    if (region !== 'live') {
      return
    }
    liveComposerKeys(input, key, event, args)
  })
}
