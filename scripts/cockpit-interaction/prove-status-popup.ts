import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { fixture, fixtureReads, buildFacts, model } from './status-popup-fixture.js'

const React = await import('react')
const { render } = await import('../../src/ink.js')
const { SettingsStatusView } = await import('../../src/components/mercury-ui/screens/SettingsStatusView.js')
const { displayWidth } = await import('../../src/components/mercury-ui/glyphs.js')
const h = React.createElement
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const settle = () => new Promise<void>(done => setTimeout(done, 10))
async function mount(facts = fixture.facts, width = 106, rowBudget = 44) {
  let closed = 0
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { columns: width + 4, rows: rowBudget + 7, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(h(SettingsStatusView, { facts, width, rowBudget, onClose: () => { closed++ } }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()).split('\n').map(line => line.trimEnd()).join('\n'),
    press: async (key: string) => { stdin.push(key); await settle() },
    close: () => { instance.unmount(); stdin.destroy(); stdout.destroy() },
    closed: () => closed,
  }
}
const normalizeCounts = (text: string) => text.replace(/MCP servers \d+ —/, 'MCP servers —').replace(/skills \d+ —/, 'skills —')
const expected = JSON.parse(readFileSync(join(import.meta.dir, 'status-body-words.json'), 'utf8')) as string[]
const outputAt = process.argv.indexOf('--frames')
const outputDir = outputAt >= 0 ? process.argv[outputAt + 1] : undefined
const designAt = process.argv.indexOf('--design')
if (designAt >= 0) {
  const page = readFileSync(process.argv[designAt + 1]!, 'utf8').split('\n').slice(16, 31).map(line => line.slice(36, 142).trimEnd())
  check('the enrolled words are the supplied design body row for row', JSON.stringify(page) === JSON.stringify(expected), JSON.stringify(page))
}
for (const [columns, rows, width] of [[178, 51, 106], [120, 40, 106], [100, 30, 96]] as const) {
  const body = await mount(fixture.facts, width, rows - 7)
  const frame = body.frame()
  check(`${columns}×${rows}: content fits without artificial height`, frame.split('\n').length === 15, frame)
  check(`${columns}×${rows}: every row stays inside the inner width`, frame.split('\n').every(line => displayWidth(line) <= width))
  check(`${columns}×${rows}: the body is the page's rows in order`, normalizeCounts(frame) === expected.join('\n'), frame)
  check(`${columns}×${rows}: no second frame, cursor or retired blocks`, !/Mercury — status|╭|╰|▸|Retention|System diagnostics|↵ inspect|r refresh/.test(frame))
  await body.press('\x1b[B'); await body.press('\r'); await body.press('r')
  check(`${columns}×${rows}: a fitting snapshot is non-interactive`, body.frame() === frame)
  if (outputDir) writeFileSync(join(outputDir, `status-${columns}x${rows}.txt`), frame + '\n')
  body.close()
}

const tall = Array.from({ length: 48 }, (_, i) => ({ k: String(i), v: `  Fact ${String(i).padStart(2, '0')}` }))
const body = await mount(tall, 96, 23)
function inspect(offset: number, direction: string): void {
  const frame = body.frame()
  const shown = [...frame.matchAll(/Fact (\d{2})/g)].map(m => Number(m[1]))
  const below = tall.length - offset - 22
  const more = frame.match(/↓ (\d+) more/)
  check(`${direction} ${offset}: the row window follows the scroll position`, shown.length === 22 && shown[0] === offset && shown.at(-1) === offset + 21)
  check(`${direction} ${offset}: the below count is exact`, below > 0 ? Number(more?.[1]) === below : more === null)
  check(`${direction} ${offset}: the body fits and more is last`, frame.split('\n').length <= 23 && frame.split('\n').every(line => displayWidth(line) <= 96) && (!more || frame.trimEnd().endsWith(more[0])))
}
inspect(0, 'down')
if (outputDir) writeFileSync(join(outputDir, 'status-100x30-overflow.txt'), body.frame() + '\n')
for (let i = 1; i <= 26; i++) { await body.press('\x1b[B'); inspect(i, 'down') }
await body.press('\x1b[B')
check('the final row is reachable and the bottom clamps', body.frame().includes('Fact 47') && !/↓ \d+ more/.test(body.frame()))
if (outputDir) writeFileSync(join(outputDir, 'status-100x30-last.txt'), body.frame() + '\n')
for (let i = 25; i >= 0; i--) { await body.press('\x1b[A'); inspect(i, 'up') }
await body.press('\x1b[A')
inspect(0, 'top clamp')
await body.press('\x1b')
await new Promise<void>(done => setTimeout(done, 180))
check('escape closes through the body owner exactly once', body.closed() === 1, String(body.closed()))
body.close()

for (const width of [20, 60, 96]) {
  const long = await mount([{ k: 'long', v: 'owner value '.repeat(80) + 'LAST' }], width, 5)
  let seenLast = false
  for (let i = 0; i < 100; i++) {
    const frame = long.frame()
    if (frame.includes('LAST')) { seenLast = true; break }
    await long.press('\x1b[B')
  }
  check(`long owner notes at ${width} cells wrap and remain reachable`, seenLast)
  check(`long owner notes at ${width} cells respect both budgets`, long.frame().split('\n').length <= 5 && long.frame().split('\n').every(line => displayWidth(line) <= width))
  long.close()
}
for (const budget of [0, 1, 2]) {
  const small = await mount(tall, 20, budget)
  const frame = small.frame()
  check(`a ${budget}-row budget is never exceeded`, frame === '' || frame.split('\n').length <= budget)
  small.close()
}
const unavailable = Object.fromEntries(Object.keys(fixtureReads).map(key => [key, () => { throw new Error('read failed') }]))
const missing = buildFacts([], model, unavailable).facts
check('failed reads keep every drawn row in place', missing.map(f => f.k).join('|') === fixture.facts.map(f => f.k).join('|'))
check('failed reads name absence rather than fabricated figures', missing.filter(f => !f.bold && f.v !== '').every(f => /unavailable|not read/.test(f.v + f.note)))
const missingBody = await mount(missing, 96, 23)
check('the unavailable snapshot stays within the short terminal budget', missingBody.frame().split('\n').length <= 23 && missingBody.frame().split('\n').every(line => displayWidth(line) <= 96))
if (outputDir) writeFileSync(join(outputDir, 'status-100x30-unavailable.txt'), missingBody.frame() + '\n')
missingBody.close()
check('MCP and skills counts are from the focused rosters', fixture.facts.find(f => f.k === 'connectivity')?.v.includes('MCP servers 2 — /mcp · skills 3 — /skills') === true)
check('the account limit alone has the warning tone', fixture.facts.find(f => f.k === 'openai')?.noteTone !== undefined && fixture.facts.find(f => f.k === 'anthropic')?.noteTone === undefined)
const connector = fixtureReads.connector!()!
const pending = buildFacts([], model, { ...fixtureReads, connector: () => ({ ...connector, modelFacts: () => ({ ...connector.modelFacts(), effectiveSource: 'record' }) }) })
check('a kit not reported by the runner never fabricates zero counts', pending.facts.find(f => f.k === 'connectivity')?.v.includes('MCP servers unavailable — /mcp · skills unavailable') === true)
const failedMcp = buildFacts([], model, { ...fixtureReads, connector: () => ({ ...connector, mcpRoster: () => { throw new Error('read failed') } }) })
check('a failed focused MCP read never borrows the screen count', failedMcp.facts.find(f => f.k === 'connectivity')?.v.includes('MCP servers unavailable') === true)
const changed = buildFacts([], model, {
  ...fixtureReads,
  seats: () => ({ ...fixtureReads.seats!(), seats: 8 }),
  connector: () => ({ ...connector,
    modelFacts: () => ({ ...connector.modelFacts(), effortSent: 'high' }),
    permissionMode: () => 'strategy',
    checkpointFacts: () => ({ capture: 'off', restorable: new Set(['one', 'two']) }),
    workRoster: () => ({ rows: [{ id: 'run', kind: 'workflow', name: 'run', status: 'running', startTime: 0 }], mission: [] }),
  }),
})
check('served effort and permission mode follow their owners', changed.facts.find(f => f.k === 'model')?.v.includes('high effort') === true && changed.facts.find(f => f.k === 'model')?.v.includes('strategy mode') === true)
check('seat setting and checkpoint facts follow their owners', changed.facts.find(f => f.k === 'settings')?.v === '  seats 8 · shell engine system · checkpoints not capturing · 2 restore points')
check('the workflow row follows the focused work owner', changed.facts.find(f => f.k === 'workflow')?.v.startsWith('  workflow running') === true)
const elsewhere = buildFacts([], model, { ...fixtureReads, telemetry: () => ({ ...fixtureReads.telemetry!(), workflowsDisk: [{ runId: 'external-fixture', status: 'running', ownerPid: process.pid, mtimeMs: Date.now() } as never] }) })
check('a workflow running elsewhere is not misreported as idle', elsewhere.facts.find(f => f.k === 'workflow')?.v.startsWith('  workflow running elsewhere') === true)
const view = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/screens/SettingsStatusView.tsx'), 'utf8')
check('the body registers no overlay of its own and gates no key on the overlay top (the settings shell owns the popup, so its arrows reach the body inside the shell)', !view.includes('useRegisterOverlay') && !view.includes('isTopOverlayNow'))
const source = readFileSync(join(import.meta.dir, '../../src/commands/status/mercuryStatus.tsx'), 'utf8')
check('production reads the running artifact and daemon client', source.includes('describeArtifactIdentity(MACRO.VERSION)') && source.includes('getMercuryDaemonStatus()') && source.includes('daemon.controlReachable'))
check('production reads the live branch and folder', source.includes('gitSnapshot()') && source.includes('branchName') && source.includes('basename(getCwd())'))
console.log(`status popup: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
