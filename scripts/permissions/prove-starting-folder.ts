#!/usr/bin/env bun
// gate-watch: src/Tool.ts src/bootstrap/state.ts src/cli/structuredIO.ts src/utils/cwd.ts
// gate-watch: src/utils/permissions/** src/tools/BashTool/** src/tools/FileWriteTool/FileWriteTool.ts src/tools/FileEditTool/FileEditTool.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolUseContext } from '../../src/Tool.js'
import type { PermissionMode } from '../../src/types/permissions.js'

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
const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.js')
const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.js')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.js')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { StructuredIO } = await import('../../src/cli/structuredIO.js')
const bootstrap = await import('../../src/bootstrap/state.js')
const { getCwd, runWithCwdOverride } = await import('../../src/utils/cwd.js')
const shellUtils = await import('../../src/tools/BashTool/utils.js')
bootstrap.setIsInteractive(false)

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
async function permissionContext(mode: PermissionMode, addDirs: string[] = []) {
  const args = { allowedToolsCli: [], disallowedToolsCli: [], permissionMode: mode, allowDangerouslySkipPermissions: mode === 'sovereign' || mode === 'autopilot', addDirs }
  return (await initializeToolPermissionContext(args)).toolPermissionContext
}
async function channel(tool: Tool, input: Record<string, unknown>, mode: PermissionMode, addDirs: string[] = []) {
  const queue: string[] = []
  let ended = false
  let wake: (() => void) | undefined
  const feed = (value: unknown): void => { queue.push(JSON.stringify(value) + '\n'); wake?.() }
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        while (queue.length) yield queue.shift()!
        if (!ended) await new Promise<void>(resolve => { wake = resolve })
      }
    },
  }
  const io = new StructuredIO(stream)
  let asks = 0
  const outward = (async () => {
    for await (const raw of io.outbound) {
      const frame = raw as { type?: string; request_id?: string; request?: { subtype?: string } }
      if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool') {
        asks++
        feed({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updated_input: input } } })
      }
    }
  })()
  void outward
  void (async () => { for await (const item of io.structuredInput) void item })()
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
    const decision = await io.createCanUseTool()(tool, input, context, { message: { id: 'permission-probe' } } as never, 'toolu_permission_probe')
    return { asks, decision }
  } finally {
    clearTimeout(timer)
    ended = true
    wake?.()
  }
}

try {
  console.log('Ancestor-directory reproduction: cwd <parent>/sanity/pass-1; mkdir inside')
  for (const mode of ['default', 'implement'] as const) {
    for (const added of [[], [scratch], [scratch + '/'], [join(scratch, 'sanity')]]) {
      const ctx = await permissionContext(mode, added)
      const result = checkPathConstraints({ command: 'mkdir inside' }, root, ctx)
      const words = 'message' in result ? result.message : ''
      check(`${mode}, ancestor=${added.length > 0}: permission result`, result.behavior === (mode === 'default' ? 'ask' : 'passthrough'), result.behavior)
      check(`${mode}, ancestor=${added.length > 0}: no folder refusal or read-only grant`, !/ADDED directory|grants reads only|may only/.test(words), words)
    }
  }
  for (const mode of ['default', 'implement', 'sovereign', 'autopilot'] as const) {
    for (const [place, directory] of [['inside', root], ['outside', sibling]] as const) {
      const file_path = join(directory, 'file.txt')
      for (const [tool, input] of [
        [FileWriteTool, { file_path, content: 'written\n' }],
        [FileEditTool, { file_path, old_string: 'before', new_string: 'after' }],
        [BashTool, { command: `mkdir ${join(directory, 'new-dir')}` }],
      ] as Array<[Tool, Record<string, unknown>]>) {
        const result = await channel(tool, input, mode)
        const expected = mode === 'default' || (mode === 'implement' && place === 'outside') ? 1 : 0
        check(`${mode} ${tool.name} ${place}: ${expected} permission-channel asks`, result.asks === expected, `asks=${result.asks}`)
        check(`${mode} ${tool.name} ${place}: approved action proceeds`, result.decision.behavior === 'allow', result.decision.behavior)
      }
    }
  }
  const oldGrant = await channel(FileWriteTool, { file_path: join(sibling, 'old-grant.txt'), content: 'x' }, 'implement', [sibling])
  check('an obsolete second root never grants an outside write', oldGrant.asks === 1, `asks=${oldGrant.asks}`)
  bootstrap.setCwdState(sibling)
  check('a shell cd leaves the starting folder unchanged', bootstrap.getOriginalCwd() === root)
  const reset = shellUtils.resetCwdIfOutsideProject(await permissionContext('sovereign'))
  check('an approved shell cd outside is not reset by a folder fence', !reset && getCwd() === sibling, getCwd())
  bootstrap.setCwdState(sibling)
  const moved = await channel(FileWriteTool, { file_path: join(sibling, 'after-cd.txt'), content: 'x' }, 'implement')
  check('implement still asks outside after cd', moved.asks === 1, `asks=${moved.asks}`)
  bootstrap.setCwdState(root)
  await runWithCwdOverride(sibling, async () => {
    const child = await channel(FileWriteTool, { file_path: join(sibling, 'child.txt'), content: 'x' }, 'implement')
    check('a child agent starts with its own single root', child.asks === 0, `asks=${child.asks}`)
    const parent = await channel(FileWriteTool, { file_path: join(root, 'parent.txt'), content: 'x' }, 'implement')
    check('the child does not inherit its parent as a second root', parent.asks === 1, `asks=${parent.asks}`)
  })
  symlinkSync(sibling, join(root, 'escape'))
  const escaped = await channel(FileWriteTool, { file_path: join(root, 'escape', 'file.txt'), content: 'x' }, 'implement')
  check('an outside symlink target raises an ordinary ask', escaped.asks === 1 && escaped.decision.behavior === 'allow')
  const sensitive = await channel(FileWriteTool, { file_path: join(root, '.mercury.json'), content: '{}' }, 'implement')
  check('sensitive-file permission remains independent of folder consent', sensitive.asks === 1)
  console.log(`starting-folder: ${passed} passed, ${failed} failed`)
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
