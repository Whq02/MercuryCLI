#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sfn-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'parse-home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')
const { settingsFaultLine } = await import('../../src/utils/settings/validation.ts')
let n = 0
const parse = (body: unknown): ReturnType<typeof parseSettingsFile> => {
  const path = join(process.env.MERCURY_CONFIG_DIR as string, `case-${n++}.json`)
  writeFileSync(path, JSON.stringify(body))
  return parseSettingsFile(path)
}

section('§1 an unknown settings key is a named warning at load — the file still applies')
{
  const root = parse({ zzzFieldWalkUnknownKey: true, engine: { model: 'claude-opus-5-5' } })
  check('a root-level unknown key is one validation record', root.errors.length === 1, JSON.stringify(root.errors))
  const first = root.errors[0]
  check('…with the generic unknown-field words and the key named', first?.message === 'Unrecognized field: zzzFieldWalkUnknownKey', first?.message)
  check('…at the root path', first?.path === '', JSON.stringify(first?.path))
  check('…graded a warning (the rest of the file applies), with the generic tip', first?.severity === 'warning' && /typos/.test(first?.suggestion ?? ''), JSON.stringify(first))
  check('…and the known keys beside it still load', root.settings?.engine?.model === 'claude-opus-5-5', JSON.stringify(root.settings))
  const nested = parse({ engine: { modell: 'x', model: 'claude-opus-5-5' } })
  check('a typo inside a known group is named with its group path', nested.errors.length === 1 && nested.errors[0]?.path === 'engine' && nested.errors[0]?.message === 'Unrecognized field: modell', JSON.stringify(nested.errors))
  const both = parse({ zzFieldUnknownKey: true, engine: { modell: 'x' } })
  check('two unknown keys are two records', both.errors.length === 2 && both.errors.every(e => e.severity === 'warning'), JSON.stringify(both.errors.map(e => `${e.path}:${e.message}`)))
  const clean = parse({ $schema: 'x', engine: { model: 'claude-opus-5-5', effort: 'high' }, guardrails: { allow: ['Read'] }, events: { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }] } } })
  check('a clean file with every declared shape loads with zero records', clean.errors.length === 0, JSON.stringify(clean.errors).slice(0, 200))
  const beside = parse({ engine: { modell: 'x' }, events: { hooks: { PreToolUse: [{ matcher: 'startu[p', hooks: [{ type: 'command', command: 'true' }] }] } } })
  check('an unknown key beside a refused hook entry: both named, both warnings', beside.errors.length === 2 && beside.errors.some(e => /not a valid regular expression/.test(e.message)) && beside.errors.some(e => e.message === 'Unrecognized field: modell'), JSON.stringify(beside.errors.map(e => e.message)))
  const line = settingsFaultLine(nested.errors[0]!)
  check('the one-line form names the file, the path, the words and the effect', /settings: .*case-1\.json · engine · Unrecognized field: modell — this value is skipped; the rest of the file applies$/.test(line), line)
}

const API_KEY = 'fixture-key-000'
const SHORT = realpathSync(mkdtempSync('/private/tmp/sfn-'))
type World = { home: string; configDir: string; cwd: string; env: Record<string, string> }
const mkWorld = (tag: string, settings: Record<string, unknown>, apiUrl: string | null): World => {
  const home = join(SHORT, tag)
  const configDir = join(home, 'c')
  const cwd = join(home, 'w')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }))
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
  const nodeDir = dirname(process.execPath)
  return {
    home, configDir, cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_API_KEY: API_KEY,
      ...(apiUrl === null ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } : { ANTHROPIC_BASE_URL: apiUrl }),
    },
  }
}
const run = (world: World, args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd: world.cwd, env: world.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (err += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 120_000)
    c.on('exit', code => { clearTimeout(k); resolve({ code, out, err }) })
  })
type Row = { id: string; status: string; evidence?: string }
const settingsRow = (text: string): Row | undefined => {
  try {
    const cert = JSON.parse(text) as { sections: Array<{ checks: Row[] }> }
    return cert.sections.flatMap(s => s.checks).find(c => c.id === 'settings')
  } catch {
    return undefined
  }
}

