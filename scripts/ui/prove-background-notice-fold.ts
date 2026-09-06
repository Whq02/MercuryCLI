#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_FULLSCREEN = '1'

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const fold = await import('../../src/utils/collapseBackgroundBashNotifications.ts')
const { BACKGROUND_BASH_SUMMARY_PREFIX } = await import('../../src/tasks/LocalShellTask/LocalShellTask.tsx')
const { extractTag } = await import('../../src/utils/messages.ts')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.ts')

type Row = Record<string, unknown> & { type: string; uuid: string; timestamp: string; queued?: true }
type Outcome = 'completed' | 'failed' | 'killed'

const notice = (id: string, status: string, summary: string): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/${id}.out</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`
const shellSummary = (title: string, status: Outcome, code?: number): string =>
  `${BACKGROUND_BASH_SUMMARY_PREFIX}"${title}" ${status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'was stopped'}${code !== undefined ? ` (exit code ${code})` : ''}`
let clock = 0
const stamp = (): string => `2026-06-19T12:00:${String(++clock).padStart(2, '0')}.000Z`
const attachmentNotice = (id: string, title: string, status: Outcome, code?: number, queued = false): Row => ({
  type: 'attachment',
  uuid: `u-${id}`,
  timestamp: stamp(),
  attachment: { type: 'queued_command', prompt: notice(id, status, shellSummary(title, status, code)), commandMode: 'task-notification' },
  ...(queued ? { queued: true as const } : {}),
})
const userNotice = (id: string, title: string, status: Outcome, code?: number): Row => ({
  type: 'user',
  uuid: `u-${id}`,
  timestamp: stamp(),
  message: { role: 'user', content: [{ type: 'text', text: notice(id, status, shellSummary(title, status, code)) }] },
})
const agentNotice = (id: string): Row => ({
  type: 'attachment',
  uuid: `u-${id}`,
  timestamp: stamp(),
  attachment: { type: 'queued_command', prompt: notice(id, 'completed', 'Agent "a quick errand" completed'), commandMode: 'task-notification' },
})
const assistantRow = (id: string): Row => ({
  type: 'assistant',
  uuid: `u-${id}`,
  timestamp: stamp(),
  message: { id, type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})
const run = (rows: Row[], verbose = false): Row[] => fold.collapseBackgroundBashNotifications(rows as never, verbose) as unknown as Row[]
const textOf = (row: Row): string => {
  if (row.type === 'attachment') return String((row.attachment as { prompt?: unknown }).prompt ?? '')
  const content = (row.message as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ''
}
const summaryOf = (row: Row): string => extractTag(textOf(row), 'summary') ?? ''
const statusOf = (row: Row): string => extractTag(textOf(row), 'status') ?? ''
const foldedOf = (row: Row): string | null => extractTag(textOf(row), fold.FOLDED_COUNT_TAG)

console.log('§1 the pure owner — one row per run, counted by outcome')
{
  const mixed = [attachmentNotice('t1', 'lint', 'completed', 0), attachmentNotice('t2', 'typecheck', 'failed', 2), attachmentNotice('t3', 'unit tests', 'completed', 0)]
  const out = run(mixed)
  check('three delivered notices (done, failed, done) fold into ONE row', out.length === 1, String(out.length))
  const row = out[0]!
  check('the row keeps the first notice\'s shape, uuid and clock', row.type === 'attachment' && row.uuid === mixed[0]!.uuid && row.timestamp === mixed[0]!.timestamp && row.queued === undefined)
  check('the words count the outcomes and keep the failed command\'s title and exit code', summaryOf(row) === '3 background commands · 2 done · 1 failed — "typecheck" (exit code 2)', summaryOf(row))
  check('the row wears the worst outcome (failed) and carries the folded count', statusOf(row) === 'failed' && foldedOf(row) === '3', `${statusOf(row)} / ${foldedOf(row)}`)
  check('the lane stays the task-notification lane (the same painter draws it)', (row.attachment as { commandMode?: string }).commandMode === 'task-notification' && (row.attachment as { type?: string }).type === 'queued_command')

  const queued = [attachmentNotice('q1', 'lint', 'completed', 0, true), attachmentNotice('q2', 'typecheck', 'failed', 2, true), attachmentNotice('q3', 'unit tests', 'completed', 0, true)]
  const qout = run(queued)
  check('three queued notices fold into ONE row that says they wait for the next turn', qout.length === 1 && summaryOf(qout[0]!) === '3 queued for the next turn · 2 done · 1 failed — "typecheck" (exit code 2)', qout.length === 1 ? summaryOf(qout[0]!) : String(qout.length))
  check('the queued dress rides the folded row', qout[0]!.queued === true)

  const boundary = [attachmentNotice('b1', 'lint', 'completed', 0), attachmentNotice('b2', 'docs', 'completed', 0), attachmentNotice('b3', 'typecheck', 'failed', 2, true)]
  const bout = run(boundary)
  check('a queued/delivered boundary breaks the run: the delivered pair folds, the queued failure stays its own row', bout.length === 2 && summaryOf(bout[0]!) === '2 background commands completed' && bout[1] === boundary[2], String(bout.length))

  const single = [assistantRow('a1'), attachmentNotice('s1', 'lint', 'completed', 0), assistantRow('a2')]
  const sout = run(single)
  check('a run of one passes through unchanged (the same object)', sout.length === 3 && sout[1] === single[1])

  const legacy = [userNotice('l1', 'lint', 'completed', 0), userNotice('l2', 'docs', 'completed', 0), userNotice('l3', 'tests', 'completed', 0)]
  const lout = run(legacy)
  check('the older user-row form folds too, and clean completions keep the plain count', lout.length === 1 && lout[0]!.type === 'user' && summaryOf(lout[0]!) === '3 background commands completed' && foldedOf(lout[0]!) === '3', lout.length === 1 ? summaryOf(lout[0]!) : String(lout.length))

  const stopped = [attachmentNotice('k1', 'lint', 'completed', 0), attachmentNotice('k2', 'watch', 'killed')]
  const kout = run(stopped)
  check('a stopped command is counted and named', kout.length === 1 && summaryOf(kout[0]!) === '2 background commands · 1 done · 1 stopped — "watch"' && statusOf(kout[0]!) === 'killed', kout.length === 1 ? summaryOf(kout[0]!) : String(kout.length))

  const broken = [attachmentNotice('x1', 'lint', 'completed', 0), agentNotice('x2'), attachmentNotice('x3', 'docs', 'completed', 0), assistantRow('x4'), attachmentNotice('x5', 'tests', 'completed', 0)]
  const xout = run(broken)
  check('an agent notification and an assistant row each break the run and keep their own rows', xout.length === 5 && xout.every((r, i) => r === broken[i]))
  check('the predicate: a shell notice is recognised, an agent notice is not, a monitor summary without status is not', fold.shellNoticeOf(broken[0] as never) !== null && fold.shellNoticeOf(broken[1] as never) === null && fold.shellNoticeOf({ ...attachmentNotice('m1', 'x', 'completed'), attachment: { type: 'queued_command', prompt: '<task-notification><summary>Background command "x" printed a line</summary></task-notification>', commandMode: 'task-notification' } } as never) === null)

  check('the viewer (verbose) is inert: every notice shows one by one', run(mixed, true).length === 3)
  process.env.MERCURY_FULLSCREEN = '0'
  check('a plain terminal is inert', run(mixed).length === 3)
  process.env.MERCURY_FULLSCREEN = '1'
}

console.log('§2 the real bundle — one folded row in the chat, the three in the viewer')
{
  const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
  const driver = resolveCaptureDriver()
  const BIN = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(BIN)) {
    check('dist/mercury.mjs exists (build first)', false)
  } else if (driver.kind !== 'posix-pty') {
    console.log(`  (skipped: capture driver ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind})`)
  } else {
    const { CONFIG_HOME, RUNTIME_CWD, SID, cleanupScenario, encodeFixtureTranscript, scenario } = await import('./renderScenarios.ts')
    const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
    const cfg = scenario('cockpit-scrolled', 150, 40) as Record<string, unknown>
    const base = (extra: Record<string, unknown>): Record<string, unknown> => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra })
    const U1 = '00000000-0000-4000-8000-000000000001'
    const A1 = '00000000-0000-4000-8000-000000000002'
    const N = (i: number): string => `00000000-0000-4000-8000-00000000001${i}`
    const drained = (uuid: string, parent: string, id: string, status: Outcome, title: string, code: number, ts: string): Record<string, unknown> =>
      base({ parentUuid: parent, type: 'attachment', uuid, attachment: { type: 'queued_command', prompt: notice(id, status, shellSummary(title, status, code)), commandMode: 'task-notification' }, timestamp: ts })
    const lines = [
      base({ parentUuid: null, type: 'user', uuid: U1, message: { role: 'user', content: 'run the three checks in the background' }, timestamp: '2026-06-19T12:00:01.000Z' }),
      base({ parentUuid: U1, type: 'assistant', uuid: A1, requestId: 'req_fold_1', message: { id: 'msg_fold_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Started three background checks; I will report when they finish.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:02.000Z' }),
      drained(N(1), A1, 't1', 'completed', 'lint', 0, '2026-06-19T12:00:03.000Z'),
      drained(N(2), N(1), 't2', 'failed', 'typecheck', 2, '2026-06-19T12:00:04.000Z'),
      drained(N(3), N(2), 't3', 'completed', 'unit tests', 0, '2026-06-19T12:00:05.000Z'),
      base({ parentUuid: N(3), type: 'user', uuid: '00000000-0000-4000-8000-000000000021', message: { role: 'user', content: 'what failed?' }, timestamp: '2026-06-19T12:00:06.000Z' }),
      base({ parentUuid: '00000000-0000-4000-8000-000000000021', type: 'assistant', uuid: '00000000-0000-4000-8000-000000000022', requestId: 'req_fold_2', message: { id: 'msg_fold_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'The typecheck failed with exit code 2; lint and the unit tests passed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:07.000Z' }),
    ]
    const projects = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript(lines, SID))
    cfg.sends = [
      { atTick: 90, minTick: 40, awaitText: 'RECENT', awaitSettleTicks: 2, awaitStableTicks: 3, data: '', mark: 'chat' },
      { afterPrevTicks: 2, data: '\x0f' },
      { afterPrevTicks: 6, awaitText: 'detailed transcript', requireAwait: true, awaitStableTicks: 3, data: '', mark: 'viewer' },
    ]
    delete cfg.readyText
    delete cfg.stableTicks
    cfg.total = 160
    const gridPath = `/tmp/notice-fold-grid-${process.pid}.json`
    const cfgPath = `/tmp/notice-fold-cfg-${process.pid}.json`
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
    const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_OPERATOR: 'op', MERCURY_CHANNEL_ROOM: `notice-fold-${process.pid}` },
    })
    check('the resumed-session journey delivered every send', res.status === 0, (res.stderr ?? '').trim().slice(-300))
    if (res.status === 0) {
      const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
      const frames: Record<string, string[]> = {}
      for (const m of payload.marks ?? []) frames[m.label] = m.grid.map(row => row.map(c => c.c).join('').trimEnd())
      const chat = frames.chat ?? []
      const viewer = frames.viewer ?? []
      const foldedRows = chat.filter(l => l.includes('3 background commands · 2 done · 1 failed'))
      check('the chat paints ONE folded row with the counts and the failed command', foldedRows.length === 1, String(foldedRows.length))
      const folded = foldedRows[0] ?? ''
      check('the folded row carries the failed title and exit code, and its clock (delivered)', /\d\d:\d\d:\d\d ● 3 background commands · 2 done · 1 failed — "typecheck" \(exit code 2\)/.test(folded), folded.trim().slice(0, 140))
      check('the folded row ends with the transcript\'s fold hint', folded.includes('(ctrl+o to expand)') || folded.includes(GLYPH.chevronDown), folded.trim().slice(0, 140))
      check('none of the single notice rows paint in the chat', !chat.some(l => l.includes('Background command "lint"') || l.includes('Background command "typecheck"') || l.includes('Background command "unit tests"')))
      check('the viewer (the fold key) shows the three notices one by one', viewer.some(l => l.includes('Background command "lint" completed (exit code 0)')) && viewer.some(l => l.includes('Background command "typecheck" failed (exit code 2)')) && viewer.some(l => l.includes('Background command "unit tests" completed (exit code 0)')))
      check('the viewer shows no folded row', !viewer.some(l => l.includes('background commands ·')))
    }
    cleanupScenario('cockpit-scrolled')
  }
}

process.exit(failures === 0 ? 0 : 1)
