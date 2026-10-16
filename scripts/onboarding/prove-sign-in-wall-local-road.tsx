#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const scenarioAt = process.argv.indexOf('--scenario')
const scenario = scenarioAt < 0 ? null : (process.argv[scenarioAt + 1] ?? null)
const MODELS = ['qwen3.6:35b-a3b-coding', 'qwen3.6:27b-coding', 'qwen3.8:27b-mtp-q4_K_M']

if (scenario !== null) {
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, MERCURY_DEMO: false }
  const withServer = scenario === 'local' || scenario === 'local-primed'
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
    process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${root}`
  } else {
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  }
  const React = await import('react')
  const { KEY, mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const handover = await import('../../src/substrate/splashHandover.js')
  const discovery = await import('../../src/services/providers/local/localDiscovery.js')
  if (scenario === 'local-primed') await discovery.refreshLocalDiscovery({ force: true })
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { Onboarding } = await import('../../src/components/Onboarding.js')
  const { loginFamilyRows } = await import('../../src/components/loginFamilyRows.ts')
  const h = React.createElement
  const element = h(AppStateProvider as never, { onChangeAppState: () => {} } as never, h(KeybindingSetup as never, {} as never, h(Onboarding as never, { onDone: () => {} } as never)))
  const mounted = await mountOffscreen(element, 120, 40)
  const until = async (needle: string): Promise<boolean> => waitFor(() => mounted.screen().includes(needle), 15_000)
  const frames: Record<string, string> = {}
  const shot = async (name: string, needle: string): Promise<void> => {
    const ok = await until(needle)
    await settle(300)
    frames[name] = `${ok ? '' : `[never saw: ${needle}]\n`}${mounted.screen()}`
  }
  await shot('theme', 'Choose your theme')
  mounted.push(KEY.enter)
  await shot('catalogue', withServer ? 'or run a local model' : 'Sign in later')
  for (let i = 0; i < loginFamilyRows({ engineLegs: true }).length; i++) {
    mounted.push(KEY.down)
    await settle(60)
  }
  await settle(300)
  frames['focused'] = mounted.screen()
  mounted.push(KEY.enter)
  await shot('after', 'Guardrails')
  frames['door'] = String(handover.peekFaceDoorDeepLink())
  frames['probed'] = String(discovery.getCachedLocalDiscovery()?.servers.length ?? -1)
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
const run = (tag: string): Record<string, string> => {
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
  const r = spawnSync(process.execPath, ['run', SELF, '--scenario', tag], { encoding: 'utf8', env, timeout: 120_000 })
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
  check('the station is offered (sign in · 2/N on the rail)', /sign in · 2\/\d/.test(catalogue), catalogue.split('\n').slice(0, 3).join(' / '))
  check(`the last row reads "Sign in later to look around, ${LOCAL_WORDS}"`, flat(catalogue).includes(`Sign in later to look around, ${LOCAL_WORDS}`), flat(catalogue).slice(-400))
  check('the words "Sign-in is required to run the agent" are nowhere on the frame', !flat(catalogue).includes('Sign-in is required to run the agent'))
  check('the fourteen hosted rows still stand above it', flat(catalogue).includes('OpenAI — ChatGPT subscription') && flat(catalogue).includes('OpenCode Zen'))
  check('↓ to the end focuses the local row', focusedRow(frames.focused ?? '').startsWith('Sign in later to look around, or run a local model'), focusedRow(frames.focused ?? ''))
  check('Enter continues the walk credential-free (Guardrails next)', (frames.after ?? '').includes('Guardrails'), (frames.after ?? '').split('\n').slice(0, 3).join(' / '))
  check("Enter armed the 'model' face door: the home face opens the model picker on arrival", frames.door === 'model', `door=${frames.door} probed=${frames.probed}`)
}

console.log('§2 the probe landed before the walk mounted (the picker already knows the server): the station is still offered, with the same row')
{
  const frames = run('local-primed')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check('a found local server never skips the sign-in station', /sign in · 2\/\d/.test(catalogue) && flat(catalogue).includes(LOCAL_WORDS), catalogue.split('\n').slice(0, 3).join(' / '))
  check("Enter on the row arms the 'model' door here too", frames.door === 'model', `door=${frames.door}`)
}

console.log('§3 no local server answers: the row keeps its words, Enter arms nothing')
{
  const frames = run('none')
  const catalogue = frames.catalogue ?? frames.error ?? ''
  check('the row reads "Sign in later to look around. Sign-in is required to run the agent."', flat(catalogue).includes('Sign in later to look around. Sign-in is required to run the agent.'), flat(catalogue).slice(-300))
  check('no local words paint', !flat(catalogue).includes('run a local model'))
  check('Enter continues the walk (Guardrails next)', (frames.after ?? '').includes('Guardrails'))
  check('no face door is armed', frames.door === 'null', `door=${frames.door}`)
}

console.log('§4 the wiring: the door opens the picker; the row owner holds the words')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const face = read('src/components/BootSplashScreen.tsx')
  const handover = read('src/substrate/splashHandover.ts')
  const card = read('src/components/ConsoleOAuthFlow.tsx')
  const rows = read('src/components/loginFamilyRows.ts')
  const onboarding = read('src/components/Onboarding.tsx')
  check("the face-door union carries 'model'", /export type FaceDoorDeepLink = [^\n]*'model'/.test(handover))
  check("the home face opens the model-default picker when the 'model' door is armed", face.includes("useState(faceDoor === 'model' && sessionDefaultsKeyOn())"))
  check('the card paints the row owner\'s local-aware row and arms the door on Enter', card.includes('signInLaterRow(localRoad)') && card.includes("if (localRoadOpen(localRoad)) armFaceDoorDeepLink('model')"))
  check('the card kicks the same TTL\'d discovery the picker uses, only when it hosts the walk\'s row', /if \(walkHost\) void refreshLocalDiscovery\(\)/.test(card))
  check('the words live in the row owner', rows.includes('or run a local model — ${local!.models} found on ${local!.labels.join'))
  check('the station gate never counts the local lane as a credential', onboarding.includes("lane.provider !== 'local' && lane.usable"))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-sign-in-wall-local-road: ALL GREEN' : `\nprove-sign-in-wall-local-road: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
