#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '../..')
const PROBE = join(ROOT, 'scripts', 'splash', 'screen-probe.mjs')
const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const ROSTER = ['crab', 'octopus', 'jellyfish', 'clam'] as const
const MAIN_SGR: Readonly<Record<(typeof ROSTER)[number], string>> = {
  crab: '\x1b[38;2;221;68;68m',
  octopus: '\x1b[38;2;176;123;224m',
  jellyfish: '\x1b[38;2;111;199;232m',
  clam: '\x1b[38;2;22;216;176m',
}
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

const [mode, targetHome = ''] = process.argv.slice(2)

if (mode === '--app') {
  process.env.MERCURY_CONFIG_DIR = targetHome
  delete process.env.MERCURY_HOME
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { getSessionAccent, getSessionCritterKey } = await import('../../src/screen/widgets/sessionAccent.ts')
  console.log(JSON.stringify({ key: getSessionCritterKey(), accentKey: getSessionAccent().key, accent: getSessionAccent().accent }))
  process.exit(0)
}

if (mode === '--critter-select') {
  process.env.MERCURY_CONFIG_DIR = targetHome
  delete process.env.MERCURY_HOME
  const React = await import('react')
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
  const { CritterSelect } = await import('../../src/commands/critter/CritterSelect.js')
  const { renderToString } = await import('../../src/screen/renderer/staticRender.js')
  const element = React.createElement(
    AppStateProvider,
    {
      children: React.createElement(
        ThemeProvider,
        {
          children: React.createElement(CritterSelect, { onClose: () => {} }),
        },
      ),
    },
  )
  const text = (await renderToString(element, 100)).replace(ANSI, '')
  console.log(JSON.stringify({ lines: text.split('\n').map(l => l.trim()).filter(Boolean) }))
  process.exit(0)
}

