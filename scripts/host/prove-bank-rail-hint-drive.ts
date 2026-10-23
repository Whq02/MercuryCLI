import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
f.state.dialect = 'sglang'; f.state.window = 131072
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.runpod.io') return nativeFetch(new Request(rp.baseUrl.replace('/v2', '') + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('The rail proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const hub: Record<string, Record<string, Buffer>> = {
  'fixture/tiny-a': { 'shards/tiny-a-00001-of-00002.bin': randomBytes(4096), 'shards/tiny-a-00002-of-00002.bin': randomBytes(6144) },
  'fixture/tiny-b': { 'model.bin': randomBytes(8192) },
}
const manifests = [
  { model: 'fixture/tiny-a', include: '', revision: 'a'.repeat(40), files: Object.entries(hub['fixture/tiny-a']!).map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) })) },
  { model: 'fixture/tiny-b', include: '', revision: 'b'.repeat(40), files: Object.entries(hub['fixture/tiny-b']!).map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) })) },
]
const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../../assets/host/recipes.json'), 'utf8')) as { version: number; publishedAt: string; recipes: any[] }
const shape = shipped.recipes.find(row => row.id === 'qwen38-27b-rtx-pro-6000')
assert.ok(shape, 'the shipped Qwen RTX PRO 6000 recipe is the shape the fixture recipes copy')
const fixtureRecipe = (id: string, title: string, model: string, weightsGb: number) => ({ ...shape, id, label: title + ' · FP8', model, weightsGb, source: 'https://huggingface.co/' + model, verification: 'documented', verified: { by: 'documented', on: '2026-10-22', note: 'fixture recipe for the rail proof', source: 'https://huggingface.co/' + model }, efforts: undefined })
const recipesFile = join(f.home, 'recipes.json')
writeFileSync(recipesFile, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: [fixtureRecipe('tiny-a-rtx-pro-6000', 'Tiny-A', 'fixture/tiny-a', 10240 / 1e9), fixtureRecipe('tiny-b-rtx-pro-6000', 'Tiny-B', 'fixture/tiny-b', 8192 / 1e9)] }))
const weightsFile = join(f.home, 'weights.json')
writeFileSync(weightsFile, JSON.stringify(manifests))
process.env.MERCURY_HOST_RECIPES_FILE = recipesFile
process.env.MERCURY_HOST_WEIGHTS_FILE = weightsFile

