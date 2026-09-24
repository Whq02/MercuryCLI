#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const bundleFacts = ((): string => {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8')) as { version?: string; buildTree?: string }
    return `${manifest.version ?? 'version unknown'} · buildTree ${manifest.buildTree ?? 'unknown'}`
  } catch {
    return 'no manifest beside the bundle'
  }
})()
console.log(`bundle under proof: ${DIST} (${bundleFacts})`)
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const API_KEY = 'fixture-key-000'
const MODEL = 'claude-opus-4-8'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + t)

const home = realpathSync(mkdtempSync(join(tmpdir(), 'workshop-cell-errors-')))
const cwd = join(home, 'project')
const configDir = join(home, '.mercury')
mkdirSync(cwd, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(join(cwd, 'README.md'), '# fixture\n')
writeFileSync(join(configDir, '.config.json'), JSON.stringify({
  theme: 'dark',
  hasCompletedOnboarding: true,
  customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}))

const filler = 'a'.repeat(3900)
const SYNTAX_CELL = `var md='/tmp/notes.md'; await mercury.tool('Edit',{file_path:md,old_string:'${filler}',new_string:'b'); await mercury.tool('Edit',{file_path:md,old_string:'c',new_string:'d'})`
const missing = join(cwd, 'missing.txt')
const BRIDGE_CELL = `const first = 1; await mercury.tool('Read', { file_path: ${JSON.stringify(missing)} }); first + 1`
const THROWN_CELL = "const n = 1\nfunction blow() { throw new TypeError('the cell threw') }\nblow()"
const SHELL_COMMAND = 'echo out-line; echo err-line >&2; exit 1'
const SHELL_CELL = `const r = await mercury.tool('Bash', { command: ${JSON.stringify(SHELL_COMMAND)} })\nmercury.display(r)\nr.code`
const WARD_COMMAND = 'nohup sleep 1 &'
const WARD_CELL = `await mercury.tool('Bash', { command: ${JSON.stringify(WARD_COMMAND)} })`
const workshop = (title: string, code: string): ScriptedTurn => ({ kind: 'tool_use', name: 'Workshop', input: { cells: [{ language: 'js', title, code }] } })
const turns: ScriptedTurn[] = [
  workshop('a syntax error late in a long line', SYNTAX_CELL),
  workshop('a bridge call that fails', BRIDGE_CELL),
  workshop('a thrown error', THROWN_CELL),
  workshop('a shell command that exits 1', SHELL_CELL),
  workshop('a shell command the ward refuses', WARD_CELL),
  { kind: 'text', text: 'Done.' },
]

const fixture = await startFixtureApi(turns)
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_TEAMS_DIR: join(home, 'teams'),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BROWSER_NO_DISCOVERY: '1',
  MERCURY_BROWSER_CACHE_DIR: join(home, 'browser-cache'),
  BROWSER: '/usr/bin/true',
  ANTHROPIC_BASE_URL: fixture.url,
  ANTHROPIC_API_KEY: API_KEY,
}
const run = await new Promise<{ code: number | null; stderr: string }>(resolveRun => {
  const child = spawn(NODE, [DIST, '-p', 'run the five cells', '--model', MODEL, '--allowed-tools', 'Workshop,Bash'], { cwd, env })
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += chunk))
  child.stdout.on('data', () => {})
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.on('close', code => { clearTimeout(killer); resolveRun({ code, stderr }) })
})

const results: Array<{ tool_use_id: string; is_error?: boolean; text: string }> = []
for (const request of fixture.messageRequests()) {
  const body = request.body as { messages?: Array<{ role: string; content: unknown }> }
  for (const message of body.messages ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
      if (block.type !== 'tool_result') continue
      const content = block.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('\n') : JSON.stringify(content)
      if (!results.some(row => row.tool_use_id === block.tool_use_id)) results.push({ tool_use_id: block.tool_use_id ?? '', is_error: block.is_error, text })
    }
  }
}
await fixture.close()
rmSync(home, { recursive: true, force: true })

const [syntax, bridge, thrown, shell, ward] = results
const show = (row?: { text: string }): string => JSON.stringify(row?.text.slice(0, 700) ?? 'no result')
const WORKER_FRAME = /\[worker eval\]|node:internal|MessagePort/
for (const row of results) console.log(`  result as the model read it (${row.text.length} chars): ${show(row)}`)

section('§0 the run: the model made five Workshop calls; the first three came back as failed cells')
check('the print run exited 0', run.code === 0, `exit=${run.code} ${run.stderr.slice(-400)}`)
check('five Workshop results reached the model', results.length === 5, results.map(show).join(' | '))
check('the first three are error results with a failed cell head', results.slice(0, 3).length === 3 && results.slice(0, 3).every(row => row.is_error === true && /^\[cell-js-g\d+-\d+\] failed/m.test(row.text)), results.slice(0, 3).map(show).join(' | '))

