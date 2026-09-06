
import { permissionRuleValueFromString, permissionRuleValueToString } from '../utils/permissions/permissionRuleParser.js'

type KeyRename = {
  from: readonly string[]
  to: readonly string[]
  value: 'same' | 'disableWord'
}

export const RETIRED_SETTINGS_KEYS: readonly KeyRename[] = [
  { from: ['permissions', 'disableBypassPermissionsMode'], to: ['permissions', 'disableSovereignMode'], value: 'disableWord' },
  { from: ['permissions', 'disableAutoMode'], to: ['permissions', 'disableFlowMode'], value: 'disableWord' },
  { from: ['disableAutoMode'], to: ['permissions', 'disableFlowMode'], value: 'disableWord' },
  { from: ['skipDangerousModePermissionPrompt'], to: ['skipSovereignConsentPrompt'], value: 'same' },
  { from: ['autoDreamEnabled'], to: ['memoryUpkeepEnabled'], value: 'same' },
  { from: ['showClearContextOnPlanAccept'], to: ['showClearContextOnStrategyAccept'], value: 'same' },
]

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(root: Rec, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

function write(root: Rec, path: readonly string[], value: unknown): Rec {
  const next = { ...root }
  let node: Rec = next
  for (const key of path.slice(0, -1)) {
    const child = node[key]
    const cloned = isRecord(child) ? { ...child } : {}
    node[key] = cloned
    node = cloned
  }
  node[path[path.length - 1]!] = value
  return next
}

function remove(root: Rec, path: readonly string[]): Rec {
  const next = { ...root }
  let node: Rec = next
  for (const key of path.slice(0, -1)) {
    const child = node[key]
    if (!isRecord(child)) return root
    const cloned = { ...child }
    node[key] = cloned
    node = cloned
  }
  delete node[path[path.length - 1]!]
  return next
}

function carriedValue(rename: KeyRename, raw: unknown): { carry: boolean; value?: unknown } {
  if (rename.value === 'same') return { carry: true, value: raw }
  return raw === 'disable' ? { carry: true, value: true } : { carry: false }
}

function rewriteKeys(settings: Rec): Rec {
  let next = settings
  for (const rename of RETIRED_SETTINGS_KEYS) {
    const raw = read(next, rename.from)
    if (raw === undefined) continue
    next = remove(next, rename.from)
    const { carry, value } = carriedValue(rename, raw)
    if (carry && read(next, rename.to) === undefined) next = write(next, rename.to, value)
  }
  return next
}

const RULE_LISTS = ['allow', 'deny', 'ask'] as const

function rewriteToolNames(settings: Rec): Rec {
  let next = settings
  const permissions = next.permissions
  if (isRecord(permissions)) {
    for (const list of RULE_LISTS) {
      const rules = permissions[list]
      if (!Array.isArray(rules)) continue
      const rewritten = rules.map(rule => (typeof rule === 'string' ? normalizeToolRuleString(rule) : rule))
      if (rewritten.some((rule, i) => rule !== rules[i])) next = write(next, ['permissions', list], rewritten)
    }
  }
  const hooks = next.hooks
  if (isRecord(hooks)) {
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue
      let changed = false
      const rewrittenEntries = entries.map(entry => {
        if (!isRecord(entry)) return entry
        let out = entry
        if (typeof entry.matcher === 'string') {
          const matcher = normalizeMatcherSpelling(entry.matcher)
          if (matcher !== entry.matcher) out = { ...out, matcher }
        }
        const hookList: unknown = entry.hooks
        if (Array.isArray(hookList)) {
          const hooksOut = hookList.map((hook: unknown) => {
            if (!isRecord(hook) || typeof hook.if !== 'string') return hook
            const cond = normalizeToolRuleString(hook.if)
            return cond === hook.if ? hook : { ...hook, if: cond }
          })
          if (hooksOut.some((hook, i) => hook !== hookList[i])) out = { ...out, hooks: hooksOut }
        }
        if (out !== entry) changed = true
        return out
      })
      if (changed) next = write(next, ['hooks', event], rewrittenEntries)
    }
  }
  return next
}

export function normalizeMatcherSpelling(matcher: string): string {
  if (!/^[a-zA-Z0-9_|]+$/.test(matcher)) return matcher
  return matcher
    .split('|')
    .map(name => normalizeToolRuleString(name))
    .join('|')
}

export function rewriteRetiredSettingsSpellings(settings: unknown): unknown {
  if (!isRecord(settings)) return settings
  return rewriteToolNames(rewriteKeys(settings))
}

export const RETIRED_TOOL_NAMES: Readonly<Record<string, string>> = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  AgentOutputTool: 'TaskOutput',
  BashOutputTool: 'TaskOutput',
  ListMcpResourcesTool: 'ListMcpResources',
  ReadMcpResourceTool: 'ReadMcpResource',
  contract: 'Contract',
  EnterPlanMode: 'EnterStrategyMode',
  ExitPlanMode: 'ExitStrategyMode',
}

export function normalizeToolRuleString(rule: string): string {
  const parsed = permissionRuleValueFromString(rule)
  const current = RETIRED_TOOL_NAMES[parsed.toolName]
  if (current === undefined) return rule
  return permissionRuleValueToString({ ...parsed, toolName: current })
}
