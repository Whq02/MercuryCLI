#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { DOMElement } from '../../src/ink/dom.js'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-surfaces-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_LIMITS', 'MERCURY_USAGE_POLL_MS', 'MERCURY_MODEL', 'MERCURY_ADVISOR_MODEL', 'MERCURY_CONSOLE_MODEL', 'NODE_ENV', 'CI']) {
  delete process.env[name]
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1/oauth'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1/backend-api/codex'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1/v1'
const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }

const frameDir = ((): string | null => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]!) : null
})()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
type Raw = Record<string, unknown>
const settle = (ms = 100): Promise<void> => new Promise(r => setTimeout(r, ms))
const ESC = String.fromCharCode(27)

async function stub(path: string, fixtureExports: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixtureExports() }))
}
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/services/providers/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined }))
await stub('../../src/services/providers/local/localAccounts.js', () => ({ resolveLocalAccount: () => undefined }))
await stub('../../src/components/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
const tracker = await import('../../src/cost-tracker.ts')
const workload = await import('../../src/utils/workloadContext.ts')
const { calculateUSDCost } = await import('../../src/utils/modelCost.ts')
const usageOwner = await import('../../src/services/providers/providerUsage.ts')
const { Usage, ADVISOR_SPEND_LABEL, SCHEDULED_SPEND_LABEL } = await import('../../src/components/Settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { getGlobalConfig } = await import('../../src/utils/config.ts')
const slots = await import('../../src/utils/model/subModelSlots.ts')

const MODEL = 'claude-opus-4-8'
const usageOf = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Raw => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })
const fold = (model: string, usage: Raw): number => {
  const cost = calculateUSDCost(model, usage as never)
  tracker.addToTotalSessionCost(cost, usage as never, model)
  return cost
}
const SIZES: Array<[number, number, number, number]> = [
  [178, 51, 146, 22],
  [80, 21, 76, 14],
]

section("§1 THE USAGE OWNER: the advisor's spend is a second share on the family's session spend, from the advisor bucket (red on the base: no share)")
state.resetCostState()
let advisorCost = 0
{
  advisorCost = await workload.runWithWorkload('advisor', async () => {
    await settle(1)
    return fold(MODEL, usageOf(90, 14))
  })
  fold(MODEL, usageOf(300, 20))
  const anthropic = usageOwner.providerSessionSpend('anthropic') as Raw
  const advisor = anthropic.advisor as Raw | undefined
  check("the family's spend carries an advisor share: 90 in · 14 out · one model", advisor !== undefined && advisor.inputTokens === 90 && advisor.outputTokens === 14 && advisor.models === 1 && Math.abs((advisor.costUSD as number) - advisorCost) < 1e-9, j(anthropic))
  check('the session spend still carries both turns; no scheduled share where no cron ran', anthropic.inputTokens === 390 && anthropic.outputTokens === 34 && anthropic.scheduled === undefined, j(anthropic))
  check("another family's spend carries no advisor share", (usageOwner.providerSessionSpend('openai') as Raw).advisor === undefined)
  const whole = usageOwner.advisorSessionSpend()
  check('the cross-family advisor spend sums the bucket', whole.inputTokens === 90 && whole.outputTokens === 14 && whole.models === 1, j(whole))
  const line = usageOwner.advisorUsageLine()
  check("the card line — 'advisor 104 spent · $…'", typeof line === 'string' && line.startsWith('advisor 104 spent · $'), j(line))
  state.resetCostState()
  check('no advisor spend ⇒ no line and no share', usageOwner.advisorUsageLine() === null && (usageOwner.providerSessionSpend('anthropic') as Raw).advisor === undefined)
}

async function mountPopup(columns: number, rowCount: number, width: number, rowBudget: number, openToken: number): Promise<{ frame: () => string; close: () => void }> {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: rowCount }) as unknown as NodeJS.WriteStream
  const root = React.createRef<DOMElement>()
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { ref: root, flexDirection: 'column' }, React.createElement(Usage, { width, rowBudget, openToken } as never)))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await settle(5)
  }
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

