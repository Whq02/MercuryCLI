
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.MERCURY_CONFIG_DIR = '/tmp/mercury-parity-home'
mkdirSync('/tmp/mercury-parity-home', { recursive: true })
mkdirSync('/tmp/mercury-parity-cwd', { recursive: true })
process.chdir('/tmp/mercury-parity-cwd')

const H = await import('../../src/utils/hooks.ts')
const { recordOrVerify, snap } = await import('../lib/goldenReplay.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const PARITY_CWD_REAL = realpathSync('/tmp/mercury-parity-cwd')
const PARITY_CWD_SLUG = basename(getProjectDir(PARITY_CWD_REAL))
const neutralObj = <T,>(o: T): T =>
  JSON.parse(
    JSON.stringify(o)
      .replaceAll(PARITY_CWD_SLUG, '«parity-cwd»')
      .replaceAll(PARITY_CWD_REAL, '«parity-cwd-abs»')
      .replaceAll('/tmp/mercury-parity-cwd', '«parity-cwd-abs»'),
  ) as T

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'goldens.json')
const RECORD = process.argv.includes('--record')

const cases: Record<string, () => unknown> = {}
const asyncCases: Record<string, () => Promise<unknown>> = {}
const covered = new Set<string>()
const add = (exportName: string, caseName: string, fn: () => unknown) => {
  covered.add(exportName)
  cases[`${exportName}/${caseName}`] = fn
}
const addAsync = (
  exportName: string,
  caseName: string,
  fn: () => Promise<unknown>,
) => {
  covered.add(exportName)
  asyncCases[`${exportName}/${caseName}`] = fn
}

const BLOCKING = { blockingError: 'nope, blocked', command: 'echo hi' } as never
add('getPreToolHookBlockingMessage', 'shape', () =>
  H.getPreToolHookBlockingMessage('MyHook', BLOCKING),
)
add('getStopHookMessage', 'shape', () => H.getStopHookMessage(BLOCKING))
add('getTeammateIdleHookMessage', 'shape', () =>
  H.getTeammateIdleHookMessage(BLOCKING),
)
add('getTaskCreatedHookMessage', 'shape', () =>
  H.getTaskCreatedHookMessage(BLOCKING),
)
add('getTaskCompletedHookMessage', 'shape', () =>
  H.getTaskCompletedHookMessage(BLOCKING),
)
add('getUserPromptSubmitHookBlockingMessage', 'shape', () =>
  H.getUserPromptSubmitHookBlockingMessage('MyHook', BLOCKING),
)

add('hasBlockingResult', 'mixed', () =>
  H.hasBlockingResult([{ blocked: false }, { blocked: true }] as never),
)
add('hasBlockingResult', 'none', () =>
  H.hasBlockingResult([{ blocked: false }] as never),
)
add('shouldSkipHookDueToTrust', 'probe-process', () =>
  H.shouldSkipHookDueToTrust(),
)
add('getSessionEndHookTimeoutMs', 'default', () =>
  H.getSessionEndHookTimeoutMs(),
)

add('createBaseHookInput', 'pinned-session', () =>
  neutralObj(
    H.createBaseHookInput('default', 'fixture-session-1', {
      agentId: 'agent-1',
      agentType: 'general-purpose',
    }),
  ),
)
add('createBaseHookInput', 'no-agent', () =>
  neutralObj(H.createBaseHookInput(undefined, 'fixture-session-2')),
)

add('hasInstructionsLoadedHook', 'probe', () => H.hasInstructionsLoadedHook())
add('hasWorktreeCreateHook', 'probe', () => H.hasWorktreeCreateHook())

const SID = 'fixture-session-hooks'
const mk = (matcher: string | undefined, cmd: string) => ({
  matcher: matcher as string,
  hooks: [{ hook: { type: 'command' as const, command: cmd } }],
})
const fixtureAppState = {
  sessionHooks: new Map([
    [
      SID,
      {
        hooks: {
          SubagentStop: [
            mk('general-purpose', 'echo exact'),
            mk('general.*|code-reviewer', 'echo regex'),
            mk('*', 'echo star'),
            mk('other-agent', 'echo miss'),
            mk(undefined, 'echo always'),
          ],
          PreToolUse: [mk('Bash', 'echo bash-hook'), mk('Grep', 'echo grep-hook')],
        },
      },
    ],
  ]),
  sessionFunctionHooks: new Map(),
} as never

addAsync('getMatchingHooks', 'subagentstop-matcher-semantics', async () =>
  H.getMatchingHooks(
    fixtureAppState,
    SID,
    'SubagentStop' as never,
    {
      hook_event_name: 'SubagentStop',
      agent_type: 'general-purpose',
      session_id: SID,
      transcript_path: '/t',
      cwd: '/c',
    } as never,
  ),
)
addAsync('getMatchingHooks', 'pretooluse-tool-name', async () =>
  H.getMatchingHooks(
    fixtureAppState,
    SID,
    'PreToolUse' as never,
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
      session_id: SID,
      transcript_path: '/t',
      cwd: '/c',
    } as never,
  ),
)
addAsync('getMatchingHooks', 'no-session-store', async () =>
  H.getMatchingHooks(
    { sessionHooks: new Map(), sessionFunctionHooks: new Map() } as never,
    'absent-session',
    'SubagentStop' as never,
    {
      hook_event_name: 'SubagentStop',
      agent_type: 'x',
      session_id: 'absent-session',
      transcript_path: '/t',
      cwd: '/c',
    } as never,
  ),
)

