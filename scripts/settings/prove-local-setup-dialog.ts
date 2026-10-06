#!/usr/bin/env bun
import { mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const ROOT = join(import.meta.dir, '../..')
if (existsSync('/private/tmp/mw')) process.env.TMPDIR = '/private/tmp/mw'
const home = pinScratchHome('local-setup-dialog')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|TYPESAFE_)/.test(name)) delete process.env[name]
}
for (const name of ['MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_REDUCED_MOTION', 'MERCURY_LOCAL_BASE_URL']) delete process.env[name]

const index = process.argv.indexOf('--frames')
const dir = index < 0 ? undefined : process.argv[index + 1]
if (dir) mkdirSync(dir, { recursive: true })
const frames: string[] = []
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}

const KEYS = '↵ run · s skip · esc stop'
const MODEL = 'local/qwen3.5:9b'
const BIG = 'local/qwen3.5:27b'
const HOSTED = 'claude-fixture'
const CHOOSE_KEYS = '↑↓ choose · ↵ pick · esc keeps'
const CURSOR = '›'
const PROBES = 'GET http://127.0.0.1:11434/api/tags · GET http://127.0.0.1:1234/api/v0/models · GET http://127.0.0.1:8000/v1/models · GET http://127.0.0.1:8080/v1/models'
const PULL = 'POST http://127.0.0.1:11434/api/pull {"model":"qwen3.5:9b","stream":true}'
const SHOW = 'POST http://127.0.0.1:11434/api/show {"model":"qwen3.5:9b"} · then write localModelWindows["local/qwen3.5:9b"] = 131072 in the config home'
const CHAT = 'POST http://127.0.0.1:11434/api/chat {"model":"qwen3.5:9b","messages":[{"role":"user","content":"reply with the single word ready"}],"stream":true,"options":{"num_ctx":131072}}'
const CHAT_TAIL = '"options":{"num_ctx":131072}}'
const PULL_ROWS = ['pulling manifest', 'pulling 4f1a2b3c9d0e 12% · 0.8 GiB of 6.6 GiB', 'pulling 4f1a2b3c9d0e 63% · 4.2 GiB of 6.6 GiB', 'verifying sha256 digest', 'success']
const READY_ROW = `ready · ${MODEL} · 128k window · reply in 41 s · esc closes`
const WINDOW_WORDS = '128k · 6.6 GiB weights + 4.3 GiB cache of 43.2 GiB usable'
const BOX_WORDS = 'pulls sized for this box: 43.2 GiB usable of 48.0 GiB (ollama.com/library/qwen3.5)'

type Row = { tag: string; words: string; on: 'server' | 'pull'; current?: boolean; tested?: boolean }
const PULL_ROWS_LIST: Row[] = [
  { tag: 'qwen3.5:0.8b', on: 'pull', words: 'pull 1.0 GB · fits · 256k' },
  { tag: 'qwen3.5:2b', on: 'pull', words: 'pull 2.7 GB · fits · 256k' },
  { tag: 'qwen3.5:4b', on: 'pull', words: 'pull 3.4 GB · fits · 256k' },
  { tag: 'qwen3.5:9b', on: 'pull', words: 'pull 6.6 GB · fits · 256k' },
  { tag: 'qwen3.5:27b', on: 'pull', words: 'pull 17 GB · fits · 256k' },
  { tag: 'qwen3.5:35b', on: 'pull', words: 'pull 24 GB · fits · 256k' },
  { tag: 'qwen3.5:122b', on: 'pull', words: 'pull 81 GB · does not fit' },
]
const FRESH_ROWS: Row[] = PULL_ROWS_LIST.map(row => (row.tag === 'qwen3.5:9b' ? { ...row, words: `${row.words} · the tested one`, tested: true } : row))
const SERVER_ROWS: Row[] = [
  { tag: 'qwen3.5:27b', on: 'server', words: 'on the server · 17.0 GB · trained 256k · current', current: true },
  { tag: 'qwen3.5:9b-q4_K_M', on: 'server', words: 'on the server · 6.6 GB · trained 256k' },
  ...PULL_ROWS_LIST.filter(row => row.tag !== 'qwen3.5:27b'),
]

