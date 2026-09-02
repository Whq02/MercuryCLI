#!/usr/bin/env bun
// ============================================================================
//  prove-continue-empty-refusal — `-p --continue` on a home with NOTHING to
//  continue refuses like the interactive door (exit 1, the same sentence,
//  no wire turn); with a prior -p conversation it genuinely continues.
//
// THE FIND: the headless resume's
//  nothing-found leg fell through to a FRESH session — `--continue -p` on
//  an empty home answered a brand-new model turn with exit 0, silently
//  pretending to be a continuation (--resume's unknown-id twin already
//  refused; main.tsx's interactive --continue already refused). One law on
//  both doors now: loadInitialMessages' continue leg refuses when the load
//  is null or empty (the --resume leg's own null≡empty rule).
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const API_KEY = 'fixture-key-000'
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'First answered.' },
  { kind: 'text', text: 'Continued.' },
  { kind: 'text', text: 'Spare.' },
])
const mkHome = (tag: string): { home: string; cwd: string; env: Record<string, string> } => {
  const home = mkdtempSync(join(tmpdir(), `cont-${tag}-home-`))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `cont-${tag}-cwd-`)))
  const configDir = join(home, '.mercury')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  const nodeDir = dirname(process.execPath)
  return {
    home, cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: API_KEY,
    },
  }
}
const run = (world: { cwd: string; env: Record<string, string> }, args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd: world.cwd, env: world.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (out += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 60_000)
    c.on('exit', code => { clearTimeout(k); resolve({ code, out }) })
  })

console.log('§1 the empty home refuses')
const w1 = mkHome('empty')
const before = api.requests.length
const empty = await run(w1, ['--continue', '-p', 'and then?'])
check('exit 1 with the interactive door\'s sentence', empty.code === 1 && /No conversation found to continue/.test(empty.out), `${empty.code} · ${empty.out.trim().slice(0, 90)}`)
check('no model turn was spent pretending (zero new message requests)', api.requests.slice(before).every(r => !r.path.startsWith('/v1/messages') || r.method === 'HEAD'), api.requests.slice(before).map(r => `${r.method} ${r.path}`).join(','))

console.log('§2 a real prior conversation continues')
const w2 = mkHome('real')
const first = await run(w2, ['-p', 'hello first'])
check('the seed turn ran', first.code === 0 && /First answered\./.test(first.out), first.out.trim().slice(0, 80))
const cont = await run(w2, ['--continue', '-p', 'and then?'])
check('--continue continues it (the next scripted turn, exit 0)', cont.code === 0 && /Continued\./.test(cont.out), `${cont.code} · ${cont.out.trim().slice(0, 80)}`)

await api.close()
rmSync(w1.home, { recursive: true, force: true })
rmSync(w1.cwd, { recursive: true, force: true })
rmSync(w2.home, { recursive: true, force: true })
rmSync(w2.cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-continue-empty-refusal: ALL LAWS HOLD' : `\nprove-continue-empty-refusal: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
