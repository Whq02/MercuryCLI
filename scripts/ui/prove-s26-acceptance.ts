#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-s26-acceptance.ts — the acceptance battery, following
//  the lane idiom: pure importable surfaces are exercised
//  BEHAVIOURALLY in-process; hook/render semantics (no in-process ink render
//  harness exists) are pinned STRUCTURALLY on the rewritten sources. The
//  rendered behaviour itself is covered by the parcel's real-TUI captures;
//  the /diff textual ratchets live in prove-diff-continuity.
//
//  Coverage map:
//  · behavioural: the dangerous-settings model, the shared reconnect
//    outcome mapper, hunkPatchText (the patch grammar), the
//    memory path helper, the null-rendering registry's type census
//    and the LooseMsg envelope spelling.
//  · structural pins: owner-consumption (hooksConfigManager, versions.ts,
//    useMinDisplayTime, getEmptyToolPermissionContext, setClipboard), the
//    summariser's block-name key, classifier capture-and-delete,
//    unmount aborts in the OAuth surfaces, the elicitation dialog's
//    validation-owner imports and shell-cancel disarm, /help's composer
//    seed, the hooks browser's read-only vocabulary.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'

import {
  dangerousSettingNames,
  extractDangerousSettings,
  hasDangerousSettings,
  hasDangerousSettingsChanged,
} from '../../src/components/ManagedSettingsSecurityDialog/utils.js'
import { describeReconnectOutcome } from '../../src/components/mcp/utils/reconnectHelpers.js'
import { hunkPatchText } from '../../src/components/diff/DiffDialog.js'
import { getRelativeMemoryPath } from '../../src/components/memory/MemoryUpdateNotification.js'
import {
  NULL_RENDERING_ATTACHMENT_TYPES,
  isNullRenderingAttachment,
} from '../../src/components/messages/nullRenderingAttachments.js'
import type { SettingsJson } from '../../src/utils/settings/types.js'

