import { type CanUseToolFn, type ToolEffect, type ToolUseContext, buildTool } from '../kit/tool.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import { zodToJsonSchema } from '../../platform/primitives/zodToJsonSchema.js'
import { modelReceivesImageBlocks } from '../../models/facts/capabilities.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { ownerFromToolUseContext } from '../../engine/run-owner/resolveOwner.js'
import { suggestionForExactCommand } from '../../permissions/rules/shellRuleMatching.js'
import { ruleSentence } from '../../permissions/rules/ruleReason.js'
import { resolveDesktopDriver } from '../../integrations/desktop/resolveDriver.js'
import {
  appApproved,
  desktopPostureRefusal,
  markCheckedActAsked,
  noteCheckedActApp,
  noteTurnHome,
  turnKeyOf,
} from '../../integrations/desktop/desktopSession.js'
import { readComputerGrant } from '../../integrations/desktop/computerGrant.js'
import { computerAccessPinnedToAsk, savedComputerAccess } from '../../integrations/desktop/computerAccess.js'
import { resolveComputerAccess } from '../../platform/substrate/startupMenu.js'
import { modeBypassesPermissions } from '../../permissions/rules/permissionMode.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { COMPUTER_TOOL_NAME } from '../../integrations/desktop/toolName.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './rows.js'
import { COMPUTER_PROMPT } from './prompt.js'
import { readFileSync } from 'node:fs'
import { errorMessage } from '../../platform/errors/errors.js'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import type { PermissionDecision, ToolPermissionContext } from '../../permissions/rules/permissions.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
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
} from './call/schema.js'
import { challengeAction, challengeVerdict, isPlanRefusal, ownTerminalRefusal, planOf } from './call/plan.js'
import { actDetail, faultText } from './call/act.js'
import { denied, routeRefusal, ruleFor, ruleVerdict } from './call/shot.js'
import { computerCall } from './call/call.js'

export { COMPUTER_TOOL_NAME }
export { computerToolEnabled, HOLD_CAP_MS, TREE_DEPTH_CAP, TREE_DEPTH_DEFAULT, TREE_LIMIT_CAP, TREE_LIMIT_DEFAULT, TYPE_TEXT_CAP } from './call/schema.js'
export type { Input, Output } from './call/schema.js'

