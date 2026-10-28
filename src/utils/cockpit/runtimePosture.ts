
import { listCapabilityKills } from '../permissions/capabilityGate.js'
import { isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { canAnswerAsks, getSessionKind } from '../../bootstrap/state.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../permissions/PermissionResult.js'

export function runtimePostureEnabled(): boolean {
  if (flagEnv('MERCURY_RUNTIME_POSTURE') === '0') return false
  return true
}

let nonInteractive = false
let bootPermissionMode: string | undefined
let bootRules: ToolPermissionContext | undefined

export function markSessionNonInteractive(permissionMode?: string): void {
  nonInteractive = true
  if (permissionMode) bootPermissionMode = permissionMode
}

export function markSessionBootRules(context: ToolPermissionContext): void {
  bootRules = context
}

const MODE_LINE = 'Permission mode for this run: '

export function permissionModeChangedReminder(permissionMode: string, bootMode: string | undefined): string {
  return `${MODE_LINE}${permissionMode} (changed by the operator${bootMode ? ` from ${bootMode}` : ''} after boot; the Runtime posture section states the mode at boot).`
}

export function markSessionPermissionMode(permissionMode: string | undefined): string | null {
  if (!permissionMode || permissionMode === bootPermissionMode) return null
  const previous = bootPermissionMode
  bootPermissionMode = permissionMode
  if (memo === undefined) return null
  return memo !== null && memo.includes(MODE_LINE) ? permissionModeChangedReminder(permissionMode, previous) : null
}

export function markSessionPermissionModeAtClaim(permissionMode: string | undefined): void {
  if (permissionMode) bootPermissionMode = permissionMode
  memo = undefined
}

export const OCULUS_POSTURE_LINE =
  '- Session: oculus (a screen belongs to this session): the operator is on the screen; ask them as you normally would — a question to the operator (AskUserQuestion) or a tool call that needs approval travels to the screen and waits for their answer, and nothing expires it. They may be away for a while, so a slow answer is not "nobody is here". A denial is policy, not tool failure: prefer tools your rules allow.'

export const OCULUS_DOCTRINE_LINE =
  'Runtime posture: this process is an oculus session: a screen belongs to it, so a permission ask or a question travels to the operator\'s screen and waits for their answer (they may be away for a while — a slow answer is not "nobody is here"); a denial is policy, not tool failure; a file-lease denial means another agent holds those paths (coordinate, do not force).'

const PUSH_PROBE = 'git push'
const PUSH_RULE_SHAPE = '`Bash(git push *)`'
const PUSH_ROADS = `an allow rule such as ${PUSH_RULE_SHAPE} (guardrails.allow in settings, or --allowed-tools)`
const HUMAN_CALLS = 'a question to the operator (AskUserQuestion), a review approval (ApolloReview) and every other tool that requires a human'

function pushVerdictAtBoot(context: ToolPermissionContext): PermissionResult | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bash = require('../../tools/BashTool/bashPermissions.js') as typeof import('../../tools/BashTool/bashPermissions.js')
    return bash.readBashRuleVerdict({ command: PUSH_PROBE }, context)
  } catch {
    return null
  }
}

function ruleWordsOf(verdict: PermissionResult): string {
  const reason = 'decisionReason' in verdict ? verdict.decisionReason : undefined
  if (reason?.type !== 'rule') return ''
  const { toolName, ruleContent } = reason.rule.ruleValue
  return `\`${ruleContent ? `${toolName}(${ruleContent})` : toolName}\` (${reason.rule.source})`
}

function modeRoad(mode: string): string {
  switch (mode) {
    case 'flow':
      return 'and under flow any call no allow rule covers and no shortcut settles (the read-only lane, the read-only tools and workspace file edits aside) — anything visible outside this machine (`git push` among them), anything destructive or outside the workspace, a new install'
    case 'default':
      return 'and under default any call no allow rule covers (the read-only lane aside)'
    case 'implement':
      return 'and under implement any call no allow rule covers (the read-only lane and workspace file edits aside)'
    case 'sovereign':
      return `and nothing else under ${mode}: every other call runs under the bypass posture (a deny rule still refuses)`
    default:
      return 'and any call no allow rule covers'
  }
}

