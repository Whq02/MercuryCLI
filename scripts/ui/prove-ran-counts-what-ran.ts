#!/usr/bin/env bun
// gate-watch: src/utils/messages/rejectionText* src/components/messages/CollapsedReadSearchContent*
// gate-watch: src/utils/collapseReadSearch* src/utils/messages/lookups*
// gate-watch: src/components/messages/* src/utils/messages/*
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectDir } from '../../src/utils/sessionStoragePortable.ts'
import { REJECT_MESSAGE, denialLineOf, isDenialResultText } from '../../src/utils/messages/rejectionText.ts'
import { buildWardDenial, evaluateWards } from '../../src/utils/wards/wards.ts'
import { CONFIG_HOME, RUNTIME_CWD, SID, cleanupScenario, encodeFixtureTranscript, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

// gate-watch: src/utils/sessionStoragePortable* src/utils/wards/wards*
const CANARY_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ran-count-')))
const PROJECT = join(CANARY_ROOT, 'Users', 'proof', 'hunt')
mkdirSync(join(PROJECT, 'scratch-dir', 'zzz-test'), { recursive: true })
const CANARY = join(PROJECT, 'CANARY')
writeFileSync(CANARY, 'alive')

const HOME_DELETE = `rm -rf ${join(PROJECT, 'scratch-dir', 'zzz-test')}`
const RULE = { name: 'no-home-recursive-delete', scope: 'bash' as const, teach: 'Autonomous sessions never recursively delete inside the user home.', patterns: ['\\brm\\b(?=[^\\n;|&]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b))[^\\n;|&]*\\s(?:~(?:\\/|\\s|$)|\\$\\{?HOME|\\/Users\\/)'], skipCommentLines: false }
const wardVerdict = evaluateWards([RULE], { toolName: 'Bash', input: { command: `rm -rf /Users/proof/hunt/scratch-dir/zzz-test` }, shellCommand: `rm -rf /Users/proof/hunt/scratch-dir/zzz-test` })
if (wardVerdict.allow) {
  console.log('❌ the fixture ward rule did not match — the proof cannot run')
  process.exit(1)
}
const WARD_TEXT = buildWardDenial(wardVerdict, 'Bash')
const WARD_ON_DISK = `<tool_use_error>${WARD_TEXT}</tool_use_error>`
const DECLINED_ON_DISK = `<tool_use_error>${REJECT_MESSAGE}</tool_use_error>`
const DECLINED_LINE = denialLineOf(REJECT_MESSAGE)
const DECLINED_NEEDLE = 'The operator declined this tool call'
const WARD_LINE = 'Ward \'no-home-recursive-delete\' blocked this Bash call'

console.log('============================================================')
console.log(' the transcript counts what ran — "Ran" only for commands that ran')
console.log('============================================================')

console.log('\n(A) a ward denial is a DENIAL — the ✕ lead and the refusal line, not an ordinary failure')
check('the ward text classifies as a denial', isDenialResultText(WARD_ON_DISK), WARD_TEXT.slice(0, 80))
check('its one line names the ward', denialLineOf(WARD_ON_DISK).startsWith(WARD_LINE), denialLineOf(WARD_ON_DISK))

type Cell = { c: string }
type Grid = { grid: Cell[][] }
const rowsOf = (grid: Cell[][]): string[] => grid.map(row => row.map(cell => cell.c).join('').trimEnd())
const flat = (rows: string[]): string => rows.join(' ').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')

function writeWardSession(): void {
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false, entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID,
    version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
  })
  const lines = [
    base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000f1',
      message: { role: 'user', content: 'delete my scratch folder with this exact command: ' + HOME_DELETE },
      timestamp: '2026-06-19T12:00:01.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000f1', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000f2', requestId: 'req_ward_1',
      message: { id: 'msg_ward_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_ward_bash1', name: 'Bash', input: { command: HOME_DELETE, description: 'Delete the disposable scratch folder' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:02.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000f2', type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000f3',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ward_bash1', content: WARD_ON_DISK, is_error: true }] },
      toolUseResult: WARD_ON_DISK,
      timestamp: '2026-06-19T12:00:03.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000f3', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000f4', requestId: 'req_ward_2',
      message: { id: 'msg_ward_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'The ward blocked it, so nothing ran.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:04.000Z' }),
  ]
  const projects = getProjectDir(RUNTIME_CWD)
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript(lines, SID))
}

function writeMixedSession(): void {
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false, entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID,
    version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
  })
  const lines = [
    base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000g1',
      message: { role: 'user', content: 'three calls: one that runs, one the ward blocks, one I decline' },
      timestamp: '2026-06-19T12:00:01.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000g1', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000g2', requestId: 'req_mix_1',
      message: { id: 'msg_mix_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', id: 'toolu_mix_ok1', name: 'Bash', input: { command: 'echo ok', description: 'Print ok' } },
          { type: 'tool_use', id: 'toolu_mix_ward1', name: 'Bash', input: { command: HOME_DELETE, description: 'Delete the scratch folder' } },
          { type: 'tool_use', id: 'toolu_mix_no1', name: 'Bash', input: { command: 'rm -f nonexistent-1.txt', description: 'Remove the file if present' } },
        ],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:02.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000g2', type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000g3',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_mix_ok1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_mix_ward1', content: WARD_ON_DISK, is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_mix_no1', content: DECLINED_ON_DISK, is_error: true },
      ] },
      toolUseResult: WARD_ON_DISK,
      timestamp: '2026-06-19T12:00:03.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000g3', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000g4', requestId: 'req_mix_2',
      message: { id: 'msg_mix_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'One ran; two never did.' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:04.000Z' }),
  ]
  const projects = getProjectDir(RUNTIME_CWD)
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript(lines, SID))
}

