#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'retention-zero-words-')))
const ZERO_HOME = join(SCRATCH, 'zero-home')
mkdirSync(ZERO_HOME, { recursive: true })
writeFileSync(join(ZERO_HOME, 'settings.json'), JSON.stringify({ records: { retentionDays: 0 } }))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = ZERO_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

console.log('§1 the records.retentionDays tip says what the product does')
{
  const { getValidationTip } = await import('../../src/utils/settings/validationTips.ts')
  const tip = getValidationTip({ path: 'records.retentionDays', code: 'too_small', expected: '0' })?.suggestion ?? ''
  check('the tip exists for a value under 0', tip.length > 0)
  check('it claims no deletion of transcripts', !/delet/i.test(tip), tip)
  check('it says 0 turns transcript writing off', /0 turns transcript writing off/.test(tip), tip)
  check('it says the transcripts already on disk stay', /already on disk stay/.test(tip), tip)
  check('it does not call transcripts the thing the window ages', !/transcript retention period/.test(tip), tip)
}

console.log('§2 the pages say what 0 does')
{
  const settingsRow = read('docs/SETTINGS.md').split('\n').find(l => l.startsWith('| `records.retentionDays`')) ?? ''
  check('docs/SETTINGS.md has the records.retentionDays row', settingsRow.length > 0)
  check('…and it says 0 turns transcript writing off', /`0` turns transcript writing off/.test(settingsRow), settingsRow)
  check('…without a deletion claim', !/delet/i.test(settingsRow), settingsRow)
  const sessions = read('docs/SESSIONS.md')
  check('docs/SESSIONS.md says 0 turns transcript writing off for new chats and the written ones stay', /`0` turns transcript writing off for\nnew chats; the transcripts already on disk stay\./.test(sessions))
}

console.log('§3 the sweep at 0 ages a recording and leaves every transcript (the real sweep over a seeded estate)')
{
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { getProjectsDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const { cleanupOldSessionFiles, retentionWindowDays } = await import('../../src/utils/cleanup.ts')
  check('the window reads 0 from the scratch settings', retentionWindowDays() === 0, String(retentionWindowDays()))
  const project = join(getProjectsDir(), 'proj-zero')
  mkdirSync(project, { recursive: true })
  const DAY = 24 * 60 * 60 * 1000
  const seed = (name: string, ageDays: number): string => {
    const file = join(project, name)
    writeFileSync(file, 'x'.repeat(64))
    const t = new Date(Date.now() - ageDays * DAY)
    utimesSync(file, t, t)
    return file
  }
  const agedTranscript = seed('00000000-0000-4000-8000-000000000001.jsonl', 400)
  const youngTranscript = seed('00000000-0000-4000-8000-000000000002.jsonl', 0.5)
  const agedRecording = seed('aged.cast', 90)
  const result = await cleanupOldSessionFiles()
  check('the aged transcript survives', existsSync(agedTranscript))
  check('the young transcript survives', existsSync(youngTranscript))
  check('the recording older than the window is gone', !existsSync(agedRecording))
  check('one file removed, no errors', result.messages === 1 && result.errors === 0, JSON.stringify(result))
}

console.log('§4 the built product: a run under retentionDays 0 writes no transcript; the default writes one')
{
  const API_KEY = 'fixture-key-000'
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi([
    { kind: 'text', text: 'Answered under zero.' },
    { kind: 'text', text: 'Answered by default.' },
  ])
  const mkWorld = (tag: string, settings: Record<string, unknown> | null): { home: string; configDir: string; cwd: string; env: Record<string, string> } => {
    const home = mkdtempSync(join(SCRATCH, `${tag}-home-`))
    const cwd = realpathSync(mkdtempSync(join(SCRATCH, `${tag}-cwd-`)))
    const configDir = join(home, '.mercury')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.config.json'), JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }))
    if (settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
    const nodeDir = dirname(process.execPath)
    return {
      home, configDir, cwd,
      env: {
        HOME: home,
        PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: configDir,
        MERCURY_CREDENTIAL_STORE: 'file',
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
      const k = setTimeout(() => c.kill('SIGKILL'), 90_000)
      c.on('exit', code => { clearTimeout(k); resolve({ code, out }) })
    })
  const transcripts = (configDir: string): string[] => {
    const root = join(configDir, 'projects')
    if (!existsSync(root)) return []
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => join(e.parentPath ?? e.path, e.name))
  }

  const zero = mkWorld('zero', { records: { retentionDays: 0 } })
  const z = await run(zero, ['run', '--format', 'text', 'hello under zero'])
  check('the run under 0 answers (exit 0, the scripted text)', z.code === 0 && /Answered under zero\./.test(z.out), `${z.code} · ${z.out.trim().slice(0, 120)}`)
  check('…and writes no transcript', transcripts(zero.configDir).length === 0, transcripts(zero.configDir).join(','))

  const plain = mkWorld('plain', null)
  const p = await run(plain, ['run', '--format', 'text', 'hello by default'])
  check('the default run answers (exit 0, the scripted text)', p.code === 0 && /Answered by default\./.test(p.out), `${p.code} · ${p.out.trim().slice(0, 120)}`)
  check('…and writes one transcript', transcripts(plain.configDir).length === 1, transcripts(plain.configDir).join(','))
  await api.close()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-retention-zero-words: ALL LAWS HOLD' : `\nprove-retention-zero-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
