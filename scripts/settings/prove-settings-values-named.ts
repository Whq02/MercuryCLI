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
const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : tmpdir(), 'svn-')))
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

const FIELD_VALUES = {
  engine: { effort: 'ultra', reasoning: 'yes', model: 'claude-opus-5-5' },
  guardrails: { mode: 'yolo', deny: ['Bash'] },
  shell: { kind: 'zsh', engine: 'turbo', sessions: 999 },
  briefs: { profile: 'x' },
  view: { firstRunCards: 'middle', ping: false },
  patience: 'slow',
  memory: { pinnedLimit: 5 },
  records: { retentionDays: -3 },
}
const EXPECTED: Array<[string, RegExp]> = [
  ['briefs.profile', /accepted values are: "auto", "native"/],
  ['engine.effort', /accepted values are: "low", "medium", "high", "xhigh", "max"/],
  ['engine.reasoning', /Expected boolean, received string/],
  ['guardrails.mode', /accepted values are: "default", "dontAsk", "implement", "sovereign", "flow", "apollo"/],
  ['memory.pinnedLimit', /at least 1000/],
  ['patience', /accepted values are: "normal", "patient", or an object/],
  ['records.retentionDays', /at least 0/],
  ['shell.engine', /accepted values are: "system", "brush"/],
  ['shell.kind', /accepted values are: "bash", "powershell"/],
  ['shell.sessions', /<=64/],
  ['view.firstRunCards', /accepted values are: "centred", "top-left"/],
]

section('§1 every wrong value is named with its key and what is accepted; nothing is swallowed')
{
  const { settings, errors } = parse(FIELD_VALUES)
  check('eleven faults for eleven wrong values', errors.length === 11, `${errors.length}: ${errors.map(e => `${e.path} · ${e.message}`).join(' | ')}`)
  for (const [path, words] of EXPECTED) {
    check(`${path} is named: ${words.source}`, errors.some(e => e.path === path && words.test(e.message)), errors.filter(e => e.path === path).map(e => e.message).join(' | ') || 'absent')
  }
  check('every fault is a value skip; the rest of the file applies', errors.every(e => e.severity === 'warning'), JSON.stringify(errors.map(e => e.severity)))
  check('a mistyped effort is dropped, not kept as if it were valid', settings?.engine?.effort === undefined, JSON.stringify(settings?.engine))
  check('the valid siblings apply: the model, the deny rule, ping off', settings?.engine?.model === 'claude-opus-5-5' && JSON.stringify(settings?.guardrails?.deny) === '["Bash"]' && settings?.view?.ping === false, JSON.stringify(settings))
  const alone = parse({ engine: { effort: 'ultra' } })
  check('engine.effort alone: one fault naming the five levels', alone.errors.length === 1 && alone.errors[0]?.path === 'engine.effort' && /"low", "medium", "high", "xhigh", "max"/.test(alone.errors[0]?.message ?? ''), JSON.stringify(alone.errors))
  const fine = parse({ engine: { effort: 'max' }, patience: 'patient' })
  check('the valid spellings still load with no fault', fine.errors.length === 0 && fine.settings?.engine?.effort === 'max' && fine.settings?.patience === 'patient', JSON.stringify(fine))
  const custom = parse({ patience: { streamIdleSeconds: 30 } })
  check('a custom patience object still loads with no fault', custom.errors.length === 0 && typeof custom.settings?.patience === 'object', JSON.stringify(custom))
}

const API_KEY = 'fixture-key-000'
section('§2 the built product: health counts the mistyped effort among the faults')
{
  const home = join(SCRATCH, 'u')
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
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(FIELD_VALUES))
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  const h = await new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const c = spawn('node', [DIST, 'health', '--json'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (err += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 120_000)
    c.on('exit', code => { clearTimeout(k); resolve({ code, out, err }) })
  })
  let row: { status?: string; evidence?: string } | undefined
  try {
    const cert = JSON.parse(h.out) as { sections: Array<{ checks: Array<{ id: string; status: string; evidence?: string }> }> }
    row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'settings')
  } catch {
    row = undefined
  }
  check('health --json carries the settings row', (h.code === 0 || h.code === 3) && row !== undefined, `${h.code} · ${h.err.trim().slice(0, 160)}`)
  check('the row counts eleven validation errors (the effort among them), not ten', row?.status === 'warn' && /^11 settings validation error\(s\)/.test(row?.evidence ?? ''), JSON.stringify(row))
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-values-named: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-values-named: all green')
