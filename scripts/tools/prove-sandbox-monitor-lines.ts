#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'sandbox-monitor-lines-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_SHELL_ENGINE = 'system'
const project = join(SCRATCH, 'project')
mkdirSync(join(project, '.mercury', 'skills'), { recursive: true })
process.chdir(project)
writeFileSync(
  join(process.env.MERCURY_CONFIG_DIR, 'settings.json'),
  JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowRead: [], denyRead: [], allowWrite: [] } } }, null, 2),
)

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const excerpt = (text: string, max = 500): string => text.replace(/\s+/g, ' ').trim().slice(0, max)
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
if (process.platform !== 'darwin' || !SandboxManager.isSandboxingEnabled()) {
  console.log(`SKIP  the macOS sandbox cannot run here (${SandboxManager.getSandboxUnavailableReason() ?? 'not macOS or not enabled'}); nothing proven`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(0)
}
await SandboxManager.initialize()
await settle(1500)
const store = SandboxManager.getSandboxViolationStore()

const bashModule = (await import('../../src/tools/BashTool/BashTool.tsx')) as { BashTool: typeof import('../../src/tools/BashTool/BashTool.tsx').BashTool; retryableSandboxViolation?: (line: string) => boolean }
const { BashTool } = bashModule
const retryable = bashModule.retryableSandboxViolation ?? ((): boolean => false)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

type AskRecord = { input: Record<string, unknown> }
function makeContext(toolUseId: string) {
  let appState = getDefaultAppState()
  return {
    options: { mainLoopModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    readFileState: new Map(),
    messages: [],
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => {
      appState = update(appState)
    },
    abortController: new AbortController(),
    toolUseId,
    setToolJSX: () => {},
  } as never
}

const rowsSince = (command: string, launched: number): string[] =>
  store.getViolationsForCommand(command).filter(row => row.timestamp.getTime() >= launched).map(row => row.line)
const target = (name: string): string => join(project, '.mercury', 'skills', name)
const redirect = (name: string): string => `printf planted > ${JSON.stringify(target(name))}`
const touch = (name: string): string => `touch ${JSON.stringify(target(name))}`
const writeLine = (name: string, lines: string[]): string | undefined => lines.find(line => /file-write/.test(line) && line.includes(target(name)))

type Bare = { code: number; rows: string[] }
async function bare(command: string): Promise<Bare> {
  const wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/sh', undefined, { commandId: command, commandText: command })
  const launched = Date.now()
  let code = 0
  try {
    execSync(wrapped, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
  } catch (error) {
    code = (error as { status?: number }).status ?? 1
  }
  await settle(300)
  return { code, rows: rowsSince(command, launched) }
}

type Product = { threw: boolean; text: string; asks: AskRecord[]; rows: string[] }
async function product(command: string, toolUseId: string): Promise<Product> {
  const asks: AskRecord[] = []
  const canUseTool = async (_tool: unknown, input: Record<string, unknown>) => {
    asks.push({ input })
    return { behavior: 'deny', message: 'The operator declined the unsandboxed rerun.' }
  }
  const launched = Date.now()
  let threw = false
  let text = ''
  try {
    const result = await BashTool.call({ command } as never, makeContext(toolUseId), canUseTool as never, undefined as never)
    const block = BashTool.mapToolResultToToolResultBlockParam(result.data, toolUseId)
    text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  } catch (error) {
    threw = true
    const e = error as { stdout?: string; stderr?: string; message?: string }
    text = [e.message ?? '', e.stderr ?? '', e.stdout ?? ''].filter(Boolean).join('\n')
  }
  await settle(300)
  return { threw, text, asks, rows: rowsSince(command, launched) }
}

console.log('rig: real sandboxed runs on this macOS through the product adapter; the store is read as the monitor filled it, nothing injected')

console.log('§1 the bare road (/bin/sh -c with nothing before the command): a refused write records the write line, for the shell\u2019s own redirection and for a child process, every time')
{
  const runs: Array<{ shape: string; name: string; result: Bare }> = []
  for (let index = 0; index < 3; index++) {
    const r = `bare-redirect-${index}.txt`
    runs.push({ shape: 'redirect', name: r, result: await bare(redirect(r)) })
    const t = `bare-touch-${index}.txt`
    runs.push({ shape: 'touch', name: t, result: await bare(touch(t)) })
  }
  for (const run of runs) console.log(`      ${run.shape} exit ${run.result.code}: the store\u2019s rows for the run: ${JSON.stringify(run.result.rows)}`)
  check('every bare run was refused by the sandbox (exit 1) and wrote nothing', runs.every(run => run.result.code === 1 && !existsSync(target(run.name))), runs.map(run => run.result.code).join(','))
  const recorded = runs.filter(run => writeLine(run.name, run.result.rows) !== undefined)
  check('the write line is recorded for every bare run, naming the path', recorded.length === runs.length, `${recorded.length} of ${runs.length} runs recorded the write`)
  check('the shell\u2019s own redirection records its write line on the bare road', runs.filter(run => run.shape === 'redirect').every(run => writeLine(run.name, run.result.rows) !== undefined))
  check('a child process\u2019s write records its write line on the bare road', runs.filter(run => run.shape === 'touch').every(run => writeLine(run.name, run.result.rows) !== undefined))
  const lines = runs.flatMap(run => run.result.rows)
  check('the recorded lines are the runtime\u2019s own shape: <process>(<pid>) deny(1) <operation> <path>', lines.length > 0 && lines.every(line => /^[^\s(]+\(\d+\) deny\(1\) \S+/.test(line)), JSON.stringify(lines.slice(0, 3)))
}

console.log('§2 the product road (the provider chain), unchanged: the ask is worded from the write line and carries no noise; the block carries the write line and no noise; a child process\u2019s write is recorded too')
{
  const name = 'product-redirect.txt'
  const command = redirect(name)
  const { threw, text, asks, rows } = await product(command, 'ask-redirect')
  console.log(`      the store\u2019s rows for the run: ${JSON.stringify(rows)}`)
  console.log(`      result: ${excerpt(text, 400)}`)
  const line = writeLine(name, rows)
  check('the write line is recorded under the command the tool looks up', line !== undefined, JSON.stringify(rows))
  check('exactly one ask, worded from the write line, with no sysctl noise in its words', asks.length === 1 && line !== undefined && String(asks[0]?.input.description ?? '').includes(line) && !/sysctl-read/.test(String(asks[0]?.input.description ?? '')), String(asks[0]?.input.description ?? `asks=${asks.length}`))
  check('declined: the refusal carries the block with the write line and no sysctl noise', threw && /<sandbox_violations>/.test(text) && line !== undefined && text.includes(line) && !/sysctl-read/.test(text), excerpt(text))
  check('nothing was written', !existsSync(target(name)))
  const child = 'product-touch.txt'
  const viaChild = await product(touch(child), 'ask-touch')
  console.log(`      touch: the store\u2019s rows for the run: ${JSON.stringify(viaChild.rows)}`)
  check('a child process\u2019s refused write on the product road records its write line and asks from it', writeLine(child, viaChild.rows) !== undefined && viaChild.asks.length === 1, JSON.stringify(viaChild.rows))
}

console.log('§3 the shell-start noise: a command that violates nothing leaves no row in the store, so the store\u2019s growth (the footer notice, /sandbox) counts real denials only; a plain failure asks nothing and shows no block')
{
  const before = store.getTotalCount()
  const clean = await product('printf clean', 'clean')
  console.log(`      a clean command: the store\u2019s rows for the run: ${JSON.stringify(clean.rows)}`)
  check('a clean command records no row under its key', clean.rows.length === 0, JSON.stringify(clean.rows))
  check('a clean command does not grow the store\u2019s total (the footer notice would have fired on it)', store.getTotalCount() === before, `total ${before} → ${store.getTotalCount()}`)
  check('a clean command succeeds as today', !clean.threw && /clean/.test(clean.text), excerpt(clean.text))
  const plain = await product('printf plain-failure; exit 3', 'plain')
  console.log(`      a plain failure: the store\u2019s rows for the run: ${JSON.stringify(plain.rows)}`)
  check('a plain failure records no row under its key', plain.rows.length === 0, JSON.stringify(plain.rows))
  check('no recorded line for it names a file or a network destination', plain.rows.filter(retryable).length === 0)
  check('a plain failure asks nothing and keeps today\u2019s text, no block', plain.asks.length === 0 && plain.threw && /code 3/.test(plain.text) && !/<sandbox_violations>/.test(plain.text), excerpt(plain.text))
  const noise = store.getViolations().map(row => row.line).filter(line => /sysctl-read kern\.iossupportversion/.test(line))
  check('no sysctl-read kern.iossupportversion row exists anywhere in the store after all the runs above', noise.length === 0, `${noise.length} noise rows`)
}

console.log('§4 the reader\u2019s parse (pure): every deny line of a chunk, paired with its own tag line; a chunk split mid-line or between a deny line and its tag reassembles; another session\u2019s events and the noise are dropped')
{
  type Reader = typeof import('../../src/utils/sandbox/macos-violation-reader.ts')
  let reader: Reader | null = null
  try {
    reader = await import('../../src/utils/sandbox/macos-violation-reader.ts')
  } catch (error) {
    check('the reader module exists', false, excerpt(String((error as Error).message)))
  }
  if (reader) {
    const session = '__proofsess_SBX'
    const key = (command: string): string => Buffer.from(command.slice(0, 100)).toString('base64')
    const tag = (command: string, suffix = session): string => `CMD64_${key(command)}_END${suffix}`
    const event = (process: string, pid: number, detail: string, command: string, suffix = session): string =>
      `0000-00-00 00:00:00.000 E  kernel[0:1] [com.apple.sandbox.reporting:violation] Sandbox: ${process}(${pid}) deny(1) ${detail}\n${tag(command, suffix)}\n`
    const command = 'touch /denied/file'
    const chunk =
      'Filtering the log data using "composedMessage ENDSWITH "_SBX""\nTimestamp               Ty Process[PID:TID]\n' +
      event('sh', 1, 'sysctl-read kern.iossupportversion', command) +
      event('touch', 2, 'sysctl-read kern.iossupportversion', command) +
      event('touch', 2, 'file-write-create /denied/file', command)
    const feed = new reader.SandboxLogFeed()
    const parsed = feed.push(chunk)
    check('three deny lines in one chunk parse as three events, in order', parsed.length === 3 && /^sh\(1\) deny\(1\) sysctl-read/.test(parsed[0]?.line ?? '') && /^touch\(2\) deny\(1\) file-write-create \/denied\/file$/.test(parsed[2]?.line ?? ''), JSON.stringify(parsed.map(p => p.line)))
    check('each event carries its own tag: the command key and the session', parsed.every(p => p.encodedCommand === key(command) && p.session === session), JSON.stringify(parsed))
    const one = event('zsh', 3, 'file-write-create /denied/two', command)
    const cut = one.indexOf('\nCMD64_') + 1
    const first = feed.push(one.slice(0, cut))
    const second = feed.push(one.slice(cut))
    check('a chunk that ends after the deny line holds it until its tag line arrives, then attributes it', first.length === 0 && second.length === 1 && second[0]?.encodedCommand === key(command), JSON.stringify([first, second]))
    const mid = one.indexOf('file-write')
    const a = feed.push(one.slice(0, mid))
    const b = feed.push(one.slice(mid))
    check('a chunk that ends mid-line reassembles the line', a.length === 0 && b.length === 1 && /file-write-create \/denied\/two$/.test(b[0]?.line ?? ''), JSON.stringify([a, b]))
    check('the noise list is the runtime\u2019s three plus the shell-start sysctl name', reader.MACOS_SANDBOX_NOISE.includes('sysctl-read kern.iossupportversion') && reader.MACOS_SANDBOX_NOISE.includes('mDNSResponder') && reader.MACOS_SANDBOX_NOISE.includes('mach-lookup com.apple.diagnosticd') && reader.MACOS_SANDBOX_NOISE.includes('mach-lookup com.apple.analyticsd'), JSON.stringify(reader.MACOS_SANDBOX_NOISE))
    const wrapped = `env /usr/bin/sandbox-exec -p '(version 1)\n(deny default (with message "${tag('printf hello', '__abc123xyz_SBX')}"))' /bin/sh -c 'printf hello'`
    check('the session tag is read from a wrapped command\u2019s profile', reader.sessionTagOf(wrapped) === '__abc123xyz_SBX', String(reader.sessionTagOf(wrapped)))
    const kept: Array<{ line: string; command?: string; encodedCommand?: string }> = []
    const sink = { addViolation: (row: { line: string; command?: string; encodedCommand?: string }) => kept.push(row) }
    const deliver = reader.violationDelivery(sink, () => ({ '*': ['file-read-data /ignored'] }))
    deliver(parsed, session)
    deliver(new reader.SandboxLogFeed().push(event('cp', 4, 'file-write-create /other/session', command, '__othersess_SBX')), session)
    deliver(new reader.SandboxLogFeed().push(event('cat', 5, 'file-read-data /ignored/secret', command)), session)
    deliver(new reader.SandboxLogFeed().push(event('cat', 6, 'file-read-data /kept/secret', command)), session)
    check('delivery keeps the write line and drops the two sysctl lines of the same chunk', kept.some(row => row.line === 'touch(2) deny(1) file-write-create /denied/file') && kept.every(row => !/sysctl-read/.test(row.line)), JSON.stringify(kept.map(row => row.line)))
    check('another session\u2019s event is dropped', kept.every(row => !/other\/session/.test(row.line)))
    check('the runtime\u2019s ignoreViolations patterns are honoured; an unmatched line is kept', kept.every(row => !/\/ignored\//.test(row.line)) && kept.some(row => /\/kept\/secret/.test(row.line)), JSON.stringify(kept.map(row => row.line)))
    check('a kept event carries the command text and the key the store matches on', kept.every(row => row.command === command && row.encodedCommand === key(command)), JSON.stringify(kept[0]))
    const ctl = new reader.SandboxLogFeed().push(event('sh', 7, `file-write-create /x`, `printf \u001b[31mred\u0007`))
    const bytes: Array<{ command?: string }> = []
    reader.violationDelivery({ addViolation: (row: { command?: string }) => bytes.push(row) }, () => undefined)(ctl, session)
    check('control bytes in a decoded key are collapsed before the command text is stored', bytes.length === 1 && !/[\u0000-\u001f\u007f]/.test(bytes[0]?.command ?? '\u0000'), JSON.stringify(bytes[0]?.command))
  }
}

console.log('§5 the store the views read: each recorded event carries the runtime\u2019s declared shape (line, command, encodedCommand, timestamp)')
{
  const rows = store.getViolations()
  check('the store holds this run\u2019s real events', rows.length > 0, `${rows.length} rows`)
  check('every event has a line, a Date timestamp, the command text and the key', rows.every(row => typeof row.line === 'string' && row.timestamp instanceof Date && typeof row.command === 'string' && typeof row.encodedCommand === 'string'), JSON.stringify(rows.at(-1)))
}

SandboxManager.reset()
await settle(200)
process.chdir(tmpdir())
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `\nsandbox monitor lines: green (${checks} checks)` : `\nsandbox monitor lines: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