type Plan = { step: number; label: string; kind: string; title: string; found: string; willRun: string; needsSudo: boolean; keys: string; skippable: boolean; rows?: Row[] }
type Outcome = { rc?: number; lastLine: string; skipWords: string }
const PLANS: Array<Plan & Outcome> = [
  { step: 1, label: '1', kind: 'find-server', title: 'find a server', found: 'four documented ports to probe · Ollama :11434 · LM Studio :1234 · vLLM :8000 · llama.cpp :8080', willRun: PROBES, needsSudo: false, keys: KEYS, skippable: false, lastLine: 'nothing answers on the four ports', skipWords: 'no probe' },
  { step: 2, label: '2', kind: 'find-ollama', title: 'find Ollama on this machine', found: 'looks on PATH, in /Applications and ~/Applications, and at Homebrew', willRun: 'which ollama · ls /Applications/Ollama.app ~/Applications/Ollama.app · brew list --formula ollama', needsSudo: false, keys: KEYS, skippable: false, lastLine: 'not installed · PATH, both app folders and Homebrew have no ollama', skipWords: 'no look' },
  { step: 2, label: '2b', kind: 'install', title: 'install Ollama', found: 'Homebrew is present · docs.ollama.com/download: "brew install ollama" (no drag to Applications)', willRun: 'brew install ollama', needsSudo: false, keys: KEYS, skippable: true, rc: 0, lastLine: 'ollama 0.34.4 installed at /opt/homebrew/bin/ollama', skipWords: 'install it yourself, then run /localsetup again' },
  { step: 3, label: '3', kind: 'start', title: 'start the server', found: 'Homebrew ollama 0.34.4 at /opt/homebrew/bin/ollama · not running', willRun: 'brew services start ollama · then GET http://127.0.0.1:11434/api/version every 0.5 s for up to 60 s', needsSudo: false, keys: KEYS, skippable: true, rc: 0, lastLine: 'Ollama 0.34.4 answered /api/version after 2.1 s', skipWords: 'the server stays down' },
  { step: 4, label: '4', kind: 'choose', title: 'choose the model', found: `Ollama at http://127.0.0.1:11434 lists no model · no local model is set up yet (the session is on ${HOSTED}) · qwen3.5:9b is the tested one · nothing is pre-chosen · ${BOX_WORDS}`, willRun: '', needsSudo: false, keys: `${CHOOSE_KEYS} ${HOSTED}`, skippable: false, rows: FRESH_ROWS, lastLine: 'qwen3.5:9b · pull 6.6 GB · fits · 256k · the tested one', skipWords: 'no pick' },
  { step: 4, label: '4b', kind: 'pull', title: 'pull qwen3.5:9b', found: 'Ollama at http://127.0.0.1:11434 does not list qwen3.5:9b · about 6.6 GB to download (ollama.com/library/qwen3.5 lists the tag at 6.6 GB); the exact size shows with the first row', willRun: PULL, needsSudo: false, keys: KEYS, skippable: true, lastLine: 'success · 6.6 GiB in 5 rows', skipWords: 'qwen3.5:9b was not pulled' },
  { step: 5, label: '5', kind: 'window', title: "set the window from this machine's memory", found: '48 GiB on this machine · qwen3.5:9b trained to 256k · 128k is the largest rung whose load fits 43.2 GiB usable', willRun: SHOW, needsSudo: false, keys: KEYS, skippable: true, lastLine: `${WINDOW_WORDS} · written for ${MODEL}`, skipWords: 'the window stays auto' },
  { step: 6, label: '6', kind: 'prove', title: 'pick and prove', found: `${MODEL} on Ollama 0.34.4 · one bounded turn: "reply with the single word ready"`, willRun: `/model ${MODEL} · ${CHAT}`, needsSudo: false, keys: KEYS, skippable: false, lastLine: 'ready · load 9.8 s · 14 tokens in 41 s', skipWords: 'nothing picked' },
]
const SERVER_UP_PLANS: Array<Plan & Outcome> = [
  { step: 1, label: '1', kind: 'find-server', title: 'find a server', found: 'four documented ports to probe · Ollama :11434 · LM Studio :1234 · vLLM :8000 · llama.cpp :8080', willRun: PROBES, needsSudo: false, keys: KEYS, skippable: false, lastLine: 'Ollama 0.34.4 at http://127.0.0.1:11434 answers with 2 models: qwen3.5:27b, qwen3.5:9b-q4_K_M', skipWords: 'no probe' },
  { step: 4, label: '4', kind: 'choose', title: 'choose the model', found: `Ollama 0.34.4 at http://127.0.0.1:11434 lists 2 models · the session is on ${BIG} · nothing is pre-chosen · ${BOX_WORDS}`, willRun: '', needsSudo: false, keys: `${CHOOSE_KEYS} ${BIG}`, skippable: false, rows: SERVER_ROWS, lastLine: 'qwen3.5:27b · on the server · 17.0 GB · trained 256k · current', skipWords: 'no pick' },
  ...PLANS.filter(plan => plan.label === '5' || plan.label === '6'),
]
let scenario: 'from-nothing' | 'server-up' = 'from-nothing'
const plansOf = (): Array<Plan & Outcome> => (scenario === 'server-up' ? SERVER_UP_PLANS : PLANS)
const keptOf = (): string => (scenario === 'server-up' ? BIG : HOSTED)

const holds: Array<() => void> = []
const hold = (): Promise<void> => new Promise(resolve => holds.push(resolve))
const release = (): void => holds.shift()?.()
type Answer = 'run' | 'skip' | 'stop' | { pick: string }
const answerWords = (answer: Answer): string => (typeof answer === 'string' ? answer : `pick ${answer.pick}`)
const record = { consents: [] as Array<{ label: string; answer: string }>, ran: [] as string[], asked: [] as string[] }
const resetRecord = (): void => {
  record.consents.length = 0
  record.ran.length = 0
  record.asked.length = 0
  holds.length = 0
}
type Consent = (plan: Plan) => Promise<Answer> | Answer
async function* fixtureRoad(consent: Consent): AsyncGenerator<Record<string, unknown>, unknown> {
  const ran: string[] = []
  const skipped: string[] = []
  const plans = plansOf()
  for (const [at, plan] of plans.entries()) {
    const { rc, lastLine, skipWords, ...shown } = plan
    record.asked.push(plan.label)
    yield { type: 'step', plan: shown }
    const answer = await consent(shown)
    record.consents.push({ label: plan.label, answer: answerWords(answer) })
    const picked = typeof answer === 'object' ? answer.pick : undefined
    if (answer === 'stop' || (plan.kind === 'choose' && picked === undefined)) {
      const notDone = plans.slice(at).map(rest => rest.label)
      yield { type: 'done', summary: { ran, skipped, failed: [], notDone, stoppedAt: plan.label, reason: 'stopped', ...(plan.kind === 'choose' ? { kept: keptOf() } : {}), words: `stopped at step ${plan.label}` } }
      return
    }
    if (answer === 'skip') {
      skipped.push(plan.label)
      yield { type: 'result', result: { step: plan.step, label: plan.label, kind: plan.kind, outcome: 'skipped', lastLine: skipWords } }
      continue
    }
    record.ran.push(plan.label)
    ran.push(plan.label)
    if (plan.label === '4b') {
      for (const [row, line] of PULL_ROWS.entries()) {
        yield { type: 'progress', step: 4, label: '4b', line }
        if (row === 1 || row === 2) await hold()
      }
    }
    const detail = plan.label === '6' ? { detail: { model: MODEL, settled: 'applied', ok: true, firstLine: 'ready' } } : {}
    const line = plan.kind === 'choose' && picked !== undefined ? `${picked} · ${(plan.rows ?? []).find(row => row.tag === picked)?.words ?? ''}` : lastLine
    yield { type: 'result', result: { step: plan.step, label: plan.label, kind: plan.kind, outcome: 'ran', ...(rc !== undefined ? { rc } : {}), lastLine: line, ...detail } }
  }
  const ready = { model: MODEL, wireId: 'qwen3.5:9b', server: 'ollama', settled: 'applied', saved: '', ok: true, firstLine: 'ready', window: 131072, timings: { totalMs: 41_000, loadMs: 9_800, evalTokens: 14 }, words: `ready · ${MODEL} · 128k window · reply in 41 s` }
  yield { type: 'done', summary: { ran, skipped, failed: [], notDone: [], reason: 'finished', model: MODEL, ready, words: `ready · ${MODEL}` } }
}
mock.module('../../src/services/localSetup/index.js', () => ({ runSetupRoad: fixtureRoad }))

