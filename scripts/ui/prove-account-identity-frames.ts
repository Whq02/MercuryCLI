import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const framesDir = argument('--frames')
const compareDir = argument('--compare-shown')
const surface = argument('--surface')
if (framesDir !== undefined) mkdirSync(framesDir, { recursive: true })
const HOME = mkdtempSync(join(tmpdir(), 'identity-frames-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|XAI_|META_|MODEL_API_KEY$|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
delete process.env.NODE_ENV
Object.assign(process.env, {
  HOME,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_AUTH_SCOPE_DIR: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_REDUCED_MOTION: '1',
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const NOW = 1_800_000_000_000
const originalNow = Date.now
Date.now = () => NOW
const originalFetch = globalThis.fetch
const requests: string[] = []
globalThis.fetch = (async input => {
  requests.push(String(input))
  throw new Error('identity source renders never contact a provider')
}) as typeof fetch
const EMAIL = 'identity-fixture@example.com'
const USERNAME = 'identity-hub-user'
const MODEL = 'claude-fable-5-1'
const json = (file: string, value: unknown): void => writeFileSync(join(HOME, file), JSON.stringify(value) + '\n', { mode: 0o600 })
json('.credentials.json', { claudeAiOauth: {
  accessToken: 'fixture-identity-access-token',
  refreshToken: 'fixture-identity-refresh-token',
  expiresAt: NOW + 86_400_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  tokenAccount: { uuid: 'fixture-identity-account', emailAddress: EMAIL },
} })
json('.huggingface-auth.json', { version: 1, tokens: { accessToken: 'fixture-hub-access-token', refreshToken: 'fixture-hub-refresh-token', accessTokenExpiresAtMs: NOW + 86_400_000 }, identity: { username: USERNAME, observedAtMs: NOW } })
json('settings.json', { engine: { model: MODEL } })
const config = await import(join(ROOT, 'src/utils/config.ts'))
config.enableConfigs()
const { resetSettingsCache } = await import(join(ROOT, 'src/utils/settings/settingsCache.ts'))
const { accountIdentityShown } = await import(join(ROOT, 'src/services/wallet/identityWords.ts'))
const { signInLedgerEpoch } = await import(join(ROOT, 'src/utils/accounts/signInLedger.ts'))
const { catalogueEpoch } = await import(join(ROOT, 'src/services/providers/catalogueEpoch.ts'))
async function stub(relative: string, overrides: Record<string, unknown>): Promise<void> {
  const path = join(ROOT, relative)
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...overrides }))
}
await stub('src/hooks/useExitOnCtrlCD.ts', { useExitOnCtrlCD: () => undefined })
await stub('src/keybindings/useKeybinding.ts', { useKeybinding: () => undefined, useKeybindings: () => undefined })
await stub('src/context/notifications.tsx', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('src/services/providers/anthropic/anthropicCatalogue.ts', { refreshAnthropicCatalogue: async () => [] })
await stub('src/services/providers/huggingface/huggingfaceCatalogue.ts', { refreshHuggingfaceCatalogue: async () => null })
const ink = await import(join(ROOT, 'src/ink.ts'))
const { default: StdinContext } = await import(join(ROOT, 'src/ink/components/StdinContext.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const picker = await import(join(ROOT, 'src/commands/model/mercuryModel.tsx'))
type Leg = 'absent' | 'shown' | 'hidden'
const setting: Record<Leg, boolean | undefined> = { absent: undefined, shown: true, hidden: false }
let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
function setLeg(leg: Leg): void {
  json('settings.json', { engine: { model: MODEL }, ...(setting[leg] === undefined ? {} : { view: { accountIdentity: setting[leg] } }) })
  resetSettingsCache()
  check(`${leg}: the real settings reader sees visibility`, accountIdentityShown() === (leg !== 'hidden'))
}
async function paint(content: React.ReactNode, columns: number, rows: number): Promise<{ final: string; frames: string[] }> {
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows, isTTY: true }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: new ink.EventEmitter(), internal_querier: null }
  const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(ink.Box, { width: columns, height: rows, flexDirection: 'column' }, content))
  const frames: string[] = []
  let instance: Awaited<ReturnType<typeof ink.render>> | undefined
  const frame = (): string => stripAnsi(instance!.lastFrame()).replace(/\n$/, '')
  let painted = (): void => {}
  const firstFrame = new Promise<void>(done => { painted = done })
  instance = await ink.render(node, { stdout, stdin, patchConsole: false, exitOnCtrlC: false, onFrame: () => { painted(); queueMicrotask(() => { if (instance !== undefined) frames.push(frame()) }) } })
  await firstFrame
  for (let tick = 0; tick < 8; tick++) {
    ink.flushPendingSyncWork()
    await new Promise<void>(done => setTimeout(done, 5))
  }
  const final = frame()
  frames.push(final)
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return { final, frames }
}
function save(name: string, frame: string): void {
  if (framesDir !== undefined) writeFileSync(join(framesDir, `${name}.txt`), frame + '\n')
  if (compareDir !== undefined && !name.includes('hidden')) check(`${name}: shown bytes equal the base source render`, frame + '\n' === readFileSync(join(compareDir, `${name}.txt`), 'utf8'))
}

try {
  if (surface === undefined || surface === 'model') {
    const warm = await picker.call(() => {}, { messages: [] } as never, '')
    await paint(React.createElement(AppStateProvider, null, warm), 178, 51)
    const snapshots = new Map<string, string>()
    for (const size of [{ columns: 178, rows: 51 }, { columns: 100, rows: 30 }]) {
      for (const leg of ['absent', 'shown', 'hidden', 'shown', 'hidden'] as Leg[]) {
        setLeg(leg)
        const before = `${signInLedgerEpoch()}|${catalogueEpoch()}`
        const body = await picker.call(() => {}, { messages: [] } as never, '')
        const painted = await paint(React.createElement(AppStateProvider, null, body), size.columns, size.rows)
        const stamp = `model-${leg}-${size.columns}x${size.rows}`
        save(stamp, painted.final)
        check(`${stamp}: credential and catalogue epochs did not change`, before === `${signInLedgerEpoch()}|${catalogueEpoch()}`)
        check(`${stamp}: real model screen and account door painted`, painted.final.includes('Mercury') && painted.final.includes('model') && painted.final.includes('Claude Max login'), painted.final)
        if (leg === 'hidden') {
          check(`${stamp}: no frame retains the signed-in address after hiding`, painted.frames.every(frame => !frame.includes(EMAIL) && !frame.includes('identity-fixture@')), painted.final.split('\n').find(line => line.includes('ANTHROPIC')))
        } else {
          check(`${stamp}: the shown address remains on the screen`, painted.final.includes(EMAIL), painted.final.split('\n').find(line => line.includes('ANTHROPIC')))
          if (leg === 'shown') check(`${stamp}: true is byte-identical to absent`, painted.final === snapshots.get(`${size.columns}`))
          else snapshots.set(`${size.columns}`, painted.final)
        }
      }
    }
  }
  if (surface === undefined || surface === 'submodels') {
    const { SubModelPicker } = await import(join(ROOT, 'src/components/SubModelPicker.tsx'))
    const { composeSubModelRegistry } = await import(join(ROOT, 'src/utils/model/subModelSlots.ts'))
    const model = composeSubModelRegistry().entries.find((entry: { source: string; kind: string }) => entry.source === 'huggingface' && entry.kind === 'model')
    check('the real submodel registry has a signed-in Hugging Face model', model !== undefined)
    let absent = ''
    for (const leg of ['absent', 'shown', 'hidden'] as Leg[]) {
      setLeg(leg)
      const painted = await paint(React.createElement(SubModelPicker, { onClose() {}, onRoute() {}, initialModelId: model?.modelId }), 178, 51)
      save(`submodels-${leg}`, painted.final)
      check(`submodels-${leg}: the account word stays`, painted.final.includes('Hugging Face account'), painted.final)
      if (leg === 'hidden') check('submodels-hidden: no frame shows the signed-in username', painted.frames.every(frame => !frame.includes(USERNAME)), painted.final)
      else {
        check(`submodels-${leg}: the signed-in username is present`, painted.final.includes(USERNAME), painted.final)
        if (leg === 'absent') absent = painted.final
        else check('submodels-shown: true is byte-identical to absent', absent === painted.final)
      }
    }
  }
  if (surface === undefined || surface === 'config') {
    const { Config } = await import(join(ROOT, 'src/components/Settings/Config.tsx'))
    const { ThemeProvider } = await import(join(ROOT, 'src/components/design-system/ThemeProvider.tsx'))
    let absent = ''
    for (const leg of ['absent', 'shown', 'hidden'] as Leg[]) {
      setLeg(leg)
      const body = React.createElement(AppStateProvider, null, React.createElement(ThemeProvider, null, React.createElement(Config, { onClose() {}, context: { messages: [], options: {} } as never, width: 118, contentHeight: 120 })))
      const painted = await paint(body, 120, 124)
      const accountRows = painted.final.split('\n').filter(line => /Hugging Face account/.test(line)).join('\n')
      save(`config-${leg}`, accountRows)
      check(`config-${leg}: the provider account row painted`, accountRows.includes('Hugging Face account'), painted.final)
      if (leg === 'hidden') check('config-hidden: no frame shows the signed-in username', painted.frames.every(frame => !frame.includes(USERNAME)), accountRows)
      else {
        check(`config-${leg}: the signed-in username is present`, accountRows.includes(USERNAME), accountRows)
        if (leg === 'absent') absent = accountRows
        else check('config-shown: the account row is byte-identical to absent', absent === accountRows)
      }
    }
  }
  check('no provider request was attempted', requests.length === 0, JSON.stringify(requests))
} finally {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  rmSync(HOME, { recursive: true, force: true })
}
console.log(`account identity frames: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
