#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'sandbox-record-settle-'))
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
if (!SandboxManager.isSandboxingEnabled()) {
  console.log(`SKIP  the sandbox cannot run here (${SandboxManager.getSandboxUnavailableReason() ?? 'not enabled'}); nothing proven`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(0)
}
await SandboxManager.initialize()
await settle(1500)
const store = SandboxManager.getSandboxViolationStore()
const encodeKey = (command: string): string => Buffer.from(command.slice(0, 100)).toString('base64')

const bashModule = (await import('../../src/tools/BashTool/BashTool.tsx')) as {
  BashTool: typeof import('../../src/tools/BashTool/BashTool.tsx').BashTool
  retryableSandboxViolation?: (line: string) => boolean
  SANDBOX_RECORD_SETTLE_MS?: number
}
const { BashTool } = bashModule
const retryable = bashModule.retryableSandboxViolation ?? ((line: string): boolean => /file-write/.test(line))
const CEILING = bashModule.SANDBOX_RECORD_SETTLE_MS ?? 300
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

type Door = (key: string, since: number, ceilingMs: number, until?: (line: string) => boolean) => Promise<string[]>
const manager = SandboxManager as unknown as { awaitRecordedViolations?: Door }
const door: Door | undefined = typeof manager.awaitRecordedViolations === 'function' ? manager.awaitRecordedViolations.bind(SandboxManager) : undefined

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

type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
type Driven = { threw: boolean; text: string; asks: Array<Record<string, unknown>>; rows: string[]; ms: number }
async function drive(input: Record<string, unknown>, toolUseId: string, verdict: Decision): Promise<Driven> {
  const asks: Array<Record<string, unknown>> = []
  const canUseTool = async (_tool: unknown, askInput: Record<string, unknown>) => {
    asks.push(askInput)
    return verdict
  }
  const launched = Date.now()
  let threw = false
  let text = ''
  try {
    const result = await BashTool.call(input as never, makeContext(toolUseId), canUseTool as never, undefined as never)
    const block = BashTool.mapToolResultToToolResultBlockParam(result.data, toolUseId)
    text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  } catch (error) {
    threw = true
    const e = error as { stdout?: string; stderr?: string; message?: string }
    text = [e.message ?? '', e.stderr ?? '', e.stdout ?? ''].filter(Boolean).join('\n')
  }
  const ms = Date.now() - launched
  await settle(CEILING + 200)
  const command = String(input.command)
  const rows = store.getViolationsForCommand(command).filter(row => row.timestamp.getTime() >= launched).map(row => row.line)
  return { threw, text, asks, rows, ms }
}

const target = (name: string): string => join(project, '.mercury', 'skills', name)
const writeCommand = (name: string): string => `printf planted > ${JSON.stringify(target(name))}`
const plant = (command: string, line: string, delayMs: number): void => {
  setTimeout(() => store.addViolation({ line, encodedCommand: encodeKey(command), timestamp: new Date() }), delayMs)
}
console.log(`rig: the sandbox is live; the adapter\u2019s door is ${door ? 'present' : 'ABSENT'}; the tool\u2019s ceiling is ${CEILING} ms`)

console.log('\u00a71 the adapter\u2019s door: a bounded wait for this command\u2019s record, ended early by a retryable line, never by noise, never past the ceiling')
if (!door) {
  check('the adapter declares awaitRecordedViolations(key, since, ceilingMs, until?)', false, 'not a function on SandboxManager')
} else {
  const key = (name: string): string => `settle-door-${name}`
  {
    const since = Date.now()
    plant(key('present'), `zsh(1) deny(1) file-write-create ${target('present.txt')}`, 0)
    await settle(30)
    const started = Date.now()
    const lines = await door(key('present'), since, CEILING, retryable)
    const ms = Date.now() - started
    check('a record already in the store returns at once with no wait', lines.length === 1 && ms < 50, `${ms} ms, ${JSON.stringify(lines)}`)
  }
  {
    const started = Date.now()
    const lines = await door(key('zero'), started, 0, retryable)
    const ms = Date.now() - started
    check('a ceiling of 0 returns at once (a zero exit never waits)', lines.length === 0 && ms < 50, `${ms} ms`)
  }
  {
    const started = Date.now()
    const lines = await door(key('never'), started, CEILING, retryable)
    const ms = Date.now() - started
    check('with no record the wait runs to the ceiling and no further (the bound a plain failure pays)', lines.length === 0 && ms >= CEILING && ms < CEILING * 3, `${ms} ms`)
  }
  {
    const command = key('late')
    const since = Date.now()
    plant(command, `zsh(2) deny(1) file-write-create ${target('late.txt')}`, 90)
    const started = Date.now()
    const lines = await door(command, since, CEILING, retryable)
    const ms = Date.now() - started
    check('a record landing after the exit ends the wait as soon as it lands, before the ceiling', lines.length === 1 && ms >= 90 && ms < CEILING, `${ms} ms, ${JSON.stringify(lines)}`)
  }
  {
    const command = key('chunks')
    const since = Date.now()
    plant(command, 'zsh(3) deny(1) sysctl-read kern.iossupportversion', 40)
    plant(command, `zsh(3) deny(1) file-write-create ${target('chunks.txt')}`, 130)
    const started = Date.now()
    const lines = await door(command, since, CEILING, retryable)
    const ms = Date.now() - started
    check('a noise line does not end the wait; the retryable line in a later chunk does, and both are returned', lines.length === 2 && ms >= 130 && ms < CEILING, `${ms} ms, ${JSON.stringify(lines)}`)
  }
  {
    const command = key('beyond')
    const since = Date.now()
    plant(command, `zsh(4) deny(1) file-write-create ${target('beyond.txt')}`, CEILING + 250)
    const started = Date.now()
    const lines = await door(command, since, CEILING, retryable)
    const ms = Date.now() - started
    check('a record landing after the ceiling is not waited for: the wait ends at the ceiling, empty', lines.length === 0 && ms >= CEILING && ms < CEILING + 250, `${ms} ms`)
    await settle(300)
  }
}

console.log('\u00a72 the road under a stalled record: the runtime\u2019s own record of a refused write lands after the child\u2019s exit, and the tool still asks')
const STALL = 150
const original = store.addViolation.bind(store)
store.addViolation = event => {
  setTimeout(() => original(event), STALL)
}
{
  const name = 'stalled.txt'
  const command = writeCommand(name)
  const { threw, text, asks, rows, ms } = await drive({ command }, 'stalled', { behavior: 'allow', updatedInput: { command, dangerouslyDisableSandbox: true } })
  console.log(`      the store\u2019s rows for the run (read ${CEILING + 200} ms after the call): ${JSON.stringify(rows)}`)
  console.log(`      result after ${ms} ms: ${excerpt(text, 400)}`)
  const line = rows.find(row => /file-write/.test(row) && row.includes(target(name)))
  check('the stall held: the refused write was recorded, after the exit', line !== undefined, JSON.stringify(rows))
  check('the tool waited for the record and asked once, worded from it', asks.length === 1 && line !== undefined && String(asks[0]?.description ?? '').includes(line), asks.length === 0 ? 'asks=0: the plain refusal, no ask' : String(asks[0]?.description))
  check('the result is the rerun\u2019s: the write landed outside the sandbox, with the notice naming the line', !threw && existsSync(target(name)) && /ran outside the sandbox after the ask/.test(text) && line !== undefined && text.includes(line), excerpt(text))
}
{
  const name = 'stalled-declined.txt'
  const command = writeCommand(name)
  const { threw, text, asks, rows } = await drive({ command }, 'stalled-declined', { behavior: 'deny', message: 'The operator declined the unsandboxed rerun.' })
  const line = rows.find(row => /file-write/.test(row) && row.includes(target(name)))
  check('declined under the stall: one ask, the typed refusal naming the line, the block, nothing written', asks.length === 1 && threw && line !== undefined && text.includes(line) && /declined/.test(text) && /<sandbox_violations>/.test(text) && !existsSync(target(name)), asks.length === 0 ? `asks=0: ${excerpt(text, 200)}` : excerpt(text))
}
{
  const { threw, text, asks, rows, ms } = await drive({ command: 'printf plain-failure; exit 3' }, 'plain', { behavior: 'allow', updatedInput: {} })
  console.log(`      a plain failure settled in ${ms} ms; rows ${JSON.stringify(rows)}`)
  check('a plain failure asks nothing and keeps today\u2019s text, no block', asks.length === 0 && threw && /code 3/.test(text) && !/<sandbox_violations>/.test(text) && rows.length === 0, excerpt(text))
}
store.addViolation = original

console.log('\u00a73 who pays the wait: a non-zero sandboxed exit passes the ceiling to the door; a zero exit passes 0; an unsandboxed run never knocks')
if (!door) {
  check('the door exists to be observed', false)
} else {
  const knocks: number[] = []
  const observed: Door = async (key, since, ceilingMs, until) => {
    knocks.push(ceilingMs)
    return door(key, since, ceilingMs, until)
  }
  manager.awaitRecordedViolations = observed
  await drive({ command: 'printf zero-exit' }, 'zero', { behavior: 'allow', updatedInput: {} })
  const zero = [...knocks]
  knocks.length = 0
  await drive({ command: 'printf non-zero; exit 5' }, 'non-zero', { behavior: 'allow', updatedInput: {} })
  const nonZero = [...knocks]
  knocks.length = 0
  await drive({ command: 'printf unsandboxed; exit 6', dangerouslyDisableSandbox: true }, 'unsandboxed', { behavior: 'allow', updatedInput: {} })
  const unsandboxed = [...knocks]
  manager.awaitRecordedViolations = door
  check('a zero exit knocks with a ceiling of 0', zero.length === 1 && zero[0] === 0, JSON.stringify(zero))
  check(`a non-zero exit knocks with the tool\u2019s ceiling (${CEILING} ms)`, nonZero.length === 1 && nonZero[0] === CEILING, JSON.stringify(nonZero))
  check('an unsandboxed run never knocks', unsandboxed.length === 0, JSON.stringify(unsandboxed))
}

SandboxManager.reset()
await settle(200)
process.chdir(tmpdir())
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `\nsandbox record settle: green (${checks} checks)` : `\nsandbox record settle: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