const OP = await import('../../src/utils/hooks/outputProcessing.ts')
const opProject = (r: Record<string, unknown>) => {
  const { message: _message, ...rest } = r
  return rest
}
const opCall = (json: unknown, expectedHookEvent?: string) =>
  opProject(
    OP.processHookJSONOutput({
      json: json as never,
      command: 'echo fixture',
      hookName: 'FixtureHook',
      toolUseID: 'tu-1',
      hookEvent: (expectedHookEvent ?? 'PreToolUse') as never,
      expectedHookEvent: expectedHookEvent as never,
    }),
  )
add('processHookJSONOutput', 'legacy-approve-with-reason', () =>
  opCall({ decision: 'approve', reason: 'fine by policy' }),
)
add('processHookJSONOutput', 'legacy-block-with-reason', () =>
  opCall({ decision: 'block', reason: 'nope, blocked' }),
)
add('processHookJSONOutput', 'pretooluse-specific-reason-wins', () =>
  opCall(
    {
      reason: 'top-level why',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'specific why',
      },
    },
    'PreToolUse',
  ),
)
add('processHookJSONOutput', 'pretooluse-toplevel-reason-preserved', () =>
  opCall(
    {
      reason: 'top-level why',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    },
    'PreToolUse',
  ),
)
add('processHookJSONOutput', 'pretooluse-ask-updatedinput', () =>
  opCall(
    {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        updatedInput: { file_path: '/rewritten' },
      },
    },
    'PreToolUse',
  ),
)
add('processHookJSONOutput', 'continue-false-stop-reason', () =>
  opCall({ continue: false, stopReason: 'fixture stop' }),
)
add('parseHookOutput', 'plain-text-lane', () =>
  OP.parseHookOutput('just words, not JSON'),
)
add('parseHttpHookOutput', 'non-json-body-rejected', () =>
  OP.parseHttpHookOutput('<html>nope</html>'),
)
add('parseElicitationHookOutput', 'decline-carries-block', () =>
  OP.parseElicitationHookOutput(
    {
      command: 'echo fixture',
      succeeded: true,
      output: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' },
        reason: 'declined why',
      }),
      blocked: false,
    },
    'Elicitation',
  ),
)

const SPAWNER = 'spawns configured shell commands — pinned by the standing hook-exercising suites; gains fixture cases as the R4 extraction reaches its family'
const SKIPPED: Record<string, string> = Object.fromEntries(
  [
    'executeConfigChangeHooks', 'executeCwdChangedHooks', 'executeElicitationHooks',
    'executeElicitationResultHooks', 'executeFileChangedHooks', 'executeFileSuggestionCommand',
    'executeInstructionsLoadedHooks', 'executeNotificationHooks', 'executePermissionDeniedHooks',
    'executePermissionRequestHooks', 'executePostCompactHooks', 'executePostToolHooks',
    'executePostToolUseFailureHooks', 'executePreCompactHooks', 'executePreToolHooks',
    'executeSessionEndHooks', 'executeSessionStartHooks', 'executeSetupHooks',
    'executeStopFailureHooks', 'executeStopHooks',
    'executeSubagentStartHooks', 'executeTaskCompletedHooks', 'executeTaskCreatedHooks',
    'executeTeammateIdleHooks', 'executeUserPromptExpansionHooks', 'executeUserPromptSubmitHooks',
    'executeWorktreeCreateHook', 'executeWorktreeRemoveHook',
  ].map(k => [k, SPAWNER]),
)

const runtimeExports = Object.keys(H)
const unaccounted = runtimeExports.filter(k => !covered.has(k) && !(k in SKIPPED))

const results: Record<string, unknown> = {}
for (const [name, fn] of Object.entries(cases)) results[name] = snap(fn)
for (const [name, fn] of Object.entries(asyncCases)) {
  try {
    const v = await fn()
    results[name] = snap(() => v)
  } catch (e) {
    results[name] = { '«throws»': e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}

const failures = recordOrVerify({
  goldenPath: GOLDEN_PATH,
  results,
  record: RECORD,
  coverageFailures: unaccounted,
  passLabel: `hooks parity: ${Object.keys(results).length} golden case(s), ${covered.size}/${runtimeExports.length} exports covered (${Object.keys(SKIPPED).length} skip-listed)`,
  readFileSync: readFileSync as never,
  writeFileSync: writeFileSync as never,
  existsSync: existsSync as never,
})

console.log(failures === 0 ? '✅ HOOKS PARITY GREEN' : `❌ ${failures} HOOKS PARITY FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
