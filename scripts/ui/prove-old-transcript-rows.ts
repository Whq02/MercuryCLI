#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'old-transcript-rows-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
delete process.env.MERCURY_CREWMATES
const { scenario, cleanupScenario, encodeFixtureTranscript, RUNTIME_CWD, SID } = await import('./renderScenarios.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const frameIndex = process.argv.indexOf('--frames')
const frameDir = frameIndex < 0 ? undefined : process.argv[frameIndex + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`)
}
type Capture = { grid: { c: string }[][]; marks?: Array<{ label: string; grid: { c: string }[][] }> }
const rowsOf = (grid: { c: string }[][]): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd())

const CREW = 'beta-fixture'
const AT = (n: number): string => `2026-06-19T12:00:${String(n).padStart(2, '0')}.000Z`
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function oldCrewRows(sid: string): Record<string, unknown>[] {
  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false, entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: sid, version: '1.0.0-beta.23', gitBranch: 'main', ...extra,
  })
  const assistant = (n: number, parent: number, content: unknown[]): Record<string, unknown> =>
    base({ parentUuid: id(parent), type: 'assistant', uuid: id(n), requestId: `req_old_${n}`,
      message: { id: `msg_old_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      timestamp: AT(n) })
  const result = (n: number, parent: number, toolUseId: string, text: string): Record<string, unknown> =>
    base({ parentUuid: id(parent), type: 'user', uuid: id(n),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
      toolUseResult: text, timestamp: AT(n) })
  const attachment = (n: number, parent: number, attachmentBody: Record<string, unknown>): Record<string, unknown> =>
    base({ parentUuid: id(parent), type: 'attachment', uuid: id(n), attachment: attachmentBody, timestamp: AT(n) })
  return [
    base({ parentUuid: null, type: 'user', uuid: id(1), message: { role: 'user', content: 'charter the fixture team and brief me' }, timestamp: AT(1) }),
    assistant(2, 1, [{ type: 'tool_use', id: 'toolu_old_create', name: 'TeamCreate', input: { team_name: CREW, description: 'the fixture team', objective: 'render an old transcript' } }]),
    result(3, 2, 'toolu_old_create', `team ${CREW} ready`),
    attachment(4, 3, { type: 'team_context', agentId: `lead@${CREW}`, agentName: 'team-lead', teamName: CREW, teamConfigPath: join(home, 'teams', CREW, 'config.json'), taskListPath: join(home, 'tasks', CREW) }),
    assistant(5, 4, [{ type: 'tool_use', id: 'toolu_old_brief', name: 'TeamBrief', input: {} }]),
    result(6, 5, 'toolu_old_brief', `Roster: team-lead, atlas`),
    assistant(7, 6, [{ type: 'tool_use', id: 'toolu_unknown_eval', name: 'REPL', input: {} }]),
    result(8, 7, 'toolu_unknown_eval', 'unknown tool result kept'),
    attachment(10, 8, { type: 'teammate_mailbox', messages: [{ from: 'beacon', text: 'the manifest edit is in', timestamp: AT(10), color: 'green', summary: 'manifest edit landed' }] }),
    attachment(16, 10, { type: 'crew_messages', messages: [{ from: 'comet', text: 'the crew kind row paints too', timestamp: AT(16), color: 'cyan', summary: 'crew kind row' }] }),
    attachment(17, 16, { type: 'queued_command', prompt: '<teammate-message teammate_id="delta" summary="OLD-TAG">OLD-TAG body from delta</teammate-message>', source_uuid: id(117), commandMode: 'prompt' }),
    attachment(18, 17, { type: 'queued_command', prompt: [{ type: 'text', text: '<crewmate-message crewmate_id="echo" color="green" summary="NEW-TAG queued from echo">\nNEW-TAG body from echo\n</crewmate-message>' }], source_uuid: id(118), commandMode: 'prompt' }),
    base({ parentUuid: id(18), type: 'user', uuid: id(12), message: { role: 'user', content: 'thanks, wrap it up' }, timestamp: AT(12) }),
  ]
}

