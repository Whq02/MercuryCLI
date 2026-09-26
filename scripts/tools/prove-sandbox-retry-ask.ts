#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'sandbox-retry-ask-'))
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
const excerpt = (text: string, max = 600): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
if (!SandboxManager.isSandboxingEnabled()) {
  console.log(`SKIP  the sandbox cannot run here (${SandboxManager.getSandboxUnavailableReason() ?? 'not enabled'}); nothing proven`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(0)
}
await SandboxManager.initialize()
const store = SandboxManager.getSandboxViolationStore()
const encodeKey = (command: string): string => Buffer.from(command.slice(0, 100)).toString('base64')

const bashModule = (await import('../../src/tools/BashTool/BashTool.tsx')) as { BashTool: typeof import('../../src/tools/BashTool/BashTool.tsx').BashTool; retryableSandboxViolation?: (line: string) => boolean }
const { BashTool } = bashModule
const retryableSandboxViolation = bashModule.retryableSandboxViolation ?? ((): boolean => false)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
const { getCanUseToolFn } = await import('../../src/cli/headless/permissionChannel.ts')

type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
type AskRecord = { input: Record<string, unknown>; toolUseId: string }

function makeContext(toolUseId: string, headless: boolean) {
  let appState = getDefaultAppState()
  return {
    options: { mainLoopModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {}, isNonInteractiveSession: headless, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
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

type Outcome = { threw: boolean; text: string; data?: Record<string, unknown> }
type Driven = { outcome: Outcome; asks: AskRecord[]; recorded: string[] }
async function drive(command: string, toolUseId: string, verdict: Decision | 'headless'): Promise<Driven> {
  const asks: AskRecord[] = []
  const headlessRoad = getCanUseToolFn(undefined, undefined, null as never, () => [])
  const canUseTool = async (tool: unknown, input: Record<string, unknown>, ctx: never, message: never, id: string, force?: never) => {
    asks.push({ input, toolUseId: id })
    if (verdict === 'headless') return headlessRoad(tool as never, input, ctx, message, id, force)
    return verdict
  }
  const context = makeContext(toolUseId, verdict === 'headless')
  const launched = Date.now()
  let outcome: Outcome
  try {
    const result = await BashTool.call({ command } as never, context, canUseTool as never, undefined as never)
    const block = BashTool.mapToolResultToToolResultBlockParam(result.data, toolUseId)
    outcome = { threw: false, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), data: result.data as never }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    outcome = { threw: true, text: [e.message ?? '', e.stderr ?? '', e.stdout ?? ''].filter(Boolean).join('\n') }
  }
  await new Promise(resolve => setTimeout(resolve, 300))
  const recorded = store.getViolationsForCommand(command).filter(row => row.timestamp.getTime() >= launched).map(row => row.line)
  return { outcome, asks, recorded }
}

const target = (name: string): string => join(project, '.mercury', 'skills', name)
const writeCommand = (name: string): string => `printf planted > ${JSON.stringify(target(name))}`
const writeLine = (name: string, lines: string[]): string | undefined => lines.find(line => /file-write/.test(line) && line.includes(target(name)))
console.log('rig: every sandboxed run here is real; the store is read as the runtime filled it (its own monitor and proxy), nothing injected except the stale row in §6')

console.log('§1 allowed: the runtime records the refused write; one ask worded from that record; then the unsandboxed rerun\u2019s result')
{
  const name = 'allowed.txt'
  const command = writeCommand(name)
  const { outcome, asks, recorded } = await drive(command, 'ask-1', { behavior: 'allow', updatedInput: { command, dangerouslyDisableSandbox: true } })
  console.log(`      the store\u2019s rows for the run: ${JSON.stringify(recorded)}`)
  console.log(`      result: ${excerpt(outcome.text, 700)}`)
  const line = writeLine(name, recorded)
  check('the runtime\u2019s own monitor recorded the refused write under the command the tool looks up, naming the path', line !== undefined, JSON.stringify(recorded))
  check('exactly one ask was raised inside the call', asks.length === 1, `asks=${asks.length}`)
  const ask = asks[0]?.input ?? {}
  check('the ask is the existing unsandboxed-override ask for the same command', ask.dangerouslyDisableSandbox === true && ask.command === command, JSON.stringify(ask))
  check('the ask\u2019s words carry the recorded line verbatim (the path, the operation)', typeof ask.description === 'string' && line !== undefined && ask.description.includes(line), String(ask.description))
  check('the ask\u2019s words carry nothing but lines naming a file or a network destination', typeof ask.description === 'string' && !/sysctl-read/.test(ask.description), String(ask.description))
  check('the ask rides the same tool-use id as the call', asks[0]?.toolUseId === 'ask-1', String(asks[0]?.toolUseId))
  check('the result is the rerun\u2019s: the write landed outside the sandbox', !outcome.threw && existsSync(target(name)), excerpt(outcome.text))
  check('the result says in one clause that it ran outside the sandbox after the ask, naming the recorded line', /ran outside the sandbox after the ask/.test(outcome.text) && line !== undefined && outcome.text.includes(line), excerpt(outcome.text))
  check('the rerun result carries no sandbox_violations block of its own', !outcome.text.includes('<sandbox_violations>'), excerpt(outcome.text))
}

console.log('§2 denied: the typed refusal names the recorded line and /sandbox; nothing reruns')
{
  const name = 'denied.txt'
  const command = writeCommand(name)
  const { outcome, asks, recorded } = await drive(command, 'ask-2', { behavior: 'deny', message: 'The operator declined the unsandboxed rerun.' })
  console.log(`      result: ${excerpt(outcome.text, 700)}`)
  const line = writeLine(name, recorded)
  check('exactly one ask was raised', asks.length === 1, `asks=${asks.length}`)
  check('the call settles as an error result', outcome.threw, excerpt(outcome.text))
  check('the refusal names the recorded line verbatim', line !== undefined && outcome.text.includes(line), JSON.stringify(recorded))
  check('the refusal names the /sandbox command', outcome.text.includes('/sandbox'), excerpt(outcome.text))
  check('the refusal says the rerun was declined and the command was not rerun, and carries the operator\u2019s words', /declined/.test(outcome.text) && /not rerun/.test(outcome.text) && /The operator declined/.test(outcome.text), excerpt(outcome.text))
  check('the result carries the block with this run\u2019s record and no sysctl noise', /<sandbox_violations>/.test(outcome.text) && !/sysctl-read/.test(outcome.text), excerpt(outcome.text))
  check('nothing was written', !existsSync(target(name)))
}

console.log('§3 headless with no channel: the same refusal, no operator asked')
{
  const name = 'headless.txt'
  const command = writeCommand(name)
  const { outcome, asks, recorded } = await drive(command, 'ask-3', 'headless')
  console.log(`      result: ${excerpt(outcome.text, 700)}`)
  const line = writeLine(name, recorded)
  check('the permission road is consulted once; the headless resolver has no card to raise', asks.length === 1, `asks=${asks.length}`)
  check('the call settles as an error result', outcome.threw, excerpt(outcome.text))
  check('the refusal names the recorded line verbatim', line !== undefined && outcome.text.includes(line), JSON.stringify(recorded))
  check('the refusal names the /sandbox command', outcome.text.includes('/sandbox'), excerpt(outcome.text))
  check('the refusal says this session cannot ask and the command was not rerun', /cannot ask/.test(outcome.text) && /not rerun/.test(outcome.text), excerpt(outcome.text))
  check('nothing was written', !existsSync(target(name)))
}

console.log('§4 a plain non-zero exit: the store holds only the shell-start noise line for it; nothing is asked and nothing is shown')
{
  const { outcome, asks, recorded } = await drive('printf plain-failure; exit 3', 'ask-4', { behavior: 'allow', updatedInput: {} })
  console.log(`      the store\u2019s rows for the run: ${JSON.stringify(recorded)}`)
  console.log(`      result: ${excerpt(outcome.text, 300)}`)
  check('no recorded line names a file or a network destination', recorded.filter(retryableSandboxViolation).length === 0, JSON.stringify(recorded))
  check('no ask was raised', asks.length === 0, `asks=${asks.length}`)
  check('the failure is today\u2019s: the exit code and the output, no refusal words, no block', outcome.threw && /code 3/.test(outcome.text) && /plain-failure/.test(outcome.text) && !/rerun/.test(outcome.text) && !/<sandbox_violations>/.test(outcome.text), excerpt(outcome.text))
}

console.log('§5 policy has switched the override off: no ask, the typed refusal')
{
  SandboxManager.setSandboxSettings({ allowUnsandboxedCommands: false })
  check('the rig: the policy switch is read live', SandboxManager.areUnsandboxedCommandsAllowed() === false)
  const name = 'policy.txt'
  const command = writeCommand(name)
  const { outcome, asks, recorded } = await drive(command, 'ask-5', { behavior: 'allow', updatedInput: { command, dangerouslyDisableSandbox: true } })
  console.log(`      result: ${excerpt(outcome.text, 700)}`)
  const line = writeLine(name, recorded)
  check('no ask was raised', asks.length === 0, `asks=${asks.length}`)
  check('the refusal names the recorded line verbatim and /sandbox', outcome.threw && line !== undefined && outcome.text.includes(line) && outcome.text.includes('/sandbox'), JSON.stringify(recorded))
  check('the refusal says policy has switched the override off', /policy/.test(outcome.text) && /not rerun/.test(outcome.text), excerpt(outcome.text))
  check('nothing was written', !existsSync(target(name)))
  SandboxManager.setSandboxSettings({ allowUnsandboxedCommands: true })
  check('the rig: the policy switch is restored', SandboxManager.areUnsandboxedCommandsAllowed() === true)
}

console.log('§6 an earlier run\u2019s record under the same key does not word this run\u2019s ask')
{
  const command = 'printf stale-failure; exit 4'
  store.addViolation({ line: `bash(1) deny(1) file-write-create ${target('stale.txt')}`, encodedCommand: encodeKey(command), timestamp: new Date(Date.now() - 60_000) })
  const { outcome, asks } = await drive(command, 'ask-6', { behavior: 'allow', updatedInput: { command, dangerouslyDisableSandbox: true } })
  check('a record older than this run raises no ask', asks.length === 0, `asks=${asks.length}`)
  check('the run fails as a plain non-zero exit', outcome.threw && /code 4/.test(outcome.text) && !/rerun/.test(outcome.text), excerpt(outcome.text))
}

console.log('§7 the prompt\u2019s bullets tell the model the ask happens for it')
{
  const prompt = getSimplePrompt(new Set(['Bash']))
  check('the sandbox section is present in the rig', prompt.includes('# Command sandbox'))
  check('the model is no longer told to retry by hand without asking', !/retry immediately with the override, without asking/.test(prompt))
  check('the model is told the harness asks once and reruns on yes', /asks once/.test(prompt) && /rerun/.test(prompt), excerpt(prompt.slice(prompt.indexOf('# Command sandbox')), 400))
  check('the override parameter is still named for the operator-asked case', prompt.includes('dangerouslyDisableSandbox'))
}

console.log('§8 a network denial: the runtime\u2019s proxy refuses a host outside the allow list (in-process, no packet leaves) and the road asks from its record')
{
  const command = 'curl -fsS --max-time 5 http://mercury-proof.invalid/ >/dev/null'
  const { outcome, asks, recorded } = await drive(command, 'ask-8', { behavior: 'deny', message: 'The operator declined the unsandboxed rerun.' })
  const latest = store.getViolations().at(-1)
  console.log(`      the store\u2019s rows for the run: ${JSON.stringify(recorded)}; latest row overall under the key ${JSON.stringify(excerpt(latest?.command ?? '(none)', 90))}`)
  console.log(`      result: ${excerpt(outcome.text, 500)}`)
  check('the runtime recorded its proxy denial under the command text the tool looks up', recorded.some(line => /deny network-outbound mercury-proof\.invalid:80/.test(line)), JSON.stringify(recorded))
  check('one ask was raised, worded from the runtime\u2019s own line', asks.length === 1 && String(asks[0]?.input.description ?? '').includes('deny network-outbound mercury-proof.invalid:80'), String(asks[0]?.input.description ?? `asks=${asks.length}`))
  check('declined: the refusal names the runtime\u2019s line and /sandbox and the command was not rerun', outcome.threw && /deny network-outbound mercury-proof\.invalid:80/.test(outcome.text) && /\/sandbox/.test(outcome.text) && /not rerun/.test(outcome.text), excerpt(outcome.text))
  check('the result carries the block with this run\u2019s record', /<sandbox_violations>/.test(outcome.text), excerpt(outcome.text))
}

console.log('§9 evidence (printed, not asserted): the vendored monitor called bare, one denied write through /bin/sh -c with no chain before it')
if (process.platform === 'darwin') {
  const runtime = await import('@anthropic-ai/sandbox-runtime')
  await runtime.SandboxManager.reset()
  SandboxManager.reset()
  const monitored = runtime.SandboxManager.getSandboxViolationStore()
  await runtime.SandboxManager.initialize(
    { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowWrite: [project], denyWrite: [join(project, '.mercury', 'skills')], allowRead: [], denyRead: [] } } as never,
    undefined as never,
    true,
  )
  await new Promise(resolve => setTimeout(resolve, 1500))
  const { execSync } = await import('node:child_process')
  const command = writeCommand('monitored.txt')
  const wrapped = await runtime.SandboxManager.wrapWithSandbox(command, '/bin/sh', undefined, undefined, { commandId: command, commandText: command })
  const launched = Date.now()
  let code = 0
  try {
    execSync(wrapped, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
  } catch (error) {
    code = (error as { status?: number }).status ?? 1
  }
  await new Promise(resolve => setTimeout(resolve, 800))
  const since = monitored.getViolations().filter(row => row.timestamp.getTime() >= launched)
  const rows = since.map(row => `${row.line}${row.encodedCommand === undefined ? ' [unattributed]' : ''}`)
  console.log(`      denied write exit ${code}; the monitor stored ${rows.length} line(s) since launch: ${JSON.stringify(rows)}`)
  console.log(`      lines the road would ask from: ${JSON.stringify(since.map(row => row.line).filter(retryableSandboxViolation))}`)
  await runtime.SandboxManager.reset()
} else {
  console.log('      not macOS; nothing measured')
}

await SandboxManager.reset()
process.chdir(tmpdir())
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `\nsandbox retry ask: green (${checks} checks)` : `\nsandbox retry ask: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
