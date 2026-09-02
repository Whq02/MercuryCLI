#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-face-logins.ts — the boot face's OWN Logins door
//  (the operator's ruling: the full sign-in
//  catalogue lives on the Boot face in its own container — never the chat —
//  while /logins and every flow share ONE home).
//
//    §1 THE ANTHROPIC MACHINE (A1) — anthropicLoginModel walked whole with
//       a fake service, fake credential writes and synchronous beats: both
//       arms (claude.ai · console mint), the setup-token arm, the forced
//       method/org reads, the manual-code law, the retry topology, the
//       paste-prompt and copy beats, dispose. NO live OAuth, browser, key
//       or network anywhere — the injected seams ARE the proof surface.
//    §2 ONE MACHINE, MANY SKINS (identity both directions) — the flow
//       sentences and the success notice live in the model and NOWHERE in
//       the in-chat skin; the skin consumes the model and no longer touches
//       the OAuth service or the credential writers; the model reaches no
//       route verb and no notification queue (provider-optionality is
//       structural — the Boot face mounts outside the AppState provider).
//  cpu-pure: no PTY, no daemon, no boot, no network, no timers left armed.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

// Env pins BEFORE the dynamic imports; a scratch
// config home so no live estate is ever read by module init.
process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'face-logins-prove-'))
process.env['FORCE_COLOR'] = '0'

const {
  COPY_ACK_MS,
  EXCHANGE_RETRY_ERROR,
  LOGIN_SUCCESS_NOTICE,
  MANUAL_CODE_ERROR,
  MINT_NO_KEY_ERROR,
  PASTE_PROMPT_DELAY_MS,
  RETRY_DELAY_MS,
  TOKEN_FINISH_MS,
  createAnthropicLoginMachine,
  exchangeFailureMessage,
  parseManualAuthCode,
  sslHint,
} = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.js')
type Machine = ReturnType<typeof createAnthropicLoginMachine>
type Snapshot = ReturnType<Machine['snapshot']>
type Deps = NonNullable<Parameters<typeof createAnthropicLoginMachine>[2]>

// ── the beat bed: injected timers drained by hand, in arm order ────────────
function beatBed(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  run: (label?: string) => Array<{ ms: number }>
  pending: () => number
} {
  const armed: Array<{ fn: () => void; ms: number } | null> = []
  return {
    setTimer(fn, ms) {
      const handle = { fn, ms }
      armed.push(handle)
      return handle
    },
    clearTimer(handle) {
      const at = armed.indexOf(handle as { fn: () => void; ms: number })
      if (at !== -1) armed[at] = null
    },
    run() {
      const fired: Array<{ ms: number }> = []
      // Drain what is armed NOW (a beat may arm the next; that one waits
      // for the next run — the walk drives beat by beat).
      const batch = armed.splice(0, armed.length)
      for (const entry of batch) {
        if (entry === null) continue
        fired.push({ ms: entry.ms })
        entry.fn()
      }
      return fired
    },
    pending: () => armed.filter(entry => entry !== null).length,
  }
}

const settle = async (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// ── the fake service + the credential-write ledger ─────────────────────────
interface FakeWorld {
  services: Array<{
    opts: Record<string, unknown>
    urlCb: (url: string, manualUrl?: string) => void
    resolve: (tokens: { accessToken: string; scopes: string[] }) => void
    reject: (error: unknown) => void
    manualInputs: Array<{ authorizationCode: string; state: string }>
    cleanedUp: boolean
  }>
  saved: Array<{ accessToken: string }>
  minted: string[]
  recorded: number
  notices: Array<typeof LOGIN_SUCCESS_NOTICE>
  clipboard: string[]
  stdout: string[]
  logged: unknown[]
  orgValidated: number
}

function fakeDeps(
  bed: ReturnType<typeof beatBed>,
  over: Partial<{
    claudeAiScopes: boolean
    mintAnswer: unknown
    orgAnswer: unknown
    settings: { forceLoginMethod?: 'claudeai' | 'console'; forceLoginOrgUUID?: string }
    notify: boolean
  }> = {},
): { deps: Deps; world: FakeWorld } {
  const world: FakeWorld = {
    services: [],
    saved: [],
    minted: [],
    recorded: 0,
    notices: [],
    clipboard: [],
    stdout: [],
    logged: [],
    orgValidated: 0,
  }
  const deps: Deps = {
    createService: () => {
      const entry: FakeWorld['services'][number] = {
        opts: {},
        urlCb: () => {},
        resolve: () => {},
        reject: () => {},
        manualInputs: [],
        cleanedUp: false,
      }
      world.services.push(entry)
      return {
        startOAuthFlow(urlCallback, options) {
          entry.opts = options as Record<string, unknown>
          entry.urlCb = urlCallback
          return new Promise((resolve, reject) => {
            entry.resolve = resolve as typeof entry.resolve
            entry.reject = reject
          })
        },
        handleManualAuthCodeInput(input) {
          entry.manualInputs.push(input)
        },
        cleanup() {
          entry.cleanedUp = true
        },
      }
    },
    // The save-truth contract (B1): the settle gates on {success}; the
    // fake reports a landed save like the real storage does.
    saveTokens: tokens => {
      world.saved.push({ accessToken: tokens.accessToken })
      return { success: true }
    },
    usesClaudeAiAuth: () => over.claudeAiScopes !== false,
    mintApiKey: async () => over.mintAnswer,
    validateOrg: async () => {
      world.orgValidated++
      return over.orgAnswer
    },
    accountInfo: () => ({ emailAddress: 'op@example.test' }),
    shadowWarning: () => 'AN ENV TOKEN SHADOWS THIS SIGN-IN',
    recordSignIn: () => void world.recorded++,
    settings: () => over.settings ?? {},
    ...(over.notify === false ? {} : { notify: notice => void world.notices.push(notice) }),
    clipboard: async text => {
      world.clipboard.push(text)
      return 'OSC52'
    },
    writeStdout: sequence => void world.stdout.push(sequence),
    log: error => void world.logged.push(error),
    setTimer: bed.setTimer,
    clearTimer: bed.clearTimer,
  }
  return { deps, world }
}

function machineOf(
  bed: ReturnType<typeof beatBed>,
  over: Parameters<typeof fakeDeps>[1] = {},
  options: Partial<{ mode: 'login' | 'setup-token'; forceLoginMethod: 'claudeai' | 'console'; onDone: () => void }> = {},
): { m: Machine; world: FakeWorld; states: string[]; snaps: Snapshot[]; doneCount: () => number } {
  const { deps, world } = fakeDeps(bed, over)
  const states: string[] = []
  const snaps: Snapshot[] = []
  let done = 0
  const m = createAnthropicLoginMachine(
    {
      onDone: options.onDone ?? (() => void done++),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.forceLoginMethod !== undefined ? { forceLoginMethod: options.forceLoginMethod } : {}),
    },
    snapshot => {
      states.push(snapshot.flow.name)
      snaps.push(snapshot)
    },
    deps,
  )
  return { m, world, states, snaps, doneCount: () => done }
}

