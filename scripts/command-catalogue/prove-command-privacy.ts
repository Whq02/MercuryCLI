#!/usr/bin/env bun
// ============================================================================
//  prove-command-privacy — THE COMMAND-PRIVACY LAW at the dispatch-rule seam
//  (the operator's finding: "/note leaked to the model"):
//  user-private commands (note · minerva · remember) and the screen-estate
//  pair (/halt stop-class interrupt-first · /crew) are SCREEN-seat — the
//  session runner's table never carries them, so the line never enters any
//  model conversation, never starts a turn, never bills a token; and a
//  words-level stray reaching the runner's slash path anyway EXECUTES with
//  ZERO persisted rows (the never-reaches defense).
//  Poison = today's leak: the /note line as a transcript user row + a
//  <local-command-stdout> row that normalizeMessagesForAPI would put on the
//  wire of every later turn.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// Hermetic homes BEFORE any src import touches ambient state.
const SCRATCH = mkdtempSync(join(tmpdir(), 'cmd-privacy-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_TABULA_DIR = join(SCRATCH, 'tabula')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_TABULA_DIR, { recursive: true })
// The taste loop's pair (/good · /meh) is flag-gated; armed so the roster
// carries them for the seat truth-table below.
process.env.MERCURY_TASTE_LOOP = '1'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { builtinCommands, commandSeat, sessionSeatCommandTable } = await import('../../src/commands.js')

// §1 — the seat truth-table.
console.log('§1 the ONE DISPATCH RULE: private + screen-estate commands sit at the screen')
const all = [...builtinCommands()]
const byName = (n: string) => all.find(c => c.name === n)
// A5: /good and /meh — the operator's own
// feedback lines — join the class (flag-gated commands; the taste loop is
// armed above so the roster carries them here).
const USER_PRIVATE = ['note', 'minerva', 'remember', 'good', 'meh'] as const
for (const name of [...USER_PRIVATE, 'halt', 'crew']) {
  const cmd = byName(name)
  check(`/${name} is registered and SCREEN-seat`, cmd !== undefined && commandSeat(cmd) === 'screen', cmd === undefined ? 'missing' : commandSeat(cmd))
}
check(
  'the user-private set carries the userPrivate mark (note · minerva · remember · good · meh)',
  USER_PRIVATE.every(n => (byName(n) as { userPrivate?: boolean } | undefined)?.userPrivate === true),
)
check('/halt is stop-class (interruptFirst)', (byName('halt') as { interruptFirst?: boolean } | undefined)?.interruptFirst === true)
const runnerTable = sessionSeatCommandTable(all)
check(
  "the session runner's table carries NONE of them (the line never reaches a runner from Mercury's own screen)",
  [...USER_PRIVATE, 'halt', 'crew'].every(n => !runnerTable.some(c => c.name === n)),
  runnerTable.filter(c => [...USER_PRIVATE, 'halt', 'crew'].includes(c.name as never)).map(c => c.name).join(','),
)
check(
  'ordinary session locals keep their seat (compact · cost stay with the session)',
  ['compact', 'cost'].every(n => {
    const cmd = byName(n)
    return cmd !== undefined && commandSeat(cmd) === 'session'
  }),
)

// §2 — the never-reaches defense: a stray '/note …' at the RUNNER's slash
// path executes with ZERO persisted rows. The context is the sdk shape the
// worker uses; the roster is the runner's own table (no note in it).
console.log('§2 the runner defense: a stray user-private line executes with zero rows')
{
  const { processUserInput } = await import('../../src/utils/processUserInput/processUserInput.js')
  const { setOriginalCwd } = await import('../../src/bootstrap/state.js')
  const cwd = join(SCRATCH, 'project')
  mkdirSync(cwd, { recursive: true })
  setOriginalCwd(cwd)
  const context = {
    options: {
      commands: runnerTable,
      tools: [],
      mcpClients: [],
      isNonInteractiveSession: true,
    },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
    }),
    setAppState: () => {},
    abortController: new AbortController(),
    readFileState: {},
    setToolJSX: () => {},
  }
  const result = await processUserInput({
    input: '/note remember the milk',
    mode: 'prompt',
    setToolJSX: () => {},
    context: context as never,
    messages: [],
    querySource: 'sdk',
  })
  check('ZERO messages enter the conversation (no user row, no stdout row)', result.messages.length === 0, `${result.messages.length} rows`)
  check('no query starts (shouldQuery false)', result.shouldQuery === false)
  check('the receipt rides resultText alone', /Captured|notepad/i.test(result.resultText ?? ''), result.resultText ?? '(none)')
  const tabRoot = process.env.MERCURY_TABULA_DIR!
  const projDirs = existsSync(tabRoot) ? readdirSync(tabRoot) : []
  const journals = projDirs.flatMap(d => {
    const p = join(tabRoot, d, 'journal.jsonl')
    return existsSync(p) ? [readFileSync(p, 'utf8')] : []
  })
  check('the note EXECUTED — the notepad journal holds the words', journals.some(j => j.includes('remember the milk')), projDirs.join(','))
}

// §3 — a words-level '/halt' reaching a session RUNNER executes NOTHING:
// the typed screen-seat refusal answers and the body never loads — the
// daemon-shutdown chain (haltAll → shutdown reapWorkers:true) is
// structurally unreachable from a runner (the operator's reaped-board
// incident, part of item 1's law).
console.log("§3 a stray '/halt' at the runner refuses typed — never the daemon-reap chain")
{
  const { processUserInput } = await import('../../src/utils/processUserInput/processUserInput.js')
  const runnerTable2 = sessionSeatCommandTable([...builtinCommands()])
  const context = {
    options: {
      commands: runnerTable2,
      tools: [],
      mcpClients: [],
      isNonInteractiveSession: true,
    },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
    }),
    setAppState: () => {},
    abortController: new AbortController(),
    readFileState: {},
    setToolJSX: () => {},
  }
  const result = await processUserInput({
    input: '/halt',
    mode: 'prompt',
    setToolJSX: () => {},
    context: context as never,
    messages: [],
    querySource: 'sdk',
  })
  check('the runner answers the typed screen-seat line (the body never loads)', /interactive surface|foreground session/.test(result.resultText ?? ''), result.resultText ?? '(none)')
  check('no query starts and no hard-stop receipt exists (poison: the reap)', result.shouldQuery === false && !/Hard stop/.test(JSON.stringify(result.messages)), '')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-command-privacy: ALL LAWS HOLD' : `\nprove-command-privacy: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
