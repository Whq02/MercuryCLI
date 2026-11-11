import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, childEnv, DIST, endLeg, finish, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.js'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.js'
import { encodeSeedTranscript } from '../lib/seedTranscript.js'

const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames !== undefined) mkdirSync(frames, { recursive: true })
const driver = requireCaptureDriver('detail-roundtrip')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.js')
const run = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<number> => new Promise(resolve => {
  execFile(argv[0]!, argv.slice(1), { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, error => resolve(error ? Number(error.code) || 1 : 0))
})
const CTRL_O = '\x0f'
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const BOTTOM = '\x1b[1;3B'
for (const [cols, rows] of [[120, 40], [178, 51]] as const) {
  const tag = `${cols}x${rows}`
  const work = join(scratch, `work-${tag}`)
  mkdirSync(work)
  const leg = await startLeg(`detail-${tag}`, [], null, work)
  process.env.MERCURY_CONFIG_DIR = leg.home
  const env = childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off', MERCURY_REDUCED_MOTION: '1', MERCURY_TMPDIR: join(leg.home, 'tmp') })
  const sid = '00000000-0000-4000-8000-000000000041'
  const directory = getProjectDir(work)
  mkdirSync(directory, { recursive: true })
  const history: Array<Record<string, unknown>> = []
  let previous: string | null = null
  for (let n = 0; n < 40; n++) {
    const uuid = `00000000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`
    history.push({ type: 'assistant', uuid, parentUuid: previous, sessionId: sid, cwd: work, timestamp: '2026-06-19T12:00:00.000Z', message: { id: `reply-${n}`, role: 'assistant', type: 'message', model: 'claude-opus-4-8', content: [{ type: 'text', text: Array.from({ length: 10 }, (_, line) => `MARK-${String(n).padStart(2, '0')}-${String(line).padStart(2, '0')} a recorded line that holds the reader's place${n === 39 && line === 9 ? ' TAIL-END' : ''}`).join('\n') }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } })
    previous = uuid
  }
  writeFileSync(join(directory, `${sid}.jsonl`), encodeSeedTranscript(history, sid))
  const wheel = '\x1b[<64;70;10M'
  const sends = [
    { atTick: 150, requireAwait: true, awaitText: 'TAIL-END', awaitSettleTicks: 6, mark: 'tail', data: wheel },
    { afterPrevTicks: 2, requireAwait: true, awaitText: 'back to the bottom', mark: 'half', data: wheel },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'back to the bottom', mark: 'off', data: CTRL_O },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'detailed transcript', mark: 'detail', data: CTRL_O },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'Type a prompt', mark: 'back', data: BOTTOM },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'TAIL-END', mark: 'bottom', data: CTRL_O },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'detailed transcript', mark: 'tail-detail', data: PAGE_UP },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'detailed transcript', mark: 'page-up', data: PAGE_DOWN },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'detailed transcript', mark: 'page-down', data: CTRL_O },
    { afterPrevTicks: 6, requireAwait: true, awaitText: 'Type a prompt', mark: 'tail-back', data: '' },
  ].map(send => send.requireAwait ? { ...send, awaitSettleTicks: 6 } : send)
  const cfg = join(scratch, `${tag}.json`)
  const grid = join(scratch, `${tag}-grid.json`)
  writeFileSync(cfg, JSON.stringify({ argv: [productNode(), DIST, '--resume', sid], cwd: work, cols, rows, sends, total: 240, out: grid, readyText: 'Type a prompt', readySettleTicks: 2 }))
  try {
    const code = await run([driver.python, captureEngineEntry(driver, ROOT), cfg], work, env, vshotBudgetMs(80_000))
    const payload = existsSync(grid) ? JSON.parse(readFileSync(grid, 'utf8')) : null
    type Grid = Array<Array<{ c: string }>>
    const marks = new Map<string, string[]>((payload?.marks ?? []).map((mark: { label: string; grid: Grid }) => [mark.label, mark.grid.map(row => row.map(cell => cell.c).join('').trimEnd())]))
    const text = (mark: string): string => (marks.get(mark) ?? []).join('\n')
    const top = (mark: string): string | undefined => text(mark).match(/MARK-\d+-\d+/)?.[0]
    check(`${tag}: every step reached the real prompt or detailed transcript`, code === 0 && marks.size === sends.length, `${code}; marks ${marks.size}/${sends.length}`)
    check(`${tag}: the reader first leaves the tail by two wheel notches`, top('off') !== undefined && top('off') !== top('tail') && text('off').includes('back to the bottom'), `${top('tail')} -> ${top('off')}`)
    check(`${tag}: detailed view and back preserves the row the reader stood on`, top('off') !== undefined && top('back') === top('off'), `${top('off')} -> ${top('back')}`)
    check(`${tag}: the round trip remains off the tail`, text('back').includes('back to the bottom'))
    check(`${tag}: alt-down reaches the tail and removes the jump pill`, text('bottom').includes('TAIL-END') && !text('bottom').includes('back to the bottom'))
    const last = (mark: string): string | undefined => text(mark).match(/MARK-\d+-\d+/g)?.at(-1)
    check(`${tag}: paging still leaves its existing small remainder below the detailed view`, top('page-up') !== top('tail-detail') && text('page-down').includes('back to the bottom') && !text('page-down').includes('TAIL-END'))
    check(`${tag}: returning carries that remainder without losing more recorded rows`, last('page-down') !== undefined && last('tail-back') === last('page-down') && text('tail-back').includes('back to the bottom'), `${last('page-down')} -> ${last('tail-back')}`)
    console.log(`${tag} markers ${JSON.stringify(Object.fromEntries([...marks.keys()].map(mark => [mark, top(mark)])))}`)
    if (frames !== undefined) for (const [mark, lines] of marks) writeFileSync(join(frames, `${tag}-${mark}.txt`), lines.join('\n') + '\n')
  } finally {
    await run([productNode(), DIST, 'daemon', 'stop'], work, env, 30_000)
    await endLeg(leg)
  }
}
finish('detail-roundtrip')