section("§2 THE POPUP, rendered from source: the API-key slot paints 'This session: …', 'Scheduled: …' and beneath them 'Advisor: …' (red on the base: no advisor line)")
const popupFrames = new Map<string, string>()
{
  state.resetCostState()
  await workload.runWithWorkload('cron', async () => {
    await settle(1)
    fold(MODEL, usageOf(1_000, 60, 400, 100))
  })
  await workload.runWithWorkload('advisor', async () => {
    await settle(1)
    fold(MODEL, usageOf(90, 14))
  })
  fold(MODEL, usageOf(300, 20))
  check('the labels are the design words', ADVISOR_SPEND_LABEL === 'Advisor' && SCHEDULED_SPEND_LABEL === 'Scheduled')
  let token = 60
  for (const [columns, rowCount, width, rowBudget] of SIZES) {
    const popup = await mountPopup(columns, rowCount, width, rowBudget, token++)
    const frame = popup.frame()
    popup.close()
    popupFrames.set(`${columns}x${rowCount}`, frame)
    const lines: string[] = []
    for (const raw of frame.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('$') && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} ${line}`
      else lines.push(line)
    }
    const session = lines.findIndex(line => line.startsWith('This session: 1,890 input · 94 output tokens · $'))
    const scheduled = lines.findIndex(line => line.startsWith('Scheduled: 1,500 input · 60 output tokens'))
    const advisor = lines.findIndex(line => line.startsWith('Advisor: 90 input · 14 output tokens'))
    check(`${columns}x${rowCount}: the session line, the scheduled row beneath it, the advisor row beneath that, each with its own figure`, session >= 0 && scheduled === session + 1 && advisor === session + 2 && /^Advisor: 90 input · 14 output tokens · \$[0-9.]+$/.test(lines[advisor] ?? ''), lines.filter(line => line.startsWith('This session') || line.startsWith('Scheduled') || line.startsWith('Advisor')).join(' | ') || frame.slice(0, 400))
  }
  state.resetCostState()
  const popup = await mountPopup(178, 51, 146, 22, token++)
  const bare = popup.frame()
  popup.close()
  check('with no advisor spend the slot paints no Advisor line (the words fixture of prove-usage-popup stands)', !bare.includes('Advisor:'), bare.slice(0, 200))
}

section('§3 /submodels, rendered from source: both containers listed, tab moves between them, a pick lands under the advisor key (each mount waits for its first painted frame: a terminal the sniff misses holds the first paint through the boot coalesce and the DECRQM probe, longer than a fixed settle)')
const SYNC_BEGIN = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`
const lastFrame = (output: string): string => {
  const windows: string[] = []
  let cursor = 0
  for (;;) {
    const begin = output.indexOf(SYNC_BEGIN, cursor)
    if (begin === -1) break
    const start = begin + SYNC_BEGIN.length
    const end = output.indexOf(SYNC_END, start)
    if (end === -1) break
    windows.push(output.slice(start, end))
    cursor = end + SYNC_END.length
  }
  for (let i = windows.length - 1; i >= 0; i--) {
    if (stripAnsi(windows[i]!).trim() !== '') return stripAnsi(windows[i]!)
  }
  const HEADER = 'main: '
  const segments = stripAnsi(output).split(HEADER)
  return segments.length > 1 ? HEADER + segments[segments.length - 1]! : stripAnsi(output)
}
const pickerFrames = new Map<string, string>()
{
  const { SubModelPicker } = await import('../../src/components/SubModelPicker.js')
  const mountPanel = async (columns: number, rows: number, initialModelId?: string) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return this }, ref() { return this }, unref() { return this } })
    const stdout = Object.assign(new PassThrough(), { columns, rows })
    let output = ''
    stdout.on('data', (chunk: Buffer | string) => { output += chunk.toString() })
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolve => { painted = resolve })
    const instance = await render(
      React.createElement(SubModelPicker, { onClose: () => {}, onRoute: () => {}, initialContainer: 'console', ...(initialModelId !== undefined ? { initialModelId } : {}) }),
      { stdout: stdout as never, stdin: stdin as never, patchConsole: false, onFrame: () => painted() },
    )
    await firstFrame
    await settle(150)
    return {
      press: async (bytes: string): Promise<void> => { stdin.write(bytes); await settle(150) },
      frame: (): string => lastFrame(output),
      unmount: (): void => { instance.unmount() },
    }
  }
  const flat = (frame: string): string => frame.replace(/\s+/g, ' ')
  const registry = slots.composeSubModelRegistry()
  const opus = registry.entries.find(entry => entry.modelId === MODEL)
  check(`rig: the live registry offers ${MODEL} selectable (the proof Anthropic key)`, opus?.state === 'selectable', j(opus ?? registry.families))
  for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
    const panel = await mountPanel(columns, rows, MODEL)
    const rest = flat(panel.frame())
    check(`${columns} columns: both containers are listed, the console first and marked, the advisor beneath with its blurb (red on the base: the console alone)`, /▸ CONSOLE — side questions · unset/.test(rest) && / ADVISOR — advises the working model, not you · unset · no model pinned/.test(rest) && rest.includes('CONSOLE') && rest.includes('ADVISOR') && rest.indexOf('CONSOLE') < rest.indexOf('ADVISOR'), rest.slice(0, 400))
    check(`${columns} columns: the cursor opens on the named row in the console list (the effort range beneath it)`, /runs @high \(the model default\)/.test(rest), rest.slice(-300))
    pickerFrames.set(`console-${columns}x${rows}`, panel.frame())
    await panel.press('\t')
    const tabbed = flat(panel.frame())
    check(`${columns} columns: tab marks the advisor container and opens its list on the same row`, /▸ ADVISOR — advises the working model, not you/.test(tabbed) && !/▸ CONSOLE/.test(tabbed) && /runs @high \(the model default\)/.test(tabbed), tabbed.slice(-300))
    pickerFrames.set(`advisor-${columns}x${rows}`, panel.frame())
    if (columns === 178) {
      await panel.press('\r')
      const picked = flat(panel.frame())
      check('↵ on the advisor list persists the pick under subModels.advisor alone and paints the Advisor receipt, live on the next note', getGlobalConfig().subModels?.advisor === MODEL && getGlobalConfig().subModels?.console === undefined && /Advisor model set to Opus 4\.8 \(Anthropic\) — runs @high \(the model default\) — live on the next note/.test(picked), `${j(getGlobalConfig().subModels)} · ${picked.slice(-300)}`)
      check('the advisor header now names the model and its saved pick; the console header stays unset', /▸ ADVISOR — advises the working model, not you · Opus 4\.8 · @high \(the model default\) · saved pick/.test(picked) && / CONSOLE — side questions · unset · no model pinned/.test(picked), picked.slice(0, 400))
      pickerFrames.set('advisor-picked-178x51', panel.frame())
      await panel.press(`${ESC}[Z`)
      const back = flat(panel.frame())
      check('shift-tab returns to the console, still unset, the advisor pick standing', /▸ CONSOLE — side questions · unset/.test(back) && / ADVISOR — advises the working model, not you · Opus 4\.8/.test(back), back.slice(0, 400))
      slots.setSubModel('advisor', null)
    }
    panel.unmount()
  }
  const command = (await import('../../src/commands/submodels/index.ts')).default as { description: string }
  check("the command's description says the surface picks both models", command.description.includes("Advisor's") && command.description.includes('advising the working model'), command.description)
  const surface = readFileSync(join(ROOT, 'src/commands/submodels/submodels.tsx'), 'utf8')
  check("the surface's subtitle and footer name both containers and the tab", surface.includes(`subtitle="the Console's and the Advisor's models"`) && surface.includes('tab container'))
}

if (frameDir !== null) {
  section(`frames → ${frameDir}`)
  mkdirSync(frameDir, { recursive: true })
  const index: string[] = ['the advisor surface frames — the /usage popup and the /submodels picker, rendered from source at the named size', '']
  for (const [name, frame] of popupFrames) {
    const file = `usage-popup-advisor-${name}.txt`
    writeFileSync(join(frameDir, file), `${frame}\n`)
    index.push(`${file} — the /usage popup's Anthropic API-key slot: the session line, the scheduled row, the advisor row beneath`)
    console.log(`  wrote ${file}`)
  }
  for (const [name, frame] of pickerFrames) {
    const file = `submodels-${name}.txt`
    writeFileSync(join(frameDir, file), `${frame.replace(/\n$/, '')}\n`)
    index.push(`${file} — the /submodels picker: both containers listed, ${name.startsWith('advisor') ? 'the advisor container active' : 'the console container active'}`)
    console.log(`  wrote ${file}`)
  }
  writeFileSync(join(frameDir, 'index-surfaces.txt'), `${index.join('\n')}\n`)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} advisor surfaces: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
