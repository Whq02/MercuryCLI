#!/usr/bin/env bun
// gate-watch: src/engine/message-shapes/rejectionText.ts src/screen/messages/CollapsedReadSearchContent.tsx
// gate-watch: src/screen/messages/collapseReadSearch.ts src/engine/messages/lookups.ts
// gate-watch: src/screen/messages/AssistantRedactedThinkingMessage.tsx src/screen/messages/AssistantTextMessage.tsx src/screen/messages/AssistantThinkingMessage.tsx src/screen/messages/AssistantToolUseMessage.tsx src/screen/messages/AttachmentMessage.tsx src/screen/messages/ChatLine.tsx src/screen/messages/CollapsedReadSearchContent.tsx src/screen/messages/FoldBoundaryMessage.tsx src/screen/messages/CrewChatRow.tsx src/screen/messages/GroupedToolUseContent.tsx src/screen/messages/HighlightedThinkingText.tsx src/screen/messages/HookProgressMessage.tsx src/screen/messages/RateLimitMessage.tsx src/screen/messages/ResumeRecapCard.tsx src/screen/messages/SystemAPIErrorMessage.tsx src/screen/messages/SystemTextMessage.tsx src/screen/messages/ToolRowLead.tsx src/screen/messages/TranscriptNameplate.tsx src/screen/messages/TurnReceiptRow.tsx src/screen/messages/UserBashInputMessage.tsx src/screen/messages/UserBashOutputMessage.tsx src/screen/messages/UserChannelMessage.tsx src/screen/messages/UserCommandMessage.tsx src/screen/messages/UserCrewmateNotificationMessage.tsx src/screen/messages/UserImageMessage.tsx src/screen/messages/UserLocalCommandOutputMessage.tsx src/screen/messages/UserMemoryInputMessage.tsx src/screen/messages/UserNoticeMessage.tsx src/screen/messages/UserPromptMessage.tsx src/screen/messages/UserResourceUpdateMessage.tsx src/screen/messages/UserTextMessage.tsx src/screen/messages/collapseReadSearch.ts src/screen/messages/nullRenderingAttachments.ts src/screen/messages/thinkingGrammar.tsx src/screen/messages/transcriptMemory.ts src/screen/messages/withheldThinkingDisclosure.ts src/engine/message-shapes/authWallHold.ts src/engine/message-shapes/batchedContent.ts src/engine/message-shapes/factories.ts src/engine/message-shapes/identity.ts src/engine/message-shapes/imageRequestFit.ts src/engine/message-shapes/normalize.ts src/engine/message-shapes/noticeRows.ts src/engine/message-shapes/openToolUses.ts src/engine/message-shapes/operatorTurns.ts src/engine/message-shapes/outsideReport.ts src/engine/message-shapes/rejectionText.ts src/engine/message-shapes/replyAddress.ts src/engine/message-shapes/resultPairing.ts src/engine/message-shapes/streamingTailStore.ts src/engine/message-shapes/structuredOutputDialect.ts src/engine/message-shapes/systemMessages.ts src/engine/message-shapes/tailRetirement.ts src/engine/message-shapes/text.ts src/engine/message-shapes/thinkingBlock.ts src/engine/message-shapes/toolSchemaDialect.ts src/engine/message-shapes/turnCut.ts src/engine/message-shapes/wireEdits.ts src/screen/messages-list/streamToScreen.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectDir } from '../../src/sessions/transcripts/sessionStoragePortable.ts'
import { CANCEL_MESSAGE, INTERRUPT_MESSAGE, REJECT_MESSAGE, denialLineOf, isDenialResultText, isUserInterruptResultText, turnCutOf, turnCutResultText } from '../../src/engine/message-shapes/rejectionText.ts'
import { buildWardDenial, evaluateWards } from '../../src/permissions/wards/wards.ts'
import { CONFIG_HOME, RUNTIME_CWD, SID, cleanupScenario, encodeFixtureTranscript, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

// gate-watch: src/sessions/transcripts/sessionStoragePortable.ts src/permissions/wards/wards.ts src/permissions/wards/wardsRefusals.ts src/permissions/wards/wardsShellRead.ts
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
const SHELL_INTERRUPTED = `Shell command failed\n${INTERRUPT_MESSAGE}\nExited with code 137`
const TOOL_INTERRUPTED = turnCutResultText(turnCutOf(undefined), 'Bash')

console.log('============================================================')
console.log(' the transcript counts what ran — "Ran" only for commands that ran')
console.log('============================================================')

console.log('\n(A) a ward denial is a DENIAL — the ✕ lead and the refusal line, not an ordinary failure')
check('the ward text classifies as a denial', isDenialResultText(WARD_ON_DISK), `${WARD_TEXT.slice(0, 80)} — isDenialResultText in src/engine/message-shapes/rejectionText.ts must accept the ward's denial text (the /^Ward '...' blocked this / form) that buildWardDenial in src/permissions/wards/wards.ts produces`)
check('its one line names the ward', denialLineOf(WARD_ON_DISK).startsWith(WARD_LINE), `${denialLineOf(WARD_ON_DISK)} — denialLineOf in src/engine/message-shapes/rejectionText.ts must return the ward's first sentence, which buildWardDenial in src/permissions/wards/wards.ts opens with the ward name`)
check('user interrupts classify as interrupts AND stay stops for isDenialResultText', isUserInterruptResultText(SHELL_INTERRUPTED) && isUserInterruptResultText(TOOL_INTERRUPTED) && isUserInterruptResultText(CANCEL_MESSAGE) && isDenialResultText(SHELL_INTERRUPTED) && isDenialResultText(TOOL_INTERRUPTED), 'isUserInterruptResultText in src/engine/message-shapes/rejectionText.ts must match shell interrupts, Interrupted by user and CANCEL_MESSAGE without changing isDenialResultText')
check('wards and permission declines are NOT user interrupts', !isUserInterruptResultText(WARD_ON_DISK) && !isUserInterruptResultText(DECLINED_ON_DISK), 'isUserInterruptResultText in src/engine/message-shapes/rejectionText.ts must return false for ward and permission refusals')

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

function writeInterruptedSession(): void {
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false, entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID,
    version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
  })
  const lines = [
    base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000h1',
      message: { role: 'user', content: 'run sleep 30' },
      timestamp: '2026-06-19T12:00:01.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000h1', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000h2', requestId: 'req_int_1',
      message: { id: 'msg_int_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_int_bash1', name: 'Bash', input: { command: 'sleep 30', description: 'Wait 30 seconds' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:02.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000h2', type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000h3',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_int_bash1', content: SHELL_INTERRUPTED, is_error: true }] },
      toolUseResult: SHELL_INTERRUPTED,
      timestamp: '2026-06-19T12:00:03.000Z' }),
  ]
  const projects = getProjectDir(RUNTIME_CWD)
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript(lines, SID))
}

