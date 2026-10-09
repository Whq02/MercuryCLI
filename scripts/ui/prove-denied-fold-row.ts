#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectDir } from '../../src/utils/sessionStoragePortable.ts'
import { unansweredAskRefusal } from '../../src/utils/permissions/askClock.ts'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  denialLineOf,
  isDenialResultText,
} from '../../src/utils/messages/rejectionText.ts'
import { CONFIG_HOME, RUNTIME_CWD, SID, cleanupScenario, encodeFixtureTranscript, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}

const MINUTE = 60_000
const EXPIRED = unansweredAskRefusal('Bash', 10 * MINUTE)
const EXPIRED_ON_DISK = `<tool_use_error>${EXPIRED}</tool_use_error>`
const EXPIRED_LINE = 'Permission to use Bash has been denied: nobody answered the permission ask within 10m, so it expired and was refused; the action was not run.'
const DECLINED_LINE = 'The operator declined this tool call; it was not run and nothing was changed.'

console.log('============================================================')
console.log(' denied fold row — the refusal\'s one line rides the folded tool row')
console.log('============================================================')

console.log('\n(A) denialLineOf — the one line of every denial the classifier reads')
check('an expired ask: the sentence that names the clock and that nothing ran', denialLineOf(EXPIRED) === EXPIRED_LINE, denialLineOf(EXPIRED))
check('the same through the transcript\'s error wrapper', denialLineOf(EXPIRED_ON_DISK) === EXPIRED_LINE, denialLineOf(EXPIRED_ON_DISK))
check('the operator\'s No: its first sentence', denialLineOf(REJECT_MESSAGE) === DECLINED_LINE, denialLineOf(REJECT_MESSAGE))
check('the operator\'s No with a reason keeps the reason', denialLineOf(`${REJECT_MESSAGE_WITH_REASON_PREFIX}use the staging box`) === `${DECLINED_LINE} The operator said: use the staging box`, denialLineOf(`${REJECT_MESSAGE_WITH_REASON_PREFIX}use the staging box`))
check('the expiry refusal is a denial the row classifier reads', isDenialResultText(EXPIRED_ON_DISK))

type Cell = { c: string }
type Grid = { grid: Cell[][] }
const rowsOf = (grid: Cell[][]): string[] => grid.map(row => row.map(cell => cell.c).join('').trimEnd())
const flat = (grid: Cell[][]): string => rowsOf(grid).join(' ').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')
const around = (rows: string[], needle: RegExp, span = 5): string => {
  const at = rows.findIndex(row => needle.test(row))
  const window = at < 0 ? rows.filter(row => row.trim() !== '').slice(-12) : rows.slice(Math.max(0, at - 1), at + span)
  return window.map(row => row.trim()).join(' | ')
}

function writeExpiredAskSession(): void {
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd: RUNTIME_CWD,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  const lines = [
    base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000e1',
      message: { role: 'user', content: 'Using the Bash tool, run exactly this command: rm -rf ./mercury-nothing-here' },
      timestamp: '2026-06-19T12:00:01.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000e1', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000e2', requestId: 'req_ask_1',
      message: { id: 'msg_ask_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'The path does not exist, so this remove will delete nothing. Running the exact command now.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:02.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000e2', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000e3', requestId: 'req_ask_2',
      message: { id: 'msg_ask_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_ask_bash1', name: 'Bash', input: { command: 'rm -rf ./mercury-nothing-here', description: 'Remove the path if present' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:03.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000e3', type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000e4',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask_bash1', content: EXPIRED_ON_DISK, is_error: true }] },
      toolUseResult: EXPIRED_ON_DISK,
      timestamp: '2026-06-19T12:10:03.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000e4', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000e5', requestId: 'req_ask_3',
      message: { id: 'msg_ask_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'I did not run the command: nobody answered within ten minutes and the request expired.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:10:10.000Z' }),
  ]
  const projects = getProjectDir(RUNTIME_CWD)
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript(lines, SID))
}

function capture(label: string, sends: Array<Record<string, unknown>>, readyText: string): Cell[][] | null {
  const cfg = scenario('two-bash-click', 80, 40) as Record<string, unknown>
  writeExpiredAskSession()
  const gridPath = `/tmp/denied-fold-${label}-${process.pid}.json`
  const cfgPath = `/tmp/denied-fold-${label}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sends, readyText, stableTicks: 4, total: 90, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME },
  })
  rmSync(cfgPath, { force: true })
  if (res.status !== 0) {
    check(`PTY capture ran (${label})`, false, res.stderr?.slice(0, 300) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  rmSync(gridPath, { force: true })
  return grid
}

console.log('\n(B) the compact fold row at 80 — a Bash call whose ask expired, nobody answering')
const folded = capture('folded', [], 'bash command')
if (folded) {
  const rows = rowsOf(folded)
  const foldRow = rows.find(row => /bash command/.test(row))
  check('the folded row stands with the ✕ lead', foldRow !== undefined && foldRow.includes('✕'), around(rows, /bash command/))
  check('the refusal\'s one line rides under the folded row', flat(folded).includes('nobody answered the permission ask within 10m, so it expired and was refused; the action was not run'), around(rows, /bash command/))
  check('the guidance meant for the model stays off the screen', !flat(folded).includes('Do not try to reach the same effect'))
}

console.log('\n(C) the expanded group (ctrl+o) — the member row carries the same line')
const expanded = capture('expanded', [{ data: '\x0f', atTick: 999, awaitText: 'bash command', requireAwait: true, minTick: 4, awaitSettleTicks: 4 }], 'Expanded group')
if (expanded) {
  const rows = rowsOf(expanded)
  const memberRow = rows.find(row => /✕ Bash/.test(row))
  check('the expanded group shows the Bash member with the ✕ lead', memberRow !== undefined, around(rows, /Expanded group/))
  check('the refusal\'s one line sits under the member row', flat(expanded).includes('nobody answered the permission ask within 10m, so it expired and was refused; the action was not run'), around(rows, /✕ Bash/))
}
cleanupScenario('two-bash-click')

console.log(`\n${failures === 0 ? '✅ denied fold row PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
