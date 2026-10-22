#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const scenarioAt = process.argv.indexOf('--scenario')
const scenario = scenarioAt < 0 ? null : (process.argv[scenarioAt + 1] ?? null)
const sizeAt = process.argv.indexOf('--size')
const [COLS, ROWS] = (sizeAt < 0 ? '120x40' : (process.argv[sizeAt + 1] ?? '120x40')).split('x').map(Number) as [number, number]

if (scenario !== null) {
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, MERCURY_DEMO: false }
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const React = await import('react')
  const { KEY, mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { Onboarding } = await import('../../src/components/Onboarding.js')
  const h = React.createElement
  const element = h(AppStateProvider as never, { onChangeAppState: () => {} } as never, h(KeybindingSetup as never, {} as never, h(Onboarding as never, { onDone: () => {} } as never)))
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
  await settle(300)
  frames['firstScreen'] = mounted.screen()
  if (scenario === 'esc-from-station') {
    mounted.push(KEY.esc)
    await settle(400)
    frames['afterEsc'] = mounted.screen()
    mounted.unmount()
    process.stdout.write(JSON.stringify(frames))
    process.exit(0)
  }
  mounted.push('s')
  await settle(400)
  frames['afterS'] = mounted.screen()
  mounted.push(KEY.esc)
  await settle(400)
  frames['afterEsc'] = mounted.screen()
  mounted.unmount()
  process.stdout.write(JSON.stringify(frames))
  process.exit(0)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const DEAD = 'http://127.0.0.1:9'
const SCRATCH = mkdtempSync(join(tmpdir(), 'provider-skip-key-'))
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
    TERM_PROGRAM: 'vscode',
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

console.log('§1 the first screen of the sign-in station names the skip key and the later row, at 80×24 and at 120×40')
for (const size of ['80x24', '120x40']) {
  const frames = run('skip-then-esc', size)
  const first = frames.firstScreen ?? frames.error ?? ''
  check(`${size}: the station paints (sign in · 2/N on the rail)`, /sign in · 2\/\d/.test(first), first.split('\n').slice(0, 3).join(' / '))
  check(`${size}: the footer names the skip key (s skip)`, /s skip/.test(flat(first)), flat(first).slice(-160))
  check(`${size}: the footer keeps the honest verbs`, /↵ choose/.test(flat(first)) && /esc back/.test(flat(first)), flat(first).slice(-160))
}

console.log('§2 pressing s on the FIRST screen activates the skip without paging (Guardrails next)')
{
  const frames = run('skip-then-esc', '80x24')
  const first = frames.firstScreen ?? frames.error ?? ''
  const afterS = frames.afterS ?? frames.error ?? ''
  const afterEsc = frames.afterEsc ?? frames.error ?? ''
  check('80x24: s moves the walk forward (Guardrails paints)', afterS.includes('Guardrails'), afterS.split('\n').slice(0, 3).join(' / '))
  check('80x24: the step tag advanced without a credential (guardrails · 3/N)', /guardrails · 3\/\d/.test(afterS), afterS.split('\n').slice(0, 3).join(' / '))
  check('80x24: the first window still paints the provider rows above the later row', /OpenAI — ChatGPT subscription/.test(first), flat(first).slice(0, 200))
  check('80x24: esc keeps its meaning after the skip (backs to the sign-in station, not out of the walk)', /sign in · 2\/\d/.test(afterEsc), afterEsc.split('\n').slice(0, 3).join(' / '))
}

console.log('§2b esc on the provider station itself keeps its meaning (backs a step to the theme, never exits)')
{
  const frames = run('esc-from-station', '80x24')
  const afterEsc = frames.afterEsc ?? frames.error ?? ''
  check('80x24: esc on the station backs a step (theme paints again)', afterEsc.includes('Choose your theme'), afterEsc.split('\n').slice(0, 3).join(' / '))
}

console.log('§3 the wiring: the card holds the key handling and the footer words; no other move changed')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const onboarding = read('src/components/Onboarding.tsx')
  const card = read('src/components/ConsoleOAuthFlow.tsx')
  check("the walk footer names the skip: '↑↓ move · ↵ choose · s skip · esc back'", onboarding.includes("provider: '↑↓ move · ↵ choose · s skip · esc back'"), onboarding.split('\n').find(l => l.includes('provider:')) ?? '')
  check('the card holds the s handling beside the c handling: only while the idle list stands and only with the skip row offered', /input === 's' &&/.test(card) && /menuUp && onSkip !== undefined/.test(card))
  check('the s press stops the event so the list never eats it', /event\.stopImmediatePropagation\(\)/.test(card.slice(card.indexOf("input === 's'"), card.indexOf("input === 's'") + 900)))
  check('esc handling is untouched: a pending leg still abandons to the catalogue, a popup esc still cancels', /key\.escape && \(state\.name === 'ready' \|\| state\.name === 'waiting' \|\| state\.name === 'error'\)/.test(card))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-provider-skip-key: ALL GREEN' : `\nprove-provider-skip-key: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