function pushClause(mode: string, verdict: PermissionResult | null): string | null {
  if (verdict === null) return null
  const bypass = mode === 'sovereign'
  if (verdict.behavior === 'allow') return `\`git push\` is pre-authorised at boot by the allow rule ${ruleWordsOf(verdict)} and runs without the channel`
  if (verdict.behavior === 'deny') return `\`git push\` is refused at boot by the deny rule ${ruleWordsOf(verdict)} and is never asked`
  if (verdict.behavior === 'ask') {
    if (mode === 'dontAsk') return `\`git push\` is pinned to the operator at boot by the ask rule ${ruleWordsOf(verdict)}, which dontAsk turns into a denial`
    if (bypass) return `the ask rule ${ruleWordsOf(verdict)} on \`git push\` stands down under the bypass posture`
    return `\`git push\` is pinned to the operator at boot by the ask rule ${ruleWordsOf(verdict)}`
  }
  const unruled = '`git push` is not pre-authorised at boot by the permission rules this seat carries'
  if (bypass) return `${unruled} and runs under the bypass posture`
  if (mode === 'dontAsk') return `${unruled} and is denied under dontAsk — ${PUSH_ROADS} lets it run`
  return `${unruled}, so a push waits on the operator — ${PUSH_ROADS} lets it run without the channel`
}

export function composeOperatorNeedsLine(mode: string | undefined, context: ToolPermissionContext | undefined): string | null {
  if (context === undefined) return null
  const road = mode ?? context.mode
  const push = pushClause(road, pushVerdictAtBoot(context))
  const tail = push === null ? '' : `; ${push}`
  if (road === 'dontAsk') {
    return `- Needs a present operator at boot: nothing travels the channel under dontAsk — every ask, a question to the operator included, is denied${tail}.`
  }
  return `- Needs a present operator at boot (the call travels the channel and waits for the client's answer): ${HUMAN_CALLS}, ${modeRoad(road)}${tail}.`
}

export function isSessionMarkedNonInteractive(): boolean {
  return nonInteractive
}

let memo: string | null | undefined

export function getRuntimePostureSection(): string | null {
  if (memo !== undefined) return memo
  if (!runtimePostureEnabled()) {
    memo = null
    return memo
  }

  const lines: string[] = []

  if (nonInteractive && canAnswerAsks() && getSessionKind() === 'oculus') {
    lines.push(
      OCULUS_POSTURE_LINE +
        (bootPermissionMode ? ` ${MODE_LINE}${bootPermissionMode}.` : ''),
    )
    const needs = composeOperatorNeedsLine(bootPermissionMode, bootRules)
    if (needs !== null) lines.push(needs)
  } else if (nonInteractive && canAnswerAsks()) {
    lines.push(
      '- Session: non-interactive (mercury runner) with a host that holds the asks: a tool call that needs approval is put to the connected host, which answers allow or deny; a question to the operator travels the same door. A denial is policy, not tool failure: prefer tools your rules allow. An ask the host leaves unanswered ends the run as blocked, with the question on its outcome row.' +
        (bootPermissionMode ? ` ${MODE_LINE}${bootPermissionMode}.` : ''),
    )
    const needs = composeOperatorNeedsLine(bootPermissionMode, bootRules)
    if (needs !== null) lines.push(needs)
  } else if (nonInteractive) {
    lines.push(
      '- Session: non-interactive (mercury run): no human is at a prompt and no host answers an ask, so a tool call that would need an interactive approval is denied automatically and no question can reach the operator — choose the most reasonable option, state the assumption, and continue. A denial is policy, not tool failure: prefer tools your rules allow. When nothing reasonable remains without the operator, still ask through AskUserQuestion and end your turn: that unanswered question ends the run as blocked with your question on its outcome row, which is how a scripted run tells stuck from done — a question written only in your answer reads as done.',
    )
  }

  const kills = listCapabilityKills()
  const killList = Object.entries(kills).flatMap(([agent, tools]) =>
    tools.map(t => (agent === '*' || agent === '' ? t : `${agent}:${t}`)),
  )
  if (killList.length > 0) {
    lines.push(`- Capability kills armed at boot: ${killList.join(', ')} (MERCURY_KILL — absolute; no mode, including bypass, overrides a kill).${nonInteractive ? '' : ' Live state: /kill.'}`)
  }

  if (isMcpPolicyActive()) {
    lines.push(`- MCP tool-risk policy: ${describeMcpPolicy()} — higher-risk MCP tools are blocked by policy, not broken.`)
  }

  memo = lines.length === 0 ? null : ['# Runtime posture (this process, at boot)', ...lines].join('\n')
  return memo
}

export function getRuntimePostureDoctrineLine(): string | null {
  if (!runtimePostureEnabled() || !nonInteractive) return null
  if (canAnswerAsks() && getSessionKind() === 'oculus') return OCULUS_DOCTRINE_LINE
  return 'Runtime posture: this process is headless: an unanswerable permission ask is denied automatically, and a denial is policy, not tool failure; a file-lease denial means another agent holds those paths (coordinate, do not force).'
}

export function resetRuntimePostureForTest(): void {
  memo = undefined
  nonInteractive = false
  bootPermissionMode = undefined
  bootRules = undefined
}
