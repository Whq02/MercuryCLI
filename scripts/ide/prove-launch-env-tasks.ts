#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const SYS_PY = '/usr/bin/python3'
const DIST_VENDOR = path.join(ROOT, 'dist', 'vendor', 'debugpy')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — launch env/tasks proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

console.log('============================================================')
console.log(' launch.json import — env and envFile, the task before the launch, the module and attach shapes')
console.log('============================================================')

const proj = mkdtempSync(path.join(tmpdir(), 'mercury-launch-env-'))
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "launch-env-fixture"\nversion = "0.0.1"\n')
writeFileSync(
  path.join(proj, 'hello.py'),
  ['import os', "mode = os.environ.get('MODE')", "print('MODE=' + str(mode) + ' GREETING=' + str(os.environ.get('GREETING')) + ' FROM_FILE=' + str(os.environ.get('FROM_FILE')) + ' EXPORTED=' + str(os.environ.get('EXPORTED')))", ''].join('\n'),
)
writeFileSync(path.join(proj, '.env'), ['# the file the launch reads', 'MODE=file', 'FROM_FILE="quoted value"', "SINGLE='single quoted'", 'export EXPORTED=1', 'MULTI="a\\nb"', 'not a pair', ''].join('\n'))
mkdirSync(path.join(proj, '.vscode'))
writeFileSync(
  path.join(proj, '.vscode', 'launch.json'),
  JSON.stringify(
    {
      version: '0.2.0',
      configurations: [
        { name: 'env wins', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py', env: { MODE: 'launch', GREETING: 'hi ${env:PROOF_WHO}' }, envFile: '${workspaceFolder}/.env', console: 'integratedTerminal' },
        { name: 'file only', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py', envFile: '.env' },
        { name: 'missing file', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py', envFile: '${workspaceFolder}/absent.env' },
        { name: 'macro env', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py', env: { X: '${command:pickProcess}' } },
        { name: 'plain', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py' },
      ],
    },
    null,
    2,
  ),
)

process.env.PROOF_WHO = 'proof-owner'
process.env.MERCURY_PYTHON = SYS_PY
process.chdir(proj)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const launch = await import('../../src/services/ide/launchProfiles.js')
const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.js')
_resetPythonProjectForTesting()

try {
  section('A. env and envFile on the profile — launch.json env over the file, a missing file named, a stray macro refused')
  const d = await launch.discoverLaunchProfiles(proj)
  const wins = d.profiles.find(p => p.label === 'env wins')
  check('A1 launch.json env wins over .env, ${env:NAME} expands, the file\'s quotes and export are read', JSON.stringify(wins?.debug?.env) === JSON.stringify({ MODE: 'launch', FROM_FILE: 'quoted value', SINGLE: 'single quoted', EXPORTED: '1', MULTI: 'a\nb', GREETING: 'hi proof-owner' }), JSON.stringify(wins?.debug))
  check('A2 the source is named: launch.json env over .env', wins?.debug?.envSource === 'launch.json env over .env', String(wins?.debug?.envSource))
  check('A3 env and envFile are represented — only console stays dropped', JSON.stringify(wins?.droppedFields) === JSON.stringify(['console']), JSON.stringify(wins?.droppedFields))
  const fileOnly = d.profiles.find(p => p.label === 'file only')
  check('A4 a file alone fills env from the file (a relative envFile resolves under the root)', fileOnly?.debug?.env?.MODE === 'file' && fileOnly?.debug?.envSource === '.env' && fileOnly?.droppedFields === undefined, JSON.stringify(fileOnly?.debug))
  check('A5 a missing envFile is a named skip, never a silent drop', d.skipped.some(s => s.name === 'missing file' && s.reason === `envFile not found: ${path.join(proj, 'absent.env')}`), JSON.stringify(d.skipped))
  check('A6 an env value with a macro the tool cannot expand is a named skip', d.skipped.some(s => s.name === 'macro env' && s.reason.includes('env X carries an unexpanded macro')), JSON.stringify(d.skipped))
  const plain = d.profiles.find(p => p.label === 'plain')
  check('A7 a config without env carries none (the payload and its id are unchanged in shape)', plain !== undefined && plain.debug?.env === undefined && plain.debug?.envSource === undefined)
  const parsed = launch.parseEnvFile('# c\nA=1\nexport B = two words \nC="x\\ny"\nD=\'q "inner"\'\nE=\n')
  check('A8 the env-file grammar: comments, export, trimmed values, \\n in double quotes, single quotes verbatim, empty values', JSON.stringify(parsed) === JSON.stringify({ A: '1', B: 'two words', C: 'x\ny', D: 'q "inner"', E: '' }), JSON.stringify(parsed))
  check('A9 ${env:NAME} expands from the environment and an unknown macro still refuses', launch.expandVsCodeVar('${env:PROOF_WHO}-${workspaceFolder}', '/r') === 'proof-owner-/r' && launch.expandVsCodeVar('${file}', '/r') === null)

  section('B. the Launch tool: inspect names the keys (never the values); run and debug hand the variables to the program')
  if (!existsSync(path.join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py')) || !existsSync(SYS_PY)) {
    console.log(`  [SKIP — LOUD] ${existsSync(SYS_PY) ? 'dist/vendor/debugpy absent — run bun run build.ts' : `${SYS_PY} absent`} — the run and debug legs need the vendored adapter and the system python.`)
    failures++
  } else {
    process.env.MERCURY_DEBUGPY_VENDOR_DIR = DIST_VENDOR
    const resolver = await import('../../src/services/dap/debugpyResolver.js')
    resolver._resetDebugpyResolverForTesting()
    const { LaunchTool } = await import('../../src/tools/LaunchTool/LaunchTool.js')
    const ctx = { getAppState: () => ({}) } as never
    const inspect = (await LaunchTool.call({ op: 'inspect', profile: wins!.id } as never, ctx)) as { data: { result: string } }
    check('B1 inspect lists the env keys and their source, and never prints a value', inspect.data.result.includes('env: MODE, FROM_FILE, SINGLE, EXPORTED, MULTI, GREETING — launch.json env over .env') && !inspect.data.result.includes('quoted value') && !inspect.data.result.includes('proof-owner'), inspect.data.result)
    const run = (await LaunchTool.call({ op: 'run', profile: wins!.id } as never, ctx)) as { data: { result: string; outcome: string } }
    check('B2 op:"run" reaches the program with launch.json env over .env over the shell', run.data.outcome === 'succeeded' && run.data.result.includes('MODE=launch GREETING=hi proof-owner FROM_FILE=quoted value EXPORTED=1'), run.data.result.split('\n').slice(0, 4).join(' | '))
    const dbg = (await LaunchTool.call({ op: 'debug', profile: wins!.id, file: path.join(proj, 'hello.py'), lines: [3] } as never, ctx)) as { data: { result: string } }
    check('B3 op:"debug" stops at the breakpoint with the same environment', dbg.data.result.includes('stopped — reason breakpoint'), dbg.data.result.split('\n')[0])
    const dap = await import('../../src/services/dap/dapClient.js')
    const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.js')
    const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.js')
    const owner = ownerFromToolUseContext(ctx)
    const session = dap.getDapSession(owner, 'main')
    const stopped = session?.treeStopped() ?? null
    if (stopped?.lastStopped) {
      const threadId = stopped.lastStopped.threadId ?? 1
      const stack = await stopped.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
      const frameId = (stack.stackFrames as Array<{ id: number }>)[0]!.id
      const mode = await stopped.request('evaluate', { expression: 'mode', frameId, context: 'repl' })
      check('B4 the stopped program reads MODE=launch (launch.json over .env)', String(mode.result).includes('launch'), JSON.stringify(mode))
    } else {
      check('B4 the stopped program reads MODE=launch', false, 'no stopped session')
    }
    await disposeOwner(owner)
    check('B5 the sessions are reaped', dap._dapSessionCountForTesting() === 0)
  }
} finally {
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
  delete process.env.MERCURY_PYTHON
  delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
  delete process.env.PROOF_WHO
}

console.log('')
if (failures > 0) {
  console.error(`prove-launch-env-tasks: ${failures} RED`)
  process.exit(1)
}
console.log('prove-launch-env-tasks: GREEN')