let localServer = false
const ids = ['anthropic', 'openai', 'gemini', 'moonshot', 'huggingface', 'deepseek', 'zai', 'openrouter', 'openai-compat', 'local']
const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const families = () => ids.map(id => ({ id, available: false, credentialed: id === 'local' && localServer, credentialLabel: `${id} fixture` }))
const owner = (id: string) => ({ provider: id, sourceKind: 'none', windows: [], figures: [], absence: undefined })
const snapshot = () => (localServer ? { servers: [{ kind: 'ollama', root: 'http://127.0.0.1:11434', baseUrl: 'http://127.0.0.1:11434/v1', label: 'Ollama 0.34.4', version: '0.34.4', models: [{ id: 'qwen3.5:9b', server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, { id: 'qwen3.5:27b', server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }] }], probedAtMs: 1_800_000_000_000, targetCount: 4 } : null)
async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/services/providers/providerUsage.js', () => ({
  providerFamilyPresences: families,
  providerSessionSpend: () => spend,
  providerUsageView: (id: string) => ({ entries: [], activeEntry: undefined, sessionSpend: spend, limits: { kind: 'none' } }),
  refreshProviderUsage: async () => undefined,
  usageForProvider: owner,
  usageCreditsLine: () => undefined,
  anthropicWindowViews: () => [],
  anthropicPoolWindowViews: () => [],
  openaiObservedWindowViews: () => [],
  activeSourceUsage: () => ({ tier: 'fixture · no metering' }),
}))
await stub('../../src/utils/auth.js', () => ({ isClaudeAISubscriber: () => false }))
await stub('../../src/utils/model/computedDefault.js', () => ({ recentSignIns: () => ids.map(family => ({ family })) }))
await stub('../../src/services/wallet/wallet.js', () => ({ walletEntries: () => [], activeWalletEntry: () => undefined }))
await stub('../../src/services/providers/usageFreshness.js', () => ({ usageSourceWords: () => 'endpoint-fed · read 0 s ago' }))
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/services/providers/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: snapshot, refreshLocalDiscovery: async () => snapshot() ?? { servers: [], probedAtMs: 0, targetCount: 0 } }))
await stub('../../src/services/providers/local/localAccounts.js', () => ({ resolveLocalAccount: () => (localServer ? { kind: 'keyless', keySource: 'none' } : undefined) }))
await stub('../../src/cost-tracker.js', () => ({ formatLaneSpend: () => '$0.00' }))
await stub('../../src/components/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const words = await import('../../src/commands/localsetup/words.ts').catch(() => null)
const registration = await import('../../src/commands/localsetup/index.ts').catch(() => null)
const command = await import('../../src/commands/localsetup/localsetup.tsx').catch(() => null)
const dialog = await import('../../src/components/LocalSetupDialog.tsx').catch(() => null)
const { configProviderRows } = await import('../../src/components/Settings/Config.js')
const { saturnVerdictSentence } = await import('../../src/components/BootSaturnScreen.js')
const { call: usageCall } = await import('../../src/commands/usage/usage.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { LOCAL_MODEL_GROUP } = await import('../../src/services/providers/local/localCatalogue.js')
const { ANTHROPIC_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')

const wrap = (element: unknown, cols: number, rows: number) => React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: cols, height: rows }, element as never)))
const keep = (name: string, m: Mounted, cols: number, rows: number): void => {
  const lines = m.lines()
  check(`${name}: fits ${cols}x${rows} with no render error`, lines.length <= rows && lines.every(line => stringWidth(line) <= cols) && !m.screen().includes('RENDER ERROR'), `${lines.length} lines · widest ${Math.max(...lines.map(line => stringWidth(line)))}`)
  frames.push(`${name}.txt`)
  if (dir) writeFileSync(join(dir, `${name}.txt`), lines.join('\n') + '\n')
}
const lineWith = (m: Mounted, needle: string): string | undefined => m.lines().find(line => line.includes(needle))
const bodyOf = (line: string): string => line.replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, '').trimEnd()
const threeLines = (name: string, m: Mounted, label: string): void => {
  const lines = m.lines()
  const at = lines.findIndex(line => line.includes(KEYS))
  const found = at >= 2 ? bodyOf(lines[at - 2] ?? '') : ''
  const willRun = at >= 1 ? bodyOf(lines[at - 1] ?? '') : ''
  check(`${name}: the step shows its three lines — found, will run, keys`, at >= 2 && found.startsWith(label) && willRun.startsWith('  will run  ') && bodyOf(lines[at] ?? '').trim() === KEYS, `at ${at} · found "${found}" · will run "${willRun}"`)
  check(`${name}: only one step asks at a time`, lines.filter(line => bodyOf(line).trim() === KEYS).length === 1)
}
const untilAsk = async (m: Mounted, label: string): Promise<boolean> => waitFor(() => m.lines().some(line => line.includes(KEYS)) && m.lines().some(line => bodyOf(line).startsWith(label)), 4000)
const untilChoice = async (m: Mounted, label: string, kept: string): Promise<boolean> => waitFor(() => m.lines().some(line => bodyOf(line).trim() === `${CHOOSE_KEYS} ${kept}`) && m.lines().some(line => bodyOf(line).startsWith(label)), 4000)
const rowLines = (m: Mounted): string[] => m.lines().map(bodyOf).filter(line => /^\s{4}[›\s] qwen/.test(line))
const rowsOnScreen = (m: Mounted): string => rowLines(m).map(line => line.trim()).join(' | ')
const rowOnScreen = (m: Mounted, row: Row): boolean => rowLines(m).some(line => new RegExp(`^\\s{4}[›\\s] ${row.tag.replace(/[.]/g, '\\.')}\\s{2,}${row.words.replace(/[.()]/g, '\\$&')}`).test(line))
const cursorOn = (m: Mounted): string | undefined => rowLines(m).find(line => line.includes(`${CURSOR} `))?.trim().slice(2).split(/\s+/)[0]
const choiceLines = (name: string, m: Mounted, label: string, kept: string, count: number): void => {
  const lines = m.lines().map(bodyOf)
  const keysAt = lines.findIndex(line => line.trim() === `${CHOOSE_KEYS} ${kept}`)
  const foundAt = lines.findIndex(line => line.startsWith(label))
  const between = keysAt > foundAt && foundAt >= 0 ? lines.slice(foundAt + 1, keysAt) : []
  check(`${name}: the step shows its found line, then one row per model, then the choice keys — nothing else between`, foundAt >= 0 && keysAt === foundAt + count + 1 && between.every(line => /^\s{4}[›\s] qwen/.test(line)), `found at ${foundAt} · keys at ${keysAt} · ${between.length} rows between`)
  check(`${name}: only one step asks at a time`, lines.filter(line => line.trim() === KEYS).length === 0 && lines.filter(line => line.trim().startsWith(CHOOSE_KEYS)).length === 1)
}