t.section('§1 — THE ANTHROPIC MACHINE (both arms · setup-token · retry · beats; fakes only)')
{
  // W1 — the claude.ai arm, whole: idle → start → ready → 0-beat →
  // waiting (manual URL wins) → 3s paste beat → tokens → success.
  const bed = beatBed()
  const { m, world, states } = machineOf(bed)
  t.check('born idle with no forced method', m.snapshot().flow.name === 'idle')
  m.wake()
  t.check('wake() on an idle-born machine arms nothing', bed.pending() === 0)
  m.start(true)
  t.check('start(true) lands ready and arms the one 0-beat', m.snapshot().flow.name === 'ready' && bed.pending() === 1)
  const fired = bed.run()
  t.check('the ready beat is the 0-tick flow start', fired.length === 1 && fired[0]!.ms === 0 && world.services.length === 1)
  t.check('the service rides the claude.ai options (no inferenceOnly, no org, no method)', world.services[0]!.opts['loginWithClaudeAi'] === true && !('inferenceOnly' in world.services[0]!.opts) && !('orgUUID' in world.services[0]!.opts) && !('loginMethod' in world.services[0]!.opts))
  world.services[0]!.urlCb('auto-url', 'manual-url')
  const waiting = m.snapshot()
  t.check('the url callback lands waiting on the MANUAL url with the prompt DOWN', waiting.flow.name === 'waiting' && (waiting.flow as { url: string }).url === 'manual-url' && waiting.pastePromptUp === false)
  t.check('the paste prompt waits its own 3s beat', bed.run().some(b => b.ms === PASTE_PROMPT_DELAY_MS) && m.snapshot().pastePromptUp === true)
  world.services[0]!.resolve({ accessToken: 'at-1', scopes: ['claude'] })
  await settle()
  const success = m.snapshot()
  t.check('the settle saves tokens, mints NOTHING, records the first login, notifies once and lands success', success.flow.name === 'success' && world.saved.length === 1 && world.minted.length === 0 && world.recorded === 1 && world.notices.length === 1 && world.notices[0] === LOGIN_SUCCESS_NOTICE)
  t.check('the success facts ride the snapshot (shadow warning · account label)', success.shadowWarning === 'AN ENV TOKEN SHADOWS THIS SIGN-IN' && success.accountLabel === 'op@example.test')
  t.check('creating-key never painted on the claude.ai arm', !states.includes('creating-key'), states.join('→'))

  // W2 — the console arm: non-claude.ai scopes mint behind creating-key.
  const bed2 = beatBed()
  const m2 = machineOf(bed2, { claudeAiScopes: false, mintAnswer: { ok: true } })
  m2.m.start(false)
  bed2.run()
  m2.world.services[0]!.urlCb('auto-2')
  t.check('a missing manual url falls back to the auto url', (m2.m.snapshot().flow as { url?: string }).url === 'auto-2')
  m2.world.services[0]!.resolve({ accessToken: 'at-2', scopes: ['console'] })
  await settle()
  t.check('console scopes paint creating-key then success (the mint ran)', m2.states.includes('creating-key') && m2.m.snapshot().flow.name === 'success', m2.states.join('→'))

  // W3 — the mint law: a keyless mint answer is the ERROR sentence, no retry.
  const bed3 = beatBed()
  const m3 = machineOf(bed3, { claudeAiScopes: false, mintAnswer: null })
  m3.m.start(false)
  bed3.run()
  m3.world.services[0]!.urlCb('u')
  m3.world.services[0]!.resolve({ accessToken: 'at-3', scopes: [] })
  await settle()
  const mintErr = m3.m.snapshot().flow
  t.check('the keyless mint lands the MINT_NO_KEY sentence with NO retry', mintErr.name === 'error' && (mintErr as { message: string }).message === MINT_NO_KEY_ERROR && (mintErr as { retry?: unknown }).retry === undefined)

  // W4 — the forced org: validated exactly when configured; invalid refuses
  // with the validator's own reason.
  const bed4 = beatBed()
  const m4 = machineOf(bed4, {
    orgAnswer: { valid: false, reason: 'not a member of the configured organisation' },
    settings: { forceLoginOrgUUID: 'org-1' },
  })
  m4.m.start(true)
  bed4.run()
  t.check('the forced org rides the flow options', m4.world.services[0]!.opts['orgUUID'] === 'org-1')
  m4.world.services[0]!.urlCb('u')
  m4.world.services[0]!.resolve({ accessToken: 'at-4', scopes: ['claude'] })
  await settle()
  t.check('an invalid org refuses with the validator reason (validated once)', m4.world.orgValidated === 1 && m4.m.snapshot().flow.name === 'error' && (m4.m.snapshot().flow as { message: string }).message === 'not a member of the configured organisation')
  t.check('W1 never validated an org (none configured)', world.orgValidated === 0)

  // W5 — exchange failure AFTER waiting: the canned sentence; retry is the
  // WAITING screen, restored whole by the 1s beat.
  const bed5 = beatBed()
  const m5 = machineOf(bed5)
  m5.m.start(true)
  bed5.run()
  m5.world.services[0]!.urlCb('the-url')
  m5.world.services[0]!.reject(new Error('token exchange refused'))
  await settle()
  const err5 = m5.m.snapshot().flow
  t.check('the exchange failure speaks the canned retry sentence and logs', err5.name === 'error' && (err5 as { message: string }).message === EXCHANGE_RETRY_ERROR && m5.world.logged.length === 1)
  m5.m.retry()
  t.check('↵ retry paints about-to-retry', m5.m.snapshot().flow.name === 'about-to-retry')
  t.check('the retry beat is the 1s beat back to the stored WAITING screen (no new service)', bed5.run().some(b => b.ms === RETRY_DELAY_MS) && m5.m.snapshot().flow.name === 'waiting' && (m5.m.snapshot().flow as { url: string }).url === 'the-url' && m5.world.services.length === 1)

  // W6 — failure BEFORE waiting: retry = ready; the landing re-arms a
  // SECOND flow start (a fresh service).
  const bed6 = beatBed()
  const m6 = machineOf(bed6)
  m6.m.start(true)
  bed6.run()
  m6.world.services[0]!.reject(new Error('bind failed'))
  await settle()
  const err6 = m6.m.snapshot().flow
  t.check('a pre-waiting failure speaks itself with ready as the retry', err6.name === 'error' && (err6 as { message: string }).message === 'bind failed' && ((err6 as { retry?: { name: string } }).retry?.name === 'ready'))
  m6.m.retry()
  bed6.run() // the 1s beat → ready (re-arms the 0-beat)
  bed6.run() // the 0-beat → the second service
  t.check('the ready retry starts a FRESH flow (second service created)', m6.world.services.length === 2)

  // W7 — the SSL hint outranks the canned sentence.
  t.check('sslHint names the proxy remedy on certificate errors and stays quiet otherwise', (sslHint(new Error('self-signed certificate in chain')) ?? '').includes('NODE_EXTRA_CA_CERTS') && sslHint(new Error('plain refusal')) === null)
  t.check('exchangeFailureMessage: hint > canned > verbatim', (exchangeFailureMessage(new Error('TLS handshake broke')) ?? '').includes('NODE_EXTRA_CA_CERTS') && exchangeFailureMessage(new Error('the exchange died')) === EXCHANGE_RETRY_ERROR && exchangeFailureMessage(new Error('something else')) === 'something else')

  // W8 — the setup-token arm: born ready; wake() arms it; inferenceOnly +
  // the one-year expiry ride the options; the token lands on the success
  // screen; NOTHING is saved/recorded/notified; onDone auto-fires on the
  // 500ms beat.
  const bed8 = beatBed()
  const m8 = machineOf(bed8, {}, { mode: 'setup-token' })
  t.check('setup-token is born ready (claude.ai account type)', m8.m.snapshot().flow.name === 'ready' && (m8.m.snapshot().flow as { loginWithClaudeAi: boolean }).loginWithClaudeAi === true)
  m8.m.wake()
  bed8.run()
  t.check('the token flow asks inferenceOnly with the one-year expiry', m8.world.services[0]!.opts['inferenceOnly'] === true && m8.world.services[0]!.opts['expiresIn'] === 365 * 24 * 60 * 60)
  m8.world.services[0]!.urlCb('u8')
  m8.world.services[0]!.resolve({ accessToken: 'the-minted-token', scopes: [] })
  await settle()
  const tok = m8.m.snapshot().flow
  t.check('the minted token paints on success and is NEVER saved, recorded or notified', tok.name === 'success' && (tok as { token?: string }).token === 'the-minted-token' && m8.world.saved.length === 0 && m8.world.recorded === 0 && m8.world.notices.length === 0)
  t.check('the auto-finish is the 500ms beat', m8.doneCount() === 0 && bed8.run().some(b => b.ms === TOKEN_FINISH_MS) && m8.doneCount() === 1)

  // W9 — the settings-forced method: born ready on the console arm; the
  // method rides the options and the waiting snapshot.
  const bed9 = beatBed()
  const m9 = machineOf(bed9, { settings: { forceLoginMethod: 'console' } })
  t.check('a settings-forced console method is born ready on the console arm', m9.m.snapshot().flow.name === 'ready' && (m9.m.snapshot().flow as { loginWithClaudeAi: boolean }).loginWithClaudeAi === false)
  m9.m.wake()
  bed9.run()
  m9.world.services[0]!.urlCb('u9')
  t.check('the forced method rides the options and the waiting screen', m9.world.services[0]!.opts['loginMethod'] === 'console' && (m9.m.snapshot().flow as { forcedMethod: string | null }).forcedMethod === 'console')

  // W10 — the manual-code law + submit.
  t.check('parseManualAuthCode refuses either missing half with the one sentence', !parseManualAuthCode('just-a-code').ok && !parseManualAuthCode('#state-only').ok && !parseManualAuthCode('  ').ok && (parseManualAuthCode('x') as { message: string }).message === MANUAL_CODE_ERROR)
  const good = parseManualAuthCode('  the-code#the-state  ')
  t.check('a whole code splits into its halves, trimmed', good.ok && good.authorizationCode === 'the-code' && good.state === 'the-state')
  const bed10 = beatBed()
  const m10 = machineOf(bed10)
  m10.m.start(true)
  bed10.run()
  m10.world.services[0]!.urlCb('u10')
  t.check('a torn paste answers false and lands the error with the WAITING retry', m10.m.submitCode('torn') === false && m10.m.snapshot().flow.name === 'error' && ((m10.m.snapshot().flow as { retry?: { name: string } }).retry?.name === 'waiting'))
  m10.m.retry()
  bed10.run()
  t.check('a whole paste reaches the pending service and answers true', m10.m.submitCode('code#state') === true && m10.world.services[0]!.manualInputs.length === 1 && m10.world.services[0]!.manualInputs[0]!.authorizationCode === 'code' && m10.world.services[0]!.manualInputs[0]!.state === 'state')

  // W11 — the copy beat: clipboard + OSC write + the 2s ack.
  const bed11 = beatBed()
  const m11 = machineOf(bed11)
  m11.m.copyUrl()
  await settle()
  t.check('copyUrl outside waiting touches nothing', m11.world.clipboard.length === 0)
  m11.m.start(true)
  bed11.run()
  m11.world.services[0]!.urlCb('copy-me')
  m11.m.copyUrl()
  await settle()
  t.check('copyUrl writes the URL through the clipboard seam and paints the ack', m11.world.clipboard[0] === 'copy-me' && m11.world.stdout[0] === 'OSC52' && m11.m.snapshot().copied === true)
  t.check('the ack clears on its own 2s beat', bed11.run().some(b => b.ms === COPY_ACK_MS) && m11.m.snapshot().copied === false)

  // W12 — dispose: the pending service is released; armed beats die; a
  // disposed machine publishes nothing.
  const bed12 = beatBed()
  const m12 = machineOf(bed12)
  m12.m.start(true)
  bed12.run()
  m12.world.services[0]!.urlCb('u12')
  const statesBefore = m12.states.length
  m12.m.dispose()
  t.check('dispose cleans the pending service up and clears every beat', m12.world.services[0]!.cleanedUp === true && bed12.pending() === 0)
  m12.world.services[0]!.resolve({ accessToken: 'late', scopes: ['claude'] })
  await settle()
  t.check('a settle after dispose publishes NOTHING (no success, nothing recorded)', m12.states.length === statesBefore && m12.world.recorded === 0)

  // W13 — idle guards: submit/retry answer without state damage off their
  // screens.
  const bed13 = beatBed()
  const m13 = machineOf(bed13)
  t.check('submitCode and retry are inert off their screens', m13.m.submitCode('a#b') === false && (m13.m.retry(), m13.m.snapshot().flow.name === 'idle'))

  // The provider-optional law, behaviorally: a machine with NO notify
  // channel settles a sign-in whole.
  const bed14 = beatBed()
  const m14 = machineOf(bed14, { notify: false })
  m14.m.start(true)
  bed14.run()
  m14.world.services[0]!.urlCb('u14')
  m14.world.services[0]!.resolve({ accessToken: 'at-14', scopes: ['claude'] })
  await settle()
  t.check('NO notify channel: the sign-in still settles whole (success · recorded · saved)', m14.m.snapshot().flow.name === 'success' && m14.world.recorded === 1 && m14.world.saved.length === 1 && m14.world.notices.length === 0)
}

t.section('§2 — ONE MACHINE, MANY SKINS (identity both directions; provider-optional structurally)')
{
  const model = read('src/components/mercury-ui/screens/anthropicLoginModel.ts')
  const skin = read('src/components/ConsoleOAuthFlow.tsx')

  // The sentences live in the MODEL…
  t.check('the model carries the manual-code sentence', model.includes('That is not the full code — copy the complete authorization code'))
  t.check('the model carries the mint law sentence', model.includes('the server accepted the API key request but returned no key'))
  t.check('the model carries the exchange retry sentence and the SSL remedy', model.includes('The token exchange failed — try again.') && model.includes('NODE_EXTRA_CA_CERTS'))
  t.check("the model carries the success notice ('login-success' · Signed in)", model.includes("key: 'login-success'") && model.includes("text: 'Signed in'"))
  // …and the SKIN retains none of them.
  t.check('the skin retains NO flow sentence', !skin.includes('not the full code') && !skin.includes('returned no key') && !skin.includes('token exchange failed') && !skin.includes('login-success'), 'a sentence is spelled twice')

  // The skin consumes the machine; the machinery is GONE from it.
  t.check('the skin consumes the one machine', skin.includes("from './mercury-ui/screens/anthropicLoginModel.js'") && skin.includes('useAnthropicLoginModel('))
  t.check('the OAuth service and the credential writers are GONE from the skin', !skin.includes('OAuthService') && !skin.includes('createAndStoreApiKey') && !skin.includes('saveOAuthTokensIfNeeded') && !skin.includes('shouldUseClaudeAIAuth') && !skin.includes('validateForceLoginOrg') && !skin.includes('setClipboard'))
  t.check('no sign-in record lives in the skin — the sign-in ledger records at the drivers, the machine records the anthropic arms, the first-login law is gone', !skin.includes('recordFirstLoginDefaultProvider') && !skin.includes('recordSignIn') && skin.includes('const settleLeg'))

  // Provider-optionality is STRUCTURAL: the model never touches the
  // notification queue or the AppState store; the queue is the in-chat
  // skin's own injection. And the model reaches no route verb — a login
  // machine can never move the surface.
  t.check('the model imports NO notification queue and NO AppState', !model.includes('context/notifications') && !model.includes('state/AppState'))
  t.check('the model reaches no route verb', !model.includes('surfaceRoute') && !model.includes('enterRootRepl'))
  t.check('the in-chat skin hands its queue through the notify seam', skin.includes('notify: notice => addNotification(notice)'))

  // The machine's timers are seams (no bare setTimeout in the model body
  // outside the live-deps defaults) — the walk above ran them by hand.
  const modelBody = model.slice(model.indexOf('export function createAnthropicLoginMachine'))
  t.check('the machine body owns no bare timer (beats ride the injected seam)', !modelBody.includes('setTimeout(') && !modelBody.includes('clearTimeout('))
}