const FIX = 'check currentProfileId in src/platform/profiles/profiles.ts, currentKey in src/screen/widgets/sessionAccent.ts, and computeCritterKey in assets/splash/mercury-splash.mjs'
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} · ` : ''}${FIX}`}`)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profile-critter-')))
try {
  const cleanEnv = (home: string, envCritter?: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, COLORTERM: 'truecolor', TERM: 'xterm-256color' }
    delete env.MERCURY_HOME
    delete env.NO_COLOR
    delete env.FORCE_COLOR
    delete env.MERCURY_TRUECOLOR
    if (envCritter !== undefined) env.MERCURY_CRITTER = envCritter
    else delete env.MERCURY_CRITTER
    return env
  }

  const readApp = (home: string, envCritter?: string): { key: string; accentKey: string; accent: string } => {
    const ran = spawnSync(process.execPath, [import.meta.path, '--app', home], {
      encoding: 'utf8',
      env: cleanEnv(home, envCritter),
      timeout: 60_000,
    })
    if (ran.status !== 0) throw new Error(`app child failed (${ran.status}): ${ran.stderr.slice(-400)}`)
    return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as { key: string; accentKey: string; accent: string }
  }

  let probeSeq = 0
  const readSplash = (home: string, envCritter?: string): { key: string; raw: string } => {
    const tee = join(scratch, `splash-${++probeSeq}.out`)
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(home, envCritter),
      MERCURY_SPLASH_ONESHOT: '1',
      MERCURY_SPLASH_VIEW: 'menu',
      MERCURY_REDUCED_MOTION: '1',
    }
    const ran = spawnSync('node', [PROBE, SPLASH, '150', '60', tee], { encoding: 'utf8', env, timeout: 60_000 })
    if (ran.status !== 0) throw new Error(`splash probe failed (${ran.status}): ${ran.stderr.slice(-400)}`)
    const raw = readFileSync(tee, 'utf8')
    const plain = raw.replace(ANSI, '')
    const match = /\bCritter\s+(\S+)/.exec(plain)
    return { key: (match?.[1] ?? '').toLowerCase(), raw }
  }

  const readCritterSelect = (home: string): string[] => {
    const ran = spawnSync(process.execPath, [import.meta.path, '--critter-select', home], {
      encoding: 'utf8',
      env: cleanEnv(home),
      timeout: 60_000,
    })
    if (ran.status !== 0) throw new Error(`critter-select child failed (${ran.status}): ${ran.stderr.slice(-400)}`)
    return (JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as { lines: string[] }).lines
  }

  const firstHome = join(scratch, 'first')
  mkdirSync(firstHome, { recursive: true })
  const homeForId = (id: number): string => {
    if (id === 1) return firstHome
    const dir = join(scratch, `profile-${id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.json'), `${JSON.stringify({ first: firstHome, id })}\n`)
    return dir
  }

  console.log('============================================================')
  console.log(' Profiles — default critter rotation (app + splash)')
  console.log('============================================================')

  for (let id = 1; id <= 9; id++) {
    const want = ROSTER[(id - 1) % ROSTER.length]!
    const home = homeForId(id)
    const app = readApp(home)
    const splash = readSplash(home)
    check(
      `profile ${id}: app and splash both default to ${want}`,
      app.key === want && app.accentKey === want && splash.key === want && splash.raw.includes(MAIN_SGR[want]),
      JSON.stringify({ id, want, app: app.key, splash: splash.key, hasRgb: splash.raw.includes(MAIN_SGR[want]) }),
    )
  }

  const p2 = homeForId(2)
  check('reading the default in profile 2 writes no .mercury.json', !existsSync(join(p2, '.mercury.json')), join(p2, '.mercury.json'))

  const selectLines = readCritterSelect(p2)
  const octopusRow = selectLines.find(l => l.includes('[2] octopus')) ?? ''
  const crabRow = selectLines.find(l => l.includes('[1] crab')) ?? ''
  check(
    '/critter in an unsaved profile 2 marks octopus as current (and not crab)',
    octopusRow.includes('❯') && octopusRow.includes('current') && !crabRow.includes('current'),
    JSON.stringify({ crabRow, octopusRow }),
  )

  const p2Saved = join(scratch, 'profile-2-saved')
  mkdirSync(p2Saved, { recursive: true })
  writeFileSync(join(p2Saved, 'profile.json'), `${JSON.stringify({ first: firstHome, id: 2 })}\n`)
  writeFileSync(join(p2Saved, '.mercury.json'), `${JSON.stringify({ defaultCritter: 'clam' })}\n`)
  const appSaved = readApp(p2Saved)
  const splashSaved = readSplash(p2Saved)
  check(
    'saved defaultCritter (clam) in profile 2 beats the profile default (octopus) in both app and splash',
    appSaved.key === 'clam' && splashSaved.key === 'clam',
    JSON.stringify({ app: appSaved.key, splash: splashSaved.key }),
  )

  const appEnvOverSaved = readApp(p2Saved, 'jellyfish')
  const splashEnvOverSaved = readSplash(p2Saved, 'jellyfish')
  check(
    'MERCURY_CRITTER (jellyfish) beats saved pick and profile default in both app and splash',
    appEnvOverSaved.key === 'jellyfish' && splashEnvOverSaved.key === 'jellyfish',
    JSON.stringify({ app: appEnvOverSaved.key, splash: splashEnvOverSaved.key }),
  )

  const appEnvOverDefault = readApp(p2, 'crab')
  const splashEnvOverDefault = readSplash(p2, 'crab')
  check(
    'MERCURY_CRITTER (crab) beats unsaved profile 2 default in both app and splash',
    appEnvOverDefault.key === 'crab' && splashEnvOverDefault.key === 'crab',
    JSON.stringify({ app: appEnvOverDefault.key, splash: splashEnvOverDefault.key }),
  )

  const corruptHome = join(scratch, 'profile-corrupt')
  mkdirSync(corruptHome, { recursive: true })
  writeFileSync(join(corruptHome, 'profile.json'), '{not-json')
  const appCorrupt = readApp(corruptHome)
  const splashCorrupt = readSplash(corruptHome)
  check(
    'unreadable profile.json falls back to crab in both app and splash',
    appCorrupt.key === 'crab' && splashCorrupt.key === 'crab',
    JSON.stringify({ app: appCorrupt.key, splash: splashCorrupt.key }),
  )

  const idOneHome = join(scratch, 'profile-id-one')
  mkdirSync(idOneHome, { recursive: true })
  writeFileSync(join(idOneHome, 'profile.json'), `${JSON.stringify({ first: firstHome, id: 1 })}\n`)
  const appIdOne = readApp(idOneHome)
  const splashIdOne = readSplash(idOneHome)
  check(
    'profile.json with id 1 resolves to crab in both app and splash',
    appIdOne.key === 'crab' && splashIdOne.key === 'crab',
    JSON.stringify({ app: appIdOne.key, splash: splashIdOne.key }),
  )

  console.log(`\nprove-profile-critter: ${checks} checks, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
} finally {
  removeScratch(scratch)
}
