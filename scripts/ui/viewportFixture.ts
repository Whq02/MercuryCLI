import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

export const ROOT = resolve(import.meta.dirname, '../..')

export function option(name: string): string {
  const at = process.argv.indexOf(name)
  const value = at < 0 ? undefined : process.argv[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`Required: ${name} <value>`)
  return value
}

export function fixture(scratchRoot: string) {
  if (!isAbsolute(scratchRoot)) throw new Error('The scratch root must be absolute')
  const root = mkdtempSync(join(scratchRoot, 'viewport-'))
  const home = join(root, 'home')
  const cwd = join(root, 'orchard')
  const config = join(home, '.mercury')
  const daemonDir = process.platform === 'win32' ? join(config, 'daemon') : '.daemon'
  const daemon = resolve(cwd, daemonDir)
  mkdirSync(config, { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(config, '.mercury.json'), JSON.stringify({
    theme: 'dark', hasCompletedOnboarding: true,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [FIXTURE_API_KEY], rejected: [] },
    switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
  }))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    TMPDIR: root, TMP: root, TEMP: root,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1',
    MERCURY_CONFIG_DIR: config, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_OPERATOR: 'operator',
    MERCURY_DAEMON_DIR: daemonDir, MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_UPDATE_NOTICE: '0',
    MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_TURN_RECEIPT: '0',
    MERCURY_DESKTOP_DRIVER: 'none', BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', OPENAI_BASE_URL: 'http://127.0.0.1:9',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
    GEMINI_BASE_URL: 'http://127.0.0.1:9', HF_BASE_URL: 'http://127.0.0.1:9',
    ZAI_BASE_URL: 'http://127.0.0.1:9', MOONSHOT_BASE_URL: 'http://127.0.0.1:9',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
  }
  for (const key of ['MERCURY_VSHOT_BUDGET_SCALE', 'MERCURY_PYTHON', 'MERCURY_VSHOT_EMULATOR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { root, home, config, cwd, daemon, env, dispose: () => rmSync(root, { recursive: true, force: true }) }
}