t.section('§3 — THE HUGGING FACE DRIVER (A2: the RFC 8628 machine out of the component, moonshotLogin-shaped)')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { runHuggingfaceDeviceLogin, storeHuggingfaceTokenLogin } = await import(
    '../../src/services/providers/huggingface/huggingfaceLogin.js'
  )
  const { huggingfaceStoredTokens, huggingfaceStoredTokenIdentity } = await import(
    '../../src/services/providers/huggingface/huggingfaceAccounts.js'
  )

  const ENV = {
    MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'test-client',
    MERCURY_HUGGINGFACE_HUB_BASE: 'https://hub.test',
  } as NodeJS.ProcessEnv
  const json = (status: number, body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const START_OK = {
    device_code: 'dev-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://hub.test/activate',
    verification_uri_complete: 'https://hub.test/activate?user_code=ABCD-1234',
    interval: 1,
    expires_in: 300,
  }

  // A scripted Hub: the device start answers once; each poll answer comes
  // off the queue; whoami answers last. (Routes by endpoint suffix.)
  const hubOf = (script: {
    start?: Response
    polls?: Array<Response | 'throw'>
    whoami?: Response | 'throw'
  }): { fetchImpl: typeof fetch; hits: string[] } => {
    const polls = [...(script.polls ?? [])]
    const hits: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      hits.push(url.replace('https://hub.test', ''))
      if (url.endsWith('/oauth/device')) return script.start ?? json(200, START_OK)
      if (url.endsWith('/oauth/token')) {
        const next = polls.shift()
        if (next === 'throw') throw new Error('socket hangup')
        return next ?? json(400, { error: 'authorization_pending' })
      }
      if (url.endsWith('/api/whoami-v2')) {
        if (script.whoami === 'throw') throw new Error('whoami unreachable')
        return script.whoami ?? json(200, { name: 'op-hf' })
      }
      throw new Error(`unscripted endpoint: ${url}`)
    }) as typeof fetch
    return { fetchImpl, hits }
  }

  // D1 — the whole happy road THROUGH mid-flight faults: pending →
  // slow-down (+5s per RFC) → a transport fault (named, never settling) →
  // authorized; whoami proves; tokens land in the scratch store; the
  // catalogue kick is the injected seam; the receipt says all of it.
  const slept: number[] = []
  const events: string[] = []
  const d1 = await runHuggingfaceDeviceLogin({
    io: { env: ENV, fetchImpl: hubOf({
      polls: [json(400, { error: 'authorization_pending' }), json(400, { error: 'slow_down' }), 'throw', json(200, { access_token: 'hf-at-1', refresh_token: 'hf-rt-1', expires_in: 3600 })],
    }).fetchImpl },
    sleep: async ms => void slept.push(ms),
    onEvent: e => void events.push(e.phase === 'waiting' ? `waiting:${e.polls}${e.note !== undefined ? ':note' : ''}` : e.phase),
    refreshCatalogue: async () => ({ models: [1, 2] }),
  })
  t.check('D1 settles ok with the whoami identity', d1.ok === true && (d1 as { username: string | null }).username === 'op-hf')
  t.check('D1 walked starting → waiting beats (fault NOTED, never settled) → finishing', events.join(' ') === 'starting waiting:0 waiting:1 waiting:2 waiting:3:note finishing', events.join(' '))
  t.check('D1 honored the RFC slow-down (+5s on the later sleeps)', JSON.stringify(slept) === JSON.stringify([1000, 1000, 6000, 6000]), JSON.stringify(slept))
  t.check('D1 stored the tokens (the scratch auth store holds them)', huggingfaceStoredTokens()?.accessToken === 'hf-at-1')
  t.check("D1's receipt: connected-as · refresh stored · live catalogue · the unverified-dispatch honesty", d1.receipt.includes('connected as op-hf') && d1.receipt.includes('refresh token stored') && d1.receipt.includes('live catalogue: 2 model(s)') && d1.receipt.includes('until the first live turn settles'))

  // D2 — cancellation between polls: the cancelled outcome, nothing stored.
  let cancelFlag = false
  const d2 = await runHuggingfaceDeviceLogin({
    io: { env: ENV, fetchImpl: hubOf({ polls: [json(400, { error: 'authorization_pending' })] }).fetchImpl },
    sleep: async () => void (cancelFlag = true),
    cancelled: () => cancelFlag,
  })
  t.check('D2 cancellation answers the cancelled outcome (nothing stored)', d2.ok === false && (d2 as { code: string }).code === 'cancelled' && d2.receipt === 'Hugging Face sign-in cancelled — nothing stored.')

  // D3 — the code expires before entry (the clock, not a poll, says so).
  let clock = 1_000_000
  const d3 = await runHuggingfaceDeviceLogin({
    io: { env: ENV, now: () => clock, fetchImpl: hubOf({}).fetchImpl },
    sleep: async () => void (clock += 400_000),
  })
  t.check('D3 the expiry clock refuses with the retry road named', d3.ok === false && (d3 as { code: string }).code === 'expired' && d3.receipt.includes('expired before the code was entered'))

  // D4 — the denied family: the Hub page's deny · an expired_token poll ·
  // a foreign refusal with its description carried verbatim.
  const denied = await runHuggingfaceDeviceLogin({ io: { env: ENV, fetchImpl: hubOf({ polls: [json(400, { error: 'access_denied' })] }).fetchImpl }, sleep: async () => {} })
  const expiredTok = await runHuggingfaceDeviceLogin({ io: { env: ENV, fetchImpl: hubOf({ polls: [json(400, { error: 'expired_token' })] }).fetchImpl }, sleep: async () => {} })
  const refused = await runHuggingfaceDeviceLogin({ io: { env: ENV, fetchImpl: hubOf({ polls: [json(400, { error: 'strange_error', error_description: 'the description' })] }).fetchImpl }, sleep: async () => {} })
  t.check('D4 denied/expired/refused each speak their own sentence', denied.ok === false && (denied as { code: string }).code === 'denied' && expiredTok.ok === false && (expiredTok as { code: string }).code === 'expired' && refused.ok === false && (refused as { code: string }).code === 'refused' && refused.receipt.includes('strange_error: the description'))

  // D5 — a refused start names the retry road and the token-paste fallback.
  const d5 = await runHuggingfaceDeviceLogin({ io: { env: ENV, fetchImpl: hubOf({ start: json(500, { error: 'down' }) }).fetchImpl } })
  t.check('D5 a refused start answers start-failed with both roads named', d5.ok === false && (d5 as { code: string }).code === 'start-failed' && d5.receipt.includes('retry from /logins, or paste a token'))

  // D6 — the token leg's three answers: REFUSED never stores; CONFIRMED
  // stores with the identity; UNREACHABLE stores unverified, fault named.
  const r6 = await storeHuggingfaceTokenLogin('hf_refused_tok_00001', { env: ENV, fetchImpl: hubOf({ whoami: json(401, {}) }).fetchImpl }, async () => null)
  t.check('D6 a refused token is corrected, never stored', r6.ok === false && r6.stored === false && r6.receipt.includes('The Hub refused this token (HTTP 401)') && huggingfaceStoredTokenIdentity('hf_refused_tok_00001') === undefined)
  const c6 = await storeHuggingfaceTokenLogin('hf_confirmed_tok_0001', { env: ENV, fetchImpl: hubOf({ whoami: json(200, { name: 'keyed-op' }) }).fetchImpl }, async () => ({ models: [1] }))
  t.check('D6 a confirmed token stores with its identity and the catalogue proof', c6.ok === true && c6.stored === true && c6.receipt.includes('stored for keyed-op') && c6.receipt.includes('Live catalogue: 1 model(s)') && huggingfaceStoredTokenIdentity('hf_confirmed_tok_0001')?.username === 'keyed-op')
  const u6 = await storeHuggingfaceTokenLogin('hf_unreach_tok_00001', { env: ENV, fetchImpl: hubOf({ whoami: 'throw' }).fetchImpl }, async () => null)
  t.check('D6 an unreachable Hub stores UNVERIFIED with the fault named (two different facts)', u6.ok === true && u6.stored === true && u6.receipt.includes('stored UNVERIFIED') && u6.receipt.includes('whoami unreachable'))

  // Identity both directions: the machinery and its sentences are GONE
  // from the component; the component consumes the driver; the driver
  // wears moonshotLogin's event grammar (one shape, every device family).
  const hfSkin = read('src/components/HuggingfaceConnect.tsx')
  const hfDriver = read('src/services/providers/huggingface/huggingfaceLogin.ts')
  t.check('the component consumes the driver and keeps NO poll machinery', hfSkin.includes("from '../services/providers/huggingface/huggingfaceLogin.js'") && !hfSkin.includes('pollHuggingfaceDeviceToken') && !hfSkin.includes('fetchHuggingfaceIdentity') && !hfSkin.includes('writeHuggingfaceTokens') && !hfSkin.includes('refreshHuggingfaceCatalogue'))
  t.check('the flow sentences left the component for the driver', !hfSkin.includes('expired before the code was entered') && !hfSkin.includes('authorized but the tokens could not be stored') && !hfSkin.includes('The Hub refused this token') && hfDriver.includes('expired before the code was entered') && hfDriver.includes('The Hub refused this token'))
  t.check("the driver wears the moonshotLogin event grammar (phase 'starting'|'waiting'|'finishing')", hfDriver.includes("{ phase: 'starting' }") && hfDriver.includes("phase: 'waiting'; start: HuggingfaceDeviceAuthStart; polls: number; note?: string") && hfDriver.includes("{ phase: 'finishing' }"))
  t.check('the browser open stays the SKIN’s move (the driver performs none)', !hfDriver.includes('openBrowser') && hfSkin.includes('void openBrowser(event.start.verificationUriComplete ?? event.start.verificationUri)'))
}

t.section('§4 — THE ROSTER LAYER (A3: one home, truthful chips, the boot-menu design, stills)')
{
  const {
    collectLoginsScreenFacts,
    loginsCatalogue,
    loginsDetailLines,
    loginsEntryOf,
    loginsLegendOf,
    loginsRowStateOf,
    loginsSortedArms,
    loginsStatusLine,
    loginsSummaryRows,
  } = await import('../../src/components/BootLoginsScreen.js')
  const { STILLS, composeLogins, expiredFacts, mixedFacts, readStill, renderStill, signedOutFacts } = await import(
    './face-logins-stills.ts'
  )

  // ONE HOME: the catalogue is THE row owner's list with engine legs (the
  // layer settles engine outcomes itself); the two Anthropic rows are ARMS
  // of the one family; the walk's "sign in later" row cannot appear.
  const arms = loginsCatalogue()
  t.check('the catalogue is the row owner’s nine, engine legs offered', arms.length === 9 && arms.map(a => a.row.value).join(',') === 'claudeai,openai,console,openrouter,gemini,huggingface,moonshot,zai,deepseek')
  t.check('the two Anthropic rows read one family through two arms', arms[0]!.familyId === 'anthropic' && arms[0]!.arm === 'subscription' && arms[2]!.familyId === 'anthropic' && arms[2]!.arm === 'key')
  t.check("the walk's sign-in-later row is structurally absent", !arms.some(a => (a.row.value as string) === 'later'))

  const facts = mixedFacts()
  // The chips: identity for a signed-in arm; plain absence reads default;
  // wrongness (window reached · expired · not ready) stands out LOUD.
  t.check('a signed-in arm wears its slot identity', loginsRowStateOf(arms[0]!, facts).chip === 'op@example.com' && loginsRowStateOf(arms[0]!, facts).signedIn === true)
  t.check('the key arm of a subscription-signed family stays honestly absent', loginsRowStateOf(arms[2]!, facts).chip === 'not signed in' && loginsRowStateOf(arms[2]!, facts).signedIn === false)
  t.check('absence is a DEFAULT tone, never loud', loginsRowStateOf(arms[4]!, facts).loud === false)
  const kimi = arms.find(a => a.row.value === 'moonshot')!
  t.check('a reached window is LOUD on the chip', loginsRowStateOf(kimi, facts).chip.endsWith('· window reached') && loginsRowStateOf(kimi, facts).loud === true)
  const expired = expiredFacts()
  t.check('a present-but-dead subscription says expired and stands out', loginsRowStateOf(arms[0]!, expired).chip === 'op@example.com · expired' && loginsRowStateOf(arms[0]!, expired).loud === true)
  t.check('the expired pane carries the typed blocker VERBATIM', loginsDetailLines(arms[0]!, expired).join('\n').includes('the claude.ai sign-in has expired —\n/logins re-authenticates it'))

  // The order: signed-in rows first, each class in catalogue order.
  const sorted = loginsSortedArms(facts)
  t.check('signed-in rows float first, catalogue order within each class', sorted.map(a => a.row.value).join(',') === 'claudeai,openai,huggingface,moonshot,console,openrouter,gemini,zai,deepseek')
  const entry = loginsEntryOf(arms[0]!, facts)
  t.check('an entry groups under its state class with the owner’s row label', entry.group === 'signed in' && entry.label === 'Claude subscription account' && entry.valueLabel === 'op@example.com')

  // The panel + status + legend speak counts from the one owner.
  t.check('the summary counts distinct families (8), signed and ready', JSON.stringify(loginsSummaryRows(facts).map(r => `${r.key}=${r.value}`)) === JSON.stringify(['Families=8', 'Signed in=4 of 8', 'Ready=4 lanes']))
  t.check('the status line: signed of total · ready', loginsStatusLine(facts) === '4 of 8 families signed in · 4 ready')
  t.check('the signed-out world says so honestly (lanes can be ready without a sign-in)', loginsStatusLine(signedOutFacts()) === 'no family signed in yet · 0 ready without one')
  // Re-pinned at A4: ↵ joined the legend the commit the first flow landed
  // (the when-gate keeps it truthful per row).
  t.check('the legend names only the moves that exist (↵ joined with the first flow)', loginsLegendOf() === '↑↓ move · ↵ sign in · esc back')

  // The composer tiers: the wide frame carries the panes; the 64×12 floor
  // WARNS and keeps the way out (never a wall).
  const wide = composeLogins(120, 40, { sel: 0 }).join('\n')
  t.check('the wide frame carries the classes, the chips and the LOGINS panel', ['signed in', 'available', 'op@example.com', 'not signed in', 'LOGINS', 'Signed in  4 of 8'].every(s => wide.includes(s)))
  const floor = composeLogins(64, 12, { sel: 0 }).join('\n')
  t.check('the 64×12 floor frame WARNS and keeps the way out', floor.includes('wants at least') && floor.includes('esc back'))

  // The stills byte-match (face-logins-stills.ts --write regenerates).
  for (const still of STILLS) {
    const written = readStill(still.id)
    t.check(`still '${still.id}' byte-matches its fixture`, written !== null && written === renderStill(still.compose()), written === null ? 'missing — run face-logins-stills.ts --write' : 'drifted')
  }

  // collectLoginsScreenFacts exists and reads the owners (structural: the
  // live read is the two owners and nothing else).
  t.check('the live facts read is exported', typeof collectLoginsScreenFacts === 'function')
}

