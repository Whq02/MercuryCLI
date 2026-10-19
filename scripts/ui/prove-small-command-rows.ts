import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg, type Leg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs, type AvailableCaptureDriver } from '../lib/captureDriver.ts'

async function drive(driver: AvailableCaptureDriver, leg: Leg, size: { cols: number; rows: number }, sends: unknown[], total: number, extra: Record<string, string>, readyText: string) {
  const out = join(scratch, 'capture.json')
  const cfg = join(scratch, 'capture-config.json')
  writeFileSync(cfg, JSON.stringify({ argv: [productNode(), DIST], cwd: leg.cwd, ...size, sends, total, readyText, readySettleTicks: 3, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfg], { cwd: leg.cwd, env: childEnv(leg, extra), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', chunk => { stderr += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 60_000))
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  type Grid = Array<Array<{ c: string }>>
  const payload = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason?: string } : {}
  const rows = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join('').trimEnd())
  return { status, stderr, marks: Object.fromEntries((payload.marks ?? []).map(mark => [mark.label, rows(mark.grid)])), final: rows(payload.grid ?? []), endReason: payload.endReason }
}

const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? null : process.argv[frameAt + 1]!
if (frames) mkdirSync(frames, { recursive: true })
const driver = requireCaptureDriver('small-command-rows')
const cwd = join(scratch, 'project')
mkdirSync(cwd, { recursive: true })
const leg = await startLeg('small-command-rows', [
  { kind: 'text', text: 'Command rows ready.' },
  { kind: 'tool_use', name: 'Eval', input: { language: 'js', title: 'Calculate the value', code: 'console.log("CELL-CODE-UNDER-APPROVAL")' } },
  { kind: 'text', text: 'Cell was declined.' },
  { kind: 'text', whenModel: 'sonnet', text: 'Model validation answered.' },
], null, cwd)
const gate = { requireAwait: true, minTick: 2, awaitSettleTicks: 4 }
const ESC = '\x1b'
try {
  const result = await drive(driver, leg, { cols: 140, rows: 50 }, [
    { ...gate, awaitText: FACE_READY, data: '\r' },
    { ...gate, awaitText: ADMITTED, data: 'start' },
    { ...gate, awaitText: '❯ start', data: '\r' },
    { ...gate, awaitText: 'Command rows ready.', data: '/config' },
    { ...gate, awaitText: '❯ /config', data: '\r' },
    { ...gate, awaitText: 'Mercury · config', data: 'j' },
    { ...gate, awaitText: 'Mercury · config', data: 'ournal' },
    { ...gate, awaitText: 'Session journal', data: '', mark: 'config-search' },
    { ...gate, awaitText: 'Session journal', data: ESC },
    { ...gate, awaitText: 'Mercury · config', data: ESC },
    { ...gate, awaitText: ADMITTED, data: '/crewmates off' },
    { ...gate, awaitText: '❯ /crewmates off', data: '\r' },
    { ...gate, awaitText: 'crewmates off for this session', data: '', mark: 'crew-off' },
    { ...gate, awaitText: ADMITTED, data: '/help' },
    { ...gate, awaitText: '❯ /help', data: '\r' },
    { ...gate, awaitText: 'custom-commands', data: '\x1b[C' },
    { ...gate, awaitText: 'Browse default commands', data: '', mark: 'help-start' },
    { ...gate, awaitText: 'Browse default commands', data: '\x1b[6~' },
    { ...gate, awaitText: 'Browse default commands', data: '', mark: 'help-page' },
    { ...gate, awaitText: 'Browse default commands', data: ESC },
    { ...gate, awaitText: ADMITTED, data: '', mark: 'crew-durable' },
    { ...gate, awaitText: ADMITTED, data: 'run the cell' },
    { ...gate, awaitText: '❯ run the cell', data: '\r' },
    { ...gate, awaitText: 'Calculate the value', data: '', mark: 'eval-card' },
    { ...gate, awaitText: 'Calculate the value', data: ESC },
    { ...gate, awaitText: 'Cell was declined.', data: '/model sonnet 5.5' },
    { ...gate, awaitText: '❯ /model sonnet 5.5', data: '\r' },
    { ...gate, awaitText: 'saved as your default for new sessions', awaitPattern: '\\A(?![\\s\\S]*Help closed)', data: '', mark: 'model-match' },
  ], 550, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off', MERCURY_REDUCED_MOTION: '1', MERCURY_DAEMON_DIR: 'daemon', TMPDIR: '.' }, 'Cell was declined.')
  for (const [name, rows] of Object.entries(result.marks)) {
    printFrame(name, rows)
    if (frames) writeFileSync(join(frames, `small-command-${name}.txt`), rows.join('\n') + '\n')
  }
  if (result.status !== 0) printFrame('capture stopped', result.final)
  const text = (name: string): string => (result.marks[name] ?? []).join('\n')
  check('the cockpit completed every gesture', result.status === 0 && result.endReason === 'ready' && Object.keys(result.marks).length === 7, `${result.status} ${result.endReason} ${result.stderr.slice(-500)}`)
  check('config preserves the first letter of journal', text('config-search').includes('/ journal'))
  check('crew flip is a chat row at the flip, not only the footer', /└ .*crewmates off for this session/.test(text('crew-off')))
  check('crew flip survives visiting another screen before a model turn', text('crew-durable').includes('crewmates off for this session'))
  const command = (name: string): string => /❯ (\/\S+)/.exec(text(name).split('Browse default commands')[1] ?? '')?.[1] ?? ''
  check('PageDown enters and pages the help list without an earlier down arrow', command('help-page') !== '' && command('help-page') !== command('help-start'))
  check('Eval approval shows the exact code, not only the title', text('eval-card').includes('console.log("CELL-CODE-UNDER-APPROVAL")'))
  check('the model match is echoed as a durable row', /└ sonnet 5.5 → claude-sonnet-5-5/.test(text('model-match')))
  check('the switch row echoes the typed words, the match and the time with its zone', /└ sonnet 5\.5 → claude-sonnet-5-5 · \d{2}:\d{2} \S+ · saved as your default for new sessions/.test(text('model-match')), text('model-match').split('\n').filter(l => l.includes('sonnet')).join(' | '))
  check('no switch row echoes the bare id in place of the words', !/❯ \/model claude-sonnet-5-5/.test(text('model-match')), text('model-match').split('\n').filter(l => l.includes('/model')).join(' | '))
} finally {
  await endLeg(leg)
  rmSync(scratch, { recursive: true, force: true })
}
finish('small-command-rows')
