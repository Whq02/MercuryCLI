#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'failed-hook-reaches-user-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const frameArg = process.argv.indexOf('--frames')
const frameDir = frameArg < 0 ? undefined : process.argv[frameArg + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

const dist = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.log('  [FAIL] dist/mercury.mjs exists (build first — this proof drives the artifact)')
  process.exit(1)
}
const { hookEndingSentence, HOOK_FAILED_CODE } = await import(join(ROOT, 'src/rows/vocabulary.ts'))
const HOOK_NAME = 'PreToolUse:Read'
const HOOK_STDERR = 's4-hook-fails-on-purpose'
const LINE = hookEndingSentence({ status: 'failed', class: 'exit', exit_code: 1, detail: HOOK_STDERR }, { name: HOOK_NAME, event: 'PreToolUse' })

section('§1 a headless --format rows run: the failed hook is one notice row, the same line as stderr')
const { startFixtureApi } = await import(join(ROOT, 'scripts/lib/fixtureApi.ts'))
const target = join(cwd, 'README.md')
writeFileSync(target, 'hello\n')
const fixture = await startFixtureApi([
  { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'failedhook_tool_1' },
  { kind: 'text', text: 'fixture answered' },
])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `echo ${HOOK_STDERR} >&2; exit 1` }] }] } } }))
let stdout = ''
let stderr = ''
const child = spawn('node', [dist, 'run', '--format', 'rows', 'a fixture prompt'], {
  cwd,
  env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: fixture.url, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_TRUST_DIALOG_ACCEPTED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', bytes => { stdout += String(bytes) })
child.stderr.on('data', bytes => { stderr += String(bytes) })
const guard = setTimeout(() => { child.kill('SIGTERM') }, 90_000)
const code = await new Promise<number | null>(resolvePromise => child.once('close', resolvePromise))
clearTimeout(guard)
await fixture.close()
type Row = Record<string, unknown> & { type: string; seq?: number }
const rows: Row[] = stdout.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Row } catch { return { type: 'bad', line } } })
check('the run settles against the fixture provider with the turn completed', code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${code}; types ${rows.map(row => row.type).join(' ')}`)
check('the hook really fired: stderr carries the one line', stderr.includes(LINE), stderr.slice(0, 300))
const notices = rows.filter(row => row.type === 'notice')
const hookNotice = notices.find(row => row.code === HOOK_FAILED_CODE)
check('THE DEFECT PIN: the rows stream carries the failed hook as a notice row', hookNotice !== undefined, `notices: ${JSON.stringify(notices)}; types ${rows.map(row => row.type).join(' ')}`)
check('…with the same line the transcript and stderr carry (the one writer)', hookNotice?.text === LINE, String(hookNotice?.text))
check('…at warning level: the turn proceeded', hookNotice?.level === 'warning', String(hookNotice?.level))
const callSeq = rows.find(row => row.type === 'tool_call')?.seq
const resultSeq = rows.find(row => row.type === 'tool_result')?.seq
check('…between the tool call and its result', typeof hookNotice?.seq === 'number' && typeof callSeq === 'number' && typeof resultSeq === 'number' && callSeq < hookNotice.seq && hookNotice.seq < resultSeq, `call ${callSeq} notice ${hookNotice?.seq} result ${resultSeq}`)
const outcome = rows.find(row => row.type === 'outcome') as (Row & { notices?: Array<{ level: string; text: string }> }) | undefined
check("…and the outcome row's notices name it", Array.isArray(outcome?.notices) && outcome.notices.some(notice => notice.text === LINE && notice.level === 'warning'), JSON.stringify(outcome?.notices))
check('every row is still a valid JSON line', rows.every(row => row.type !== 'bad'))

section("§2 the session file through the cockpit's reader: the hook row rides the chain")
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path] })
const sessionFile = walk(join(home, 'projects')).find(path => path.endsWith('.jsonl'))
check('the run wrote one session file', sessionFile !== undefined)
type ChainRow = { type: string; uuid?: string; attachment?: { type: string; hookName?: string; stderr?: string }; message?: { content?: unknown } }
const blocksOf = (row: ChainRow): Array<{ type: string }> => (Array.isArray(row.message?.content) ? (row.message.content as Array<{ type: string }>) : [])
let chain: ChainRow[] = []
if (sessionFile !== undefined) {
  const reader = await import(join(ROOT, 'src/utils/sessionStorage/transcriptReader.ts'))
  chain = (await reader.readTranscriptChainSince(sessionFile, null)).rows as ChainRow[]
}
const kinds = chain.map(row => row.type + (row.attachment ? `:${row.attachment.type}` : ''))
const hookAt = chain.findIndex(row => row.type === 'attachment' && row.attachment?.type === 'hook_non_blocking_error')
const useAt = chain.findIndex(row => row.type === 'assistant' && blocksOf(row).some(block => block.type === 'tool_use'))
const resultAt = chain.findIndex(row => row.type === 'user' && blocksOf(row).some(block => block.type === 'tool_result'))
check('THE DEFECT PIN: the conversation chain the cockpit reads carries the hook_non_blocking_error row', hookAt !== -1, kinds.join(' | '))
check('…after its tool use and before the tool result', hookAt !== -1 && useAt !== -1 && resultAt !== -1 && useAt < hookAt && hookAt < resultAt, `use ${useAt} hook ${hookAt} result ${resultAt}`)
check('…carrying the same line', chain[hookAt]?.attachment?.stderr === LINE, String(chain[hookAt]?.attachment?.stderr))
check('…and the chain holds it once', chain.filter(row => row.attachment?.type === 'hook_non_blocking_error').length === 1)

section("§3 the cockpit's transcript rows: the notice is painted (a source-render frame)")
const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { deserializeLiveMessages } = await import(join(ROOT, 'src/utils/conversationRecovery.ts'))
const { Messages } = await import(join(ROOT, 'src/components/Messages.tsx'))
const { getTools } = await import(join(ROOT, 'src/tools.ts'))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 300): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const tools = getTools({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false } as never)
const painted = deserializeLiveMessages(chain as never)
for (const screen of ['chat', 'transcript'] as const) {
  let written = ''
  const out = Object.assign(new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }), { columns: 100, rows: 30, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(
    h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(Messages as never, { messages: painted, tools, verbose: screen === 'transcript', toolJSX: null, toolUseConfirmQueue: [], inProgressToolUseIDs: new Set(), isMessageSelectorVisible: false, conversationId: 'failed-hook', screen, streamingToolUses: [], agentDefinitions: { activeAgents: [], allAgents: [] }, isLoading: false })),
    { stdout: out, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  const frame = strip(instance.lastFrame())
  instance.unmount?.()
  await settle(50)
  if (frameDir !== undefined) writeFileSync(join(frameDir, `failed-hook-${screen}-100x30.txt`), `${frame}\n`)
  check(`THE DEFECT PIN (${screen} screen): the transcript rows carry the hook's notice`, frame.includes(`Hook ${HOOK_NAME} reported an error`), frame.replace(/\s+/g, ' ').slice(0, 400))
  check(`…with the one line (${screen} screen)`, frame.includes(LINE), frame.replace(/\s+/g, ' ').slice(0, 400))
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nFAILED HOOK REACHES USER GREEN' : `\n${failures} FAILED HOOK REACHES USER FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