t.section('§5 — THE REAL MOUNT (staticRender with injected facts; the route cannot move)')
{
  process.env['FORCE_COLOR'] = '3'
  process.env['MERCURY_CRITTER_GAZE'] = '0'
  process.env['MERCURY_LIVE_GLYPHS'] = '0'
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootLoginsScreen } = await import('../../src/components/BootLoginsScreen.js')
  const { mixedFacts } = await import('./face-logins-stills.ts')
  const frame = await renderToString(
    React.createElement(BootLoginsScreen, { facts: mixedFacts(), fullScene: { columns: 120, rows: 40 } } as never),
    120,
  )
  t.check('the mounted layer presents the classes and the truthful chips', frame.includes('signed in') && frame.includes('op@example.com') && frame.includes('not signed in'))
  t.check('the mounted layer presents the LOGINS panel and the legend', frame.includes('LOGINS') && frame.includes('↑↓ move · ↵ sign in · esc back'))

  // NEVER THE CHAT, structurally: the layer module reaches no route verb —
  // stricter than the resume screen (which owns the ONE lawful door): this
  // module must import NOTHING of the surface-route bridge.
  const screenSrc = read('src/components/BootLoginsScreen.tsx')
  const routeTokens = ['surfaceRoute', 'enterRootRepl', 'settleAbsentChat', 'armRootCommand', 'initialMessage', 'enterConcourse']
  const routeHits = routeTokens.filter(tok => screenSrc.includes(tok))
  t.check('the logins layer module never touches the surface-route bridge', routeHits.length === 0, routeHits.join(','))
  // ONE-HOME needles: the module imports THE row owner and THE two truth
  // owners; it enumerates no family list of its own.
  t.check('the module imports the row owner and the two truth owners', screenSrc.includes("from './loginFamilyRows.js'") && screenSrc.includes('deriveFamilySlotGroups') && screenSrc.includes('resolveProviderUsability'))
  t.check('no second enumeration: the module never spells a family list literal', !/'anthropic',\s*'openai'/.test(screenSrc) && !screenSrc.includes("['claudeai'"))
  // Provider-optionality: no notification queue, no AppState requirement.
  t.check('the layer needs no notification queue and no AppState provider', !screenSrc.includes('context/notifications') && !screenSrc.includes('useAppState('))
}

t.section('§6 — THE ANTHROPIC PANES (A4: the machine on the face; reset totality; masked drafts; never stranded)')
{
  // The RESET law (the layer's long life): abandoning a flow cleans the
  // service and every beat; a LATE settle from the abandoned flow writes
  // NOTHING; the machine revives for a fresh flow afterwards.
  const bed = beatBed()
  const m = machineOf(bed)
  m.m.start(true)
  bed.run()
  m.world.services[0]!.urlCb('u-reset')
  const statesBefore = m.states.length
  m.m.reset()
  t.check('reset lands idle, cleans the pending service and clears every beat', m.m.snapshot().flow.name === 'idle' && m.world.services[0]!.cleanedUp === true && bed.pending() === 0)
  m.world.services[0]!.resolve({ accessToken: 'late-after-reset', scopes: ['claude'] })
  await settle()
  t.check('a settle after reset writes NOTHING (no success, no save, no record, no notice)', m.m.snapshot().flow.name === 'idle' && m.world.saved.length === 0 && m.world.recorded === 0 && m.world.notices.length === 0 && m.states.length === statesBefore + 1, `${m.states.join('→')}`)
  m.m.start(true)
  bed.run()
  t.check('the machine REVIVES: a fresh flow rides a fresh service', m.world.services.length === 2)
  m.world.services[1]!.urlCb('u-revive')
  m.world.services[1]!.resolve({ accessToken: 'at-revive', scopes: ['claude'] })
  await settle()
  t.check('the revived flow settles whole', m.m.snapshot().flow.name === 'success' && m.world.saved.length === 1 && m.world.recorded === 1)

  // The pane composers (pure): every state paints a way out; the draft is
  // MASKED (dots, never bytes); the URL hard-wraps instead of clipping.
  const { anthropicFlowLegendOf, anthropicFlowPaneLines, anthropicFlowStatusOf, maskedDraftLine, wrapHard } = await import(
    '../../src/components/BootLoginsScreen.js'
  )
  const snapOf = (flow: Record<string, unknown>, over: Record<string, unknown> = {}): never =>
    ({ flow, pastePromptUp: false, copied: false, shadowWarning: null, accountLabel: null, ...over }) as never
  const waiting = snapOf(
    { name: 'waiting', url: 'https://x.test/' + 'a'.repeat(60), loginWithClaudeAi: true, forcedMethod: null },
    { pastePromptUp: true },
  )
  const waitingLines = anthropicFlowPaneLines(waiting, 6)
  t.check('the waiting pane: sentence · hard-wrapped URL · copy hint · MASKED draft · the way out', waitingLines.join('\n').includes('finish signing in there.') && waitingLines.some(l => l === 'code: ••••••▌') && waitingLines[waitingLines.length - 1] === 'esc cancels the wait' && waitingLines.every(l => l.length <= 38))
  t.check('the URL hard-wraps whole (no clipped byte lost)', waitingLines.join('').includes('a'.repeat(60)))
  t.check('the masked draft NEVER paints bytes and caps its dots', maskedDraftLine(0) === 'code: ▌' && maskedDraftLine(3) === 'code: •••▌' && maskedDraftLine(99) === `code: ${'•'.repeat(24)}…▌`)
  t.check('wrapHard chunks exactly at the width', JSON.stringify(wrapHard('abcdef', 4)) === JSON.stringify(['abcd', 'ef']) && JSON.stringify(wrapHard('', 4)) === JSON.stringify(['']))
  const states: Array<Record<string, unknown>> = [
    { name: 'idle' },
    { name: 'ready', loginWithClaudeAi: true },
    { name: 'waiting', url: 'https://u.test', loginWithClaudeAi: true, forcedMethod: null },
    { name: 'creating-key' },
    { name: 'success' },
    { name: 'error', message: 'x failed' },
    { name: 'about-to-retry', target: { name: 'ready', loginWithClaudeAi: true } },
  ]
  const strandable = states.filter(flow => {
    const lines = anthropicFlowPaneLines(snapOf(flow), 0).join('\n')
    const legend = anthropicFlowLegendOf(snapOf(flow), 0)
    // NEVER-STRANDED: each state paints an exit on the pane or the legend.
    return !(lines.includes('esc') || lines.includes('↵ done') || legend.includes('esc') || legend.includes('↵'))
  })
  t.check('NO flow state exists without a painted way out', strandable.length === 0, JSON.stringify(strandable))
  t.check('the success pane speaks the account and the refresh; error speaks the machine sentence verbatim', anthropicFlowPaneLines(snapOf({ name: 'success' }, { accountLabel: 'op@x' }), 0)[0] === 'Signed in as op@x.' && anthropicFlowPaneLines(snapOf({ name: 'error', message: 'the exact words' }), 0)[0] === 'the exact words')
  t.check('the legends name only the moves that exist', anthropicFlowLegendOf(waiting, 0) === '↵ submit code · c copy url · esc cancel' && anthropicFlowLegendOf(waiting, 3) === '↵ submit code · esc cancel' && anthropicFlowLegendOf(snapOf({ name: 'success' }), 0) === '↵ done' && anthropicFlowLegendOf(snapOf({ name: 'error', message: 'x', retry: { name: 'ready', loginWithClaudeAi: true } }), 0) === '↵ retry · esc close')
  t.check('the status words track the flow', anthropicFlowStatusOf(waiting) === 'waiting on the browser sign-in' && anthropicFlowStatusOf(snapOf({ name: 'creating-key' })) === 'minting the usage-based key')

  // The screen's flow gates (structure): the roster list and its pointer
  // targets park while a flow is open; ↵ rides the when-gate (no dead key
  // on a row whose flow is not yet built); the success esc REFRESHES (the
  // no-optimistic-flip law reads the owners again).
  const src = read('src/components/BootLoginsScreen.tsx')
  // Re-pinned at A5: the flow became a typed union ('flow'), and the
  // pointer targets ride a dispatch that also serves the pick list.
  t.check('the roster parks under an open flow (list + pointer)', src.includes('active: flow === null') && src.includes('flow === null && arms[entryIdx] !== undefined'))
  t.check('↵ rides the when-gate over loginsFlowReady', src.includes('when: a => loginsFlowReady(a.row.value)'))
  t.check('a settled flow RE-READS the owners (never an optimistic flip); injected facts never re-read live', src.includes('if (given === undefined) setFacts(collectLoginsScreenFacts());'))
  // Re-pinned at A5: the pick sub-view owns its own list keys.
  t.check('the flow keys are consumed above every owner beneath (picks own their own)', src.includes("{ isActive: flow !== null && flow.kind !== 'pick' },"))
}