const RAIL = 24
const KEYS = ['b bank', 'v verify', 'm mirror', 'd drop', 'k keep safe']
const RAIL_LINE = '↑↓ choose · ↵ continue · ' + KEYS.join(' · ') + ' · esc closes'
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
const check = (name: string, truth: unknown, detail = '') => { if (!truth) console.log((detail ? detail + '\n' : '') + (mounted?.screen() ?? '')); assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const React = await import('react')
  const { Box, Text } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { railPlanAt } = await import('../../src/utils/helmGeometry.ts')

  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const runner = { ...ssh.runner, run: async (command: string, args: string[], signal: AbortSignal, timeoutMs?: number) => ssh!.runner.run(command, args, signal, timeoutMs) }
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner, pauseMs: 10, readyTimeoutMs: 2000, sessionId: 'rail-proof', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner, pauseMs: 10, timeoutMs: 4000, keepAlive: false })) } })
  let width = 120
  let height = 40
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  const scene = (columns: number, rows: number, rail: number, centreCols: number) => {
    const centreRef = React.createRef<any>()
    const centre = React.createElement(Box, { ref: centreRef, flexDirection: 'column', ...(rail > 0 ? { width: centreCols } : { flexGrow: 1 }), minWidth: 0, flexShrink: 0, overflow: 'hidden', borderStyle: 'round' }, ...Array.from({ length: Math.max(0, rows - 2) }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, index === 0 ? 'CENTRE' : 'c'.repeat(columns))))
    const body = rail > 0
      ? React.createElement(Box, { flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' }, React.createElement(Box, { flexDirection: 'column', width: rail, flexShrink: 0, overflow: 'hidden', borderStyle: 'single' }, ...Array.from({ length: Math.max(0, rows - 2) }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, index === 0 ? 'FILES' : 'f'.repeat(rail)))), React.createElement(Box, { width: columns - rail - centreCols, flexShrink: 0 }), centre)
      : centre
    return React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, body, React.createElement(SettingsPopupSlot, { overlay: true, hostRef: centreRef, framed: true }))))
  }
  const mount = async (columns: number, rows: number, rail: number, centreCols = columns - rail - 2) => {
    width = columns
    height = rows
    mounted = await mountOffscreen(scene(columns, rows, rail, centreCols), columns, rows)
  }
  const screen = () => mounted!.screen()
  const heading = async (needle: string) => assert.ok(await waitFor(() => mounted!.lines().some(line => line.includes(needle)), 20000), 'question reaches ' + needle + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const select = async (needle: string) => {
    for (let n = 0; n < 40; n++) {
      const before = selected()
      if (before.includes(needle)) return
      mounted!.push(KEY.down)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'selection reaches ' + needle + '\n' + screen())
    }
    throw new Error('Choice not found: ' + needle)
  }
  const choose = async (needle: string) => { await select(needle); mounted!.push(KEY.enter) }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const capture = async (name: string) => {
    const text = screen()
    check(name + ' renders without errors or keys', !text.includes('RENDER ERROR') && !text.includes(rp.key))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), text)
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const openBank = async () => {
    open(); await heading('Which model?'); await choose('More options'); await heading('Where should the model run?'); await choose('Bank · your weights')
    assert.ok(await waitFor(() => screen().includes('Where should the bank live?') || screen().includes('MODEL'), 20000), 'the Bank road opens\n' + screen())
    if (screen().includes('Where should the bank live?')) mounted!.push(KEY.enter)
    assert.ok(await waitFor(() => screen().includes('MODEL') && screen().includes('↑↓ choose'), 20000), 'the Bank table paints its key rail\n' + screen())
  }
  const RAIL_WORD = /(↑↓ choose|↵ continue|esc closes|closes|[bvmdk] [a-z]+|safe|·)/
  const popupSegment = (line: string): string => line.split('│').map(part => part.trim()).filter(part => part !== '' && !/^[cf…]+$/.test(part) && part !== 'FILES' && part !== 'CENTRE').find(part => RAIL_WORD.test(part)) ?? ''
  const railRows = (): string[] => {
    const rows = mounted!.lines().map(popupSegment)
    const end = rows.findIndex(line => line.includes('esc closes') || line === 'closes')
    assert.ok(end >= 0, 'the key rail is on screen\n' + screen())
    let start = end
    while (start > 0 && rows[start - 1] !== '' && !rows[start - 1]!.includes('Banked:') && !rows[start - 1]!.includes('Back ·') && !rows[start - 1]!.includes('Refresh ·')) start--
    return rows.slice(start, end + 1)
  }
  const wholeLabels = (rows: string[]): boolean => rows.every(row => row.split(' · ').every(label => ['↑↓ choose', '↵ continue', 'esc closes', ...KEYS].includes(label) || /^pgup\/pgdn [a-z]+$/.test(label)))
  const plan = railPlanAt(120, false)
  check('the cockpit plan at 120 columns is a 24-column rail beside a 94-column centre', plan.railW === RAIL && plan.centerCols === 94, JSON.stringify(plan))

  console.log('§1 the Bank screen at 120×40 beside the ' + RAIL + '-column rail (the cockpit plan): the popup is narrower than the terminal')
  await mount(120, 40, plan.railW, plan.centerCols)
  await openBank()
  await capture('120x40-rail24-bank')
  const narrowRows = railRows()
  console.log('      rail: ' + JSON.stringify(narrowRows))
  check('the rail wraps onto a second line (the one-line form does not fit the narrowed popup)', narrowRows.length === 2 && !screen().includes(RAIL_LINE), JSON.stringify(narrowRows))
  check('every painted rail line is whole labels joined by the separator — "k keep safe" and "esc closes" never split', wholeLabels(narrowRows) && narrowRows.join(' · ') === RAIL_LINE, JSON.stringify(narrowRows))
  await close(); mounted!.unmount()

  console.log("§2 the Bank screen at 120×40 with the centre at the width the box's frame showed (the popup's rail box 74 wide)")
  await mount(120, 40, 120 - 2 - 82, 82)
  await openBank()
  await capture('120x40-centre82-bank')
  const boxRows = railRows()
  console.log('      rail: ' + JSON.stringify(boxRows))
  check("the box's own split never paints: no line ends in \"k keep\" and none starts with \"safe\"", !boxRows.some(line => /k keep$/.test(line) || /^safe\b/.test(line)), JSON.stringify(boxRows))
  check('every painted rail line is whole labels joined by the separator', wholeLabels(boxRows) && boxRows.join(' · ') === RAIL_LINE, JSON.stringify(boxRows))
  await close(); mounted!.unmount()

  console.log('§3 the Bank screen at 80×24 with no rail')
  await mount(80, 24, 0)
  await openBank()
  await capture('80x24-bank')
  const smallRows = railRows()
  console.log('      rail: ' + JSON.stringify(smallRows))
  check('at 80×24 the rail is whole labels joined by the separator and carries every key (a short popup appends its paging clause)', wholeLabels(smallRows) && smallRows.join(' · ').startsWith(RAIL_LINE), JSON.stringify(smallRows))
  await close(); mounted!.unmount()

  console.log('§4 the Bank screen at 120×40 with no rail: the one-line form holds when it fits')
  await mount(120, 40, 0)
  await openBank()
  await capture('120x40-bank')
  const wideRows = railRows()
  check('the five keys and esc sit on one line at the full width', wideRows.length === 1 && wideRows[0] === RAIL_LINE, JSON.stringify(wideRows))
  await close(); mounted!.unmount()
  await Promise.all(jobs)
  check('no request left the loopback fixtures', escaped.length === 0)

  console.log('§5 the pure wrap: separators only, whole when it fits, a plain word wrap for one oversize label')
  const wrap = (popup as { wrapSettingsPopupHint?: (hint: string, columns: number) => string[] }).wrapSettingsPopupHint
  check('the popup store exports wrapSettingsPopupHint', typeof wrap === 'function')
  const at87 = wrap!(RAIL_LINE, 87)
  check('at 87 columns the Bank rail breaks at a separator and every label stays whole', at87.length === 2 && at87.every(line => line.length <= 87) && at87.join(' · ') === RAIL_LINE && KEYS.every(key => at87.some(line => line.includes(key))), JSON.stringify(at87))
  check('the one-line form holds when it fits', wrap!(RAIL_LINE, RAIL_LINE.length).length === 1 && wrap!(RAIL_LINE, 200)[0] === RAIL_LINE)
  check('a rail narrower than its widest label breaks the other separators first and word-wraps only that label', wrap!('a · bb · a label wider than the line here · c', 12).join('|') === 'a · bb|a label|wider than|the line|here · c', JSON.stringify(wrap!('a · bb · a label wider than the line here · c', 12)))
  check('a rail with no separator word-wraps like plain text', wrap!('esc closes the popup now', 10).join('|') === 'esc closes|the popup|now', JSON.stringify(wrap!('esc closes the popup now', 10)))
  console.log('BANK RAIL HINT DRIVE GREEN — ' + checks + ' checks; the real popup on the Bank screen at 120×40 beside a 24-column rail and at 80×24: the key rail breaks at separators only')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }
