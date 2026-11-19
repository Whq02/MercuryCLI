import type { ToolEffectOutcome, ToolUseContext } from '../../../Tool.js'
import type { OwnerKey } from '../../../services/run/ownerKey.js'
import type { Input } from './schema.js'
import { CRASH_OPEN_OPS, crashedWords } from './failures.js'
import { type LiveSession, statusReport } from './page.js'
import { backOp, openOp, reloadOp, waitForOp } from './navigateOps.js'
import { clickOp, hoverOp, pressOp, scrollOp, selectOp, uploadOp } from './pointerOps.js'
import { typeOp } from './typeOp.js'
import { devicesOp, viewportOp } from './viewportOps.js'
import { consoleOp, extractOp, infoOp, screenshotOp } from './readOps.js'
import { closeOp, downloadOp, provisionOp } from './sessionOps.js'

export interface OpRun {
  input: Input
  owner: OwnerKey
  tab: string
  context: ToolUseContext
  sessionAtEntry: LiveSession | null
  crashedAtEntry: boolean
  signalFor: (s: LiveSession) => AbortSignal
  acting: (s: LiveSession) => void
  holdSecret: (secret: { value: string; ref: string }) => void
  holdImage: (path: string) => void
}

export interface OpDone {
  result: string
  outcome: ToolEffectOutcome
  inlinePath?: string
  inlineMediaType?: string
}

export async function runOp(run: OpRun): Promise<OpDone> {
  const { input, owner, sessionAtEntry, crashedAtEntry } = run
  switch (crashedAtEntry && !CRASH_OPEN_OPS.has(input.op) ? 'crashed' : input.op) {
    case 'crashed':
      return { result: crashedWords(sessionAtEntry!, input.tab !== undefined), outcome: 'failed' }
    case 'status':
      return { result: await statusReport(owner, input), outcome: 'no-change' }
    case 'open':
      return openOp(run)
    case 'click':
      return clickOp(run)
    case 'upload':
      return uploadOp(run)
    case 'type':
      return typeOp(run)
    case 'scroll':
      return scrollOp(run)
    case 'waitFor':
      return waitForOp(run)
    case 'back':
      return backOp(run)
    case 'reload':
      return reloadOp(run)
    case 'select':
      return selectOp(run)
    case 'press':
      return pressOp(run)
    case 'hover':
      return hoverOp(run)
    case 'provision':
      return provisionOp(run)
    case 'viewport':
      return viewportOp(run)
    case 'devices':
      return devicesOp()
    case 'extract':
      return extractOp(run)
    case 'console':
      return consoleOp(run)
    case 'info':
      return infoOp(run)
    case 'screenshot':
      return screenshotOp(run)
    case 'download':
      return downloadOp(run)
    case 'close':
      return closeOp(run)
  }
}