t.section('§7 — THE KEY FAMILIES (A5: picks · the one guard spelling · drivers · receipts · esc edges)')
{
  const {
    keyLegGuardOpts,
    keyPromptPaneLines,
    loginsFlowLegendOf,
    loginsFlowReady,
    loginsFlowStatusOf,
    loginsPickOptions,
    loginsPickPaneLines,
    receiptPaneLines,
  } = await import('../../src/components/BootLoginsScreen.js')
  const { keyPasteGuardNote } = await import('../../src/components/mercury-ui/screens/keyPasteGuards.js')
  const { zaiPlanLabel } = await import('../../src/services/providers/zai/zaiLogin.js')

  // The flow set widened to the key families + the usage-based door.
  // Re-pinned at A6b: the set CLOSED — every catalogue row's flow exists.
  t.check('↵ is live on EVERY catalogue row (the set closed at A6b)', ['claudeai', 'console', 'zai', 'deepseek', 'moonshot', 'huggingface', 'openai', 'openrouter', 'gemini'].every(v => loginsFlowReady(v as never)))

  // The picks wear the LANDED cards' labels verbatim (one vocabulary).
  // Re-pinned at OS-AUTH-1 (the operator's split: the console door is
  // purely Anthropic; the OpenAI key moved home): the openai pick renders
  // THE row owner's pair — byte-same by construction, held here.
  const { openaiArmPickRows } = await import('../../src/components/loginFamilyRows.js')
  t.check('the openai pick is the row owner\'s two-arm pair, byte-same labels', JSON.stringify(loginsPickOptions('openai').map(o => o.label)) === JSON.stringify(openaiArmPickRows.map(o => o.label)) && JSON.stringify(loginsPickOptions('openai').map(o => o.label)) === JSON.stringify(['ChatGPT subscription — browser sign-in', 'OpenAI API key — paste one (stored locally, mode 600)']))
  // The OTHER half of the one-home chain (the face-vs-owner
  // equality above left the in-chat side unpinned): the card/walk/router
  // surfaces all render through ConsoleOAuthFlow's ONE Select, which spreads
  // the row owner — and no render site hand-spells an arm label.
  const consoleFlowSrc = read('src/components/ConsoleOAuthFlow.tsx')
  t.check(
    'the in-chat pick renders the row owner by construction (ConsoleOAuthFlow spreads openaiArmPickRows; walk + card mount it)',
    consoleFlowSrc.includes('options={[...openaiArmPickRows]}') &&
      read('src/components/Onboarding.tsx').includes('ConsoleOAuthFlow') &&
      read('src/commands/login/login.tsx').includes('ConsoleOAuthFlow'),
  )
  t.check(
    'no render site spells an arm label by hand (the pair lives ONLY in the row owner)',
    !consoleFlowSrc.includes('ChatGPT subscription — browser sign-in') &&
      !read('src/components/BootLoginsScreen.tsx').includes('ChatGPT subscription — browser sign-in') &&
      read('src/components/loginFamilyRows.ts').includes("{ label: 'ChatGPT subscription — browser sign-in', value: 'subscription' }"),
  )
  t.check('the zai pick is the landed plan question, byte-same labels', JSON.stringify(loginsPickOptions('zai').map(o => o.label)) === JSON.stringify(['GLM Coding Plan key — api.z.ai/api/coding/paas/v4', 'Z.AI API key (general, pay-as-you-go) — api.z.ai/api/paas/v4']))
  t.check('the pick panes explain and name the way out', loginsPickPaneLines('openai').join(' ').includes('One OpenAI family, two credentials') && loginsPickPaneLines('zai').join(' ').includes('the answer picks the base') && [loginsPickPaneLines('openai'), loginsPickPaneLines('zai')].every(l => l[l.length - 1] === 'esc — back to the roster'))

  // THE ONE GUARD SPELLING: the module owns both sentences; every leg —
  // in-chat and face — parameterizes the same builder; the face's params
  // reproduce the landed sentences byte-identically.
  t.check('the guard refuses an sk-ant key with the landed sentence (zai form)', keyPasteGuardNote('sk-ant-abc123', keyLegGuardOpts('zai-coding')) === `That is an Anthropic API key (sk-ant-…) — this step stores a ${zaiPlanLabel('coding')}.`)
  t.check('the guard refuses whitespace with the landed sentence', keyPasteGuardNote('two words', keyLegGuardOpts('deepseek')) === 'That does not look like an API key (it contains whitespace).')
  t.check("the openai form carries the Console redirect clause verbatim", keyPasteGuardNote('sk-ant-x', keyLegGuardOpts('openai-key')) === 'That is an Anthropic API key (sk-ant-…) — this step stores an OpenAI key. Anthropic usage-based billing signs in through the Console row instead.')
  t.check('a clean draft passes the guard', keyPasteGuardNote('zk-9f2c3d4e5f6a7b8c', keyLegGuardOpts('zai-general')) === null && keyPasteGuardNote('  ', keyLegGuardOpts('deepseek')) === null)
  const skinFiles = ['ConsoleOAuthFlow.tsx', 'KimiConnect.tsx', 'HuggingfaceConnect.tsx', 'ZaiConnect.tsx', 'DeepseekConnect.tsx']
  const spellers = skinFiles.filter(f => read(`src/components/${f}`).includes('That is an Anthropic API key'))
  t.check('NO component spells the guard sentences any more (one home)', spellers.length === 0, spellers.join(','))
  t.check('every key leg consumes the one guard', skinFiles.every(f => read(`src/components/${f}`).includes('keyPasteGuardNote')))

  // The OpenAI key leg's logic is a DRIVER now (openaiLogin — the zai/
  // deepseek shape); the in-chat leg and the face consume the same one.
  const openaiDriver = read('src/services/providers/openai/openaiLogin.ts')
  t.check('the openai key driver carries the store + catalogue-proof receipt', openaiDriver.includes('storeOpenaiApiKeyLogin') && openaiDriver.includes('GPT rows join /model now') && openaiDriver.includes("refreshOpenaiCatalogue('api-key', { force: true })"))
  const consoleSkin = read('src/components/ConsoleOAuthFlow.tsx')
  t.check('the in-chat key leg consumes the driver (no writer, no catalogue call left)', consoleSkin.includes('storeOpenaiApiKeyLogin(value)') && !consoleSkin.includes('writeStoredOpenaiApiKey') && !consoleSkin.includes('refreshOpenaiCatalogue'))

  // The openai driver walked with an injected catalogue (cpu-pure): the
  // receipt proves what the catalogue ANSWERED, all three shapes.
  const { storeOpenaiApiKeyLogin } = await import('../../src/services/providers/openai/openaiLogin.js')
  const live = await storeOpenaiApiKeyLogin('ok-abcdefgh12345678', { refreshCatalogue: async () => ({ models: [1, 2, 3] }) })
  const dead = await storeOpenaiApiKeyLogin('ok-abcdefgh12345678', { refreshCatalogue: async () => ({ models: [], lastError: 'ECONNREFUSED' }) })
  const silent = await storeOpenaiApiKeyLogin('ok-abcdefgh12345678', { refreshCatalogue: async () => null })
  t.check('the openai key receipt: live catalogue · dead catalogue · no answer', live.ok && live.receipt.includes('Live catalogue: 3 model(s)') && dead.receipt.includes('did not answer (ECONNREFUSED)') && silent.receipt.endsWith('usage-based billing.'))

  // The key pane + the receipt pane: masked draft, note verbatim, the way
  // out ALWAYS last (a long receipt clamps rather than pushing it off).
  const pane = keyPromptPaneLines('zai-coding', 'the driver said no', 4, false)
  t.check('the key pane: title · store words · MASKED key · note verbatim · way out', pane[0] === zaiPlanLabel('coding') && pane.includes('key: ••••▌') && pane.join('\n').includes('the driver said no') && pane[pane.length - 1] === '↵ stores it · esc back')
  t.check('the storing pane swaps the way out for the honest wait', keyPromptPaneLines('deepseek', null, 8, true)[keyPromptPaneLines('deepseek', null, 8, true).length - 1] === 'checking the key…')
  const longReceipt = receiptPaneLines(Array.from({ length: 120 }, () => 'word').join(' '), true)
  t.check('a long receipt clamps and the way out stays last', longReceipt[longReceipt.length - 1] === '↵ done — the roster refreshes' && longReceipt.length <= 10 && longReceipt.includes('…'))

  // Legends + status per sub-view.
  t.check('the pick/key/receipt legends name only the moves that exist', loginsFlowLegendOf({ kind: 'pick', pick: 'console', pickSel: 0 }) === '↑↓ move · ↵ pick · esc back' && loginsFlowLegendOf({ kind: 'key', leg: 'deepseek', note: null, draftLen: 0, storing: false }) === '↵ store key · esc back' && loginsFlowLegendOf({ kind: 'key', leg: 'deepseek', note: null, draftLen: 0, storing: true }) === 'checking…' && loginsFlowLegendOf({ kind: 'receipt', receipt: 'r', ok: true }) === '↵ done')
  t.check('the status words track the sub-view', loginsFlowStatusOf({ kind: 'pick', pick: 'zai', pickSel: 0 }) === 'which Z.AI key is this?' && loginsFlowStatusOf({ kind: 'receipt', receipt: 'r', ok: false }) === 'not connected — ↵ returns to the roster')

  // The esc edges (structure): a key prompt backs to ITS OWN pick (console
  // key → the console pick; a zai key → the plan question; deepseek → the
  // roster) — the landed legs' own back edges, spelled in the screen.
  const src = read('src/components/BootLoginsScreen.tsx')
  // Re-pinned at A6a (the one cursor-resetting opener) and again at
  // OS-AUTH-1: the OpenAI key's esc backs to ITS family's pick — the key
  // moved home from the console door.
  t.check('the esc edges ride the landed back topology', src.includes("if (leg === 'openai-key') openPick('openai');") && src.includes("else if (leg === 'zai-general' || leg === 'zai-coding') openPick('zai');") && src.includes('else closeFlow();'))
  t.check('a storing prompt holds its esc (no half-stored abandon)', src.includes('if (!current.storing) keyEscape(current.leg);'))
}

t.section('§8 — THE DEVICE FAMILIES (A6a: Kimi + Hugging Face whole — picks · region · the wait pane · key legs)')
{
  const {
    deviceFamilyWords,
    deviceWaitPaneLines,
    keyLegGuardOpts: guardOptsOf,
    loginsFlowLegendOf,
    loginsFlowReady,
    loginsFlowStatusOf,
    loginsPickOptions,
    loginsPickPaneLines,
  } = await import('../../src/components/BootLoginsScreen.js')

  // Re-pinned at A6b: the closed set (§9 pins the handles trio's flows).
  t.check('↵ is live on moonshot + huggingface (and the whole catalogue since A6b)', (['moonshot', 'huggingface', 'openai', 'openrouter', 'gemini'] as const).every(v => loginsFlowReady(v)))

  // The picks wear the LANDED cards' labels verbatim.
  t.check('the Kimi choice is the landed card, byte-same', JSON.stringify(loginsPickOptions('moonshot').map(o => o.label)) === JSON.stringify(['Sign in with Kimi — device code in your browser', 'Paste a Moonshot API key (platform.kimi.ai; stored locally, mode 600)']))
  t.check('the Hub choice is the landed card, byte-same', JSON.stringify(loginsPickOptions('huggingface').map(o => o.label)) === JSON.stringify(['Sign in with Hugging Face — device code in your browser', 'Paste a token (Inference Providers permission; stored locally, mode 600)']))
  t.check('the region question is the landed card, byte-same values incl. mainland-cn', JSON.stringify(loginsPickOptions('kimi-region')) === JSON.stringify([{ label: 'Global — kimi.ai (auth.kimi.ai · api.kimi.ai/coding/v1)', value: 'global' }, { label: 'Mainland China — kimi.com (auth.kimi.com · api.kimi.com/coding/v1)', value: 'mainland-cn' }]))
  t.check('the region pane backs one step, not to the roster', loginsPickPaneLines('kimi-region')[loginsPickPaneLines('kimi-region').length - 1] === 'esc — back to the Kimi choice')

  // The device wait pane: TZ-free relative expiry; the fault named but
  // CLAMPED; the way out always last; every phase painted.
  const wait = deviceWaitPaneLines(
    {
      family: 'moonshot',
      regionWords: 'Global — kimi.ai',
      phase: 'waiting',
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.kimi.ai/activate?user_code=ABCD-1234',
      expiresAtMs: 300_000,
      polls: 3,
      note: 'the Kimi host did not answer (socket hangup) — still trying until the code expires',
      copied: false,
    },
    0,
  )
  t.check('the wait pane: code · url whole · polls · RELATIVE expiry · fault · way out last', wait.includes('    ABCD-1234') && wait.join('').includes('user_code=ABCD-1234') && wait.some(l => l === 'waiting (3 checks) · expires in 5m') && wait.join('\n').includes('did not answer') && wait[wait.length - 1] === 'c copies the URL · esc cancels' && wait.every(l => l.length <= 38))
  t.check('no local-time string anywhere (TZ-free by construction)', !wait.some(l => /\d:\d\d:\d\d|AM|PM/.test(l)))
  const starting = deviceWaitPaneLines({ family: 'huggingface', phase: 'starting', polls: 0, copied: false }, 0)
  const finishing = deviceWaitPaneLines({ family: 'moonshot', phase: 'finishing', polls: 0, copied: false }, 0)
  t.check('starting and finishing phases paint their honest words with a way out where one exists', starting[starting.length - 1] === 'esc cancels — nothing is stored' && finishing.join(' ').includes('Authorized — storing the sign-in and reading your usage…'))
  t.check('the family words name Kimi with its region and the Hub plain', deviceFamilyWords('moonshot', 'Global — kimi.ai') === 'Kimi (device code · Global — kimi.ai)' && deviceFamilyWords('huggingface') === 'Hugging Face (device code)')

  // The new key legs ride the ONE guard spelling with the landed clauses.
  t.check('the Kimi key + Hub token guards carry the landed clauses', guardOptsOf('moonshot-key').stores === 'a Moonshot platform key' && guardOptsOf('hf-token').stores === 'a Hugging Face token (hf_…)' && guardOptsOf('hf-token').looksLike === 'a token')

  // Legends + status.
  t.check('the device legend flips with the phase', loginsFlowLegendOf({ kind: 'device', device: { family: 'moonshot', phase: 'waiting', polls: 0, copied: false }, nowMs: 0 }) === 'c copy url · esc cancel' && loginsFlowLegendOf({ kind: 'device', device: { family: 'moonshot', phase: 'starting', polls: 0, copied: false }, nowMs: 0 }) === 'esc cancel')
  t.check('the status words name the waiting family and the settle', loginsFlowStatusOf({ kind: 'device', device: { family: 'huggingface', phase: 'waiting', polls: 0, copied: false }, nowMs: 0 }) === 'waiting on the Hub device code' && loginsFlowStatusOf({ kind: 'device', device: { family: 'moonshot', phase: 'finishing', polls: 0, copied: false }, nowMs: 0 }) === 'authorized — settling the sign-in')

  // The glue's laws (structure): the run-id cancel (esc bumps → the driver
  // reads cancelled and the late landing is ignored); the browser opens on
  // the FIRST waiting event (the skin's move); a device esc returns to the
  // FAMILY's choice; the pick cursor resets through the one opener; the
  // region hop seeds the REMEMBERED region.
  const src = read('src/components/BootLoginsScreen.tsx')
  t.check('the run-id cancel law is wired (bump on esc/close; cancelled reads it; landings check live())', src.includes('const run = (deviceRunRef.current += 1);') && src.includes('cancelled: () => !live()') && src.includes('if (!live()) return;'))
  t.check('the browser opens on the first waiting event only', src.includes('if (event.polls === 0 && uri !== undefined) void openBrowser(uri);'))
  t.check('a device esc backs to the family choice (never strands, never loses the roster)', src.includes('deviceRunRef.current += 1;') && src.includes('openPick(current.device.family);'))
  t.check('every pick opens through the cursor-resetting opener; the region seeds the remembered answer', src.includes('const openPick = (pick: LoginsPickId, cursor = 0): void => {') && src.includes("openPick('kimi-region', moonshotStoredRegion() === 'mainland-cn' ? 1 : 0);"))
  // Needle re-cut (AUTHHARD H2b): the landing now passes the
  // settledAfterCancel gate (landOrDisclose) before land — still the
  // drivers' own outcomes, never a re-implemented poll.
  t.check('the device landings ride the drivers (never a re-implemented poll)', src.includes('void runKimiDeviceLogin({ region: region ?? ') && src.includes('void runHuggingfaceDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);') && !src.includes('pollMoonshotDeviceToken') && !src.includes('pollHuggingfaceDeviceToken'))
}

