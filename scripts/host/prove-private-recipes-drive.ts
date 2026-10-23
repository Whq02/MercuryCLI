import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOST_RECIPES_FILE
pinSourceRef()
const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
process.env.HOME = f.home
process.env.USERPROFILE = f.home
const realFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request) => { escaped.push(String(input)); throw new Error('This file chooser needs no network') }, realFetch)
let mounted: Mounted | undefined
let checks = 0
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const recipes = await import('../../src/services/host/recipesFile.ts')
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const base = HOST_RECIPES[0]!
  const privateRows = [
    { ...base, id: 'private-deepseek', label: 'Private DeepSeek · FP8', model: 'fixture/private-deepseek' },
    { ...base, id: 'private-qwen', label: 'Private Qwen · FP8', model: 'fixture/private-qwen' },
  ]
  const fileOf = (rows: unknown[]) => JSON.stringify({ version: 2, publishedAt: '2026-10-22', recipes: rows })
  const choicePath = join(f.home, 'host', 'recipes-file.json')
  const valid = join(f.home, 'my recipes.json')
  const other = join(f.home, 'other.json')
  const invalid = join(f.home, 'invalid.json')
  const empty = join(f.home, 'empty.json')
  const broken = join(f.home, 'broken.json')
  const missing = join(f.home, 'missing.json')
  writeFileSync(valid, fileOf(privateRows))
  writeFileSync(other, fileOf([{ ...base, id: 'other-private', label: 'Other private model' }]))
  writeFileSync(invalid, fileOf([{ ...privateRows[0], count: 'two' }]))
  writeFileSync(empty, fileOf([]))
  writeFileSync(broken, '{')
  let question: LlmHostQuestion | undefined
  const implementation = createHostRoad({ sessionId: 'private-recipes-proof', runner: { run: async () => { throw new Error('No process is needed') }, tunnel: () => { throw new Error('No tunnel is needed') } }, startJob: () => { throw new Error('No rental is allowed') } })
  const road: LlmHostRoad = (ask, emit, signal) => implementation(plan => { question = plan; return ask(plan) }, emit, signal)
  const screen = () => mounted?.screen() ?? ''
  const check = (name: string, truth: unknown) => { assert.ok(truth, name + '\n' + screen()); checks++; console.log('PASS ' + name) }
  const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 24)), 10000), name + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  let tracked: { plan: LlmHostQuestion; at: number | null } | undefined
  const select = async (value: string) => {
    const plan = question!
    const rows = plan.rows ?? []
    const target = rows.findIndex(row => row.value === value)
    assert.ok(target >= 0, 'question offers ' + value + '\n' + screen())
    if (tracked?.plan !== plan) { const initial = rows.findIndex(row => row.value === plan.initial); tracked = { plan, at: initial < 0 ? null : initial } }
    while (tracked.at !== target) {
      const before = selected()
      const down = tracked.at === null || tracked.at < target
      mounted!.push(down ? KEY.down : KEY.up)
      tracked.at = tracked.at === null ? (down ? 0 : rows.length - 1) : tracked.at + (down ? 1 : -1)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'cursor reaches ' + value + '\n' + screen())
    }
  }
  const choose = async (value: string) => { await select(value); mounted!.push(KEY.enter) }
  const enterPath = async (value: string) => {
    value = value.replace(f.home, '~')
    const beforePlan = question
    const before = screen()
    mounted!.push('\u0015')
    if (question!.initial) assert.ok(await waitFor(() => screen() !== before, 3000), 'clear the path')
    const beforeType = screen()
    mounted!.push(value)
    assert.ok(await waitFor(() => screen().split(value).length > beforeType.split(value).length, 3000), 'the path is entered\n' + screen())
    mounted!.push(KEY.enter)
    assert.ok(await waitFor(() => question !== beforePlan, 5000), 'the entered path is checked')
  }
  const open = async () => { question = undefined; popup.openSettingsPopup(llmHostPopupRequest(road)); await step('door-models') }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000), 'Escape closes') }
  const capture = async (name: string, width: number, height: number) => {
    check(name + ' fits the terminal with an exit and no render error', screen().includes('╰') && screen().includes('esc') && !screen().includes('RENDER ERROR'))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    rmSync(choicePath, { force: true })
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
    await open()
    check('private models are absent before choosing a file', !question!.rows!.some(row => row.value === 'Private DeepSeek'))
    await choose('other'); await step('where')
    check('More options offers the private file chooser', question!.rows!.some(row => row.value === 'private-recipes' && row.label === 'Private recipes · none · choose a file →'))
    await select('private-recipes'); await capture(width + 'x' + height + '-row-empty', width, height)
    mounted!.push(KEY.enter); await step('door-private-recipes-file')
    check('the path prompt lists the home default', question!.found.includes('host') && question!.found.includes('private-recipes.json'))
    await capture(width + 'x' + height + '-prompt', width, height)
    await enterPath(missing); await step('door-private-recipes-file')
    check('a missing file is named without saving', question!.found.includes('File not found:') && question!.found.includes('missing.json') && !existsSync(choicePath))
    await capture(width + 'x' + height + '-missing', width, height)
    await enterPath(broken); await step('door-private-recipes-file')
    check('malformed JSON is reported without saving', question!.found.includes('Invalid JSON:') && !existsSync(choicePath))
    await enterPath(empty); await step('door-private-recipes-file')
    check('zero valid rows is reported without saving', question!.found.includes('No valid recipes') && !existsSync(choicePath))
    await enterPath(invalid); await step('door-private-recipes-file')
    check('schema failure names the row and field without saving', question!.found.includes('private-deepseek') && question!.found.includes('count') && !existsSync(choicePath))
    await capture(width + 'x' + height + '-invalid-row', width, height)
    await enterPath('~/my recipes.json'); await step('door-private-recipes-confirm')
    check('validation names the rows and models before saving', question!.found.includes('2 rows') && question!.found.includes('Private DeepSeek') && question!.found.includes('Private Qwen') && !existsSync(choicePath))
    await capture(width + 'x' + height + '-validated', width, height)
    await choose('use'); await step('door-models')
    check('choosing a file immediately refreshes Which model with private tags', ['Private DeepSeek', 'Private Qwen'].every(name => question!.rows!.some(row => row.value === name && row.label.includes(' · private · '))))
    await capture(width + 'x' + height + '-result', width, height)
    check('the absolute choice is stored beside bank.json with private permissions', JSON.parse(readFileSync(choicePath, 'utf8')).path === valid && (process.platform === 'win32' || (statSync(choicePath).mode & 0o777) === 0o600))
    await choose('Private DeepSeek'); await step('door-model')
    check('a private model offers the same chooser with loaded path and count', question!.rows!.some(row => row.value === 'private-recipes' && row.label.includes('my recipes.json') && row.label.endsWith('2 rows · replaces the shipped list')))
    await select('private-recipes'); await capture(width + 'x' + height + '-row-loaded', width, height)
    mounted!.push(KEY.enter); await step('door-private-recipes-file')
    check('the chosen file is a candidate and the initial value', question!.found.includes('my recipes.json') && question!.initial?.includes('my recipes.json'))
    await enterPath(invalid); await step('door-private-recipes-file')
    check('a bad replacement leaves the previous selection and rows intact', JSON.parse(readFileSync(choicePath, 'utf8')).path === valid && recipes.currentHostRecipes().some(row => row.id === 'private-deepseek'))
    await close()
    await open()
    check('closing and reopening retains the private models', question!.rows!.some(row => row.value === 'Private DeepSeek' && row.label.includes(' · private · ')))
    await choose('other'); await step('where'); await select('private-recipes')
    await capture(width + 'x' + height + '-more-loaded', width, height)
    process.env.MERCURY_HOST_RECIPES_FILE = other
    mounted!.push(KEY.enter); await step('door-private-recipes-file')
    check('the candidates include default, environment and saved files', ['host/private-recipes.json', 'other.json', 'my recipes.json'].every(name => question!.found.replaceAll('\\', '/').includes(name)))
    await enterPath(other); await step('door-private-recipes-confirm'); await choose('use'); await step('door-models')
    check('a different valid file replaces the previous rows immediately', question!.rows!.some(row => row.value === 'Other private model' && row.label.includes(' · private · ')) && !question!.rows!.some(row => row.value === 'Private DeepSeek'))
    await choose('Other private model'); await step('door-model'); await choose('private-recipes'); await step('door-private-recipes-file')
    await enterPath(valid); await step('door-private-recipes-confirm'); await choose('use'); await step('door-models')
    check('changing the file from a private model returns to refreshed models', question!.rows!.some(row => row.value === 'Private DeepSeek') && !question!.rows!.some(row => row.value === 'Other private model'))
    delete process.env.MERCURY_HOST_RECIPES_FILE
    await close(); mounted!.unmount(); mounted = undefined
  }
  const child = spawnSync(process.execPath, ['-e', `const m = await import(${JSON.stringify(join(f.root, 'src/services/host/recipesFile.ts'))}); console.log(JSON.stringify(m.currentHostRecipes().map(r => r.id)))`], { cwd: f.root, encoding: 'utf8', env: { ...process.env, MERCURY_HOST_RECIPES_FILE: other } })
  check('a fresh process reads the saved choice ahead of the environment file', child.status === 0 && JSON.parse(child.stdout.trim().split('\n').at(-1)!).includes('private-deepseek'))
  const remembered = readFileSync(choicePath, 'utf8')
  writeFileSync(invalid, fileOf([privateRows[0], { ...privateRows[1], count: 0 }]))
  assert.throws(() => recipes.rememberPrivateHostRecipesFile(invalid), /Row 2 \(private-qwen\) · count/)
  check('one valid row does not hide a bad row or overwrite the saved choice', readFileSync(choicePath, 'utf8') === remembered)
  assert.throws(() => recipes.rememberPrivateHostRecipesFile('relative.json'), /absolute file path/)
  check('relative paths are refused without changing the saved choice', readFileSync(choicePath, 'utf8') === remembered)
  rmSync(valid)
  check('a saved file that disappears reports its path and uses the shipped list', recipes.currentPrivateHostRecipes().errors.some(error => error.includes('File not found:') && error.includes('my recipes.json')) && recipes.currentHostRecipes().length === HOST_RECIPES.length)
  writeFileSync(valid, fileOf(privateRows))
  rmSync(choicePath)
  process.env.MERCURY_HOST_RECIPES_FILE = other
  check('the environment override still works without a saved choice', recipes.currentHostRecipes().map(row => row.id).join(',') === 'other-private')
  delete process.env.MERCURY_HOST_RECIPES_FILE
  writeFileSync(recipes.privateHostRecipesPath(), fileOf(privateRows))
  check('the home default still works without an environment override or saved choice', recipes.currentHostRecipes().map(row => row.id).join(',') === privateRows.map(row => row.id).join(','))
  check('no network request was made', escaped.length === 0)
  console.log('PRIVATE RECIPES DRIVE GREEN — ' + checks + ' checks; real popup at 120×40 and 80×24; fixture files only')
} finally { mounted?.unmount(); globalThis.fetch = realFetch; delete process.env.MERCURY_HOST_RECIPES_FILE; f.close() }
