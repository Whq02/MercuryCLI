#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : tmpdir(), 'hfan-')))
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
let n = 0
const parse = (body: unknown): ReturnType<typeof parseSettingsFile> => {
  const path = join(process.env.MERCURY_CONFIG_DIR as string, `case-${n++}.json`)
  writeFileSync(path, JSON.stringify(body))
  return parseSettingsFile(path)
}
const log = (word: string): string => `echo ${word} >> hook-log.txt`
const FIELD_FILE = {
  events: {
    hooks: {
      'tool.before': [
        { name: 'f-unknown-field', match: 'Read', run: log('F-UNKNOWN-FIELD'), bogus: 1 },
        { name: 'f-bad-regex', match: '(', run: log('F-BAD-REGEX') },
        { name: 'f-two-kinds', match: 'Read', run: log('F-TWO-KINDS'), question: 'Is this ok?' },
        { name: 'f-timeout-string', match: 'Read', run: log('F-TIMEOUT-STRING'), timeout: '5' },
        { name: 'f-watch-on-wrong-event', match: 'Read', run: log('F-WATCH-WRONG-EVENT'), watch: ['a.txt'] },
        { name: 'f-wake-without-background', match: 'Read', run: log('F-WAKE-NOBG'), wake: true },
        { name: 'f-empty-run', match: 'Read', run: '' },
        { name: 'ok-after-faults', match: 'Read', run: log('OK-AFTER-FAULTS') },
      ],
      'tool.befor': [{ name: 'f-bad-event', run: log('F-BAD-EVENT') }],
      'turn.start': [{ name: 'f-match-on-turn-start', match: 'x', run: log('F-MATCH-ON-TURN-START') }],
      'session.end': [{ name: 'f-question-on-session-end', question: 'Anything to report?' }],
    },
  },
}
const EXPECTED: Array<[string, RegExp]> = [
  ['events.hooks.session.end.0', /session\.end runs run hooks only/],
  ['events.hooks.tool.befor', /tool\.befor is not a hook event Mercury fires/],
  ['events.hooks.tool.before.0', /Unrecognized key: "bogus"/],
  ['events.hooks.tool.before.1', /match is not a valid regular expression: "\("/],
  ['events.hooks.tool.before.2', /exactly one of run, question or crewmate/],
  ['events.hooks.tool.before.3', /timeout: .*expected number, received string/],
  ['events.hooks.tool.before.4', /watch belongs to file\.changed, not tool\.before/],
  ['events.hooks.tool.before.6', /run: .*>=1 characters/],
  ['events.hooks.turn.start.0', /turn\.start has no match field/],
]
const namesOf = (settings: unknown, event: string): string[] => {
  const list = ((settings as { events?: { hooks?: Record<string, Array<{ name?: string }>> } } | null)?.events?.hooks ?? {})[event] ?? []
  return list.map(entry => String(entry.name))
}

section('§1 the field file: every faulty entry is named with its path and its fault; the two clean ones load')
{
  const { settings, errors } = parse(FIELD_FILE)
  check('nine faults, one per faulty entry plus the unknown event', errors.length === 9, `${errors.length}: ${errors.map(e => `${e.path} · ${e.message}`).join(' | ')}`)
  for (const [path, words] of EXPECTED) {
    check(`${path} is named: ${words.source}`, errors.some(e => e.path === path && words.test(e.message)), errors.filter(e => e.path === path).map(e => e.message).join(' | ') || 'absent')
  }
  check('every fault is graded a value skip (the rest of the file applies)', errors.every(e => e.severity === 'warning'), JSON.stringify(errors.map(e => e.severity)))
  check('the faults come in path order', errors.map(e => e.path).join(' ') === EXPECTED.map(([path]) => path).join(' '), errors.map(e => e.path).join(' '))
  check('the two valid tool.before entries load, in their order', namesOf(settings, 'tool.before').join(',') === 'f-wake-without-background,ok-after-faults', namesOf(settings, 'tool.before').join(','))
  check('the faulty turn.start and session.end entries are gone, the events stay', namesOf(settings, 'turn.start').length === 0 && namesOf(settings, 'session.end').length === 0, JSON.stringify(settings?.events?.hooks))
  check('the unknown event never loads', (settings?.events?.hooks as Record<string, unknown> | undefined)?.['tool.befor'] === undefined)
}

