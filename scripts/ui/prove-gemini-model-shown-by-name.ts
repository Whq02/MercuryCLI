#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

const scratch = mkdtempSync(join(tmpdir(), 'gemini-model-shown-by-name-'))
const path = process.env.PATH ?? ''
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, {
  PATH: path,
  HOME: join(scratch, 'os-home'),
  MERCURY_CONFIG_DIR: scratch,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE: 'https://assist.fixture.invalid',
  GOOGLE_API_KEY: 'fixture-key',
})
mkdirSync(join(scratch, 'os-home'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { refreshGeminiCatalogue, __resetGeminiCatalogueForTest } = await import('../../src/models/roads/gemini/geminiCatalogue.ts')
const { resolveDisplayedSessionModel, useDisplayedSessionModel } = await import('../../src/screen/model-picker/useDisplayedSessionModel.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { render, Text, flushPendingSyncWork } = await import('../../src/screen/themedRenderer.ts')
type EngineConnectorV1 = import('../../src/engine/connector/types.ts').EngineConnectorV1

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} | to fix: the session card's model line and the status line both read useDisplayedSessionModel in src/screen/model-picker/useDisplayedSessionModel.ts (which must subscribe to useCatalogueEpoch) and renderModelChip -> getPublicModelDisplayName in src/models/catalogue/engineModel.ts (which must take the name Google's own list gives an exact row via geminiListedModel in src/models/roads/gemini/geminiCatalogue.ts)`}`)
}

const LISTED = [
  { name: 'models/gemini-4-hydrogen-medium', displayName: 'Gemini 4 Hydrogen (Medium)', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
  { name: 'models/gemini-4-hydrogen-high', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
]
const listing: typeof fetch = async () => new Response(JSON.stringify({ models: LISTED }), { status: 200, headers: { 'content-type': 'application/json' } })

let mounted: Awaited<ReturnType<typeof render>> | null = null
const stream = new PassThrough()
stream.resume()
try {
  console.log('a session on a Gemini model the build has no row for, shown on its card\'s model line and its status line')
  __resetGeminiCatalogueForTest()
  const before = resolveDisplayedSessionModel('gemini-4-hydrogen-medium')
  check('before the list has been read there is no name to show: the id stands', before.label === 'gemini-4-hydrogen-medium', before.label)
  const baseConnector = noSessionConnector()
  const standInConnector: EngineConnectorV1 = Object.assign(Object.create(Object.getPrototypeOf(baseConnector)), baseConnector, {
    modelFacts: () => ({ effective: 'gemini-4-hydrogen-medium', main: 'gemini-4-hydrogen-medium', setting: null, sessionPin: null, pendingSwitch: null }),
    subscribeModel: () => () => {},
  })
  setFocusedSessionConnector(standInConnector)
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    unref() { return this },
    ref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(stream, { columns: 100, rows: 10 }) as unknown as NodeJS.WriteStream
  function StatusRowReading(): React.ReactNode {
    return React.createElement(Text, null, useDisplayedSessionModel().compact)
  }
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  mounted = await render(React.createElement(StatusRowReading), { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  for (let tick = 0; tick < 4; tick++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  const mountedBefore = stripAnsi(mounted.lastFrame()).trim()
  const snapshot = await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: listing })
  check('the list is read from the stand-in, two models', snapshot !== null && snapshot.models.length === 2, JSON.stringify(snapshot?.models.map(model => model.id)))
  for (let tick = 0; tick < 6; tick++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  const mountedAfter = stripAnsi(mounted.lastFrame()).trim()
  check(
    'a mounted status-row reading flips from the raw id to the name when the list lands without any other redraw',
    mountedBefore === 'gemini-4-hydrogen-medium' && mountedAfter === 'Gemini 4 Hydrogen (Medium)',
    `before=${mountedBefore} · after=${mountedAfter}`,
  )
  mounted.unmount()
  mounted.cleanup()
  mounted = null
  setFocusedSessionConnector(noSessionConnector())
  const named = resolveDisplayedSessionModel('gemini-4-hydrogen-medium')
  check('the model the list names reads by that name', named.label === 'Gemini 4 Hydrogen (Medium)' && named.compact === 'Gemini 4 Hydrogen (Medium)', `${named.label} · ${named.compact}`)
  const unnamed = resolveDisplayedSessionModel('gemini-4-hydrogen-high')
  check('a model the list gives no name keeps its id: nothing is made up', unnamed.label === 'gemini-4-hydrogen-high', unnamed.label)
  const queued = resolveDisplayedSessionModel('gemini-4-hydrogen-high', { setting: 'gemini-4-hydrogen-medium' })
  check('a queued switch to it reads by the name too', queued.label === 'gemini-4-hydrogen-high → Gemini 4 Hydrogen (Medium) (queued)', queued.label)
  const elsewhere = resolveDisplayedSessionModel('gpt-9.9-ultra')
  check('a GPT id new to the build has its name as before', elsewhere.label === 'GPT-9.9 Ultra', elsewhere.label)
  delete process.env.GOOGLE_API_KEY
  writeFileSync(
    join(scratch, '.gemini-auth.json'),
    JSON.stringify({
      version: 1,
      preferredSource: 'plan',
      plan: {
        tokens: { accessToken: 'ya29.plan-fixture', refreshToken: '1//refresh-fixture', accessTokenExpiresAtMs: Date.now() + 3_600_000 },
        projectId: 'project-fixture-123',
        tier: { paid: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
        tierReadAtMs: Date.now(),
      },
    }),
  )
  __resetGeminiCatalogueForTest()
  const planListing: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        models: {
          'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 262144 },
          'gemini-4-hydrogen-xhigh': { displayName: 'Gemini 4 Hydrogen (XHigh)', supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 262144 },
        },
        imageGenerationModelIds: [],
        agentModelSorts: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  await refreshGeminiCatalogue('plan', { force: true, fetchImpl: planListing })
  const bareAlone = resolveDisplayedSessionModel('gemini-4-hydrogen')
  const bareRide = resolveDisplayedSessionModel('gemini-4-hydrogen', null, 'gemini-4-hydrogen-xhigh')
  const exactRow = resolveDisplayedSessionModel('gemini-4-hydrogen-xhigh')
  check(
    'on a plan roster whose -high row is named … (High), a bare id with no row of its own stays its id (alone and on a ride) while an exact row takes its name',
    bareAlone.compact === 'gemini-4-hydrogen' && bareRide.compact === 'gemini-4-hydrogen ▸ gemini-4-hydrogen-xhigh' && exactRow.compact === 'Gemini 4 Hydrogen (XHigh)',
    `${bareAlone.compact} · ${bareRide.compact} · ${exactRow.compact}`,
  )
} finally {
  if (mounted !== null) {
    mounted.unmount()
    mounted.cleanup()
  }
  stream.destroy()
  setFocusedSessionConnector(noSessionConnector())
  __resetGeminiCatalogueForTest()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ a Gemini model is shown by its name' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