t.section('§9 — THE HANDLES FAMILIES (A6b: openai · openrouter · gemini — hoisted receipts · panes · the client prompt)')
{
  const {
    geminiClientPaneLines,
    geminiPickOptions,
    handlesWaitPaneLines,
    loginsPickOptions,
    openaiDevicePaneLines,
  } = await import('../../src/components/BootLoginsScreen.js')

  // THE RECEIPT HOISTS: each family's settle sentence lives in ITS login
  // door, proven over an injected catalogue — three answers each.
  const { finishOpenaiSubscriptionConnect, OPENAI_DEVICE_STOPPED_RECEIPT } = await import(
    '../../src/services/providers/openai/openaiLogin.js'
  )
  const { finishOpenrouterConnect, storeOpenrouterApiKeyLogin } = await import(
    '../../src/services/providers/openrouter/openrouterLogin.js'
  )
  const { finishGeminiOauthConnect, storeGeminiApiKeyLogin } = await import(
    '../../src/services/providers/gemini/geminiLogin.js'
  )
  const ref = { label: 'ChatGPT Plus', accountId: 'acct1234567890' } as never
  const live = await finishOpenaiSubscriptionConnect(ref, { refreshCatalogue: async () => ({ models: [1, 2] }) })
  const dead = await finishOpenaiSubscriptionConnect(ref, { refreshCatalogue: async () => ({ models: [], lastError: 'ETIMEDOUT' }) })
  t.check('the openai settle receipt: label · account tail · catalogue truth both ways', live.receipt.includes('OpenAI connected: ChatGPT Plus · account acct1234…') && live.receipt.includes('live catalogue: 2 model(s)') && dead.receipt.includes('catalogue: unavailable (ETIMEDOUT)'))
  const orRef = { label: 'OAuth (scoped key)', keySource: 'oauth' } as never
  const orLive = await finishOpenrouterConnect(orRef, { refreshCatalogue: async () => ({ models: [1] }) })
  t.check('the openrouter settle receipt speaks the landed sentence', orLive.receipt.includes('OpenRouter connected: OAuth (scoped key)') && orLive.receipt.includes('/accounts manages the credential'))
  const gLive = await finishGeminiOauthConnect({ refreshCatalogue: async () => ({ models: [1, 2, 3] }) })
  t.check('the gemini settle receipt speaks the landed sentence', gLive.receipt.includes('Gemini connected: Google account (OAuth)') && gLive.receipt.includes('live catalogue: 3 model(s)'))
  const orKey = await storeOpenrouterApiKeyLogin('or-abcdefgh12345678', { refreshCatalogue: async () => ({ models: [1, 2, 3, 4] }) })
  const gKey = await storeGeminiApiKeyLogin('gk-abcdefgh12345678', { refreshCatalogue: async () => null })
  t.check('the key drivers store + prove (openrouter · gemini)', orKey.stored && orKey.receipt.includes('Live catalogue: 4 model(s)') && gKey.stored && gKey.receipt.endsWith('generativelanguage.googleapis.com.'))

  // IDENTITY: the settle/fail sentences are GONE from the three components
  // (one home); every one consumes its login door + the one guard.
  const routers = ['RouterOpenaiConnect.tsx', 'RouterOpenrouterConnect.tsx', 'GeminiConnect.tsx']
  const spellers = routers.filter(f => {
    const src = read(`src/components/${f}`)
    return src.includes('live catalogue: ') || src.includes('connect failed: ${') || src.includes('That is an Anthropic API key')
  })
  t.check('NO connect component spells a settle/fail/guard sentence any more', spellers.length === 0, spellers.join(','))
  t.check('each component consumes its login door', read('src/components/RouterOpenaiConnect.tsx').includes('finishOpenaiSubscriptionConnect') && read('src/components/RouterOpenrouterConnect.tsx').includes('finishOpenrouterConnect') && read('src/components/GeminiConnect.tsx').includes('finishGeminiOauthConnect'))

  // The picks: openrouter verbatim; gemini's labels ride the client gate
  // (pure over the two booleans — stills and screen compose the same).
  t.check('the openrouter pick is the landed card, byte-same', JSON.stringify(loginsPickOptions('openrouter').map(o => o.label)) === JSON.stringify(['Sign in with the browser — OAuth mints a scoped key', 'Headless — OpenRouter shows a code you paste here', 'Paste an API key (stored locally, mode 600)']))
  t.check('the gemini labels flip on the gate exactly as landed', geminiPickOptions(true, false)[1]!.label === 'Google OAuth — needs an OAuth client first (set it below)' && geminiPickOptions(false, true)[1]!.label === 'Sign in with Google (OAuth, browser)' && geminiPickOptions(false, true)[2]!.label === 'Update the stored OAuth client (id/secret)' && geminiPickOptions(true, false)[2]!.label === 'Set the OAuth client (id/secret from Google Cloud Console)')

  // The panes: masked paste + way out; the headless words; the exchanging
  // phase; the opdevice honesty; the client prompt's plain id + masked
  // secret; every pane inside the width.
  const wait = handlesWaitPaneLines({ leg: 'openai-browser', phase: 'waiting', authorizeUrl: 'https://auth.openai.test/' + 'q'.repeat(50), copied: false }, 5)
  t.check('the openai wait pane: loopback sentence · url whole · masked paste · d offered', wait.join(' ').includes('loopback listener completes automatically') && wait.join('').includes('q'.repeat(50)) && wait.some(l => l === 'paste: •••••▌') && wait[wait.length - 1] === 'c copy · d device · esc cancel' && wait.every(l => l.length <= 38))
  const headless = handlesWaitPaneLines({ leg: 'openrouter-headless', phase: 'waiting', authorizeUrl: 'https://openrouter.test/auth', copied: false }, 0)
  t.check('the headless pane says paste-the-code and offers NO d', headless.join(' ').includes('displays a code — paste it below') && headless.some(l => l === 'code: ▌') && !headless.join(' ').includes('d device'))
  t.check('the exchanging phase paints the mint words with a way out', handlesWaitPaneLines({ leg: 'openrouter-browser', phase: 'exchanging', copied: false }, 0).join(' ').includes('OpenRouter mints the key…') && handlesWaitPaneLines({ leg: 'gemini-oauth', phase: 'exchanging', copied: false }, 0).includes('esc cancels'))
  const dev = openaiDevicePaneLines({ userCode: 'WXYZ-9876', verifyHint: 'visit chatgpt.com/device and enter the code', copied: false })
  t.check('the opdevice pane: the code · the hint · the honest stop-watching esc', dev.includes('    WXYZ-9876') && dev.join(' ').includes('chatgpt.com/device') && dev[dev.length - 1] === 'c copies the code · esc stops watching')
  t.check('the stop-watching receipt is the landed sentence', OPENAI_DEVICE_STOPPED_RECEIPT.includes('stopped watching') && OPENAI_DEVICE_STOPPED_RECEIPT.includes('the connection still lands'))
  const clientId = geminiClientPaneLines({ field: 'id', clientId: '', note: null }, 8, 'my-client')
  const clientSecret = geminiClientPaneLines({ field: 'secret', clientId: 'my-client.apps.example', note: null }, 6, '••••••')
  t.check('the client prompt: the id PLAIN, the secret MASKED and optional, one esc one layer', clientId.some(l => l === 'id: my-client▌') && clientSecret.join(' ').includes('my-client.apps.example ✓') && clientSecret.some(l => l.includes('secret (optional, ↵ skips): ••••••▌')) && clientId[clientId.length - 1] === '↵ continues · esc back' && clientSecret[clientSecret.length - 1] === '↵ stores · esc back to the id')

  // The glue's laws (structure): the d-switch cancels then remounts the
  // device leg; the opdevice esc lands the STOPPED receipt (never a silent
  // close); a handles esc backs where the leg came from; the gemini OAuth
  // pick redirects to the client prompt when the gate says missing.
  const src = read('src/components/BootLoginsScreen.tsx')
  t.check('the d-switch cancels the browser flow and remounts the device leg', src.includes("handlesRef.current?.cancel('switching to the device-code flow');") && src.includes('startOpenaiDeviceRun();'))
  t.check('the opdevice esc paints the honest stopped receipt', src.includes('setFlow({ kind: \'receipt\', receipt: OPENAI_DEVICE_STOPPED_RECEIPT, ok: false });'))
  t.check('a handles esc backs where the leg came from', src.includes("if (h.leg === 'openai-browser') closeFlow();") && src.includes("else if (h.leg === 'gemini-oauth') openPick('gemini');") && src.includes("else openPick('openrouter');"))
  t.check('the gemini OAuth pick honors the client gate (the landed redirect)', src.includes("if (value === 'client' || Boolean(geminiOauthClientMissingCopy())) {"))
  t.check('the client store rides the ONE owner (writeGeminiOauthClientConfig)', src.includes('writeGeminiOauthClientConfig({') && src.includes('clientId: c.clientId,'))
}