function writeBlockedAndInterruptedSession(): void {
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false, entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID,
    version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
  })
  const lines = [
    base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000000i1',
      message: { role: 'user', content: 'four calls: one ran, one ward-blocked, two interrupted' },
      timestamp: '2026-06-19T12:00:01.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000i1', type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000i2', requestId: 'req_bi_1',
      message: { id: 'msg_bi_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', id: 'toolu_bi_ok1', name: 'Bash', input: { command: 'echo ok', description: 'Print ok' } },
          { type: 'tool_use', id: 'toolu_bi_ward1', name: 'Bash', input: { command: HOME_DELETE, description: 'Delete the scratch folder' } },
          { type: 'tool_use', id: 'toolu_bi_int1', name: 'Bash', input: { command: 'sleep 30', description: 'Wait 30 seconds' } },
          { type: 'tool_use', id: 'toolu_bi_int2', name: 'Bash', input: { command: 'echo after', description: 'Print after' } },
        ],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: '2026-06-19T12:00:02.000Z' }),
    base({ parentUuid: '00000000-0000-4000-8000-0000000000i2', type: 'user',
      uuid: '00000000-0000-4000-8000-0000000000i3',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_bi_ok1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_bi_ward1', content: WARD_ON_DISK, is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_bi_int1', content: TOOL_INTERRUPTED, is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_bi_int2', content: CANCEL_MESSAGE, is_error: true },
      ] },
      toolUseResult: TOOL_INTERRUPTED,
      timestamp: '2026-06-19T12:00:03.000Z' }),
  ]
  const projects = getProjectDir(RUNTIME_CWD)
  if (!existsSync(projects)) mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript(lines, SID))
}

function capture(label: string, readyText: string): string[] | null {
  const cfg = scenario('two-bash-click', label === 'blocked-and-interrupted' ? 140 : 100, 50) as Record<string, unknown>
  if (label === 'ward') writeWardSession()
  else if (label === 'interrupted') writeInterruptedSession()
  else if (label === 'blocked-and-interrupted') writeBlockedAndInterruptedSession()
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
  check('the folded row stands', foldRow !== undefined, wardRows.filter(r => r.trim() !== '').slice(-6).join(' | ') + ' — the folded bash-command row was not on screen: read the PTY capture from vshot.py and the row built in src/screen/messages/CollapsedReadSearchContent.tsx')
  check('the row does NOT say "Ran … bash command"', !/Ran \d+ bash command/.test(all), `${foldRow ?? ''} — a denied bash call is counted as ran: bashDenied/bashRan in src/screen/messages/CollapsedReadSearchContent.tsx must come from lookups.deniedToolUseIDs`)
  check('the row says "blocked … bash command"', /[Bb]locked \d+ bash command/.test(all), `${foldRow ?? ''} — the 'blocked' fragment (bashBlocked) in src/screen/messages/CollapsedReadSearchContent.tsx did not render for the ward-denied call`)
  check('the row carries the ✕ denial lead', (foldRow ?? '').includes('✕'), `${foldRow ?? ''} — the folded row lost its ✕ denial lead: check how src/screen/messages/CollapsedReadSearchContent.tsx marks denied members`)
  check('the ward\'s one line rides under the folded row', all.includes(WARD_LINE), `${foldRow ?? ''} — the ward's one-line refusal (denialLineOf in src/engine/message-shapes/rejectionText.ts) is not shown under the folded row`)
  check('the model-facing teach text stays off the screen', !all.includes('rewrite the call to comply') && !all.includes('surface the refusal to the operator'), 'the ward\'s model-facing teach text leaked onto the screen: show only denialLineOf(...) from src/engine/message-shapes/rejectionText.ts, not the full ward denial')
}

