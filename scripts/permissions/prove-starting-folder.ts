#!/usr/bin/env bun
// gate-watch: src/tools/kit/tool.ts src/boot/process-state/processState.ts src/daemon/runner/runnerAsks.ts src/daemon/runner-wire/* src/platform/files/cwd.ts
// gate-watch: src/permissions/rules/PermissionRule.ts src/permissions/rules/PermissionUpdateSchema.ts src/permissions/rules/askClock.ts src/permissions/rules/askWords.ts src/permissions/rules/bashRuleVerdict.ts src/permissions/rules/bypassPermissionsKillswitch.ts src/permissions/rules/capabilityGate.ts src/permissions/rules/commandContent.ts src/permissions/rules/dangerousPatterns.ts src/permissions/rules/decision/** src/permissions/rules/decisionReasonWire.ts src/permissions/rules/filesystem.ts src/permissions/rules/flowLaw.ts src/permissions/rules/flowPolicy.ts src/permissions/rules/getNextPermissionMode.ts src/permissions/rules/lateAllowRules.ts src/permissions/rules/modeTransitions.ts src/permissions/rules/ownGround.ts src/permissions/rules/pathValidation.ts src/permissions/rules/permissionDoor.ts src/permissions/rules/permissionFocus.ts src/permissions/rules/permissionMode.ts src/permissions/rules/permissionResult.ts src/permissions/rules/permissionRuleParser.ts src/permissions/rules/permissionSetup.ts src/permissions/rules/permissionUpdate.ts src/permissions/rules/permissionsLoader.ts src/permissions/rules/protectedPaths.ts src/permissions/rules/rootNotice.ts src/permissions/rules/ruleBraces.ts src/permissions/rules/ruleReason.ts src/permissions/rules/runtimeProtection.ts src/permissions/rules/safeWrappers.ts src/permissions/rules/serviceInputHistory.ts src/permissions/rules/shadowedRuleDetection.ts src/permissions/rules/shell-protected-paths/** src/permissions/rules/shellProtectedPaths.ts src/permissions/rules/shellRuleMatching.ts src/permissions/rules/uncPath.ts src/permissions/rules/webFetchRuleMatches.ts src/permissions/rules/windowsPath.ts src/tools/shell/** src/tools/write/WriteTool.ts src/tools/edit/EditTool.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { slashed } from '../lib/platformPath.ts'
import type { Tool, ToolUseContext } from '../../src/tools/kit/tool.js'
import type { PermissionMode } from '../../src/permissions/rules/permissions.js'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'starting-folder-')))
const root = join(scratch, 'sanity', 'pass-1')
const sibling = join(scratch, 'sibling')
for (const dir of [root, sibling, join(scratch, 'home')]) mkdirSync(dir, { recursive: true })
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { initializeToolPermissionContext } = await import('../../src/permissions/rules/permissionSetup.js')
const { checkParsedPaths: checkPathConstraints } = await import('../bash/floor-proof-helpers.ts')
const { FileWriteTool } = await import('../../src/tools/write/WriteTool.js')
const { FileEditTool } = await import('../../src/tools/edit/EditTool.js')
const { BashTool } = await import('../../src/tools/shell/BashTool.js')
const { createRunnerAsks } = await import('../../src/daemon/runner/runnerAsks.js')
const { createPeer } = await import('../../src/daemon/runner-wire/peer.js')
const bootstrap = await import('../../src/boot/process-state/processState.js')
const { getCwd, runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
const shellUtils = await import('../../src/platform/shell/shellOutput.js')
bootstrap.setIsInteractive(false)

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ' — ' + hint : ''}`)
}
const ASK_HINT = 'fix the permission decision that createCanUseTool in src/daemon/runner/runnerAsks.ts relays (checks in src/permissions/rules/ and src/tools/shell/pathValidation.ts) so the number of asks matches the starting-folder rule'
async function permissionContext(mode: PermissionMode, addDirs: string[] = []) {
  const args = { allowedToolsCli: [], disallowedToolsCli: [], permissionMode: mode, allowDangerouslySkipPermissions: mode === 'sovereign', addDirs }
  return (await initializeToolPermissionContext(args)).toolPermissionContext
}
async function channel(tool: Tool, input: Record<string, unknown>, mode: PermissionMode, addDirs: string[] = []) {
  const toHost = new PassThrough()
  const toRunner = new PassThrough()
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log: () => {} })
  const host = createPeer({ input: toHost, output: toRunner, side: 'host', log: () => {} })
  const capabilities = { holds_asks: true, elicitation: false, partial_rows: false }
  const runnerAsks = createRunnerAsks(runner, () => capabilities)
  let asks = 0
  host.onRequest('permission/request', () => {
    asks++
    return { outcome: 'allow' as const, input }
  })
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'sid' }))
  void host.request('initialize', { protocol: 1, host: { name: 'proof', version: '0' }, capabilities })
  let state = { toolPermissionContext: await permissionContext(mode, addDirs), sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} } }
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (f: (p: typeof state) => typeof state) => { state = f(state) },
    messages: [],
    options: { tools: [tool] },
  } as unknown as ToolUseContext
  const timer = setTimeout(() => context.abortController.abort(), 30_000)
  try {
    const decision = await runnerAsks.createCanUseTool()(tool, input, context, { message: { id: 'permission-probe' } } as never, 'toolu_permission_probe')
    return { asks, decision }
  } finally {
    clearTimeout(timer)
    host.end('the host left')
    toHost.end()
    toRunner.end()
  }
}

try {
  console.log('Ancestor-directory reproduction: cwd <parent>/sanity/pass-1; mkdir inside')
  for (const mode of ['default', 'implement'] as const) {
    for (const added of [[], [scratch], [scratch + '/'], [join(scratch, 'sanity')]]) {
      const ctx = await permissionContext(mode, added)
      const result = (await checkPathConstraints({ command: 'mkdir inside' }, root, ctx))
      const words = 'message' in result ? result.message : ''
      check(`${mode}, ancestor=${added.length > 0}: permission result`, result.behavior === (mode === 'default' ? 'ask' : 'passthrough'), result.behavior, 'fix checkPathConstraints in src/tools/shell/pathValidation.ts so a mkdir inside the starting folder asks in default mode and passes through in implement mode, with or without an ancestor directory added')
      check(`${mode}, ancestor=${added.length > 0}: no folder refusal or read-only grant`, !/ADDED directory|grants reads only|may only/.test(words), words, 'remove the folder refusal or read-only grant wording from the result of checkPathConstraints in src/tools/shell/pathValidation.ts')
    }
  }
  for (const mode of ['default', 'implement', 'sovereign'] as const) {
    for (const [place, directory] of [['inside', root], ['outside', sibling]] as const) {
      const file_path = join(directory, 'file.txt')
      for (const [tool, input] of [
        [FileWriteTool, { file_path, content: 'written\n' }],
        [FileEditTool, { file_path, old_string: 'before', new_string: 'after' }],
        [BashTool, { command: `mkdir ${slashed(join(directory, 'new-dir'))}` }],
      ] as Array<[Tool, Record<string, unknown>]>) {
        const result = await channel(tool, input, mode)
        const expected = mode === 'default' || (mode === 'implement' && place === 'outside') ? 1 : 0
        check(`${mode} ${tool.name} ${place}: ${expected} ask(s) on the runner door`, result.asks === expected, `asks=${result.asks}`, ASK_HINT)
        check(`${mode} ${tool.name} ${place}: approved action proceeds`, result.decision.behavior === 'allow', result.decision.behavior, 'an action the host approved must proceed; fix createCanUseTool in src/daemon/runner/runnerAsks.ts')
      }
    }
  }
  const oldGrant = await channel(FileWriteTool, { file_path: join(sibling, 'old-grant.txt'), content: 'x' }, 'implement', [sibling])
  check('an obsolete second root never grants an outside write', oldGrant.asks === 1, `asks=${oldGrant.asks}`, 'a directory added with addDirs must not make a write outside the starting folder silent; see initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts')
  bootstrap.setCwdState(sibling)
  check('a shell cd leaves the starting folder unchanged', bootstrap.getOriginalCwd() === root, '', 'setCwdState must not change the original folder; see src/boot/process-state/processState.ts')
  check('an approved shell cd outside is not reset by a folder fence — the shell tools carry no reset road', !('resetCwdIfOutsideProject' in shellUtils) && getCwd() === sibling, getCwd(), 'remove resetCwdIfOutsideProject from src/platform/shell/shellOutput.ts and keep getCwd in src/platform/files/cwd.ts following the shell cd')
  bootstrap.setCwdState(sibling)
  const moved = await channel(FileWriteTool, { file_path: join(sibling, 'after-cd.txt'), content: 'x' }, 'implement')
  check('implement still asks outside after cd', moved.asks === 1, `asks=${moved.asks}`, ASK_HINT + ', also after a shell cd')
  bootstrap.setCwdState(root)
  await runWithCwdOverride(sibling, async () => {
    const child = await channel(FileWriteTool, { file_path: join(sibling, 'child.txt'), content: 'x' }, 'implement')
    check('a child agent starts with its own single root', child.asks === 0, `asks=${child.asks}`, ASK_HINT + ', with the override folder as the only root (runWithCwdOverride in src/platform/files/cwd.ts)')
    const parent = await channel(FileWriteTool, { file_path: join(root, 'parent.txt'), content: 'x' }, 'implement')
    check('the child does not inherit its parent as a second root', parent.asks === 1, `asks=${parent.asks}`, ASK_HINT + ', with the override folder as the only root (runWithCwdOverride in src/platform/files/cwd.ts)')
  })
  symlinkSync(sibling, join(root, 'escape'))
  const escaped = await channel(FileWriteTool, { file_path: join(root, 'escape', 'file.txt'), content: 'x' }, 'implement')
  check('an outside symlink target raises an ordinary ask', escaped.asks === 1 && escaped.decision.behavior === 'allow', '', ASK_HINT + ', and a symlink out of the folder must ask once')
  const sensitive = await channel(FileWriteTool, { file_path: join(root, '.mercury.json'), content: '{}' }, 'implement')
  check('sensitive-file permission remains independent of folder consent', sensitive.asks === 1, '', 'a write to .mercury.json must ask exactly once; ' + ASK_HINT)
  console.log(`starting-folder: ${passed} passed, ${failed} failed`)
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