t.section('§10 — THE WIRING, DARK (A7: the deep-link · route silence on the LIVE store · the chip epoch · the settle)')
{
  // The deep-link union gains 'logins'; the wire word waits for the card
  // recut (ACTIONS untouched this commit — the degradation law's order:
  // a runtime must understand a word before any launcher writes it).
  const handover = await import('../../src/substrate/splashHandover.js')
  handover.armFaceDoorDeepLink('logins')
  t.check('the resolver PEEKS without consuming; the face consumes ONCE', handover.peekFaceDoorDeepLink() === 'logins' && handover.consumeFaceDoorDeepLink() === 'logins' && handover.consumeFaceDoorDeepLink() === null)
  const handoverSrc = read('src/substrate/splashHandover.ts')
  // Re-pinned at C1: the wire word LANDED with the card row (the
  // degradation order held — the runtime learned the word at A7, the
  // launcher writes it now); `project` stays consumed for stale splashes.
  // Needles re-pinned: the 'agents' wire word joined the
  // union and ACTIONS by the same ruling grammar — the logins law stands.
  t.check("the union carries 'logins'; ACTIONS gained the wire word at the recut", handoverSrc.includes("export type FaceDoorDeepLink = 'health' | 'resume' | 'saturn' | 'logins' | 'agents'") && handoverSrc.includes("const ACTIONS = new Set(['continue', 'doctor', 'project', 'resume', 'concourse', 'kit', 'saturn', 'logins', 'agents', 'cancel'])") && handoverSrc.includes("receipt.action === 'logins'"))
  t.check('the SATURN-form arming stays a NAMED SEAM only', handoverSrc.includes('"re-login now" arming is a NAMED SEAM ONLY'))

  // ROUTE SILENCE on the LIVE store around a REAL mount (the §11 grammar):
  // opening/walking/closing the logins layer can never move the surface.
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootLoginsScreen } = await import('../../src/components/BootLoginsScreen.js')
  const { mixedFacts } = await import('./face-logins-stills.ts')
  const routeStore = await import('../../src/context/surfaceRoute.js')
  routeStore._resetSurfaceRouteForTesting()
  const unregister = routeStore.registerRouteSurface('boot-settings', { render: () => null })
  routeStore.initializeSurfaceRoute({ kind: 'boot-settings' })
  const gen0 = routeStore.surfaceGeneration()
  const stops0 = routeStore.presentStripStops().join('·')
  await renderToString(React.createElement(BootLoginsScreen, { facts: mixedFacts(), fullScene: { columns: 100, rows: 30 } } as never), 100)
  t.check('the route never left boot-settings across the real mount', routeStore.currentSurfaceRoute().kind === 'boot-settings')
  t.check('NO transition committed (generation at the seed; INIT stands)', routeStore.surfaceGeneration() === gen0 && routeStore.lastSurfaceTransition().verb === 'INIT')
  t.check('the strip’s stops are unmoved while the layer exists', routeStore.presentStripStops().join('·') === stops0)
  unregister()
  routeStore._resetSurfaceRouteForTesting()

  // The face wiring (structure): the layer is a state sibling seeded by
  // the deep-link; BOTH lists park under it; its close bumps the presence
  // epoch the account chip re-reads; NO card row exists yet (dark — the
  // recut's move); the layer return rides fullScene+onClose.
  const face = read('src/components/BootSplashScreen.tsx')
  // Re-pinned at C1: the projects VIEW retired with its row — ONE list
  // remains and the layer parks it.
  // Needle re-pinned: the agents layer joined the gate.
  t.check('the face seeds the layer from the one-shot and parks the list under it', face.includes("useState(faceDoor === 'logins')") && face.includes('!saturnOpen && !agentsOpen && !loginsOpen,'))
  t.check('the layer mounts with esc-home wiring and the chip epoch bump', face.includes('<BootLoginsScreen') && face.includes('setLoginsOpen(false);') && face.includes('setPresenceEpoch(e => e + 1);'))
  // The strip keys on the presence epoch beside the catalogue and sign-in
  // epochs (a face sign-in, a live catalogue settling, a credential landing
  // or leaving anywhere in the process).
  t.check('the account chip re-reads on the presence epoch', face.includes('}, [mainModel, presenceEpoch, catalogueEpoch, signInEpoch]);'))
  // Re-pinned at C1: THE ROW LIVES — the recut wired it (the dark phase
  // ended; the deep-link and the row are the two lawful doors).
  t.check("the card row opens the layer (the recut's wiring)", face.includes("case 'logins':") && face.includes('setLoginsOpen(true);'))

  // The post-login settle (structure): the parity subset + the MAYBE bump
  // (authVersion when a store exists; the killswitch re-check outside the
  // updater); fires on OK settles only; injected facts never run it.
  const screen = read('src/components/BootLoginsScreen.tsx')
  t.check('the settle runs the parity subset in the /logins ordering', screen.includes('user.resetUserCache();') && screen.includes('await gates.refreshFeatureGates().catch(() => {});') && screen.includes('resetUserCache') && screen.indexOf('resetUserCache') < screen.indexOf('refreshFeatureGates().catch'))
  t.check('the authVersion bump rides the MAYBE setter; the killswitch re-check stays outside the updater', screen.includes('const setAppStateMaybe = useSetAppStateMaybe();') && screen.includes('authVersion: (prev.authVersion ?? 0) + 1') && screen.includes('checkAndDisableBypassPermissionsIfNeeded(capturedContext, setAppStateMaybe)'))
  t.check('the settle fires on OK settles only and never on injected facts', screen.includes('if (current.ok) postLoginSettle();') && screen.includes('if (given !== undefined) return;'))
}

t.section('§11 — THE MERGED SESSIONS·PROJECTS SCREEN (B2, dark: the container · the filter · one highlight)')
{
  const {
    resumeLegendOf,
    resumeProjectDetailLines,
    resumeProjectEntryOf,
    resumeStatusLine,
    resumeSummaryRows,
  } = await import('../../src/components/BootResumeScreen.js')
  const { MERGED_FIXTURE_PROJECTS, MERGED_STILLS, composeMerged, readStill, renderStill } = await import(
    './face-logins-stills.ts'
  )

  // The project rows: the trailing 'projects' section; age + running; the
  // detail names the landing and the filter truth.
  const entry = resumeProjectEntryOf(MERGED_FIXTURE_PROJECTS[0]!)
  t.check("a project row groups under 'projects' with age + running", entry.groupTitle === 'projects' && entry.label === 'orchard-src' && entry.valueLabel === '2m · 2 running')
  const detail = resumeProjectDetailLines(MERGED_FIXTURE_PROJECTS[1]!)
  t.check('the project trail: repo · dir · age · the filter fact · the landing truth', detail[0] === 'repo: moodle' && detail.join('\n').includes('this repo alone') && detail.join('\n').includes('the refusal paints on the row.'))

  // The widened composers stay BYTE-SAME without the new facts (the landed
  // pins and stills cannot drift): the two-arg legend, the panel without a
  // repos count, the status without a filter.
  t.check('two-arg legend output is the landed bytes', resumeLegendOf('all', true) === '↑↓ move · ↵ open · n new session · d prune · a this project · esc back')
  t.check('the merged legend adds ONLY the container jump', resumeLegendOf('all', true, true) === '↑↓ move · ↵ open · n new session · d prune · a this project · ⇥ repos · esc back')
  t.check('the panel without projectsCount is the landed rows', JSON.stringify(resumeSummaryRows({ scope: 'all', count: 4, crewCount: 1, elsewhereCount: 0, pendingMore: 0 }).map(r => r.key)) === JSON.stringify(['Scope', 'Sessions', 'Opens']))
  t.check('the panel with projects carries the Repos row', resumeSummaryRows({ scope: 'all', count: 4, crewCount: 1, elsewhereCount: 0, pendingMore: 0, projectsCount: 2 }).some(r => r.key === 'Repos' && r.value === '2'))
  t.check('the status names a live filter and stays landed without one', resumeStatusLine({ loading: false, count: 1, crewCount: 0, scope: 'all', pendingMore: 0, filterBase: 'moodle' }) === "1 session in 'moodle' (filtered) · ↵ opens the real chat" && resumeStatusLine({ loading: false, count: 4, crewCount: 1, scope: 'all', pendingMore: 0 }) === '4 sessions in the full history · 1 crew · ↵ opens the real chat')

  // The merged frames byte-match; the filtered frame shows the one repo's
  // sessions and names the filter.
  for (const still of MERGED_STILLS) {
    const written = readStill(still.id)
    t.check(`still '${still.id}' byte-matches its fixture`, written !== null && written === renderStill(still.compose()), written === null ? 'missing — run face-logins-stills.ts --write' : 'drifted')
  }
  const filtered = composeMerged(120, 40, { sel: 99, filterDir: '/repo/moodle' }).join('\n')
  t.check('the filtered frame: moodle alone above, the filter named, the projects below', filtered.includes("in 'moodle' (filtered)") && filtered.includes('moodle groundwork') && !filtered.includes('the tool-loop fold'))
  const merged = composeMerged(120, 40, { sel: 1 }).join('\n')
  t.check('the merged frame: title · both containers · the jump in the legend', merged.includes('sessions · projects') && merged.includes('projects') && merged.includes('⇥ repos'))

  // THE REAL MOUNT with injected model + projects + a fake landing; the
  // route stays silent (the §10 store law covers the layer class; here the
  // structural halves): the ↵-dispatch rides the INJECTED openProject; the
  // screen keeps its ONE lawful route door for session picks alone.
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootResumeScreen } = await import('../../src/components/BootResumeScreen.js')
  const { resumeModelOf } = await import('./face-door-stills.ts')
  const model = { ...resumeModelOf('all'), pendingMore: 0 }
  const frame = await renderToString(
    React.createElement(BootResumeScreen, { model, projects: MERGED_FIXTURE_PROJECTS, openProject: () => null, fullScene: { columns: 120, rows: 40 } } as never),
    120,
  )
  t.check('the mounted merged screen presents both containers and the merged title', frame.includes('sessions · projects') && frame.includes('orchard-src') && frame.includes('moodle') && frame.includes('⇥ repos'))
  const src = read('src/components/BootResumeScreen.tsx')
  t.check('↵ on a project row rides the INJECTED landing (never re-implemented)', src.includes('return openProject?.(row.project) ?? null;') && !src.includes('bornSession({ workspaceDir: row'))
  t.check('the filter rides the core (live) and the SAME matcher (injected)', src.includes('...(projectFilter !== null ? { filterDir: projectFilter.dir } : {})') && src.includes('given.flat.filter(f => isProjectSession(f.row.log, projectFilter.dir))'))
  t.check('the cursor re-anchors BY ID when the filter resizes the list', src.includes('const at = selectable.findIndex(r => selectableIdOf(r) === want);') && src.includes('if (at !== -1 && at !== list.selectedIndex) list.moveTo(at);'))
  t.check('⇥ jumps containers through the list’s own moveTo (the ← precedent)', src.includes('list.moveTo(list.selectedIndex >= projStart ? 0 : projStart);'))
  t.check('the prune door REFUSES under a project filter (its card vocabulary is pinned elsewhere)', src.includes('the prune door offers the whole scope — walk back out of the project filter first'))
  t.check('a projects-less mount is the landed picker (title · panel · legend unchanged)', src.includes("title: merged ? 'sessions · projects' : 'resume session'"))
}