console.log('\n(C) one ran, one ward-blocked, one declined — the count splits and both refusals show')
const mixRows = capture('mixed', 'bash command')
if (mixRows) {
  const all = flat(mixRows)
  const foldRow = mixRows.find(row => /bash command/i.test(row)) ?? ''
  if (process.env.RAN_COUNT_DEBUG) console.log(mixRows.filter(r => r.trim() !== '').join('\n'))
  check('the row counts the ONE command that ran', /[Rr]an 1 bash command/.test(all), `${foldRow} — the ran count (bashRan) in src/screen/messages/CollapsedReadSearchContent.tsx must be total bash calls minus denied ones; set RAN_COUNT_DEBUG=1 to print the screen`)
  check('the blocked calls are named, not counted as ran', /[Bb]locked 2 bash commands/.test(all), `${foldRow} — the blocked count (bashBlocked) in src/screen/messages/CollapsedReadSearchContent.tsx must count both the ward-blocked and the declined call`)
  check('the ward\'s line shows', all.includes(WARD_LINE), 'the ward refusal line is missing from the screen: see denialLineOf in src/engine/message-shapes/rejectionText.ts and the folded row in src/screen/messages/CollapsedReadSearchContent.tsx')
  check('the decline\'s line shows', all.includes(DECLINED_NEEDLE), `${foldRow} — the declined call's line (REJECT_MESSAGE in src/engine/message-shapes/rejectionText.ts) is missing from the screen`)
  check('no command is counted as ran that did not run', !/[Rr]an [23] bash commands?/.test(all), `${foldRow} — denied calls are still counted as ran: fix bashDenied/bashRan in src/screen/messages/CollapsedReadSearchContent.tsx`)
}

console.log('\n(D) an interrupted bash command — summed up as "Interrupted", never "Blocked"')
const intRows = capture('interrupted', 'bash command')
if (intRows) {
  const all = flat(intRows)
  const foldRow = intRows.find(row => /bash command/i.test(row)) ?? ''
  check('the interrupted row says "Interrupted 1 bash command"', /Interrupted 1 bash command/.test(all), `${foldRow} — an interrupted bash call must count as interrupted in src/screen/messages/CollapsedReadSearchContent.tsx`)
  check('the interrupted row does NOT say "Blocked" or "Ran"', !/[Bb]locked \d+ bash command/.test(all) && !/[Rr]an \d+ bash command/.test(all), `${foldRow} — an interrupted bash call must not be counted as blocked or ran in src/screen/messages/CollapsedReadSearchContent.tsx`)
  check('the interrupted row keeps the ✕ lead', foldRow.includes('✕'), `${foldRow} — an interrupted bash row keeps the ✕ lead in src/screen/messages/CollapsedReadSearchContent.tsx`)
  check('the interrupt line rides under the folded row', all.includes(INTERRUPT_MESSAGE), `${foldRow} — the interrupt line must still appear under the folded row`)
}

console.log('\n(E) one ran, one ward-blocked, two interrupted — three separate counts')
const biRows = capture('blocked-and-interrupted', 'bash command')
if (biRows) {
  const all = flat(biRows)
  const foldRow = biRows.find(row => /bash command/i.test(row)) ?? ''
  check('the row counts the 1 ran command', /[Rr]an 1 bash command/.test(all), `${foldRow} — fix bashRan in src/screen/messages/CollapsedReadSearchContent.tsx`)
  check('the row counts the 1 blocked command separately', /[Bb]locked 1 bash command/.test(all), `${foldRow} — fix bashBlocked in src/screen/messages/CollapsedReadSearchContent.tsx`)
  check('the row counts the 2 interrupted commands separately', /[Ii]nterrupted 2 bash commands/.test(all), `${foldRow} — fix bashInterrupted in src/screen/messages/CollapsedReadSearchContent.tsx`)
}

check('the canary survived — no fixture command was ever executed', readFileSync(CANARY, 'utf8') === 'alive' && existsSync(join(PROJECT, 'scratch-dir', 'zzz-test')), 'the fixture command ran or the canary file changed: the proof must only render a recorded transcript, so look at what this script or vshot.py launched, not at src/')
cleanupScenario('two-bash-click')
rmSync(CANARY_ROOT, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅ ran-counts-what-ran PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
