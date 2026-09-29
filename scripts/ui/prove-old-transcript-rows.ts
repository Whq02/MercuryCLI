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
delete process.env.MERCURY_TEAMMATES
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

const TEAM = 'beta-fixture'
const AT = (n: number): string => `2026-06-19T12:00:${String(n).padStart(2, '0')}.000Z`
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function oldTeamRows(sid: string): Record<string, unknown>[] {
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
  const relay = (n: number, parent: number, from: string, summary: string, body: string): Record<string, unknown> =>
    base({ parentUuid: id(parent), type: 'user', uuid: id(n),
      message: { role: 'user', content: `<teammate-message teammate_id="${from}" color="blue" summary="${summary}">${body}</teammate-message>` },
      timestamp: AT(n) })
  const attachment = (n: number, parent: number, attachmentBody: Record<string, unknown>): Record<string, unknown> =>
    base({ parentUuid: id(parent), type: 'attachment', uuid: id(n), attachment: attachmentBody, timestamp: AT(n) })
  return [
    base({ parentUuid: null, type: 'user', uuid: id(1), message: { role: 'user', content: 'charter the fixture team and brief me' }, timestamp: AT(1) }),
    assistant(2, 1, [{ type: 'tool_use', id: 'toolu_old_create', name: 'TeamCreate', input: { team_name: TEAM, description: 'the fixture team', objective: 'render an old transcript' } }]),
    result(3, 2, 'toolu_old_create', `team ${TEAM} ready`),
    attachment(4, 3, { type: 'team_context', agentId: `lead@${TEAM}`, agentName: 'team-lead', teamName: TEAM, teamConfigPath: join(home, 'teams', TEAM, 'config.json'), taskListPath: join(home, 'tasks', TEAM) }),
    assistant(5, 4, [{ type: 'tool_use', id: 'toolu_old_brief', name: 'TeamBrief', input: {} }]),
    result(6, 5, 'toolu_old_brief', `# Team: ${TEAM}\n\nOpen tasks: none\nRoster: team-lead, atlas`),
    assistant(7, 6, [{ type: 'tool_use', id: 'toolu_old_send', name: 'SendMessage', input: { to: 'atlas', summary: 'map the auth flow', message: 'map the auth flow and report' } }]),
    result(8, 7, 'toolu_old_send', 'Message delivered to atlas'),
    relay(9, 8, 'atlas', 'auth findings ready', 'I finished mapping the auth flow; notes are in the handoff.'),
    attachment(10, 9, { type: 'teammate_mailbox', messages: [{ from: 'beacon', text: 'the manifest edit is in', timestamp: AT(10), color: 'green', summary: 'manifest edit landed' }] }),
    relay(11, 10, 'atlas', 'shutting down', JSON.stringify({ type: 'shutdown_request', requestId: 'shutdown-old1', from: 'atlas', reason: 'the work is done', timestamp: AT(11) })),
    base({ parentUuid: id(11), type: 'user', uuid: id(12), message: { role: 'user', content: 'thanks, wrap it up' }, timestamp: AT(12) }),
  ]
}

try {
  for (const band of [{ cols: 120, rows: 40 }, { cols: 80, rows: 24 }]) {
    const cfg = scenario('resume-2turn', band.cols, band.rows)
    const path = join(getProjectDir(RUNTIME_CWD), `${SID}.jsonl`)
    writeFileSync(path, encodeFixtureTranscript(oldTeamRows(SID), SID))
    const sends = [{ awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 4, data: '', mark: 'opened' }]
    const out = join(home, `${band.cols}.json`)
    const config = `${out}.cfg.json`
    writeFileSync(config, JSON.stringify({ ...cfg, sends, readyText: 'Type a prompt', total: 160, ...band, out }))
    const result = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), config], {
      encoding: 'utf8', timeout: vshotBudgetMs(180_000), env: { ...process.env, MERCURY_AWAY_SUMMARY: '0' },
    })
    let payload: Capture | undefined
    try { payload = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
    const frame = rowsOf(payload?.marks?.find(mark => mark.label === 'opened')?.grid ?? payload?.grid ?? [])
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${band.cols}x${band.rows}.txt`), frame.join('\n') + '\n')
    const flat = frame.join('\n')
    check(`${band.cols}: the old transcript opens to the composer`, result.status === 0 && flat.includes('Type a prompt'), `rc ${result.status} ${(result.stderr ?? '').slice(-200)}`)
    check(`${band.cols}: nothing calls the file a retired format or fails to open it`, !/retired format|cannot be opened|Failed to load|could not be loaded/i.test(flat), frame.filter(r => /retired|cannot be opened|Failed/i.test(r)).join(' | '))
    check(`${band.cols}: the operator's own lines render`, flat.includes('charter the fixture team') && flat.includes('wrap it up'), frame.filter(r => /charter the fixture|wrap it up/.test(r)).join(' | '))
    check(`${band.cols}: the old TeamCreate row still paints`, /create team: beta-fixture|TeamCreate/.test(flat), frame.filter(r => /TeamCreate|create team/.test(r)).join(' | '))
    const order = ['[sam] ❯ charter the fixture team', 'TeamCreate   create team:', '❯ @atlas auth findings ready', '❯ @beacon manifest edit landed', '@atlas requested shutdown', '[sam] ❯ thanks, wrap it up'].map(needle => frame.findIndex(r => r.includes(needle)))
    check(`${band.cols}: the old brief and send rows break nothing — the rows after them paint, in order`, order.every(i => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]!), order.join(','))
    check(`${band.cols}: the crewmate relay row paints its sender and summary`, /@atlas auth findings ready/.test(flat), frame.filter(r => /@atlas/.test(r)).join(' | '))
    check(`${band.cols}: the mailbox row paints its sender and summary`, /@beacon/.test(flat) && /manifest edit landed/.test(flat), frame.filter(r => /@beacon/.test(r)).join(' | '))
    check(`${band.cols}: the shutdown request card paints with its reason`, /@atlas requested shutdown — the work is done/.test(flat), frame.filter(r => /shutdown/.test(r)).join(' | '))
    cleanupScenario('resume-2turn')
  }
} finally {
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-old-transcript-rows: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