section('§2 the built product: health names the unknown key where it reports settings faults')
{
  const world = mkWorld('u', { zzzFieldWalkUnknownKey: true, engine: { modell: 'x' } }, null)
  const h = await run(world, ['health', '--json'])
  const row = settingsRow(h.out)
  check('health --json carries the settings row (exit 0 or 3)', (h.code === 0 || h.code === 3) && row !== undefined, `${h.code} · ${h.err.trim().slice(0, 160)}`)
  check('the row is a warning counting both unknown keys', row?.status === 'warn' && /^2 settings validation error\(s\)/.test(row?.evidence ?? ''), JSON.stringify(row))
  check('…and its evidence names a key with the generic unknown-field words', /Unrecognized field: (zzzFieldWalkUnknownKey|modell)/.test(row?.evidence ?? ''), row?.evidence)
}

section('§3 the built product: a headless run names every settings fault on stderr before it answers anything')
{
  const world = mkWorld('r', { engine: { modell: 'x' }, events: { hooks: { PostToolUse: [{ matcher: 'startu[p', hooks: [{ type: 'command', command: 'true' }] }] } } }, null)
  const r = await run(world, ['run', '--format', 'text', '--resume', 'notauuid', 'hi'])
  check('the run still refuses the bad resume target as a usage error (exit 2) — no model call', r.code === 2, `${r.code} · ${r.err.trim().slice(0, 160)}`)
  const lines = r.err.split('\n').filter(l => /settings: /.test(l))
  check('two settings lines on stderr, one per fault', lines.length === 2, r.err.trim().slice(0, 400))
  check('the refused hook entry is named with its path and words', lines.some(l => /settings\.json · events\.hooks\.PostToolUse\.0 · matcher is not a valid regular expression: "startu\[p" — this value is skipped; the rest of the file applies/.test(l)), lines.join(' | '))
  check('the unknown key is named with the generic words', lines.some(l => /settings\.json · engine · Unrecognized field: modell — this value is skipped; the rest of the file applies/.test(l)), lines.join(' | '))
  check('nothing about settings reaches stdout', !/settings: /.test(r.out), r.out.slice(0, 200))
  const clean = mkWorld('k', { engine: { model: 'claude-opus-5-5' } }, null)
  const c = await run(clean, ['run', '--format', 'text', '--resume', 'notauuid', 'hi'])
  check('a clean settings file draws no settings line', c.code === 2 && !/settings: /.test(c.err), c.err.trim().slice(0, 200))
}

section('§4 the built product: a "*" PostToolUse hook written as docs/HOOKS.md teaches fires on a real tool call')
{
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Read', input: { file_path: join(SHORT, 'h', 'w', 'note.txt') } },
    { kind: 'text', text: 'Read it.' },
  ])
  const mark = join(SHORT, 'h', 'hook-fired.log')
  const world = mkWorld('h', {
    events: { hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `cat >> "${mark}"; printf '\\n' >> "${mark}"` }] }] } },
  }, api.url)
  writeFileSync(join(world.cwd, 'note.txt'), 'the note\n')
  const h = await run(world, ['health', '--json'])
  const row = settingsRow(h.out)
  check('health reads the "*" hook as valid settings (0 validation errors)', row?.status === 'ok' && /0 validation errors/.test(row?.evidence ?? ''), JSON.stringify(row))
  const r = await run(world, ['run', '--format', 'text', 'read the note'])
  check('the run answers (exit 0, the scripted text)', r.code === 0 && /Read it\./.test(r.out), `${r.code} · ${(r.out + r.err).trim().slice(0, 200)}`)
  check('no settings fault line was drawn', !/settings: /.test(r.err), r.err.trim().slice(0, 200))
  const fired = existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(l => l.trim() !== '') : []
  check('the hook fired once, for the one tool call', fired.length === 1, `${fired.length} record(s)`)
  let record: Record<string, unknown> = {}
  try { record = JSON.parse(fired[0] ?? '{}') as Record<string, unknown> } catch { record = {} }
  check('…with the documented PostToolUse input (event, tool name, tool input, tool response)', record.hook_event_name === 'PostToolUse' && record.tool_name === 'Read' && typeof record.tool_input === 'object' && 'tool_response' in record, JSON.stringify(Object.keys(record)))
  await api.close()
}

rmSync(SCRATCH, { recursive: true, force: true })
rmSync(SHORT, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-faults-named: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-faults-named: all green')