function capture(label: string, readyText: string): string[] | null {
  const cfg = scenario('two-bash-click', 100, 50) as Record<string, unknown>
  if (label === 'ward') writeWardSession()
  else writeMixedSession()
  const gridPath = `/tmp/ran-count-${label}-${process.pid}.json`
  const cfgPath = `/tmp/ran-count-${label}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sends: [], readyText, stableTicks: 4, total: 90, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_FULLSCREEN: '1' },
  })
  rmSync(cfgPath, { force: true })
  if (res.status !== 0) {
    check(`PTY capture ran (${label})`, false, res.stderr?.slice(0, 300) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  rmSync(gridPath, { force: true })
  return rowsOf(grid)
}

console.log('\n(B) a ward-blocked delete — the row never says "Ran", the ✕ lead and the ward line show')
const wardRows = capture('ward', 'bash command')
if (wardRows) {
  const foldRow = wardRows.find(row => /bash command/i.test(row))
  const all = flat(wardRows)
  check('the folded row stands', foldRow !== undefined, wardRows.filter(r => r.trim() !== '').slice(-6).join(' | '))
  check('the row does NOT say "Ran … bash command"', !/Ran \d+ bash command/.test(all), foldRow ?? '')
  check('the row says "blocked … bash command"', /[Bb]locked \d+ bash command/.test(all), foldRow ?? '')
  check('the row carries the ✕ denial lead', (foldRow ?? '').includes('✕'), foldRow ?? '')
  check('the ward\'s one line rides under the folded row', all.includes(WARD_LINE), foldRow ?? '')
  check('the model-facing teach text stays off the screen', !all.includes('rewrite the call to comply') && !all.includes('surface the refusal to the operator'))
}

console.log('\n(C) one ran, one ward-blocked, one declined — the count splits and both refusals show')
const mixRows = capture('mixed', 'bash command')
if (mixRows) {
  const all = flat(mixRows)
  const foldRow = mixRows.find(row => /bash command/i.test(row)) ?? ''
  if (process.env.RAN_COUNT_DEBUG) console.log(mixRows.filter(r => r.trim() !== '').join('\n'))
  check('the row counts the ONE command that ran', /[Rr]an 1 bash command/.test(all), foldRow)
  check('the blocked calls are named, not counted as ran', /[Bb]locked 2 bash commands/.test(all), foldRow)
  check('the ward\'s line shows', all.includes(WARD_LINE))
  check('the decline\'s line shows', all.includes(DECLINED_NEEDLE), foldRow)
  check('no command is counted as ran that did not run', !/[Rr]an [23] bash commands?/.test(all), foldRow)
}

check('the canary survived — no fixture command was ever executed', readFileSync(CANARY, 'utf8') === 'alive' && existsSync(join(PROJECT, 'scratch-dir', 'zzz-test')))
cleanupScenario('two-bash-click')
rmSync(CANARY_ROOT, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅ ran-counts-what-ran PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