let failures = 0
let passes = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++
    console.log(`  [PASS] ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(name: string): void {
  console.log(`\n── ${name} ──`)
}
const ROOT = new URL('../../', import.meta.url).pathname
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

// ── the dangerous-settings model (behavioural) ─────────────────────────
section('dangerous-settings model')
{
  const empty = extractDangerousSettings({} as SettingsJson)
  check('empty settings extract as not dangerous', !hasDangerousSettings(empty))

  const shell = extractDangerousSettings({
    apiKeyHelper: 'echo key',
    statusLine: '',
  } as unknown as SettingsJson)
  check(
    'non-empty shell-executing keys are dangerous; empty strings are not',
    hasDangerousSettings(shell) &&
      Object.keys(shell.shellSettings).join(',') === 'apiKeyHelper',
  )

  const env = extractDangerousSettings({
    env: { PATH: '/bin', SOME_TOKEN: 'x', http_proxy: 'y', EMPTY: '' },
  } as unknown as SettingsJson)
  check(
    'env vars are deny-by-default against the shared allow-list (upper-cased)',
    Object.keys(env.envVars).includes('SOME_TOKEN') &&
      !Object.keys(env.envVars).includes('EMPTY'),
  )

  const hooks = extractDangerousSettings({
    hooks: { PreToolUse: [] },
  } as unknown as SettingsJson)
  check('a non-empty hooks object is dangerous', hasDangerousSettings(hooks))
  const noHooks = extractDangerousSettings({ hooks: {} } as unknown as SettingsJson)
  check('an empty hooks object is not', !hasDangerousSettings(noHooks))

  const oldDoc = { apiKeyHelper: 'echo a' } as unknown as SettingsJson
  const changedValue = { apiKeyHelper: 'echo b' } as unknown as SettingsJson
  const safeDoc = {} as SettingsJson
  check('not-dangerous incoming never requires approval', !hasDangerousSettingsChanged(oldDoc, safeDoc))
  check('danger appearing over a safe cache requires approval', hasDangerousSettingsChanged(safeDoc, oldDoc))
  check('a changed VALUE requires re-approval', hasDangerousSettingsChanged(oldDoc, changedValue))
  check('an identical document does not', !hasDangerousSettingsChanged(oldDoc, oldDoc))
  check('a null cache requires approval when dangerous', hasDangerousSettingsChanged(null, oldDoc))

  const names = dangerousSettingNames(
    extractDangerousSettings({
      apiKeyHelper: 'echo topsecret',
      env: { A_TOKEN: 'sekrit' },
      hooks: { Stop: [] },
    } as unknown as SettingsJson),
  )
  check(
    'the UI list is names only — shell keys, env names, then the hooks token',
    names.join(',') === 'apiKeyHelper,A_TOKEN,hooks',
  )
  check(
    'no configured VALUE leaks into the list',
    !names.some(name => name.includes('topsecret') || name.includes('sekrit')),
  )
}

// ── the shared reconnect outcome mapper (behavioural) ────────────────
section('reconnect outcome mapper')
{
  const config = { type: 'stdio', command: 'x', scope: 'user' } as never
  check(
    'connected reads as success',
    describeReconnectOutcome('srv', { type: 'connected', name: 'srv', config } as never).success,
  )
  const needsAuth = describeReconnectOutcome('srv', {
    type: 'needs-auth',
    name: 'srv',
    config,
  } as never)
  check(
    'needs-auth fails and points at the authenticate option in /mcp',
    !needsAuth.success && needsAuth.message.includes('/mcp') && needsAuth.message.toLowerCase().includes('authenticate'),
  )
  check(
    'failed reads as failure',
    !describeReconnectOutcome('srv', { type: 'failed', name: 'srv', config } as never).success,
  )
  check(
    'anything else (pending/disabled/missing) is the unknown fallback',
    !describeReconnectOutcome('srv', undefined).success &&
      describeReconnectOutcome('srv', { type: 'pending', name: 'srv', config } as never).message.includes('unknown'),
  )
}

// ── hunkPatchText (behavioural) ──────────────────────────────────────
section('hunk patch grammar')
{
  const patch = hunkPatchText('src/a.ts', {
    oldStart: 3,
    oldLines: 2,
    newStart: 3,
    newLines: 3,
    lines: [' ctx', '-old', '+new', '+more'],
  } as never)
  const lines = patch.split('\n')
  check('header names the file on both sides', lines[0] === '--- a/src/a.ts' && lines[1] === '+++ b/src/a.ts')
  check('the @@ header carries -old,oldLines +new,newLines', lines[2] === '@@ -3,2 +3,3 @@')
  check('the hunk lines follow verbatim', lines[3] === ' ctx' && lines[5] === '+new')
  check('the patch is newline-terminated', patch.endsWith('+more\n'))
}

// ── the memory path helper (behavioural) ───────────────────────────────
section('memory path helper')
{
  const { getCwd } = await import('../../src/utils/cwd.js')
  const os = await import('node:os')
  const cwd = getCwd()
  const inCwd = join(cwd, 'X.md')
  const rel = getRelativeMemoryPath(inCwd)
  check('a cwd file renders cwd-relative (./…) when shorter', rel === './X.md' || rel.startsWith('~'), `got ${rel}`)
  const home = os.homedir()
  const inHome = join(home, 'Y.md')
  check('a home file renders home-relative (~/…)', getRelativeMemoryPath(inHome) === '~/Y.md')
  check('an unrelated absolute path stays absolute', getRelativeMemoryPath('/opt/z.md') === '/opt/z.md')
}

// ── the null-rendering registry (behavioural census) ──────────────
section('null-rendering registry')
{
  const asMessage = (type: string) =>
    ({ type: 'attachment', attachment: { type } }) as never
  check(
    'the registry is a non-empty set with the membership predicate agreeing',
    NULL_RENDERING_ATTACHMENT_TYPES.length > 0 &&
      NULL_RENDERING_ATTACHMENT_TYPES.every(type =>
        isNullRenderingAttachment(asMessage(type)),
      ),
  )
  check('a rendered kind is NOT in the registry', !isNullRenderingAttachment(asMessage('file')))
  const dispatcher = src('src/components/messages/AttachmentMessage.tsx')
  check(
    "the dispatcher's default branch asserts registry membership (type-system sync)",
    dispatcher.includes('NullRenderingAttachmentType = attachment.type'),
  )
}

// ── structural pins ─────────────────────────────────────────────────────────
section('structural pins — owner consumption (rule 4)')
{
  const hooksMenu = src('src/components/hooks/HooksConfigMenu.tsx')
  check(
    'the hooks browser consumes the ONE metadata/grouping owner',
    hooksMenu.includes('getHookEventMetadata') &&
      hooksMenu.includes('groupHooksByEventAndMatcher') &&
      hooksMenu.includes('getSortedMatchersForEvent'),
  )
  check(
    'no hand-authored event-summary table survives',
    !hooksMenu.includes('EVENT_SUMMARIES'),
  )
  check(
    'matcher support comes from the metadata, not a hand list',
    hooksMenu.includes('matcherMetadata !== undefined') && !hooksMenu.includes('MATCHERLESS_EVENTS'),
  )

  const memSel = src('src/components/memory/MemoryFileSelector.tsx')
  check(
    'the git-repo answer comes from the versions owner',
    memSel.includes('projectIsInGitRepo') && !memSel.includes('findGitRoot'),
  )
  check(
    'the picker suspends on the memoised discovery promise',
    memSel.includes('use(getInstructionFiles())'),
  )
  check(
    'the dream row visibility is latched at mount',
    memSel.includes('const [showDreamRow] = useState(() => isAutoMemoryEnabled())'),
  )

  const collapsed = src('src/components/messages/CollapsedReadSearchContent.tsx')
  check(
    'the 700 ms hint floor is the shared min-display-time hook',
    collapsed.includes('useMinDisplayTime(rawHint, HINT_MIN_DISPLAY_MS)'),
  )
  check(
    'the REPL retry resolves through the primitive registry, keyed by the name set',
    collapsed.includes('REPL_ONLY_TOOLS.has(entry.name)') &&
      collapsed.includes('getReplPrimitiveTools()'),
  )

  const toolDetail = src('src/components/mcp/MCPToolDetailView.tsx')
  check(
    'the description probe uses the EMPTY permission-context owner',
    toolDetail.includes('getEmptyToolPermissionContext()') &&
      toolDetail.includes('isNonInteractiveSession: false'),
  )

  const dialog = src('src/components/diff/DiffDialog.tsx')
  check(
    'both diff copies route through the shared OSC-52 clipboard writer',
    (dialog.match(/setClipboard\(/g) ?? []).length === 2 &&
      dialog.includes('process.stdout.write(sequence)'),
  )
  check(
    'the editor open goes through the line-capable owner',
    dialog.includes('openFileInExternalEditor(') && dialog.includes('$VISUAL or $EDITOR'),
  )
}

section('structural pins — transcript renderers')
{
  const success = src('src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx')
  check(
    'the inline-summary suppression keys on the TOOL-USE BLOCK name',
    success.includes('lookups.toolUseByToolUseID.get(toolUseID)?.name'),
  )
  check(
    'classifier bookkeeping captures once at mount then deletes',
    success.includes('deleteClassifierApproval(toolUseID)') && success.includes('useState(() => {'),
  )
  check(
    'a declared output schema gates rendering',
    success.includes('outputSchema.safeParse') && success.includes('if (!parsed.success) return null'),
  )
  const reject = src('src/components/messages/UserToolResultMessage/UserToolRejectMessage.tsx')
  check(
    'the reject path falls back to the shared element and never renders empty',
    (reject.match(/FallbackToolUseRejectedMessage/g) ?? []).length >= 4,
  )
  const teammate = src('src/components/messages/UserTeammateMessage.tsx')
  check(
    'LooseMsg calls spell the content member (never text)',
    teammate.includes('({ content: message.content })') && !teammate.includes('({ text: message.content })'),
  )
}

section('structural pins — OAuth surfaces + elicitation')
{
  const remote = src('src/components/mcp/MCPRemoteServerMenu.tsx')
  check(
    'unmount aborts the flow, clears the copy timer, and marks unmounted',
    remote.includes('abortRef.current?.abort()') &&
      remote.includes('clearTimeout(copyTimerRef.current)') &&
      remote.includes('unmountedRef.current = true'),
  )
  check(
    'a revoke before re-auth preserves step-up state',
    remote.includes('preserveStepUpState: true'),
  )
  check(
    'the proxy server id rewrites mcprs → mcpsrv',
    remote.includes("replace(/^mcprs/, 'mcpsrv')"),
  )
  const agentMenu = src('src/components/mcp/MCPAgentServerMenu.tsx')
  check(
    'the agent menu aborts its flow on unmount too',
    agentMenu.includes('abortRef.current?.abort()'),
  )
  const elicit = src('src/components/mcp/ElicitationDialog.tsx')
  check(
    'every validation rule comes from the S45 owner',
    elicit.includes("from '../../utils/mcp/elicitationValidation.js'") &&
      elicit.includes('validateElicitationInputAsync'),
  )
  check(
    "the shell's own cancel is disarmed while a field is focused",
    elicit.includes('isCancelActive={(!fieldFocused || buttonFocused) && !accordionOpen}'),
  )
  check(
    'the field-focused escape rides confirm-no in the Settings context',
    elicit.includes("{ context: 'Settings', isActive: fieldFocused && !accordionOpen }"),
  )
  check(
    'unmount aborts every per-field resolve and clears the debounce timers',
    elicit.includes('for (const controller of resolveAbortsRef.current.values())'),
  )
  check(
    'the accepted payload keeps JSON types (content map built from values)',
    elicit.includes('content[field.name] = field.value'),
  )
  const settings = src('src/components/mcp/MCPSettings.tsx')
  check(
    'the auth probe is time-boxed at 3000 ms',
    settings.includes('AUTH_PROBE_TIMEOUT_MS = 3_000') && settings.includes('Promise.race'),
  )
  check(
    'the ide client is excluded and preparation is cancellable',
    settings.includes("IDE_CLIENT_NAME = 'ide'") && settings.includes('if (!cancelled) setServers(prepared)'),
  )
}

section('structural pins — /help + misc')
{
  const help = src('src/components/HelpV2/HelpV2.tsx')
  check(
    'selecting a command stages /name through the composer seed, quietly',
    help.includes('nextInput: `/${commandName} `') && help.includes("display: 'skip'"),
  )
  check(
    'no external documentation URL (fork requirement)',
    !/https?:\/\//.test(help),
  )
  const stdio = src('src/components/mcp/MCPStdioServerMenu.tsx')
  check(
    'the stdio menu keeps BOTH config-location reads',
    stdio.includes('getMcpConfigByName(server.name)') && stdio.includes("?? 'dynamic'"),
  )
  const list = src('src/components/mcp/MCPListPanel.tsx')
  check(
    'the /mcp empty-state and list carry no upstream doc links or binary names',
    !/claude\s+mcp|docs\.anthropic|https?:\/\/docs/.test(list),
  )
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s) · ${passes} passes`)
  process.exit(1)
}
console.log(`✓ S26 acceptance battery green — ${passes} checks`)