export const ComputerTool = buildTool({
  name: COMPUTER_TOOL_NAME,
  searchHint: 'inspect desktop applications and operate their mouse and keyboard',
  searchKeywords: ['computer use', 'screen', 'mouse', 'keyboard', 'desktop', 'screenshot', 'click', 'type', 'scroll', 'press', 'keys', 'application', 'window', 'control', 'native app', 'automate', 'GUI'],
  capability: {
    intents: [
      'see the screen and drive the mouse and keyboard',
      'take a screenshot of the desktop',
      'click, type, scroll or press keys in the application in front',
      'find out which application is in front',
    ],
    units: ['desktop-drive'],
    class: 'execution',
    operations: [...ACTIONS],
    execution: { kind: 'desktop-session', representation: 'child-execution' },
    evidence: ['artifact'],
    resources: [],
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_COMPUTER_USE',
    conditions: ['a desktop driver that resolves (the native driver pack; MERCURY_DESKTOP_DRIVER=none switches it off)'],
    proof: 'scripts/computer/prove-computer-asks.ts',
  },
  maxResultSizeChars: 20_000,
  async description() {
    return "Drive the operator's screen: screenshot, click, type, press keys, scroll and drag in the application in front, on every model route that receives images"
  },
  async prompt() {
    return COMPUTER_PROMPT
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  get inputJSONSchema() {
    return zodToJsonSchema(modelInputSchema())
  },
  isEnabled() {
    return computerToolEnabled()
  },
  isConcurrencySafe(input: Input) {
    return FACT_ACTIONS.has(input?.action)
  },
  isReadOnly(input: Input) {
    return input?.action !== 'sequence' && READ_ACTIONS.has(input ? permissionAction(input) : '')
  },
  requiresUserInteraction() {
    return computerAccessPinnedToAsk()
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (!flagEnabled('MERCURY_COMPUTER_USE')) {
      return refuse("the Computer tool is off — MERCURY_COMPUTER_USE=0 in this session's environment removes it; unset it before the session starts")
    }
    const posture = desktopPostureRefusal(context)
    if (posture !== null && context.agentId) return refuse(posture)
    const model = context?.options?.engineModel ?? getEngineModel()
    const route = await routeRefusal(model, context.abortController?.signal)
    if (route !== null) return refuse(route)
    const resolution = resolveDesktopDriver()
    if (resolution.state === 'unavailable') {
      return refuse(`no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`)
    }
    const table = tableRefusal(input)
    if (table !== null) return refuse(table)
    return { result: true as const }
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const posture = desktopPostureRefusal(context)
    if (posture !== null && !context.agentId) return denied(posture, 'desktop session policy')
    if (input.action === 'read' && input.clipboard === true) {
      const permissionContext = context.getAppState?.()?.toolPermissionContext as ToolPermissionContext | undefined
      const rule = ruleFor(permissionContext, 'clipboard')
      if (rule?.ruleBehavior === 'deny') return denied(ruleSentence('Reading the clipboard', 'deny', rule), 'clipboard carries a deny rule')
      if (rule?.ruleBehavior === 'allow') return { behavior: 'allow' as const, updatedInput: input }
      return { behavior: 'ask' as const, message: 'Computer read clipboard — read the clipboard text', decisionReason: { type: 'safetyCheck' as const, reason: 'Clipboard text needs separate consent', operatorOnly: true }, suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, 'clipboard') }
    }
    if (!ASK_ACTIONS.has(permissionAction(input))) return { behavior: 'allow' as const, updatedInput: input }
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const resolution = resolveDesktopDriver()
    if (resolution.state !== 'ok') return { behavior: 'allow' as const, updatedInput: input }
    const driver = resolution.driver
    const front = await driver.frontmostApplication()
    if (!front.ok) {
      return denied(
        `Computer ${input.action} refused: the application in front could not be read — ${front.error.note}`,
        'the application in front is unknown',
      )
    }
    let app = front.value
    const home = noteTurnHome(owner, turnKeyOf(context), { identity: app.identity, name: app.name })
    if (input.action === 'focusApp') {
      if (!driver.findApplication) return denied('focusApp is unavailable in this desktop driver', 'application lookup unavailable')
      const target = await driver.findApplication(input.focusApp!.name)
      if (!target.ok) return denied(faultText('focusApp', target.error), 'application not found')
      app = target.value
    }
    const plan = planOf(owner, context, input)
    if (isPlanRefusal(plan)) return denied(plan.refusal, 'the act has no screenshot frame')
    const terminal = permissionAction(input) === 'tree' || input.action === 'focusApp' ? null : await ownTerminalRefusal(driver, input, app, plan)
    if (terminal !== null) return denied(terminal, 'the own-terminal guard refused the act')
    const permissionContext = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()
      ?.toolPermissionContext as ToolPermissionContext | undefined
    const content = `app:${app.identity}`
    const ruled = ruleVerdict(permissionContext, content)
    if (ruled === 'deny') {
      return denied(ruleSentence(`Driving ${app.name} (${app.identity})`, 'deny', ruleFor(permissionContext, content)!), `${content} carries a deny rule`)
    }
    noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name })
    const asked = (decision: PermissionDecision): PermissionDecision => {
      if (decision.behavior === 'ask') markCheckedActAsked(owner)
      return decision
    }
    const challenge = (viaGrant: boolean): PermissionDecision => {
      if (input.captcha !== true || !ACT_ACTIONS.has(input.action)) return { behavior: 'allow' as const, updatedInput: input }
      const verdict = challengeVerdict(input, app, context)
      if (verdict.verdict === 'deny') return denied(`Computer ${input.action} not done: ${verdict.text}`, 'captcha carries a deny rule')
      noteCheckedActApp(owner, challengeAction(input.action), { identity: app.identity, name: app.name }, viaGrant)
      return verdict.verdict === 'allow' ? { behavior: 'allow' as const, updatedInput: input } : asked(verdict.decision)
    }
    if (ruled === 'allow' || (ruled === null && appApproved(owner, app.identity))) return challenge(false)
    const access = resolveComputerAccess(savedComputerAccess(), permissionContext !== undefined && modeBypassesPermissions(permissionContext.mode))
    const opened = access.value === 'full' || (access.value === 'permissive' && home.identity === app.identity)
    if (ruled === null && (opened || readComputerGrant(String(getSessionId())) !== null)) {
      noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name }, true)
      return challenge(true)
    }
    return asked({
      behavior: 'ask' as const,
      message: `Computer ${input.action}${actDetail(input)} in ${app.name} (${app.identity}) — the first act this session (${permissionAction(input) === 'tree' ? 'reads its accessibility tree: the controls with their titles, values and frames' : input.action === 'focusApp' ? 'brings this application to the front' : 'drives your mouse and keyboard'})`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: `${app.name} (${app.identity}) is in front of the operator's screen; the first act of the session needs the operator's own consent`,
        operatorOnly: true,
      },
      suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, content),
    })
  },
  call(input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, parentAssistantMessage?: AssistantMessage): Promise<{ data: Output; effect: ToolEffect }> {
    return computerCall(ComputerTool, input, context, canUseTool, parentAssistantMessage)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    if (output.imagePath && modelReceivesImageBlocks(getEngineModel())) {
      const path = output.inlinePath ?? output.imagePath
      try {
        const bytes = readFileSync(path)
        const mediaType = (output.inlinePath ? (output.inlineMediaType ?? 'image/png') : 'image/png') as 'image/png'
        return {
          tool_use_id: toolUseId,
          type: 'tool_result' as const,
          content: [
            { type: 'text' as const, text: output.result },
            {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: mediaType, data: bytes.toString('base64') },
            },
          ],
        }
      } catch (error) {
        return {
          tool_use_id: toolUseId,
          type: 'tool_result' as const,
          content: `${output.result}\n(image not inlined — could not read ${path} (${errorMessage(error)}))`,
        }
      }
    }
    const text =
      output.imagePath && !modelReceivesImageBlocks(getEngineModel())
        ? `${output.result}\n(image not inlined — this model takes no image input; open the file to view it)`
        : output.result
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: text,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText({ result }) {
    return result
  },
})
