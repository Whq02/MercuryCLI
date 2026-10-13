#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = realpathSync(mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : tmpdir(), 'late-folder-')))
const HOME = join(ROOT, 'home')
const PROJ = join(ROOT, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(PROJ, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const waitMs = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

section('§1 the watcher: a project with no .mercury folder at boot still sees the local file written later')
{
  const state = await import('../../src/bootstrap/state.ts')
  state.setOriginalCwd(PROJ)
  state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
  const { settingsChangeDetector } = await import('../../src/utils/settings/changeDetector.ts')
  const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { model: 'initial' } }))
  const events: Array<{ source: string; allow: unknown }> = []
  await settingsChangeDetector.resetForTesting({ stabilityThresholdMs: 60, pollIntervalMs: 20 })
  settingsChangeDetector.subscribe(source => {
    events.push({ source, allow: getInitialSettings().guardrails?.allow })
  })
  await settingsChangeDetector.initialize()
  await waitMs(600)
  events.length = 0
  check('the project has no .mercury folder when the watcher arms', !existsSync(join(PROJ, '.mercury')))
  mkdirSync(join(PROJ, '.mercury'), { recursive: true })
  writeFileSync(join(PROJ, '.mercury', 'settings.local.json'), JSON.stringify({ guardrails: { allow: ['Bash(echo *)'] } }))
  const t0 = Date.now()
  while (Date.now() - t0 < 6000 && !events.some(e => e.source === 'localSettings')) await waitMs(40)
  const local = events.find(e => e.source === 'localSettings')
  check('one localSettings notification arrives for the file the new folder brought', local !== undefined, `events: ${JSON.stringify(events)}`)
  check('…and the rule is already readable when the listener runs', JSON.stringify(local?.allow) === JSON.stringify(['Bash(echo *)']), JSON.stringify(local))
  await waitMs(800)
  const before = events.length
  writeFileSync(join(PROJ, '.mercury', 'settings.local.json'), JSON.stringify({ guardrails: { allow: ['Bash(echo *)', 'Bash(pwd)'] } }))
  const t1 = Date.now()
  while (Date.now() - t1 < 6000 && events.length === before) await waitMs(40)
  check('a later edit of the same file is seen too (the folder is a watched root now)', events.length > before && JSON.stringify(events[events.length - 1]?.allow) === JSON.stringify(['Bash(echo *)', 'Bash(pwd)']), JSON.stringify(events.slice(before)))
  await settingsChangeDetector.dispose()
}

section('§2 the built product: a rule written mid-session into a project that had no .mercury folder is honoured on the next call')
{
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  const { startScriptedFixture } = await import('../lib/scriptedTurn.ts')
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    check('dist/mercury.mjs is built', false, 'run bun run build.ts first')
  } else {
    const home = join(ROOT, 'home2')
    const cwd = join(ROOT, 'work')
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    seedFirstRun(home, [cwd])
    const fixture = await startScriptedFixture(req => (req.step === 0 ? [{ type: 'tool_use', name: 'Bash', input: { command: 'git --version && echo versioned' } }] : [{ type: 'text', text: req.ask.includes('again') ? 'second answer' : 'first answer' }]))
    const child = spawn('node', [dist, 'run', '--input', 'rows', '--format', 'rows'], {
      cwd,
      env: { ...process.env, HOME: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: fixture.base, MERCURY_LOCAL_PROBE_TARGETS: 'none' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const rows: Array<Record<string, unknown>> = []
    const waiters: Array<() => void> = []
    child.stdout.on('data', bytes => {
      stdout += String(bytes)
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          rows.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          rows.push({ bad: line })
        }
      }
      for (const wake of waiters.splice(0)) wake()
    })
    child.stderr.on('data', bytes => { stderr += String(bytes) })
    const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const closed = new Promise<number | null>(resolve => child.once('close', resolve))
    const outcomes = (): Array<Record<string, unknown>> => rows.filter(row => row.type === 'outcome')
    const results = (): Array<Record<string, unknown>> => rows.filter(row => row.type === 'tool_result')
    const waitForOutcomes = async (n: number, budgetMs: number): Promise<boolean> => {
      const until = Date.now() + budgetMs
      while (outcomes().length < n && Date.now() < until) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 250)
          waiters.push(() => { clearTimeout(timer); resolve() })
        })
      }
      return outcomes().length >= n
    }
    check('the project has no .mercury folder when the session starts', !existsSync(join(cwd, '.mercury')))
    child.stdin.write(`${JSON.stringify({ type: 'prompt', content: 'which git version' })}\n`)
    const first = await waitForOutcomes(1, 60_000)
    check('turn 1 ends blocked: the first call asked and headless cannot answer (headless-process RUN-03 — the outcome tells the truth)', first && outcomes()[0]?.status === 'blocked', `${JSON.stringify(outcomes()[0])} ${stderr.slice(0, 300)}`)
    check('the first Bash call is refused: nothing allows it and headless cannot ask', results()[0]?.status === 'error' && /needs approval/.test(String(results()[0]?.output ?? '')), JSON.stringify(results()[0]).slice(0, 300))
    mkdirSync(join(cwd, '.mercury'), { recursive: true })
    writeFileSync(join(cwd, '.mercury', 'settings.local.json'), JSON.stringify({ guardrails: { allow: ['Bash(git --version)'] } }))
    await waitMs(4_000)
    child.stdin.write(`${JSON.stringify({ type: 'prompt', content: 'which git version again' })}\n`)
    const second = await waitForOutcomes(2, 60_000)
    child.stdin.end()
    const code = await closed
    clearTimeout(guard)
    await fixture.close()
    check('turn 2 completes and the run leaves cleanly', second && outcomes()[1]?.status === 'completed' && code === 0, `${code} ${JSON.stringify(outcomes()[1])} ${stderr.slice(0, 300)}`)
    check('the second Bash call ran: the rule written mid-session was honoured without a restart', results()[1]?.status === 'ok' && /versioned/.test(String(results()[1]?.output ?? '')), JSON.stringify(results()[1]).slice(0, 300))
  }
}

rmSync(ROOT, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-watch-late-folder: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-watch-late-folder: all green')
