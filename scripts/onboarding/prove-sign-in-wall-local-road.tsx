#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const scenarioAt = process.argv.indexOf('--scenario')
const scenario = scenarioAt < 0 ? null : (process.argv[scenarioAt + 1] ?? null)
const sizeAt = process.argv.indexOf('--size')
const [COLS, ROWS] = (sizeAt < 0 ? '120x40' : (process.argv[sizeAt + 1] ?? '120x40')).split('x').map(Number) as [number, number]
const MODELS = ['qwen3.6:35b-a3b-coding', 'qwen3.6:27b-coding', 'qwen3.8:27b-mtp-q4_K_M']

if (scenario !== null) {
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, MERCURY_DEMO: false }
  const withServer = scenario === 'local' || scenario === 'local-primed' || scenario === 'local-default'
  let close = (): void => {}
  if (withServer) {
    const json = (res: ServerResponse, body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const root = await new Promise<string>(resolve => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        req.on('data', () => {})
        req.on('end', () => {
          const url = req.url ?? ''
          if (url === '/api/tags') return json(res, { models: MODELS.map(name => ({ name, model: name, size: 1024, details: { family: 'qwen3' } })) })
          if (url === '/api/version') return json(res, { version: '0.34.4' })
          if (url === '/api/ps') return json(res, { models: [] })
          if (url === '/api/show') return json(res, { parameters: '', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 }, capabilities: ['completion', 'tools'] })
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`)
      })
      close = () => server.close()
    })
    if (scenario === 'local-default') {
      delete process.env.MERCURY_LOCAL_PROBE_TARGETS
      const realFetch = globalThis.fetch
      const reroute = (url: string): string => (url.startsWith('http://127.0.0.1:11434/') ? `${root}${url.slice('http://127.0.0.1:11434'.length)}` : url.replace(/^http:\/\/127\.0\.0\.1:(1234|8000|8080)\//, 'http://127.0.0.1:9/'))
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => realFetch(typeof input === 'string' ? reroute(input) : input instanceof URL ? reroute(input.href) : input, init)) as typeof fetch
    } else {
      process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${root}`
    }
  } else {
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  }
  const React = await import('react')
  const { KEY, mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const { enableConfigs } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const handover = await import('../../src/platform/substrate/splashHandover.js')
  const discovery = await import('../../src/models/roads/local/localDiscovery.js')
  if (scenario === 'local-primed') await discovery.refreshLocalDiscovery({ force: true })
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
  const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
  const { Onboarding } = await import('../../src/boot/first-run/Onboarding.js')
  const { loginFamilyRows } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.ts')
  const h = React.createElement
  const element = h(AppStateProvider as never, {} as never, h(KeybindingSetup as never, {} as never, h(Onboarding as never, { onDone: () => {} } as never)))
  const mounted = await mountOffscreen(element, COLS, ROWS)
  const until = async (needle: string | RegExp): Promise<boolean> => waitFor(() => (typeof needle === 'string' ? mounted.screen().includes(needle) : needle.test(mounted.screen())), 15_000)
  const frames: Record<string, string> = {}
  const shot = async (name: string, needle: string | RegExp): Promise<void> => {
    const ok = await until(needle)
    await settle(300)
    frames[name] = `${ok ? '' : `[never saw: ${needle}]\n`}${mounted.screen()}`
  }
  await shot('theme', 'Choose your theme')
  mounted.push(KEY.enter)
  await shot('catalogue', /sign in · 2\/\d/)
  const focusedLine = (): string => mounted.screen().split('\n').find(line => /[▸❯]/.test(line)) ?? ''
  for (let i = 0; i <= loginFamilyRows({ engineLegs: true, tensorfold: { kind: 'host' } }).length && !focusedLine().includes('Sign in later'); i++) {
    mounted.push(KEY.down)
    await settle(60)
  }
  if (withServer) await until('or run a local model')
  await settle(300)
  frames['focused'] = mounted.screen()
  mounted.push(KEY.enter)
  await shot('after', 'Guardrails')
  frames['door'] = String(handover.peekFaceDoorDeepLink())
  frames['probed'] = String(discovery.getCachedLocalDiscovery()?.servers.length ?? -1)
  frames['targets'] = discovery.localProbeTargets(process.env).map(t => t.root).join(',')
  frames['probeEnv'] = String(process.env.MERCURY_LOCAL_PROBE_TARGETS)
  mounted.unmount()
  close()
  process.stdout.write(JSON.stringify(frames))
  process.exit(0)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const DEAD = 'http://127.0.0.1:9'
const SCRATCH = mkdtempSync(join(tmpdir(), 'sign-in-wall-local-road-'))
const run = (tag: string, size = '120x40'): Record<string, string> => {
  const home = mkdtempSync(join(SCRATCH, `${tag}-home-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_RECESS: '0',
    BROWSER: 'true',
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    TERM_PROGRAM: 'Apple_Terminal',
  }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MERCURY_COMPAT_BASE_URL|MERCURY_LOCAL_BASE_URL|MERCURY_LOCAL_PROBE_TARGETS|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR)$/.test(key)) delete env[key]
  }
  const r = spawnSync(process.execPath, ['run', SELF, '--scenario', tag, '--size', size], { encoding: 'utf8', env, timeout: 120_000 })
  rmSync(home, { recursive: true, force: true })
  const start = r.stdout.indexOf('{"theme"')
  const end = r.stdout.lastIndexOf('}')
  try {
    return JSON.parse(r.stdout.slice(start, end + 1)) as Record<string, string>
  } catch {
    return { error: `${r.status} · ${(r.stderr + r.stdout).slice(-900)}` }
  }
}
const flat = (grid: string): string => grid.split('\n').map(l => l.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '')).join(' ').replace(/\s+/g, ' ')
const focusedRow = (grid: string): string => grid.split('\n').find(l => /[▸❯]/.test(l))?.replace(/^.*[▸❯]\s*/, '').replace(/\s*│\s*$/, '').trim() ?? ''
const LOCAL_WORDS = `or run a local model — ${MODELS.length} found on Ollama 0.34.4`

console.log('§1 a local server answers while the sign-in station paints: the last row names the local road and Enter on it arms the model picker')
{
  const frames = run('local')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check('the station is offered (sign in · 2/N on the rail)', /sign in · 2\/\d/.test(catalogue), catalogue.split('\n').slice(0, 3).join(' / ') + ' — the sign-in station did not paint; if this text is a child exit status and stderr, the scenario crashed, so fix what it names (the station is src/boot/first-run/Onboarding.tsx)')
  check(`the last row reads "Sign in later to look around, ${LOCAL_WORDS}"`, flat(frames.focused ?? '').includes(`Sign in later to look around, ${LOCAL_WORDS}`), 'change signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts, or the local discovery that feeds it; the focused frame ends: ' + flat(frames.focused ?? '').slice(-400))
  check('the words "Sign-in is required to run the agent" are nowhere on the frame', !flat(catalogue).includes('Sign-in is required to run the agent'), 'remove the words from the sign-in station text; the later-row words are owned by src/models/sign-in/flow-cards/loginFamilyRows.ts')
  check('the fourteen hosted rows still stand above it', flat(catalogue).includes('OpenAI — ChatGPT subscription') && flat(catalogue).includes('OpenCode Zen'), 'restore the hosted rows that loginFamilyRows in src/models/sign-in/flow-cards/loginFamilyRows.ts returns to the sign-in station')
  check('↓ to the end focuses the local row', focusedRow(frames.focused ?? '').startsWith('Sign in later to look around, or run a local model'), focusedRow(frames.focused ?? '') + ' — the last row must be the sign-in-later row from signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts')
  check('Enter continues the walk credential-free (Guardrails next)', (frames.after ?? '').includes('Guardrails'), (frames.after ?? '').split('\n').slice(0, 3).join(' / ') + ' — Enter on the later row must move on to the Guardrails step; see the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx')
  check("Enter armed the 'model' face door: the home face opens the model picker on arrival", frames.door === 'model', `door=${frames.door} probed=${frames.probed} — the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx must call armFaceDoorDeepLink('model') when localRoadOpen is true`)
}

console.log('§1b a FRESH home on the default road (MERCURY_LOCAL_PROBE_TARGETS unset): the station probes the documented default ports itself and paints the found row from the server on 11434')
{
  const frames = run('local-default')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check('the child saw no probe variable (the default road, not a pinned target set)', frames.probeEnv === 'undefined', `probeEnv=${frames.probeEnv} — the scenario child must run with MERCURY_LOCAL_PROBE_TARGETS deleted`)
  check('the targets the station probed are the four documented defaults, Ollama first on 11434', frames.targets === 'http://127.0.0.1:11434,http://127.0.0.1:1234,http://127.0.0.1:8000,http://127.0.0.1:8080', `targets=${frames.targets} — change the default target list that localProbeTargets reads in src/models/roads/local/localDiscovery.ts`)
  check(`the last row reads "Sign in later to look around, ${LOCAL_WORDS}" — the station's own refresh landed and repainted the wall`, flat(frames.focused ?? '').includes(`Sign in later to look around, ${LOCAL_WORDS}`), 'the station must start its own local discovery refresh and repaint the row (signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts); the focused frame ends: ' + flat(frames.focused ?? '').slice(-400))
  check('no-server words are nowhere on the frame', !flat(catalogue).includes('The agent needs a sign-in or a local model'), 'the no-server row (SIGN_IN_LATER_ROW in src/models/sign-in/flow-cards/loginFamilyRows.ts) painted although a server answered on 11434')
  check('one server in the snapshot (the three dead default ports are simply absent)', frames.probed === '1', `probed=${frames.probed} — the cached snapshot from getCachedLocalDiscovery in src/models/roads/local/localDiscovery.ts should hold only the Ollama server`)
  check("Enter on the row arms the 'model' door", frames.door === 'model', `door=${frames.door} — the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx must call armFaceDoorDeepLink('model')`)
}

console.log('§2 the probe landed before the walk mounted (the picker already knows the server): the station is still offered, with the same row')
{
  const frames = run('local-primed')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check('a found local server never skips the sign-in station', /sign in · 2\/\d/.test(catalogue) && flat(frames.focused ?? '').includes(LOCAL_WORDS), catalogue.split('\n').slice(0, 3).join(' / ') + ' — a server already in the discovery cache must not skip the station and must still show the found-server row (signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts)')
  check("Enter on the row arms the 'model' door here too", frames.door === 'model', `door=${frames.door} — the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx must call armFaceDoorDeepLink('model')`)
}

const NO_SERVER_ROW = 'Sign in later to look around. The agent needs a sign-in or a local model (/localsetup).'
console.log('§3 no local server answers: the row says a sign-in OR a local model is needed and names /localsetup, Enter arms nothing')
{
  const frames = run('none')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check(`the row reads "${NO_SERVER_ROW}"`, flat(catalogue).includes(NO_SERVER_ROW), 'change SIGN_IN_LATER_ROW in src/models/sign-in/flow-cards/loginFamilyRows.ts to the expected words; the frame ends: ' + flat(catalogue).slice(-300))
  check('the row stands on ONE line at 120×40', catalogue.split('\n').some(line => line.includes(NO_SERVER_ROW)), catalogue.split('\n').filter(line => line.includes('Sign in later')).join(' / ') + ' — shorten SIGN_IN_LATER_ROW in src/models/sign-in/flow-cards/loginFamilyRows.ts or the row layout so it fits one line')
  check('/localsetup is on the no-server frame (the readiness row that names it sits below the fold)', catalogue.includes('/localsetup'), 'SIGN_IN_LATER_ROW in src/models/sign-in/flow-cards/loginFamilyRows.ts must name /localsetup')
  check('the words "Sign-in is required to run the agent" are nowhere on this frame either', !flat(catalogue).includes('Sign-in is required to run the agent'), 'remove those words from the sign-in station text; the later-row words are owned by src/models/sign-in/flow-cards/loginFamilyRows.ts')
  check('no found-server words paint', !flat(catalogue).includes('run a local model —'), 'with MERCURY_LOCAL_PROBE_TARGETS=none no server may be found; signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts must return SIGN_IN_LATER_ROW when localRoadOpen is false')
  check('↓ to the end focuses the row, /localsetup still on the frame', focusedRow(frames.focused ?? '').startsWith('Sign in later to look around. The agent needs') && (frames.focused ?? '').includes('/localsetup'), focusedRow(frames.focused ?? '') + ' — the last row must be SIGN_IN_LATER_ROW from src/models/sign-in/flow-cards/loginFamilyRows.ts, with /localsetup on the frame')
  check('Enter continues the walk (Guardrails next)', (frames.after ?? '').includes('Guardrails'), 'Enter on the later row must move on to the Guardrails step; see the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx')
  check('no face door is armed', frames.door === 'null', `door=${frames.door} — the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx must call armFaceDoorDeepLink only when localRoadOpen is true`)
}

console.log('§3b the same at 80×24: the row is below the first window, focused it wraps to two lines and /localsetup is on the frame')
{
  const frames = run('none', '80x24')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check('the station paints at 80×24 (sign in · 2/N on the rail)', /sign in · 2\/\d/.test(catalogue), catalogue.split('\n').slice(0, 3).join(' / '))
  const focused = frames.focused ?? ''
  check('↓ to the end focuses the row', focusedRow(focused).startsWith('Sign in later to look around. The agent needs'), focusedRow(focused) + ' — the last row must be SIGN_IN_LATER_ROW from src/models/sign-in/flow-cards/loginFamilyRows.ts')
  const unboxed = focused.split('\n').map(line => line.replace(/[│╭╮╰╯─]/g, ' ')).join(' ').replace(/\s+/g, ' ')
  check(`the whole row reads across its wrapped lines: "${NO_SERVER_ROW}"`, unboxed.includes(NO_SERVER_ROW), 'the focused row must wrap, not truncate, at 80 columns (SIGN_IN_LATER_ROW in src/models/sign-in/flow-cards/loginFamilyRows.ts); the frame ends: ' + unboxed.slice(-300))
  check('/localsetup is on the 80×24 frame', focused.includes('/localsetup'), 'the focused later row must wrap so /localsetup stays visible at 80×24')
  check('Enter continues the walk (Guardrails next)', (frames.after ?? '').includes('Guardrails'), 'Enter on the later row must move on to the Guardrails step; see the later-row branch in src/models/sign-in/flow-cards/SignInFlow.tsx')
}

console.log('§4 the wiring: the door opens the picker; the row owner holds the words')
{
  const { LOCAL_NO_SERVER_BLOCKER } = await import('../../src/models/roads/local/localAccounts.ts')
  const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.ts')
  check("the wall's readiness row for Local servers names /localsetup when no server answers (the readiness block below the roster paints this blocker)", LOCAL_NO_SERVER_BLOCKER.includes('/localsetup sets one up (Ollama, LM Studio, vLLM, llama.cpp)') && resolveProviderUsability({ anthropicApiKey: () => null, anthropicSubscriber: () => false, anthropicBearerToken: () => false, anthropicLimitStatus: () => 'allowed', gptSeat: () => ({ state: 'disabled', reason: 'no OpenAI account is signed in', why: 'no-account' }), zaiKeyPresent: () => false, moonshotAccount: () => undefined, deepseekKeyPresent: () => false, xaiKeyPresent: () => false, compatConfigured: () => false, huggingfaceAccount: () => undefined, localServerPresent: () => false, openrouterKeyPresent: () => false, geminiAccount: () => undefined }).local.blockers[0] === LOCAL_NO_SERVER_BLOCKER)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-sign-in-wall-local-road: ALL GREEN' : `\nprove-sign-in-wall-local-road: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