try {
  for (const band of [{ cols: 120, rows: 40 }, { cols: 80, rows: 28 }]) {
    const cfg = scenario('resume-2turn', band.cols, band.rows)
    const path = join(getProjectDir(RUNTIME_CWD), `${SID}.jsonl`)
    writeFileSync(path, encodeFixtureTranscript(oldCrewRows(SID), SID))
    const sends = [
      { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 4, data: '', mark: 'opened' },
      { afterPrevTicks: 2, data: '\x1b[5~' },
      { afterPrevTicks: 8, data: '', mark: 'earlier' },
    ]
    const out = join(home, `${band.cols}.json`)
    const config = `${out}.cfg.json`
    writeFileSync(config, JSON.stringify({ ...cfg, sends, readyText: 'Type a prompt', total: 160, ...band, out }))
    const result = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), config], {
      encoding: 'utf8', timeout: vshotBudgetMs(180_000), env: { ...process.env, MERCURY_AWAY_SUMMARY: '0' },
    })
    let payload: Capture | undefined
    try { payload = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
    const frame = [
      ...rowsOf(payload?.marks?.find(mark => mark.label === 'earlier')?.grid ?? []),
      ...rowsOf(payload?.marks?.find(mark => mark.label === 'opened')?.grid ?? payload?.grid ?? []),
    ]
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${band.cols}x${band.rows}.txt`), frame.join('\n') + '\n')
    const flat = frame.join('\n')
    check(`${band.cols}: the old transcript opens to the composer`, result.status === 0 && flat.includes('Type a prompt'), `rc ${result.status} ${(result.stderr ?? '').slice(-200)}`)
    check(`${band.cols}: nothing calls the file a retired format or fails to open it`, !/retired format|cannot be opened|Failed to load|could not be loaded/i.test(flat), frame.filter(r => /retired|cannot be opened|Failed/i.test(r)).join(' | '))
    check(`${band.cols}: the operator's own lines render`, flat.includes('charter the fixture team') && flat.includes('wrap it up'), frame.filter(r => /charter the fixture|wrap it up/.test(r)).join(' | '))
    check(`${band.cols}: a tool row whose tool Mercury does not have paints by its name, its result under it`, /TeamCreate/.test(flat) && flat.includes('Roster: team-lead, atlas'), frame.filter(r => /TeamCreate|TeamBrief|Roster/.test(r)).join(' | '))
    check(`${band.cols}: an unknown execution tool keeps its name and result`, flat.includes('REPL') && flat.includes('unknown tool result kept'), frame.filter(r => /REPL|unknown tool result/.test(r)).join(' | '))
    const joined = frame.map(r => (r.endsWith('│') ? r.split('│').slice(-2)[0]! : r.replace(/│/g, ' '))).join(' ').replace(/\s+/g, ' ')
    const order = ['[sam] ❯ charter the fixture team', 'TeamCreate', 'TeamBrief', '❯ @comet crew kind row', 'OLD-TAG body from delta', '❯ @echo NEW-TAG queued from echo', '[sam] ❯ thanks, wrap it up'].map(needle => joined.indexOf(needle))
    check(`${band.cols}: every row paints, in the transcript's order`, order.every(i => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]!), order.join(','))
    check(`${band.cols}: an attachment kind Mercury does not know paints nothing — no sender, no summary, no error`, !/@beacon/.test(flat) && !/manifest edit landed/.test(flat) && !/teammate_mailbox/.test(flat), frame.filter(r => /@beacon|manifest edit|teammate_mailbox/.test(r)).join(' | '))
    check(`${band.cols}: the crew_messages row paints its sender and summary the same way (RED on the base: an unknown kind paints nothing)`, /@comet/.test(flat) && /crew kind row/.test(flat), frame.filter(r => /@comet/.test(r)).join(' | '))
    check(`${band.cols}: a crewmate message queued under the crew tag paints as the relay row`, /❯ @echo NEW-TAG queued from echo/.test(flat), frame.filter(r => /@echo/.test(r)).join(' | '))
    check(`${band.cols}: a tag Mercury does not know is the operator's own text: the line paints as typed, under no sender`, /\[sam\] ❯ <teammate-message/.test(flat) && joined.includes('OLD-TAG body from delta') && !/❯ @delta/.test(flat), frame.filter(r => /OLD-TAG|@delta/.test(r)).join(' | '))
    cleanupScenario('resume-2turn')
  }
} finally {
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-old-transcript-rows: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