section('§1 a syntax error late in a long line: the diagnosis reaches the model with its position, never an echo of the source')
check('the error names SyntaxError with its message', syntax !== undefined && /^error: SyntaxError: \S/m.test(syntax.text), show(syntax))
check('the error names the cell position (file:line:column)', syntax !== undefined && /\(cell-js-g\d+-\d+\.js:1:\d+\)/.test(syntax.text), show(syntax))
check('the position is the parse position near the end of the line, not the first await', syntax !== undefined && /\.js:1:39\d\d\)/.test(syntax.text), show(syntax))
check('the result is bounded: no 4000-character echo of the cell source', syntax !== undefined && syntax.text.length < 1500 && !syntax.text.includes(filler.slice(0, 500)), `length=${syntax?.text.length}`)
check('no misleading top-level-await complaint', syntax !== undefined && !/await is only valid/.test(syntax.text), show(syntax))

section('§2 a bridge call that fails: the result names the call, carries the tool\'s own words, and points at the cell line')
check('the error names the failed bridge call by ordinal and tool', bridge !== undefined && /^error: bridge call 1 \(Read\) failed: /m.test(bridge.text), show(bridge))
check('the nested tool\'s words are carried without the transcript wrapper', bridge !== undefined && /File does not exist/.test(bridge.text) && !bridge.text.includes('<tool_use_error>'), show(bridge))
check('the result says the cell stopped at that call', bridge !== undefined && /the cell stopped at that call/.test(bridge.text), show(bridge))
check('the location is the cell\'s own line', bridge !== undefined && /^\s+at .*cell-js-g\d+-\d+\.js:1:\d+/m.test(bridge.text), show(bridge))
check('no worker-internal frames', bridge !== undefined && !WORKER_FRAME.test(bridge.text), show(bridge))

section('§3 a thrown error: name, message and the cell\'s own frames only')
check('the error names the type and message first', thrown !== undefined && /^error: TypeError: the cell threw$/m.test(thrown.text), show(thrown))
check('the frames are the cell\'s: the throwing function on its line', thrown !== undefined && /^\s+at blow \(cell-js-g\d+-\d+\.js:2:\d+\)/m.test(thrown.text), show(thrown))
check('no worker-internal frames and no source echo before the message', thrown !== undefined && !WORKER_FRAME.test(thrown.text) && !/^error: cell-js/m.test(thrown.text), show(thrown))

section('§4 a shell command that exits 1: the tool RAN, so the cell reads { code, stdout, stderr } as a value and goes on')
const shellText = shell?.text ?? ''
console.log(`  record (${bundleFacts}) · is_error=${String(shell?.is_error)} · head=${JSON.stringify(shellText.split('\n')[0] ?? '')}`)
console.log(`  record · out-line in the result=${shellText.includes('out-line')} · err-line in the result=${shellText.includes('err-line')} · the command text in the result=${shellText.includes(SHELL_COMMAND)} · "bridge call 1 (Bash) failed"=${/bridge call 1 \(Bash\) failed/.test(shellText)} · "the cell stopped at that call"=${/the cell stopped at that call/.test(shellText)} · "Shell command failed"=${shellText.includes('Shell command failed')} · "Exited with code 1"=${shellText.includes('Exited with code 1')}`)
check('the shell cell is not an error result and its head says succeeded: the cell survived the exit', shell !== undefined && shell.is_error !== true && /^\[cell-js-g\d+-\d+\] succeeded/m.test(shellText), show(shell))
check('the cell read the exit code as a value: the cell value is r.code = 1', /^value: 1$/m.test(shellText), show(shell))
check('the displayed value is { code: 1, stdout: both lines, stderr: "" }', /"code": 1/.test(shellText) && /"stdout": "[^"]*out-line[^"]*err-line/.test(shellText) && /"stderr": ""/.test(shellText), show(shell))
check('the result names no failed bridge call and no stopped cell', !/bridge call 1 \(Bash\) failed/.test(shellText) && !/the cell stopped at that call/.test(shellText), show(shell))
check('the cell made exactly one bridge call', /1 bridge call\(s\)/.test(shellText), show(shell))

section("§5 a shell command the ward refuses: the tool never ran, so the bridge still throws the ward's words into the cell")
const wardText = ward?.text ?? ''
console.log(`  record · is_error=${String(ward?.is_error)} · head=${JSON.stringify(wardText.split('\n')[0] ?? '')} · the refused command in the result=${wardText.includes(WARD_COMMAND)}`)
check('the ward cell is an error result with a failed head', ward !== undefined && ward.is_error === true && /^\[cell-js-g\d+-\d+\] failed/m.test(wardText), show(ward))
check("the error names bridge call 1 (Bash) and carries the ward's words without the transcript wrapper", /^error: bridge call 1 \(Bash\) failed: .*Ward 'self-daemonize' blocked this Bash call/m.test(wardText) && !wardText.includes('<tool_use_error>'), show(ward))
check('the result says the cell stopped at that call', /the cell stopped at that call/.test(wardText), show(ward))
check('no worker-internal frames', !WORKER_FRAME.test(wardText), show(ward))

console.log(failures === 0 ? '\nprove-workshop-cell-errors-product: ALL LAWS HOLD' : `\nprove-workshop-cell-errors-product: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
