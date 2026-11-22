import { type ToolEffectOutcome, type ToolUseContext, buildTool } from '../../Tool.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../services/model/model.js'
import {
  BROWSER_CLOSE_BOUND_MS,
  BROWSER_PROTOCOL_TIMEOUT_MS,
  CONSOLE_RING_CAP,
  MAIN_TAB,
  NAVIGATION_CAP_MS,
  activeSession,
  beginBrowserActivity,
  bringTabToFront,
  browserSessionCap,
  pageKitOf,
} from '../../services/browser/browserSession.js'
import { EMULATION_FIELD_WORDS } from '../../services/browser/browserEmulation.js'
import { scrubSecretFromText } from '../../services/browser/browserSecrets.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'
import { readFileSync } from 'node:fs'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import {
  ACT_OPS,
  EXTRACT_CAP,
  FRONT_OPS,
  type Input,
  OPS,
  type Output,
  type SchemaType,
  TABLESS_OPS,
  TOUCH_OPS,
  browserToolEnabled,
  inputSchema,
} from './browser/schema.js'
import {
  BROWSER_GONE_ERROR,
  type OpLife,
  PAGE_CRASHED_ERROR,
  browserGoneMidOpWords,
  crashedWords,
  driverFailureWords,
  errorChainText,
  openOpLife,
} from './browser/failures.js'
import { type LiveSession, pageWhere } from './browser/page.js'
import { downloadAct, downloadSought, downloadVia, namedTransfers, transferWords } from './browser/downloads.js'
import { firstRequestWords, popupWords } from './browser/settle.js'
import { checkBrowserPermissions, sentByEmulation } from './browser/permissions.js'
import { validateBrowserInput } from './browser/validate.js'
import { runOp } from './browser/ops.js'
import { errorMessage } from '../../utils/errors.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'
export { browserToolEnabled, EXTRACT_CAP, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './browser/schema.js'
export type { Input, Output } from './browser/schema.js'
export { browserGoneMidOpWords, driverFailureWords, errorChainText, isDriverTimeout, openSchemeRefusal } from './browser/failures.js'
export { localClock } from './browser/page.js'
export { DOWNLOADS_NOT_FOLLOWED } from './browser/downloads.js'

export const BrowserTool: Unbuilt = unbuilt('src/tools/BrowserTool/BrowserTool.ts:59')
