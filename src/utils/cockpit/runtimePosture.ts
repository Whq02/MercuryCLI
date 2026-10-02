
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { listCapabilityKills } from '../permissions/capabilityGate.js'
import { isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { canAnswerAsks } from '../../bootstrap/state.js'
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

const PUSH_PROBE = 'git push'
const PUSH_RULE_SHAPE = '`Bash(git push:*)`'
const PUSH_ROADS = `an allow rule such as ${PUSH_RULE_SHAPE} (guardrails.allow in settings, or --allowed-tools)`
const HUMAN_CALLS = 'a question to the operator (AskUserQuestion), a review approval (ApolloReview) and every other tool that requires a human'

function pushVerdictAtBoot(context: ToolPermissionContext): PermissionResult | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bash = require('../../tools/BashTool/bashPermissions.js') as typeof import('../../tools/BashTool/bashPermissions.js')
    return bash.bashToolCheckPermission({ command: PUSH_PROBE }, context)
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
      return 'and under flow any call the flow check blocks — anything visible outside this machine (`git push` among them), anything destructive or outside the workspace, a new install'
    case 'default':
      return 'and under default any call no allow rule covers (the read-only lane aside)'
    case 'implement':
      return 'and under implement any call no allow rule covers (the read-only lane and workspace file edits aside)'
    case 'strategy':
      return 'and under strategy the plan approval itself — a shell command that would change anything is refused until the plan is approved'
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
  if (mode === 'strategy') return `${unruled} and is refused until the plan is approved; after that a push waits on the operator unless ${PUSH_ROADS} pre-authorises it`
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

  const lines: string[] = ['# Runtime posture (this process, at boot)']

  if (nonInteractive && canAnswerAsks()) {
    lines.push(
      '- Session: NON-INTERACTIVE (mercury run / rows) with a permission channel: a tool call that needs approval is put to the connected client, which answers allow or deny; a question to the operator travels the same channel. Do not retry a denied call unchanged and do not invent tool failure as the cause — prefer tools your rules allow, or state the policy blocker plainly in your output.' +
        (bootPermissionMode ? ` Permission mode for this run: ${bootPermissionMode}.` : ''),
    )
    const needs = composeOperatorNeedsLine(bootPermissionMode, bootRules)
    if (needs !== null) lines.push(needs)
  } else if (nonInteractive) {
    lines.push(
      '- Session: NON-INTERACTIVE (mercury run / rows). There is no human at a prompt and no permission channel: any tool call that would need an interactive permission approval is DENIED automatically, and no question can reach the operator — choose the most reasonable option, state the assumption, and continue. Do not retry a denied call unchanged and do not invent tool failure as the cause — prefer tools your rules allow, or state the policy blocker plainly in your output.' +
        (bootPermissionMode ? ` Permission mode for this run: ${bootPermissionMode}.` : ''),
    )
  } else {
    lines.push(
      '- Session: interactive. Permission asks reach the operator; the current mode is on the shift+tab carousel and can change mid-session.',
    )
  }

  const kills = listCapabilityKills()
  const killList = Object.entries(kills).flatMap(([agent, tools]) =>
    tools.map(t => (agent === '*' || agent === '' ? t : `${agent}:${t}`)),
  )
  lines.push(
    killList.length > 0
      ? `- Capability kills armed at boot: ${killList.join(', ')} (MERCURY_KILL — absolute; no mode, including bypass, overrides a kill).${nonInteractive ? '' : ' Live state: /substrate.'}`
      : `- Capability kills armed at boot: none.${nonInteractive ? '' : ' (Kills can be armed mid-session via /kill; live state: /substrate.)'}`,
  )

  lines.push(
    isMcpPolicyActive()
      ? `- MCP tool-risk policy: ${describeMcpPolicy()} — higher-risk MCP tools are blocked by policy, not broken.`
      : '- MCP tool-risk policy: permissive (no max-risk cap set).',
  )

  lines.push(
    isAgentSwarmsEnabled()
      ? '- Crew tooling (swarms) available: file leases guard concurrent edits (a lease denial is coordination, not an error); LiveComms carries the crew\'s live state.'
      : '- Crew tooling (swarms): off for this process.',
  )

  memo = lines.join('\n')
  return memo
}

export function getRuntimePostureDoctrineLine(): string | null {
  if (!runtimePostureEnabled()) return null
  const denyClause = nonInteractive
    ? 'this process is HEADLESS — an unanswerable permission ask is an automatic DENY; treat a denied tool as policy, not failure, and say so instead of retrying'
    : 'a denied tool call may be permission policy, not tool failure — say which it was'
  return `Runtime posture: ${denyClause}; a file-lease denial means another agent holds those paths (coordinate, do not force).`
}

export function resetRuntimePostureForTest(): void {
  memo = undefined
  nonInteractive = false
  bootPermissionMode = undefined
  bootRules = undefined
}
