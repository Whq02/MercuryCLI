#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('  RED dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}
let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')

type Run = { rc: number; out: string; err: string }
const runMercury = (home: string, args: string[]): Promise<Run> =>
  new Promise(resolve => {
    const child = spawn('node', [DIST, ...args], {
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    const k = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', rc => { clearTimeout(k); resolve({ rc: rc ?? -1, out, err }) })
  })

console.log('§1 — the concourse switches are an interactive boot\'s; run and runner answer them as any unknown option, and persist nothing')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'w6-concourse-')))
  writeFileSync(join(home, '.config.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true }))
  for (const verb of ['run', 'runner']) {
    const tail = verb === 'run' ? ['probe'] : []
    const control = await runMercury(home, [verb, '--frobnicate', ...tail])
    for (const flag of ['--concourse-off', '--concourse-on', '--chat']) {
      const r = await runMercury(home, [verb, flag, ...tail])
      check(`${verb} ${flag} is the parser's unknown option (same answer and exit as --frobnicate)`, r.rc === control.rc && r.out === '' && r.err === control.err.replaceAll('--frobnicate', flag), `rc=${r.rc} ${JSON.stringify((r.err + r.out).slice(0, 160))}`)
    }
  }
  const config = JSON.parse(readFileSync(join(home, '.config.json'), 'utf8')) as Record<string, unknown>
  check('the config home carries no concourseEnabled after the headless attempts', !('concourseEnabled' in config), JSON.stringify(config))
  rmSync(home, { recursive: true, force: true })
}

console.log('§2 — still exactly one CLI writer of the persisted field')
{
  const setCalls = (main.match(/setConcourseEnabled\(/g) ?? []).length
  check('setConcourseEnabled is called exactly once in main.tsx', setCalls === 1, `found ${setCalls}`)
  check('the switch is read last-wins from argv', main.includes("[...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')"))
  check('run and runner are built without the interactive boot options (each skips them before it adds the root options)', /if \(INTERACTIVE_BOOT_OPTIONS\.has\(option\.long \?\? ''\)\) continue\n\s*runCommand\.addOption\(/.test(main) && /INTERACTIVE_BOOT_OPTIONS\.has\(option\.long \?\? ''\)\) continue\n\s*runnerCommand\.addOption\(/.test(main))
}

process.exit(failures === 0 ? 0 : 1)
