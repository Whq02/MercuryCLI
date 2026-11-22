import { type CanUseToolFn, type ToolEffect, type ToolUseContext, buildTool } from '../../Tool.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../services/model/model.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { resolveDesktopDriver } from '../../services/desktop/resolveDriver.js'
import {
  appApproved,
  desktopPostureRefusal,
  markCheckedActAsked,
  noteCheckedActApp,
  noteTurnHome,
  turnKeyOf,
} from '../../services/desktop/desktopSession.js'
import { readComputerGrant } from '../../services/desktop/computerGrant.js'
import { computerAccessPinnedToAsk, savedComputerAccess } from '../../services/desktop/computerAccess.js'
import { resolveComputerAccess } from '../../substrate/startupMenu.js'
import { postureBypassesAsks } from '../../utils/permissions/decision/engine.js'
import { getSessionId } from '../../bootstrap/state.js'
import { COMPUTER_TOOL_NAME } from '../../services/desktop/toolName.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'
import { COMPUTER_PROMPT } from './prompt.js'
import { readFileSync } from 'node:fs'
import { errorMessage } from '../../utils/errors.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import type { PermissionDecision, ToolPermissionContext } from '../../types/permissions.js'
import type { AssistantMessage } from '../../types/message.js'
import {
  ACTIONS,
  ACT_ACTIONS,
  ASK_ACTIONS,
  FACT_ACTIONS,
  type Input,
  type Output,
  READ_ACTIONS,
  type SchemaType,
  computerToolEnabled,
  inputSchema,
  modelInputSchema,
  permissionAction,
  refuse,
  tableRefusal,
} from './computer/schema.js'
import { challengeAction, challengeVerdict, isPlanRefusal, ownTerminalRefusal, planOf } from './computer/plan.js'
import { actDetail, faultText } from './computer/act.js'
import { denied, routeRefusal, ruleFor, ruleVerdict } from './computer/shot.js'
import { computerCall } from './computer/call.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export { COMPUTER_TOOL_NAME }
export { computerToolEnabled, HOLD_CAP_MS, TREE_DEPTH_CAP, TREE_DEPTH_DEFAULT, TREE_LIMIT_CAP, TREE_LIMIT_DEFAULT, TYPE_TEXT_CAP } from './computer/schema.js'
export type { Input, Output } from './computer/schema.js'

export const ComputerTool: Unbuilt = unbuilt('src/tools/ComputerTool/ComputerTool.ts:56')
