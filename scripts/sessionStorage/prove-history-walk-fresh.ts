#!/usr/bin/env bun
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const home = mkdtempSync(join(tmpdir(), 'history-walk-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'history-walk-cwd-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(cwd)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const settle = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms))

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(cwd)
const history = await import('../../src/history.ts')
const quiet = (): boolean => {
  const h = history.getHistoryFlushHealth()
  return h.pending === 0 && !h.inFlight
}
async function flushed(): Promise<void> {
  for (let i = 0; i < 100 && !quiet(); i++) await settle(20)
}
const filePath = join(home, 'history.jsonl')
const project = bootstrap.getProjectRoot()
const session = bootstrap.getSessionId()
type Rec = { display: string; project: string; sessionId?: string; timestamp: number }
const onDisk = (): Rec[] => readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Rec)
async function walkOf(count = 100): Promise<string[]> {
  const out: string[] = []
  for await (const entry of history.getHistory()) {
    out.push(entry.display)
    if (out.length >= count) break
  }
  return out
}

const LINES = {
  m1: 'alpha one idle',
  m2: 'bravo two idle',
  m3: 'charlie three busy',
  fold: '/compact',
  m4: 'delta four held',
  m5: 'echo five idle',
  m6: 'foxtrot six idle',
  m7: 'golf seven busy',
} as const
const BEFORE_FOLD = [LINES.m1, LINES.m2, LINES.m3]
const FROM_FOLD = [LINES.fold, LINES.m4, LINES.m5, LINES.m6, LINES.m7]
const ALL_NEWEST_FIRST = [...BEFORE_FOLD, ...FROM_FOLD].slice().reverse()

section('§1 the writer: one record per taken line, the cockpit\'s project and session; the reader\'s order')
{
  for (const line of BEFORE_FOLD) history.addToHistory(line)
  await flushed()
  const rows = onDisk()
  check('three taken lines are three records, in the order they were taken', rows.map(r => r.display).join(' | ') === BEFORE_FOLD.join(' | '), rows.map(r => r.display).join(' | '))
  check('every record carries the cockpit\'s project', rows.every(r => r.project === project), JSON.stringify(rows.map(r => r.project)))
  check('every record carries the cockpit\'s session id', rows.every(r => r.sessionId === session), JSON.stringify(rows.map(r => r.sessionId)))
  const olderCockpit = { display: 'a line from an older cockpit', pastedContents: {}, timestamp: Date.now() + 1, project, sessionId: 'another-cockpit' }
  const otherProject = { display: 'a line from another project', pastedContents: {}, timestamp: Date.now() + 2, project: `${project}-other`, sessionId: session }
  appendFileSync(filePath, `${JSON.stringify(olderCockpit)}\n${JSON.stringify(otherProject)}\n`)
  const walk = await walkOf()
  check('the up-arrow reader yields this session\'s lines first, newest first, then the older cockpit\'s', walk.join(' | ') === [...BEFORE_FOLD.slice().reverse(), olderCockpit.display].join(' | '), walk.join(' | '))
  check('another project\'s line never enters the walk', !walk.includes(otherProject.display))
}

section('§2 the submit road: the composer is taken once, before the send, busy or idle — and the take ends the walk')
{
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  const onSubmitAt = repl.indexOf('const onSubmit = useCallback(async (input: string')
  const onSubmit = repl.slice(onSubmitAt, repl.indexOf('const onSubmitRef = useRef(onSubmit)'))
  const takeAt = onSubmit.indexOf('const takeComposer = (): void => {')
  const take = onSubmit.slice(takeAt, onSubmit.indexOf('};', takeAt))
  check('the take writes the history entry once (the one composer write)', (take.match(/addToHistory\(/g) ?? []).length === 1 && (onSubmit.match(/addToHistory\(/g) ?? []).length === 1)
  const sessionAt = onSubmit.indexOf("if (seat === 'session') {")
  const sendAt = onSubmit.indexOf('.sendWords(text, {')
  const sessionRoad = onSubmit.slice(sessionAt, sendAt)
  const lastTake = sessionRoad.lastIndexOf('takeComposer();')
  check('the session road takes the composer right after the landing arm and before the send, on one straight road with no busy gate (a queued line records at its take)', lastTake !== -1 && /return;\s*\}\s*takeComposer\(\);\s*repinToBottom\(\);/.test(sessionRoad) && !sessionRoad.slice(lastTake).includes('return') && !/isLoadingRef\.current\)\s*\{[^}]*takeComposer/.test(sessionRoad), sessionRoad.slice(lastTake).replace(/\s+/g, ' ').slice(0, 160))
  check('the rearmed word rides exactly the two roads that recorded at queue time (the dialog queue, the landing arm)', (repl.match(/\{ rearmed: true \}/g) ?? []).length === 2 && repl.includes('queuedDialogCommandsRef.current.push({ input, name: dialogName });') && onSubmit.indexOf('takeComposer();', onSubmit.indexOf('if (inFlight !== null) {')) < onSubmit.indexOf('queuedDialogCommandsRef.current.push'))
  check('no drain-time history write exists on the face (the runner drains in its own process)', !repl.includes('queuedCommandHistoryEntry('))
  check('the take ends the walk: helpers.resetHistory() beside the buffer clear and the cursor reset', take.includes('helpers.clearBuffer();') && take.includes('helpers.setCursorOffset(0);') && take.includes('helpers.resetHistory();'), 'takeComposer calls clearBuffer and setCursorOffset and never resetHistory — a submit leaves the walk where it stood')
}

