import type { DesktopDriver } from '../../services/desktop/driver.js'
import { isTypingActive, TYPING_HOLD_MS } from '../../utils/cockpit/typingActivity.js'
import { pollUntil } from '../../utils/deadline.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

const OPERATOR_QUIET_MS = TYPING_HOLD_MS
const OPERATOR_PAUSE_CAP_MS = 3000
export const OPERATOR_TYPING_REFUSAL = 'the operator is typing — nothing done; try again in a moment'

let idleUnread: string | null = null

export async function operatorIsTyping(driver: DesktopDriver): Promise<boolean> {
  let idle: number | null = null
  try {
    idle = await driver.keyboardIdleMs?.() ?? null
    idleUnread = null
  } catch (error) {
    const reason = errorMessage(error)
    if (idleUnread !== reason) logForDebugging(`computer: the keyboard's idle time could not be read (${reason}), so only typing in this window holds an act`, { level: 'warn' })
    idleUnread = reason
  }
  return isTypingActive() || (idle !== null && Number.isFinite(idle) && idle >= 0 && idle < OPERATOR_QUIET_MS)
}

export async function waitForOperatorPause(driver: DesktopDriver, signal: AbortSignal): Promise<boolean> {
  return pollUntil(
    async () => {
      const typing = await operatorIsTyping(driver)
      return signal.aborted ? false : typing ? undefined : true
    },
    100,
    OPERATOR_PAUSE_CAP_MS,
    () => false,
    { signal, onAbort: () => false },
  )
}