section('§2 an entry with two faults drops alone: its clean sibling stays, both faults named')
{
  const { settings, errors } = parse({ events: { hooks: { 'tool.before': [{ name: 'two-faults', match: 'Read', run: 'echo x', bogus: 1, timeout: '5' }, { name: 'fine', match: 'Read', run: 'echo fine' }] } } })
  check('the clean sibling survives', namesOf(settings, 'tool.before').join(',') === 'fine', namesOf(settings, 'tool.before').join(','))
  check('both faults of the one entry are named at its index', errors.length === 2 && errors.every(e => e.path === 'events.hooks.tool.before.0'), errors.map(e => `${e.path} · ${e.message}`).join(' | '))
  const mixed = parse({ events: { hooks: { 'tool.before': [{ name: 'a', match: 'Read', run: 'echo a', bogus: 1 }, { name: 'b', match: 'Read', run: 'echo b', watch: ['x'] }, { name: 'c', match: 'Read', run: 'echo c' }] } } })
  check('an entry-level fault at 0 and an event-level fault at 1 are named at their own indexes', mixed.errors.length === 2 && mixed.errors.some(e => e.path === 'events.hooks.tool.before.0' && /bogus/.test(e.message)) && mixed.errors.some(e => e.path === 'events.hooks.tool.before.1' && /watch belongs/.test(e.message)) && namesOf(mixed.settings, 'tool.before').join(',') === 'c', mixed.errors.map(e => `${e.path} · ${e.message}`).join(' | '))
}

section('§3 a fault outside hooks found only after a first prune is named too')
{
  const { settings, errors } = parse({ engine: { model: 'claude-opus-5-5' }, events: { hooks: { Nope: [{ run: 'x' }] } }, records: { retentionDays: '30' } })
  check('the unknown event and the wrong-typed value are both named', errors.some(e => e.path === 'events.hooks.Nope') && errors.some(e => e.path === 'records.retentionDays'), errors.map(e => `${e.path} · ${e.message}`).join(' | '))
  check('the rest of the file applies', settings?.engine?.model === 'claude-opus-5-5' && settings?.records?.retentionDays === undefined, JSON.stringify(settings))
}

const API_KEY = 'fixture-key-000'
type World = { home: string; configDir: string; cwd: string; env: Record<string, string> }
const mkWorld = (tag: string, settings: Record<string, unknown>): World => {
  const home = join(SCRATCH, tag)
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
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
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

section('§4 the built product: health counts every dropped entry; a headless run names each on stderr')
{
  const world = mkWorld('u', FIELD_FILE)
  const h = await run(world, ['health', '--json'])
  const row = settingsRow(h.out)
  check('health --json carries the settings row', (h.code === 0 || h.code === 3) && row !== undefined, `${h.code} · ${h.err.trim().slice(0, 160)}`)
  check('the row counts nine validation errors, not one', row?.status === 'warn' && /^9 settings validation error\(s\)/.test(row?.evidence ?? ''), JSON.stringify(row))
  const r = await run(world, ['run', '--format', 'text', '--resume', 'notauuid', 'hi'])
  const lines = r.err.split('\n').filter(l => /settings: /.test(l))
  check('nine settings lines on stderr, one per fault', lines.length === 9, `${lines.length}: ${r.err.trim().slice(0, 600)}`)
  for (const [path, words] of EXPECTED) {
    check(`stderr names ${path}`, lines.some(l => l.includes(` · ${path} · `) && words.test(l) && / — this value is skipped; the rest of the file applies$/.test(l)), lines.filter(l => l.includes(path)).join(' | ') || 'absent')
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-hook-faults-all-named: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-faults-all-named: all green')