section('§3 the walk (the real hook, headless): after a fold and more lines, ↑ recalls what was typed after the earlier walk')
{
  const React = await import('react')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { render } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { useArrowKeyHistory } = await import('../../src/hooks/useArrowKeyHistory.js')
  type Api = ReturnType<typeof useArrowKeyHistory>
  let api: Api | null = null
  let setHostMode: ((mode: 'prompt' | 'bash') => void) | null = null
  const applied: Array<{ value: string; mode: string }> = []
  const onSetInput = (value: string, mode: string): void => {
    applied.push({ value, mode })
  }
  const noCursor = (): void => {}
  function Host(): null {
    const [mode, setMode] = React.useState<'prompt' | 'bash'>('prompt')
    setHostMode = setMode
    api = useArrowKeyHistory(onSetInput, '', {}, noCursor, mode)
    return null
  }
  const stdout = Object.assign(new Writable({ write(_c, _e, cb) { cb() } }), { columns: 80, rows: 24, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const h = React.createElement as (...a: unknown[]) => React.ReactElement
  const instance = await render(h(AppStateProvider as never, {}, h(Host as never, {})), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  await settle()
  check('the hook rendered', api !== null && setHostMode !== null)
  const walk = (): Api => api as Api
  const press = async (key: 'up' | 'down'): Promise<string> => {
    applied.length = 0
    if (key === 'up') walk().onHistoryUp()
    else walk().onHistoryDown()
    await settle()
    return applied.at(-1)?.value ?? '(nothing)'
  }
  check('the first walk, before the fold: ↑ recalls the newest line', (await press('up')) === LINES.m3)
  check('↓ returns to the empty draft', (await press('down')) === '')
  for (const line of FROM_FOLD) history.addToHistory(line)
  await flushed()
  check('the fold and four more lines are on the file (eight records of this cockpit and project)', onDisk().filter(r => r.sessionId === session && r.project === project).map(r => r.display).join(' | ') === [...BEFORE_FOLD, ...FROM_FOLD].join(' | '))
  const census = history.historyIoCensus
  census.reads = 0
  const first = await press('up')
  check(`the walk after the fold: ↑ recalls "${LINES.m7}", the newest line`, first === LINES.m7, `the walk recalled "${first}" — the five lines typed after the earlier walk are missing from the arrow, while all eight are in history.jsonl`)
  const seen = [first]
  for (let i = 1; i < 10; i++) seen.push(await press('up'))
  check('eight presses walk all eight lines newest first; the ninth reaches the older cockpit\'s line; the tenth rests', seen.slice(0, 8).join(' | ') === ALL_NEWEST_FIRST.join(' | ') && seen[8] === 'a line from an older cockpit' && seen[9] === '(nothing)', seen.join(' | '))
  check('the walk cost one whole-file read (batched per walk, not per press)', census.reads === 1, `${census.reads} reads`)
  for (let i = 0; i < 10; i++) await press('down')
  walk().resetHistory()
  history.addToHistory(LINES.m3)
  await flushed()
  check('a line re-sent from history (↑ then ↵, the take resets the walk) is the newest on the next ↑', (await press('up')) === LINES.m3)
  check('…and the older copy follows, then the rest', (await press('up')) === LINES.m7)
  for (let i = 0; i < 3; i++) await press('down')
  walk().resetHistory()
  history.addToHistory('!ls -la')
  await flushed()
  setHostMode!('bash')
  await settle()
  const shell = await press('up')
  check('a bash-mode walk keeps its filter: the shell line comes back stripped, in bash mode', shell === 'ls -la' && applied.at(-1)?.mode === 'bash', JSON.stringify(applied.at(-1)))
  check('…and a prompt line never enters the bash walk', (await press('up')) === '(nothing)', JSON.stringify(applied))
  instance.unmount()
}

console.log(failures === 0 ? '\n✅ ALL HISTORY-WALK-FRESH PROOFS PASS' : `\n❌ ${failures} HISTORY-WALK-FRESH FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