check('the words module names the command and the one offer line', words !== null && words.LOCAL_SETUP_COMMAND === '/localsetup' && words.LOCAL_SETUP_OFFER === 'or /localsetup sets one up')
check('/localsetup is registered as a private screen-seat local command', registration !== null && registration.default.name === 'localsetup' && registration.default.type === 'local' && registration.default.seat === 'screen' && registration.default.userPrivate === true && registration.default.supportsNonInteractive === false)
const roster = readFileSync(join(ROOT, 'src/commands.ts'), 'utf8')
check('the roster imports and lists /localsetup', roster.includes("import localsetup from './commands/localsetup/index.js'") && /\n  localsetup,\n/.test(roster))
const domains = readFileSync(join(ROOT, 'src/components/HelpV2/commandDomains.ts'), 'utf8')
check('/help files /localsetup under config & setup', /'jev', 'localsetup'/.test(domains))
check('the dialog module exists with the keys line the spec names; the step titles name no model tag', dialog !== null && dialog.LOCAL_SETUP_KEYS === KEYS && dialog.LOCAL_SETUP_STEP_TITLES['4'] === 'choose the model' && dialog.LOCAL_SETUP_STEP_TITLES['4b'] === 'pull the model' && !Object.values(dialog.LOCAL_SETUP_STEP_TITLES).some(title => /qwen/i.test(title)))
check('the words module names no model tag: the choice is the road\'s, never a hard-wired model', words !== null && !Object.values(words).some(value => typeof value === 'string' && /qwen|local\//i.test(value)), JSON.stringify(words))

if (dialog !== null) {
  const reduce = dialog.reduceLocalSetup
  const ask = (step: string, found: string, willRun: string) => ({ kind: 'ask' as const, ask: { step, found, willRun } })
  let state = reduce(dialog.LOCAL_SETUP_INITIAL, ask('4b', 'not on the server', PULL))
  check('an ask becomes one asking step with the spec title', state.steps.length === 1 && state.steps[0]?.phase === 'asking' && state.steps[0]?.title === 'pull the model')
  check('a repeated ask for the same open step is not a second row', reduce(state, ask('4b', 'not on the server', PULL)).steps.length === 1)
  state = reduce(state, { kind: 'consent', answer: 'run' })
  check('↵ moves the asking step to running', state.steps[0]?.phase === 'running')
  state = reduce(state, { kind: 'progress', step: '4b', words: PULL_ROWS[1] ?? '' })
  state = reduce(state, { kind: 'progress', step: '4b', words: PULL_ROWS[2] ?? '' })
  const rows = dialog.localSetupRows(state, 100)
  check('the pull keeps one progress row that updates in place', rows.length === 3 && rows[2]?.text.includes('63%') && !rows.some(row => row.text.includes('12%')), rows.map(row => row.text).join(' | '))
  state = reduce(state, { kind: 'result', step: '4b', outcome: 'ran', words: 'success · 6.6 GiB in 5 rows' })
  check('a result closes the step under its own rows', state.steps[0]?.phase === 'ran' && dialog.localSetupRows(state, 100)[2]?.text === '  ✓ success · 6.6 GiB in 5 rows')
  const has = (name: string): boolean => typeof (dialog as Record<string, unknown>)[name] === 'function'
  const choiceAsk = { kind: 'ask' as const, ask: { step: '4', found: 'lists 2 models', willRun: '', keys: `${CHOOSE_KEYS} ${BIG}`, rows: SERVER_ROWS } }
  let choice = reduce(dialog.LOCAL_SETUP_INITIAL, choiceAsk)
  const choiceRows = dialog.localSetupRows(choice, 120)
  check('a choice ask lists its rows between the found line and its own keys line, the current row marked, no cursor and no tick before a key', choiceRows.length === SERVER_ROWS.length + 2 && choiceRows[0]?.text === '4 · choose the model · lists 2 models' && choiceRows[1]?.text === '      qwen3.5:27b        on the server · 17.0 GB · trained 256k · current' && choiceRows[choiceRows.length - 1]?.text === `  ${CHOOSE_KEYS} ${BIG}` && !choiceRows.some(row => row.text.includes(CURSOR) || row.text.includes('✓')), choiceRows.map(row => row.text).join(' | '))
  check('↵ with no row under the cursor is no pick: the reducer reads a pick only from a pick answer', has('localSetupPickOf') && has('localSetupIsChoice') && dialog.localSetupPickOf('run') === undefined && dialog.localSetupPickOf({ pick: 'qwen3.5:9b' }) === 'qwen3.5:9b' && dialog.localSetupIsChoice(dialog.localSetupAsking(choice)) && dialog.localSetupAsking(choice)?.cursor === undefined)
  choice = has('localSetupMoveCursor') ? reduce(choice, { kind: 'cursor', delta: 1 }) : choice
  check('↓ puts the cursor on the first row; ↑ from the top stays; ↑ from no row goes to the last', has('localSetupMoveCursor') && dialog.localSetupAsking(choice)?.cursor === 0 && dialog.localSetupRows(choice, 120)[1]?.text.startsWith(`    ${CURSOR} qwen3.5:27b`) === true && dialog.localSetupMoveCursor(SERVER_ROWS, 0, -1) === 0 && dialog.localSetupMoveCursor(SERVER_ROWS, undefined, -1) === SERVER_ROWS.length - 1 && dialog.localSetupMoveCursor(SERVER_ROWS, SERVER_ROWS.length - 1, 1) === SERVER_ROWS.length - 1, dialog.localSetupRows(choice, 120)[1]?.text)
  const picked = reduce(choice, { kind: 'consent', answer: { pick: 'qwen3.5:27b' } })
  check('a pick moves the choice step to running, like ↵ on a plain step', picked.steps[0]?.phase === 'running' && !picked.stopRequested)
  const keptState = reduce(reduce(choice, { kind: 'consent', answer: 'stop' }), { kind: 'done', summary: { stopped: true, done: ['1'], notDone: ['4', '5', '6'], kept: BIG } })
  check('esc at the choice: the summary says the model stays and the line says so', dialog.localSetupSummaryRows(keptState.summary!)[1] === `the model stays ${BIG}` && dialog.localSetupLine(keptState) === `stopped · the model stays ${BIG}`, dialog.localSetupSummaryRows(keptState.summary!).join(' | '))
  check('the choice line says nothing is pre-chosen', dialog.localSetupLine(choice) === 'step 4 of 6 · choose the model · ↑↓ then ↵ · nothing is pre-chosen', dialog.localSetupLine(choice))
  check('the row window follows the cursor: a row past the tail window scrolls to it, a row inside the tail keeps the tail', has('localSetupScrollFor') && dialog.localSetupScrollFor(30, 12, 2) === 0 && dialog.localSetupScrollFor(30, 12, 15) === 6 && dialog.localSetupScrollFor(30, 12, 25) === null && dialog.localSetupScrollFor(5, 12, 3) === null)
  const skipped = reduce(reduce(dialog.LOCAL_SETUP_INITIAL, ask('2b', 'brew present', 'brew install ollama')), { kind: 'consent', answer: 'skip' })
  check('s marks the asking step skipped', skipped.steps[0]?.phase === 'skipped' && dialog.localSetupRows(skipped, 100)[2]?.text === '  – skipped')
  const stopped = reduce(reduce(dialog.LOCAL_SETUP_INITIAL, ask('3', 'installed', 'brew services start ollama')), { kind: 'consent', answer: 'stop' })
  const ended = reduce(stopped, { kind: 'ended' })
  check('esc leaves the step as it stands and the summary says what is done and what is not', stopped.stopRequested && stopped.steps[0]?.phase === 'stopped' && ended.summary?.stopped === true && ended.summary.done.length === 0 && ended.summary.notDone.join(',') === '3,1,2,4,5,6')
  check('the ready row is the spec sentence', dialog.localSetupReadyRow({ model: MODEL, window: '128k', replySeconds: 41 }) === READY_ROW)
  const narrow = dialog.localSetupRows(reduce(dialog.LOCAL_SETUP_INITIAL, ask('6', 'ollama answers', CHAT)), 74)
  const tailRows = dialog.localSetupRows(reduce(dialog.LOCAL_SETUP_INITIAL, ask('6', 'ollama answers', CHAT)), 74, true)
  check('a long will-run line clips in its own cell and → shows its tail', narrow.every(row => stringWidth(row.text) <= 74) && narrow[1]?.text.endsWith('…') && tailRows[1]?.text.endsWith(CHAT_TAIL) && tailRows[1]?.text.includes('will run  …'), `${narrow[1]?.text} / ${tailRows[1]?.text}`)
  const window = dialog.localSetupWindow
  check('the row window follows the newest rows and its markers never hide a row they count', JSON.stringify(window(20, 12, null)) === JSON.stringify({ start: 9, end: 20, above: 9, below: 0 }) && JSON.stringify(window(20, 12, 0)) === JSON.stringify({ start: 0, end: 11, above: 0, below: 9 }) && JSON.stringify(window(20, 12, 4)) === JSON.stringify({ start: 4, end: 14, above: 4, below: 6 }) && JSON.stringify(window(5, 12, null)) === JSON.stringify({ start: 0, end: 5, above: 0, below: 0 }))
}

if (command !== null) {
  const request = command.localSetupPopupRequest(async function* () {})
  check('the popup request is the shared floating window with a fixed height and the keys hint', request.view === 'localsetup' && request.rows === 33 && typeof request.width === 'function' && request.width(178) === 120 && request.width(80) === 80 && request.hint.startsWith(KEYS))
  const bare = command.localSetupPopupRequest()
  check('the picker opens the same request with no road of its own — the body builds the real road', bare.view === 'localsetup' && bare.rows === 33 && typeof command.openLocalSetupPopup === 'function')
  const summary = command.setupSummaryOf({ ran: ['1', '2'], skipped: ['2b'], failed: [], notDone: ['3', '4', '5', '6'], reason: 'stopped', words: 'stopped at step 3 · done: 1, 2 · not done: 3, 4, 5, 6' })
  check('the adapter keeps ran, skipped and not-done apart in label order and lets the dialog word a stop itself', summary.stopped && summary.done.join(',') === '1,2' && summary.skipped?.join(',') === '2b' && summary.notDone.join(',') === '3,4,5,6' && summary.words === undefined)
  const ended = command.setupSummaryOf({ ran: ['1', '2', '2b'], skipped: [], failed: ['3'], notDone: ['4', '5', '6'], reason: 'ended', words: 'step 3 failed · brew services start ollama rc 1' })
  check('a road that ends on a failed step keeps its own words and lists the failed step as not done', !ended.stopped && ended.notDone.join(',') === '3,4,5,6' && ended.words === 'step 3 failed · brew services start ollama rc 1')
  const finished = command.setupSummaryOf({ ran: ['1', '2', '2b', '3', '4', '5', '6'], skipped: [], failed: [], notDone: [], reason: 'finished', ready: { model: MODEL, ok: true, window: 131072, timings: { totalMs: 41_400 } }, words: '' })
  check('the adapter turns the prove result into the ready row facts', finished.ready?.model === MODEL && finished.ready.window === '128k' && finished.ready.replySeconds === 41 && finished.ready.words === undefined)
  const worded = command.setupSummaryOf({ ran: ['1'], skipped: [], failed: [], notDone: [], reason: 'finished', ready: { model: MODEL, ok: true, timings: { totalMs: 900 }, words: 'ready · local/qwen3.5:9b · 32k window · reply in 1 s' }, words: '' })
  check("the road's own ready sentence is kept when it states one", worded.ready?.words === 'ready · local/qwen3.5:9b · 32k window · reply in 1 s' && dialog !== null && dialog.localSetupReadyRow(worded.ready!) === 'ready · local/qwen3.5:9b · 32k window · reply in 1 s · esc closes')
  check('a result line carries its rc when the step ran a command', command.setupResultWords({ label: '3', outcome: 'ran', rc: 0, lastLine: 'started' }) === 'rc 0 · started' && command.setupResultWords({ label: '1', outcome: 'ran', lastLine: 'nothing answers' }) === 'nothing answers')
  check("step 6's row says how the session switch settled, in the receipt's own word", command.setupResultWords({ label: '6', outcome: 'ran', lastLine: 'ready · load 9.8 s', detail: { settled: 'applied' } }) === 'ready · load 9.8 s · session model switched' && command.setupResultWords({ label: '6', outcome: 'ran', lastLine: 'ready', detail: { settled: 'unavailable' } }) === 'ready · session model not switched · no session door' && command.setupResultWords({ label: '6', outcome: 'ran', lastLine: 'ready', detail: { settled: 'queued' } }).includes("queued for the turn's end") && command.setupResultWords({ label: '6', outcome: 'ran', lastLine: 'ready', detail: { settled: 'parked' } }) === 'ready · session switch: parked' && command.setupResultWords({ label: '5', outcome: 'ran', lastLine: '128k', detail: { window: 131072 } }) === '128k')
}

const offerAbsent = configProviderRows([{ id: 'local', available: true, credentialed: false }] as never)[0]?.valueText ?? ''
const offerPresent = configProviderRows([{ id: 'local', available: true, credentialed: true, credentialLabel: 'Ollama 0.34.4 · 2 models' }] as never)[0]?.valueText ?? ''
check('/config Local row offers /localsetup when no server answers', offerAbsent.endsWith(', or /localsetup sets one up') && offerAbsent.startsWith('no sign-in — start a local server'), offerAbsent)
check('/config Local row drops the offer when a server answers', !offerPresent.includes('/localsetup') && offerPresent.startsWith('Ollama 0.34.4'), offerPresent)
const unreachable = saturnVerdictSentence({ state: 'unreachable' } as never)
const ready = saturnVerdictSentence({ state: 'ready' } as never)
check('the boot screen unreachable line offers /localsetup before the born-held clause', unreachable.includes(', or /localsetup sets one up, or the fire is born held') && unreachable.startsWith('preflight: no local server answering'), unreachable)
check('the boot screen ready line carries no offer', !ready.includes('/localsetup'))

try {
  for (const server of [false, true]) {
    localServer = server
    const m = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), 178, 51), 178, 51)
    await usageCall('', {} as never)
    await waitFor(() => m.screen().includes('Mercury · usage'), 4000)
    await settle(120)
    for (let step = 0; step < 40 && !m.lines().some(line => line.includes('Local models usage')); step++) {
      m.push(KEY.down)
      await settle(60)
    }
    await settle(120)
    const flat = m.lines().map(bodyOf).join('\n').replace(/\s+/g, ' ')
    check(`the usage popup reaches its local block${server ? ' (server answering)' : ''}`, flat.includes('Local models usage'), flat.slice(-300))
    if (server) check('the usage local block drops the offer when a server answers', !flat.includes('/localsetup') && flat.includes('Ollama 0.34.4 · Ollama at') && flat.includes('2 models'), lineWith(m, 'Ollama') ?? flat.slice(-400))
    else check('the usage local block offers /localsetup when no server answers', flat.includes('or /localsetup sets one up'), lineWith(m, 'Local models') ?? flat.slice(-400))
    popup.closeSettingsPopup()
    m.unmount()
  }
  localServer = false
  const PICKER_OFFER = 'no local server · s sets one up'
  const ANTHROPIC_ROW = { id: 'claude-fable-5-1', name: 'fable', tag: '', ctx: '1M', group: ANTHROPIC_MODEL_GROUP }
  const LOCAL_ROW = { id: 'local/qwen3.5:9b', name: 'qwen3.5:9b', tag: '', ctx: '256k', group: LOCAL_MODEL_GROUP }
  const pickerHeadings = (answering: boolean) => ({
    [ANTHROPIC_MODEL_GROUP]: { name: 'ANTHROPIC', doors: [] },
    [LOCAL_MODEL_GROUP]: answering ? { name: 'LOCAL', doors: [{ door: 'Ollama 0.34.4' }] } : { name: 'LOCAL', doors: [], reason: 'no local server answered' },
  })
  const pickerRecord = { closed: 0, slot: [] as string[] }
  function PickerHost({ answering, slotReceipt }: { answering: boolean; slotReceipt: string | null }): React.ReactNode {
    const [open, setOpen] = React.useState(true)
    return React.createElement(
      React.Fragment,
      {},
      open
        ? React.createElement(MercuryModelPicker, {
            models: answering ? [ANTHROPIC_ROW, LOCAL_ROW] : [ANTHROPIC_ROW],
            current: 'claude-fable-5-1',
            ctxPct: 23,
            efforts: ['low', 'medium', 'high', 'max'],
            effort: 'high',
            headings: pickerHeadings(answering),
            onSlotSwitch: (group: string) => {
              pickerRecord.slot.push(group)
              return slotReceipt
            },
            onClose: () => {
              pickerRecord.closed += 1
              setOpen(false)
            },
          } as never)
        : null,
      React.createElement(SettingsPopupSlot, { overlay: true }),
    )
  }
  for (const [cols, rows] of [[178, 51], [80, 21]] as const) {
    const tag = `${cols}x${rows}`
    pickerRecord.closed = 0
    pickerRecord.slot.length = 0
    const offer = await mountOffscreen(wrap(React.createElement(PickerHost, { answering: false, slotReceipt: null }), cols, rows), cols, rows)
    await waitFor(() => offer.screen().includes('Mercury · model'), 4000)
    await settle(120)
    const offerLine = lineWith(offer, PICKER_OFFER)
    check(`${tag}: the picker's LOCAL section offers the road when no local server answers`, offerLine !== undefined && bodyOf(offerLine).includes(`LOCAL · ${PICKER_OFFER}`), offer.lines().filter(line => line.trim() !== '').slice(-8).join('\n'))
    check(`${tag}: the offer row sits after the last section, inside the panel`, offer.lines().findIndex(line => line.includes(PICKER_OFFER)) > offer.lines().findIndex(line => line.includes('fable')) && stringWidth(offerLine ?? '') <= cols)
    keep(`picker-offer-${tag}`, offer, cols, rows)
    offer.push('/')
    await settle(80)
    offer.push('s')
    await settle(120)
    check(`${tag}: with the filter focused, s types into the filter and the row hides while a filter is typed`, !offer.screen().includes(PICKER_OFFER) && offer.lines().some(line => /\/ s\b/.test(bodyOf(line))) && popup.settingsPopupRequest() === null && pickerRecord.closed === 0, offer.lines().filter(line => line.includes('/')).join(' | '))
    offer.push(KEY.esc)
    await settle(80)
    check(`${tag}: esc leaves the filter and the offer row returns`, await waitFor(() => offer.screen().includes(PICKER_OFFER) && pickerRecord.closed === 0, 4000))
    offer.push('s')
    check(`${tag}: s opens the set-up dialog in the shared popup and closes the picker`, (await waitFor(() => popup.settingsPopupRequest()?.view === 'localsetup' && offer.screen().includes('Mercury · localsetup'), 4000)) && pickerRecord.closed === 1 && pickerRecord.slot.length === 1, `closed ${pickerRecord.closed} · slot asks ${pickerRecord.slot.join(',')} · view ${popup.settingsPopupRequest()?.view ?? 'none'}`)
    check(`${tag}: the dialog asks step 1 with nothing run`, (await untilAsk(offer, '1 · find a server')) && record.ran.length === 0 && !offer.screen().includes('Mercury · model'))
    keep(`picker-s-opens-dialog-${tag}`, offer, cols, rows)
    popup.closeSettingsPopup()
    offer.unmount()
    resetRecord()

    pickerRecord.closed = 0
    pickerRecord.slot.length = 0
    const switched = await mountOffscreen(wrap(React.createElement(PickerHost, { answering: false, slotReceipt: 'switched to the Console key' }), cols, rows), cols, rows)
    await waitFor(() => switched.screen().includes(PICKER_OFFER), 4000)
    switched.push('s')
    await settle(120)
    check(`${tag}: a slot switch that consumes s keeps the dialog closed`, pickerRecord.slot.length === 1 && popup.settingsPopupRequest() === null && pickerRecord.closed === 0 && switched.screen().includes('switched to the Console key'))
    switched.unmount()

    pickerRecord.closed = 0
    pickerRecord.slot.length = 0
    const answering = await mountOffscreen(wrap(React.createElement(PickerHost, { answering: true, slotReceipt: null }), cols, rows), cols, rows)
    await waitFor(() => answering.screen().includes('qwen3.5:9b'), 4000)
    await settle(80)
    check(`${tag}: the picker drops the offer when a local server answers`, !answering.screen().includes(PICKER_OFFER) && answering.screen().includes('Ollama 0.34.4'))
    answering.push('s')
    await settle(120)
    check(`${tag}: s without the offer opens nothing`, popup.settingsPopupRequest() === null && pickerRecord.closed === 0)
    answering.unmount()
  }
  for (const [cols, rows] of [[178, 51], [80, 21]] as const) {
    const tag = `${cols}x${rows}`
    if (command === null) break
    resetRecord()
    const m = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
    const result = await command.call('', {} as never)
    check(`${tag}: /localsetup opens the dialog in the shared popup and returns skip`, result.type === 'skip' && popup.settingsPopupRequest()?.view === 'localsetup')
    check(`${tag}: the window is the popup every other pop-up uses`, await waitFor(() => m.screen().includes('Mercury · localsetup'), 4000))
    check(`${tag}: step 1 asks first`, await untilAsk(m, '1 · find a server'))
    keep(`opening-step-1-${tag}`, m, cols, rows)
    threeLines(`${tag} step 1`, m, '1 · find a server')
    check(`${tag}: nothing ran before ↵`, record.ran.length === 0 && record.asked.join(',') === '1')
    m.push(KEY.enter)
    check(`${tag}: ↵ runs step 1 and its result lands under it`, await waitFor(() => m.screen().includes('✓ nothing answers on the four ports'), 4000) && record.consents[0]?.answer === 'run' && record.ran.join(',') === '1')
    check(`${tag}: step 2 asks next`, await untilAsk(m, '2 · find Ollama on this machine'))
    m.push(KEY.enter)
    check(`${tag}: step 2 ran`, await waitFor(() => m.screen().includes('✓ not installed'), 4000))
    check(`${tag}: step 2b offers the install`, await untilAsk(m, '2b · install Ollama'))
    threeLines(`${tag} step 2b`, m, '2b · install Ollama')
    check(`${tag}: the install line is the documented brew command`, bodyOf(lineWith(m, 'will run  brew install ollama') ?? '').trim() === 'will run  brew install ollama')
    check(`${tag}: the install has not run before ↵`, !record.ran.includes('2b'))
    keep(`install-offer-${tag}`, m, cols, rows)
    m.push(KEY.enter)
    check(`${tag}: the install ran with its rc and last line`, await waitFor(() => m.screen().includes('✓ rc 0 · ollama 0.34.4 installed'), 4000))
    check(`${tag}: step 3 asks`, await untilAsk(m, '3 · start the server'))
    m.push(KEY.enter)
    check(`${tag}: the server started`, await waitFor(() => m.screen().includes('answered /api/version after 2.1 s'), 4000))
    check(`${tag}: step 4 asks which model — the seven pulls the fresh server can take, sized for the box, the tested 9B a suggestion row`, (await untilChoice(m, '4 · choose the model', HOSTED)) && FRESH_ROWS.every(row => rowOnScreen(m, row)), rowsOnScreen(m))
    choiceLines(`${tag} step 4`, m, '4 · choose the model', HOSTED, FRESH_ROWS.length)
    check(`${tag}: no row is pre-chosen — no cursor, no tick, and ↵ before ↓ picks nothing`, !cursorOn(m) && !m.lines().some(line => /✓ qwen/.test(bodyOf(line))) && record.consents.length === 4)
    keep(`choose-model-pulls-${tag}`, m, cols, rows)
    m.push(KEY.enter)
    await settle(120)
    check(`${tag}: ↵ with no row under the cursor leaves the ask standing`, record.consents.length === 4 && record.asked.join(',') === '1,2,2b,3,4' && m.lines().some(line => bodyOf(line).includes(`${CHOOSE_KEYS} ${HOSTED}`)))
    for (let step = 0; step < 4; step++) m.push(KEY.down)
    check(`${tag}: four ↓ put the cursor on the 9B row and nowhere else`, await waitFor(() => cursorOn(m) === 'qwen3.5:9b', 4000), cursorOn(m) ?? 'no cursor')
    keep(`choose-model-cursor-${tag}`, m, cols, rows)
    m.push(KEY.enter)
    check(`${tag}: ↵ on the row picks it — the consent carries the tag and the row becomes the result`, (await waitFor(() => m.screen().includes('✓ qwen3.5:9b · pull 6.6 GB · fits · 256k · the tested one'), 4000)) && record.consents[4]?.answer === 'pick qwen3.5:9b', record.consents.map(c => `${c.label}:${c.answer}`).join(' '))
    check(`${tag}: step 4b asks with the size before ↵`, (await untilAsk(m, '4b · pull qwen3.5:9b')) && m.screen().includes('6.6 GB'))
    threeLines(`${tag} step 4b`, m, '4b · pull qwen3.5:9b')
    m.push(KEY.enter)
    check(`${tag}: the pull streams its first progress row`, await waitFor(() => m.screen().includes('12%'), 4000))
    release()
    check(`${tag}: the progress row updates in place`, (await waitFor(() => m.screen().includes('63%'), 4000)) && !m.screen().includes('12%') && m.lines().filter(line => bodyOf(line).startsWith('  pulling')).length === 1)
    keep(`pull-progress-${tag}`, m, cols, rows)
    release()
    check(`${tag}: the pull ends in success`, await waitFor(() => m.screen().includes('✓ success · 6.6 GiB'), 4000))
    check(`${tag}: step 5 asks with the machine's figures`, (await untilAsk(m, '5 · set the window')) && m.screen().includes('48 GiB on this machine'))
    threeLines(`${tag} step 5`, m, '5 · set the window')
    m.push(KEY.enter)
    check(`${tag}: the window words land`, await waitFor(() => m.screen().includes(`✓ ${WINDOW_WORDS}`), 4000))
    check(`${tag}: step 6 asks`, await untilAsk(m, '6 · pick and prove'))
    keep(`window-words-${tag}`, m, cols, rows)
    threeLines(`${tag} step 6`, m, '6 · pick and prove')
    const head = bodyOf(lineWith(m, 'will run  ') ?? '')
    m.push(KEY.right)
    check(`${tag}: → shows the tail of the long chat request`, await waitFor(() => (lineWith(m, CHAT_TAIL) ?? '').includes('will run  …'), 4000), lineWith(m, 'will run') ?? '')
    m.push(KEY.left)
    check(`${tag}: ← returns to its head`, await waitFor(() => bodyOf(lineWith(m, 'will run  ') ?? '') === head, 4000))
    m.push(KEY.enter)
    check(`${tag}: the ready row is the spec sentence`, await waitFor(() => m.screen().includes(READY_ROW), 4000), lineWith(m, 'ready') ?? '')
    check(`${tag}: step 6's result row names the session switch by the receipt's word`, m.lines().some(line => bodyOf(line).includes('✓ ready · load 9.8 s · 14 tokens in 41 s · session model switched')), lineWith(m, '✓ ready') ?? '')
    keep(`ready-row-${tag}`, m, cols, rows)
    check(`${tag}: every consent went through the road's own callback`, record.consents.map(consent => `${consent.label}:${consent.answer}`).join(' ') === '1:run 2:run 2b:run 3:run 4:pick qwen3.5:9b 4b:run 5:run 6:run', record.consents.map(consent => `${consent.label}:${consent.answer}`).join(' '))
    m.push(KEY.esc)
    check(`${tag}: esc closes the popup once the road has ended`, await waitFor(() => popup.settingsPopupRequest() === null, 4000))
    m.unmount()

    resetRecord()
    scenario = 'server-up'
    const up = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
    await command.call('', {} as never)
    check(`${tag} server up: step 1 asks`, await untilAsk(up, '1 · find a server'))
    up.push(KEY.enter)
    check(`${tag} server up: step 4 asks with the server's two models first, the session's 27B marked current, then what it can pull`, (await untilChoice(up, '4 · choose the model', BIG)) && SERVER_ROWS.every(row => rowOnScreen(up, row)) && rowsOnScreen(up).indexOf('qwen3.5:27b') < rowsOnScreen(up).indexOf('qwen3.5:0.8b'), rowsOnScreen(up))
    choiceLines(`${tag} server up step 4`, up, '4 · choose the model', BIG, SERVER_ROWS.length)
    check(`${tag} server up: the current mark sits on the 27B only, the tested suggestion is absent, no pull row repeats a listed model, nothing is ticked or under a cursor`, up.lines().filter(line => bodyOf(line).includes('· current')).length === 1 && (lineWith(up, '· current') ?? '').includes('qwen3.5:27b') && !up.screen().includes('the tested one') && !up.lines().some(line => /pull 17 GB/.test(bodyOf(line))) && !cursorOn(up), rowsOnScreen(up))
    check(`${tag} server up: the keys line says esc keeps ${BIG}`, up.lines().some(line => bodyOf(line).trim() === `${CHOOSE_KEYS} ${BIG}`))
    keep(`choose-model-server-${tag}`, up, cols, rows)
    up.push(KEY.esc)
    check(`${tag} server up: esc keeps the model — the summary says it stays ${BIG} and nothing more runs`, (await waitFor(() => up.screen().includes('stopped · nothing more runs · esc closes') && up.screen().includes(`the model stays ${BIG}`), 4000)) && record.consents.map(c => c.answer).join(',') === 'run,stop' && record.ran.join(',') === '1', up.lines().map(bodyOf).filter(l => l.trim() !== '').slice(-6).join(' | '))
    keep(`esc-keeps-model-${tag}`, up, cols, rows)
    up.push(KEY.esc)
    check(`${tag} server up: a second esc closes`, await waitFor(() => popup.settingsPopupRequest() === null, 4000))
    up.unmount()
    scenario = 'from-nothing'

    resetRecord()
    const stop = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
    await command.call('', {} as never)
    check(`${tag} stop: step 1 asks`, await untilAsk(stop, '1 · find a server'))
    stop.push(KEY.enter)
    check(`${tag} stop: step 2 asks`, await untilAsk(stop, '2 · find Ollama'))
    stop.push(KEY.enter)
    check(`${tag} stop: step 2b asks`, await untilAsk(stop, '2b · install Ollama'))
    stop.push('s')
    check(`${tag} stop: s skips the install with the road's words`, await waitFor(() => stop.screen().includes('– skipped · install it yourself'), 4000))
    check(`${tag} stop: step 3 asks`, await untilAsk(stop, '3 · start the server'))
    check(`${tag} stop: nothing ran on the skipped step`, record.ran.join(',') === '1,2')
    stop.push(KEY.esc)
    check(`${tag} stop: esc stops and the dialog says what is done and what is not`, await waitFor(() => stop.screen().includes('stopped · nothing more runs · esc closes'), 4000))
    const flat = stop.lines().map(bodyOf).join('\n')
    check(`${tag} stop: the stopped step stays on screen as not run`, flat.includes('– not run · stopped here'))
    check(`${tag} stop: done, skipped and not done are listed by step`, flat.includes('done: 1 find a server, 2 find Ollama on this machine') && flat.includes('skipped: 2b install Ollama') && flat.includes('not done: 3 start the server, 4 choose the model, 4b pull the model'), flat.slice(-600))
    check(`${tag} stop: the consents were run, run, skip, stop`, record.consents.map(consent => consent.answer).join(',') === 'run,run,skip,stop')
    keep(`esc-summary-${tag}`, stop, cols, rows)
    stop.push(KEY.esc)
    check(`${tag} stop: a second esc closes`, await waitFor(() => popup.settingsPopupRequest() === null, 4000))
    stop.unmount()
  }
} finally {
  popup.closeSettingsPopup()
  if (dir) writeFileSync(join(dir, 'index.txt'), ['Source renders of the /localsetup dialog in the shared popup on a fixture road (no PTY, no network, no server): the LOCAL offer row of the model picker and the dialog its s key opens, the opening ask, the install offer after nothing was found, the model choice on a fresh server (the seven pulls sized for the box, the tested 9B a suggestion, nothing pre-chosen) before and after four ↓, the pull mid-way, the window words under step 6, the ready row, the model choice on a server already holding two models with the session\'s 27B marked current, the esc that keeps it, and the esc summary; 178x51 and 80x21.', ...frames].join('\n') + '\n')
  await releaseScratchHome(home)
}
console.log(`prove-local-setup-dialog: ${frames.length} frames; ${failures ? `${failures} FAILED` : 'ALL PASS'}`)
process.exit(failures ? 1 : 0)
