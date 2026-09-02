#!/usr/bin/env bun
// ============================================================================
//  prove-headless-command-refusal — a slash command the headless seat cannot
//  serve refuses TYPED: `-p /help` answers the unavailable family's own
//  sentence on STDERR and exits 1 — never a bare success masquerade (the
//  sentence on stdout with exit 0 that scripted consumers read as a result).
//
// THE FIND (the lead's standing -p queue row):
//  the QueryEngine's no-query path stamped EVERY shouldQuery:false answer
//  `subtype success · is_error false`, so the print road put a refusal on
//  stdout and exited 0. The refusal now rides a typed field from the ONE
//  refusal door (unavailableCommandLine's two call sites) into the result
//  envelope's is_error — the established stderr+exit-1 lane. The whole
//  unavailable family speaks this shape (interactive-surface, interactive-
//  only, headless-disabled, retired, concourse-off, sign-in, enablement):
//  a refusal is not a result. The intended consumer contract for a deploy
//  ritual probing `-p /help`: sentence present + rc=1 is the green.
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
const api = await startFixtureApi([{ kind: 'text', text: 'Control answered.' }])
const mkHome = (tag: string): { home: string; cwd: string; env: Record<string, string> } => {
  const home = mkdtempSync(join(tmpdir(), `cmdref-${tag}-home-`))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `cmdref-${tag}-cwd-`)))
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
const run = (world: { cwd: string; env: Record<string, string> }, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd: world.cwd, env: world.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', d => (stdout += d))
    c.stderr.on('data', d => (stderr += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 60_000)
    c.on('exit', code => { clearTimeout(k); resolve({ code, stdout, stderr }) })
  })
const SENTENCE = /The \/help command is an interactive surface — it needs the foreground session and has no headless form\./

console.log('§1 an interactive-only surface refuses typed: sentence on stderr, exit 1, no wire turn')
const w = mkHome('main')
const before = api.requests.length
const ref = await run(w, ['-p', '/help'])
check('exit 1 (a refusal is not a result)', ref.code === 1, String(ref.code))
check('the family sentence, on STDERR', SENTENCE.test(ref.stderr), ref.stderr.trim().slice(0, 110))
check('stdout carries no sentence (the requested-result channel stays clean)', !SENTENCE.test(ref.stdout), ref.stdout.trim().slice(0, 80))
check('no model turn was spent (zero new message requests)', api.requests.slice(before).every(r => !r.path.startsWith('/v1/messages') || r.method === 'HEAD'), api.requests.slice(before).map(r => `${r.method} ${r.path}`).join(','))

console.log('§2 json mode carries the typed envelope: subtype success · is_error true · the sentence as result')
const js = await run(w, ['-p', '/help', '--output-format', 'json'])
let envelope: { type?: string; subtype?: string; is_error?: boolean; result?: string } = {}
try { envelope = JSON.parse(js.stdout) } catch { /* fails the checks below */ }
check('exit 1 in json mode too', js.code === 1, String(js.code))
check('the envelope is typed: result · success · is_error', envelope.type === 'result' && envelope.subtype === 'success' && envelope.is_error === true, JSON.stringify({ type: envelope.type, subtype: envelope.subtype, is_error: envelope.is_error }))
check('the sentence rides result', SENTENCE.test(envelope.result ?? ''), (envelope.result ?? '').slice(0, 90))

console.log('§3 the positive control: a real -p prompt still succeeds on stdout, exit 0')
const ok = await run(w, ['-p', 'hello control'])
check('exit 0 with the model answer on stdout', ok.code === 0 && /Control answered\./.test(ok.stdout), `${ok.code} · ${ok.stdout.trim().slice(0, 60)}`)

console.log('§4 the source seams: ONE refusal door, marked at both call sites, read at the envelope')
const { readFileSync } = await import('node:fs')
const slash = readFileSync(join(REPO, 'src/utils/processUserInput/processSlashCommand.tsx'), 'utf8')
check('both unavailableCommandLine call sites mark commandRefused', (slash.match(/const line = unavailableCommandLine\((?:command|registered)\)\n    (?:.*\n){1,5}?\s*commandRefused: true,/g) ?? []).length === 2, String((slash.match(/commandRefused: true/g) ?? []).length))
const engine = readFileSync(join(REPO, 'src/QueryEngine.ts'), 'utf8')
check("the no-query envelope reads the mark (is_error: inputResult.commandRefused === true)", engine.includes('is_error: inputResult.commandRefused === true'), 'QueryEngine no-query envelope')

await api.close()
rmSync(w.home, { recursive: true, force: true })
rmSync(w.cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-headless-command-refusal: ALL LAWS HOLD' : `\nprove-headless-command-refusal: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