t.section('§12 — THE SECRECY RIDER (the ruling: keys masked on screen AND absent from every receipt/notify/log surface)')
{
  const SECRET = 'zz-SECRETBYTES-0f9e8d7c6b5a4321'
  const json = (status: number, body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  // Every key driver's OUTCOME (ok and refused alike) never carries the
  // pasted bytes — receipts speak facts, never secrets.
  const receipts: string[] = []
  const { storeOpenaiApiKeyLogin } = await import('../../src/services/providers/openai/openaiLogin.js')
  receipts.push((await storeOpenaiApiKeyLogin(SECRET, { refreshCatalogue: async () => ({ models: [1] }) })).receipt)
  const { storeOpenrouterApiKeyLogin } = await import('../../src/services/providers/openrouter/openrouterLogin.js')
  receipts.push((await storeOpenrouterApiKeyLogin(SECRET, { refreshCatalogue: async () => null })).receipt)
  const { storeGeminiApiKeyLogin } = await import('../../src/services/providers/gemini/geminiLogin.js')
  receipts.push((await storeGeminiApiKeyLogin(SECRET, { refreshCatalogue: async () => ({ models: [], lastError: 'x' }) })).receipt)
  const { storeZaiApiKeyLogin } = await import('../../src/services/providers/zai/zaiLogin.js')
  receipts.push(storeZaiApiKeyLogin(SECRET, 'coding').receipt)
  receipts.push(storeZaiApiKeyLogin(SECRET, 'general').receipt)
  const { storeDeepseekApiKeyLogin } = await import('../../src/services/providers/deepseek/deepseekLogin.js')
  const dsFetch = (async () => json(200, { balance_infos: [{ currency: 'USD', total_balance: '1.00' }], is_available: true })) as unknown as typeof fetch
  receipts.push((await storeDeepseekApiKeyLogin(SECRET, { fetchImpl: dsFetch })).receipt)
  const dsRefused = (async () => json(401, {})) as unknown as typeof fetch
  receipts.push((await storeDeepseekApiKeyLogin(SECRET, { fetchImpl: dsRefused })).receipt)
  const { storeMoonshotApiKeyLogin } = await import('../../src/services/providers/moonshot/moonshotLogin.js')
  const msFetch = (async () => json(200, { data: { available_balance: 1, voucher_balance: 0, cash_balance: 1 } })) as unknown as typeof fetch
  receipts.push((await storeMoonshotApiKeyLogin(SECRET, { fetchImpl: msFetch })).receipt)
  const { storeHuggingfaceTokenLogin } = await import('../../src/services/providers/huggingface/huggingfaceLogin.js')
  const hfEnv = { MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'c', MERCURY_HUGGINGFACE_HUB_BASE: 'https://hub.test' } as NodeJS.ProcessEnv
  const hfFetch = (async () => json(200, { name: 'op' })) as unknown as typeof fetch
  receipts.push((await storeHuggingfaceTokenLogin(SECRET, { env: hfEnv, fetchImpl: hfFetch }, async () => null)).receipt)
  const leaks = receipts.filter(r => r.includes('SECRETBYTES'))
  t.check('NO driver receipt carries the pasted bytes (ok · refused · unverified alike)', leaks.length === 0, leaks.join(' | ').slice(0, 120))
  t.check('every receipt is a real sentence (the sweep exercised them)', receipts.length === 9 && receipts.every(r => r.length > 20))

  // The notify surface: the machine hands its queue the FIXED notice const
  // — no interpolation path exists for a credential to ride.
  const model = read('src/components/mercury-ui/screens/anthropicLoginModel.ts')
  t.check('the success notice is the fixed const (no interpolated notify anywhere)', model.includes('deps.notify?.(LOGIN_SUCCESS_NOTICE)') && (model.match(/deps\.notify\?\.\(/g) ?? []).length === 1)

  // The pane composers CANNOT paint a key: their signatures take a LENGTH,
  // never the draft (the client prompt's id is the one deliberate plain
  // field — not a secret; its secret half rides the masked length).
  const screen = read('src/components/BootLoginsScreen.tsx')
  t.check('the key pane signature takes draftLen, never the draft', screen.includes('export function keyPromptPaneLines(leg: FaceKeyLegId, note: string | null, draftLen: number, storing: boolean): string[]'))
  t.check('the anthropic pane signature takes draftLen, never the draft', screen.includes('export function anthropicFlowPaneLines(snap: AnthropicLoginSnapshot, draftLen: number): string[]'))
  t.check('the handles pane signature takes draftLen, never the draft', screen.includes('export function handlesWaitPaneLines(h: HandlesWaitStateV1, draftLen: number): string[]'))
}

// ── §13 THE LATE-SETTLE DISCLOSURE (AUTHHARD H2b — the disclose-not-unwind
//    ruling's E1): a connect that completes AFTER the operator's cancel is
//    never a dropped stale settle. The layer speaks it as the panel's first
//    loud row, re-reads the facts, and runs the same post-login settle a
//    live sign-in earns; the in-chat mid-wait esc receipts stop claiming
//    "nothing stored" where an exchange may already be completing. ──
{
  const { lateSettleNotice, loginsSummaryRows } = await import('../../src/components/BootLoginsScreen.js')

  // The one sentence, byte-stable, family-derived (the display-name owner).
  t.check(
    'the late-settle sentence names the family, the landing, and both removal doors',
    lateSettleNotice('openrouter') ===
      'OpenRouter sign-in completed after cancel — the approval landed while the flow was closing, so the account IS signed in. ⌫ on its row (or /accounts) signs it out.' &&
      lateSettleNotice('gemini').startsWith('Gemini sign-in completed after cancel'),
  )

  // The notice rides FIRST and loud; an absent notice leaves the rows
  // byte-identical (identity both directions — the landed pins stand).
  const facts = { groups: [], usability: {} } as never
  const plain = loginsSummaryRows(facts)
  const noticed = loginsSummaryRows(facts, lateSettleNotice('moonshot'))
  t.check(
    'the notice row rides first (teal) and absence is byte-identical',
    JSON.stringify(loginsSummaryRows(facts, null)) === JSON.stringify(plain) &&
      JSON.stringify(loginsSummaryRows(facts, undefined)) === JSON.stringify(plain) &&
      noticed.length === plain.length + 1 &&
      noticed[0]!.key === 'Notice' &&
      noticed[0]!.tone === 'teal' &&
      JSON.stringify(noticed.slice(1)) === JSON.stringify(plain),
  )

  // Source needles: every late-settle road reaches the disclosure — the
  // three handles register the callback, the device runs land through the
  // settledAfterCancel read, the openai device leg's stale ref discloses,
  // the roster clears the seen notice, and the mount threads it into the
  // composer (the stills' own composer, so a still can carry it).
  const screen = read('src/components/BootLoginsScreen.tsx')
  t.check(
    'the three handles register onSettledAfterCancel',
    screen.includes('beginOpenaiBrowserConnect({ onListenerIssue, onSettledAfterCancel })') &&
      screen.includes('beginGeminiBrowserConnect({ onListenerIssue, onSettledAfterCancel })') &&
      screen.includes("beginOpenrouterConnect({ mode: leg === 'openrouter-browser' ? 'browser' : 'headless', onListenerIssue, onSettledAfterCancel })"),
  )
  t.check(
    'the device runs land through the settledAfterCancel read (driver sentence verbatim)',
    screen.includes('if (outcome.settledAfterCancel === true) {') &&
      screen.includes('discloseLateSettle(outcome.receipt)'),
  )
  t.check(
    "the openai device leg's stale landing discloses (the stop-watching completion made loud)",
    screen.includes("discloseLateSettle(lateSettleNotice('openai'))"),
  )
  t.check(
    'the roster clears the seen notice and the mount threads it into the composer',
    screen.includes('setNotice(null); // the operator moved on') &&
      screen.includes('summaryRows: loginsSummaryRows(facts, opts.notice ?? null)'),
  )

  // The in-chat mid-wait receipts: the may-still-land shape at the esc
  // sites where an exchange can be in flight; the pre-flow cancels keep
  // the plain nothing-stored truth.
  const { KIMI_CONNECT_STOPPED_RECEIPT } = await import('../../src/services/providers/moonshot/moonshotLogin.js')
  const { HUGGINGFACE_CONNECT_STOPPED_RECEIPT } = await import('../../src/services/providers/huggingface/huggingfaceLogin.js')
  const { OPENROUTER_CONNECT_STOPPED_RECEIPT, OPENROUTER_CONNECT_CANCELLED_RECEIPT } = await import('../../src/services/providers/openrouter/openrouterLogin.js')
  t.check(
    'the mid-wait receipts admit an in-flight approval may land, naming /accounts',
    [KIMI_CONNECT_STOPPED_RECEIPT, HUGGINGFACE_CONNECT_STOPPED_RECEIPT, OPENROUTER_CONNECT_STOPPED_RECEIPT].every(
      receipt => /already in flight|already completing/.test(receipt) && receipt.includes('/accounts'),
    ) && OPENROUTER_CONNECT_CANCELLED_RECEIPT.includes('nothing stored'),
  )
  const kimi = read('src/components/KimiConnect.tsx')
  const hf = read('src/components/HuggingfaceConnect.tsx')
  t.check(
    'the in-chat device esc sites speak the STOPPED receipts (pre-flow cancels keep nothing-stored)',
    kimi.includes('settle(KIMI_CONNECT_STOPPED_RECEIPT)') &&
      kimi.includes("onCancel={() => settle('Kimi sign-in cancelled — nothing stored.')}") &&
      hf.includes('settle(HUGGINGFACE_CONNECT_STOPPED_RECEIPT)') &&
      hf.includes("onCancel={() => settle('Hugging Face sign-in cancelled — nothing stored.')}"),
  )
}

// ── §14 THE SETTLE'S CAPTURED POSTURE (the
//    handoff's fourth row, adjudicated SOUND): the killswitch re-check's
//    captured posture cannot go stale across the async gap, structurally —
//    (1) the app store's setState runs its updater SYNCHRONOUSLY, so the
//    capture lands before the bump call returns and the re-check fires in
//    the same tick; (2) the captured posture feeds only the availability
//    short-circuit, which is read BEFORE any await; (3) the disable WRITE
//    rides a functional updater reading FRESH prev at write time — a
//    posture change across the check's own IO lands on fresh state, never
//    the captured copy. Pinned so a refactor that breaks any leg reds. ──
{
  const { createStore } = await import('../../src/state/store.js')
  const store = createStore<{ n: number }>({ n: 1 })
  let captured: number | null = null
  store.setState(prev => {
    captured = prev.n
    return { n: prev.n + 1 }
  })
  t.check(
    'the app store runs updaters synchronously (the capture lands before setState returns)',
    captured === 1 && store.getState().n === 2,
  )

  const screen = read('src/components/BootLoginsScreen.tsx')
  t.check(
    'the settle captures the posture INSIDE the bump updater (one tick, no gap)',
    screen.includes('capturedContext = prev.toolPermissionContext;') &&
      screen.includes('void killswitch.checkAndDisableBypassPermissionsIfNeeded(capturedContext, setAppStateMaybe)'),
  )
  const killswitch = read('src/utils/permissions/bypassPermissionsKillswitch.ts')
  const availabilityAt = killswitch.indexOf('if (!context.isBypassPermissionsModeAvailable) return')
  const ioAt = killswitch.indexOf('isBypassPermissionsModeDisabled()')
  t.check(
    'the availability read precedes the IO await, and the disable write reads FRESH prev (never the captured posture)',
    availabilityAt !== -1 &&
      ioAt !== -1 &&
      availabilityAt < ioAt &&
      killswitch.includes('createDisabledBypassPermissionsContext(prev.toolPermissionContext)'),
  )
}

t.section('§15 — THE CLASSIC FRAME CLAMP (no entry row overruns the columns; the legend keeps the way out)')
{
  // The classic composer centers by the WIDEST line and used to emit entry
  // rows wider than the frame (the fixed label budget never measured the
  // VALUE column — the Kimi 'kimi.ai (global) · window reached' value at 64
  // cols overran by 15 and the terminal's wrap broke the grid). The clamp:
  // every classic line clips to the columns EXCEPT the legend, whose tail is
  // 'esc back' — the way out sheds LAST (the micro tier's law), so an
  // overwide legend wraps rather than losing its exit word.
  const { loginsMenuModelOf, lateSettleNotice } = await import('../../src/components/BootLoginsScreen.js')
  const { createSplashCore } = (await import('../../assets/splash/splash-core.mjs')) as never as {
    createSplashCore: (o: { nocolor: boolean; truecolor: boolean; accent: string }) => {
      composeBootMenu: (c: number, r: number, m: unknown) => { lines: string[] }
      placeBlock: (l: string[], r: number) => { placed: string[]; top: number }
    }
  }
  const { mixedFacts } = await import('./face-logins-stills.ts')
  const environment = { model: 'fable', critter: 'Fox', critterHue: '#e2725b', dirBase: 'proj', dirTail: '' }
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'fox' })
  for (const [cols, rows] of [
    [64, 16],
    [64, 20],
    [80, 24],
  ] as const) {
    const m = loginsMenuModelOf(mixedFacts(), { selIdx: 0, environment, notice: lateSettleNotice('huggingface') })
    const { lines } = core.composeBootMenu(cols, rows, m)
    const { placed } = core.placeBlock(lines, rows)
    const legend = placed[placed.length - 1] ?? ''
    const body = placed.slice(0, -1)
    const over = body.filter(l => l.length > cols)
    t.check(
      `${cols}x${rows}: every classic body line fits the frame (the entry value column can no longer overrun)`,
      over.length === 0,
      over.length > 0 ? `first overwide: ${JSON.stringify(over[0])}` : '',
    )
    t.check(`${cols}x${rows}: the legend keeps the way out (never clipped into a wall)`, legend.includes('esc back'), JSON.stringify(legend))
  }

  // THE NOTICE AT EVERY SIZE (ruled Way A — the dedicated
  // noticeLine): summaryRows paint ONLY in the wide ≥110-col tier, so the
  // late-settle disclosure was invisible on every narrower terminal (80×24
  // included) while §13 pinned the model. The classic tier now paints the
  // ONE upstream notice as a wrapped teal block above the entries, budgeted
  // so the way-out chrome and the list floor never yield; absence is
  // byte-identical.
  const sentence = lateSettleNotice('huggingface')
  for (const [cols, rows] of [
    [64, 12],
    [64, 13],
    [80, 24],
  ] as const) {
    const m = loginsMenuModelOf(mixedFacts(), { selIdx: 0, environment, notice: sentence })
    const { placed } = core.placeBlock(core.composeBootMenu(cols, rows, m).lines, rows)
    const joined = placed.join('\n')
    t.check(
      `${cols}x${rows}: the disclosure paints in the classic tier (visible, inside the frame, way out kept)`,
      placed.length <= rows &&
        joined.includes('completed after cancel') &&
        placed.every(l => l.length <= cols) &&
        (placed[placed.length - 1] ?? '').includes('esc back'),
      `placed=${placed.length} visible=${joined.includes('completed after cancel')}`,
    )
  }
  {
    const bare = loginsMenuModelOf(mixedFacts(), { selIdx: 0, environment })
    const withNull = loginsMenuModelOf(mixedFacts(), { selIdx: 0, environment, notice: null })
    t.check(
      'notice absence is byte-identical (null and unset compose the same classic frame)',
      JSON.stringify(core.composeBootMenu(64, 16, bare).lines) === JSON.stringify(core.composeBootMenu(64, 16, withNull).lines),
    )
    // A cramped frame CLIPS the wrap with an ellipsis rather than pushing
    // the block past the rows — drive a pathologically long sentence.
    const longM = loginsMenuModelOf(mixedFacts(), {
      selIdx: 0,
      environment,
      notice: sentence + ' ' + sentence + ' ' + sentence,
    })
    const { placed } = core.placeBlock(core.composeBootMenu(64, 12, longM).lines, 12)
    t.check(
      'a pathological notice clips to its slack (ellipsis; the block never exceeds the rows; way out kept)',
      placed.length <= 12 && placed.join('\n').includes('…') && (placed[placed.length - 1] ?? '').includes('esc back'),
      `placed=${placed.length}`,
    )
  }
}

t.finish('prove-face-logins')
