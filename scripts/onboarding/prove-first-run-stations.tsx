#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const scenarioAt = process.argv.indexOf('--scenario')
const scenario = scenarioAt < 0 ? null : (process.argv[scenarioAt + 1] ?? null)

if (scenario !== null) {
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, MERCURY_DEMO: false }
  const React = await import('react')
  const { KEY, mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
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
  if (scenario === 'bare') {
    await shot('catalogue', 'Sign in later')
    for (let i = 0; i < loginFamilyRows({ engineLegs: true }).length; i++) {
      mounted.push(KEY.down)
      await settle(60)
    }
    await settle(300)
    mounted.push(KEY.enter)
    await shot('guardrails', 'Guardrails')
    mounted.push(KEY.enter)
    await shot('terminal', 'Terminal keys')
  } else {
    await shot('after-theme', 'Guardrails')
  }
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
const SCRATCH = mkdtempSync(join(tmpdir(), 'first-run-stations-'))
const run = (tag: string, extraEnv: Record<string, string>): Record<string, string> => {
  const home = mkdtempSync(join(SCRATCH, `${tag}-home-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
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
    ...extraEnv,
  }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MERCURY_COMPAT_BASE_URL|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR)$/.test(key) && !(key in extraEnv)) delete env[key]
  }
  const r = spawnSync(process.execPath, ['run', SELF, '--scenario', tag], { encoding: 'utf8', env, timeout: 120_000 })
  rmSync(home, { recursive: true, force: true })
  const start = r.stdout.indexOf('{"theme"')
  const end = r.stdout.lastIndexOf('}')
  try {
    return JSON.parse(r.stdout.slice(start, end + 1)) as Record<string, string>
  } catch {
    return { error: `${r.status} · ${(r.stderr + r.stdout).slice(-600)}` }
  }
}
const focusedRow = (grid: string): string => grid.split('\n').find(l => /▸/.test(l))?.replace(/^.*▸\s*/, '').replace(/\s*│\s*$/, '').trim() ?? ''
const flat = (grid: string): string => grid.split('\n').map(l => l.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '')).join(' ').replace(/\s+/g, ' ')

console.log('§1 a fresh home with no credential: the terminal station is opt-in and says what Yes writes')
{
  const frames = run('bare', {})
  const terminal = frames.terminal ?? frames.error ?? ''
  check('the walk carried a sign-in station (no credential anywhere)', (frames.catalogue ?? '').includes('sign in · 2/5'), (frames.catalogue ?? frames.error ?? '').split('\n').slice(0, 3).join(' / '))
  check('the terminal station paints under Apple Terminal (terminal · 4/5)', terminal.includes('Terminal keys') && terminal.includes('terminal · 4/5') && terminal.includes("silence Terminal's bell"), terminal.split('\n').slice(0, 3).join(' / '))
  check('the sentence says WHERE Yes writes and that a backup is kept', /Yes writes those two keys into Terminal's own settings for every profile, with a backup kept beside them; Terminal needs a restart afterwards\./.test(flat(terminal)), flat(terminal).slice(0, 400))
  check('the focused row is "not now" — a bare ↵ writes nothing', /^not now;/.test(focusedRow(terminal)), focusedRow(terminal))
  check('"yes, set it up" is offered but not focused', terminal.includes('yes, set it up') && !/▸\s*yes, set it up/.test(terminal))
  check('the footer says esc backs a station (nothing is skipped by esc)', terminal.includes('↑↓ move · ↵ select · esc back') && !terminal.includes('esc skip'))
}

console.log('§2 a home whose environment carries a provider key: the walk has no sign-in station')
{
  const frames = run('env-key', { OPENROUTER_API_KEY: 'sk-or-v1-proof-key-not-real' })
  const after = frames['after-theme'] ?? frames.error ?? ''
  check('after the theme the walk lands on Guardrails, not the sign-in station (guardrails · 2/4)', after.includes('Guardrails') && after.includes('guardrails · 2/4'), after.split('\n').slice(0, 3).join(' / '))
  check('the rail has no "sign in" step', !after.includes('sign in'), after.split('\n').slice(0, 3).join(' / '))
  check('the "sign in later" row with its caveat never painted', !after.includes('Sign in later'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-first-run-stations: ALL GREEN' : `\nprove-first-run-stations: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
