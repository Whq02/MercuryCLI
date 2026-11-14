#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi, handoffTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'imported-rule-fold-')))
const node = Bun.which('node') ?? 'node'
let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`) }

const RULE = 'imported-scoped-rule-needle'
const HEAD = '(it governs files matching src/**)'
const RAW = 'globs: src/**'
const home = join(scratch, 'home')
const config = join(home, '.mercury')
const project = join(home, 'work', 'project')
for (const [file, text] of Object.entries({
  'MERCURY.md': 'native-guide-needle\n@.cursor/rules\n',
  '.cursor/rules/ts.mdc': `---\n${RAW}\n---\n${RULE}\n`,
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 2\n',
})) {
  mkdirSync(dirname(join(project, file)), { recursive: true })
  writeFileSync(join(project, file), text)
}
seedFirstRun(config, [project])
const read = (file: string): { kind: 'tool_use'; name: string; input: Record<string, unknown> } => ({ kind: 'tool_use', name: 'Read', input: { file_path: join(project, file) } })
const api = await startFixtureApi([
  read('src/a.ts'),
  { kind: 'text', text: 'The first file was read.\n' + Array.from({ length: 1024 }, (_, index) => createHash('sha256').update(String(index)).digest('hex')).join('\n'), usage: { input_tokens: 35000, output_tokens: 24000 } },
  { kind: 'text', text: 'One file was read. The requested work is still open; preserve the operator instructions.', usage: { input_tokens: 59000, output_tokens: 40 } },
  read('src/b.ts'),
  { kind: 'text', text: 'The second file was read.' },
  read('src/a.ts'),
  { kind: 'text', text: 'The first file was read again.' },
  handoffTurn(),
])
const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_COMPACT_KEEP_TAIL: '0', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url }
const sent = (): string[] => api.messageRequests().map(request => JSON.stringify(request.body))
const copies = (body: string | undefined): number => (body ?? '').split(RULE).length - 1
const boot = (argv: string[]): ReturnType<typeof hostRunner> => {
  const host = hostRunner({ dist: join(repo, 'dist/mercury.mjs'), node, cwd: project, home, env, argv: ['--model', 'claude-opus-4-8', ...argv] })
  host.onAsk(() => ({ outcome: 'allow' }) as never)
  return host
}
try {
  let session = ''
  const first = boot([])
  try {
    await first.initialize()
    await first.prompt('Read the first file.')
    await first.waitFor('the read turn ended', row => row.type === 'outcome' && row.turn === 1, 120_000)
    session = String(first.rows.find(row => row.type === 'session')?.session_id ?? '')
    const opened = sent()
    check('the scene: a MERCURY.md imports a rules folder, and its scoped rule is absent until a matching file is read', copies(opened[0]) === 0 && (opened[0] ?? '').includes('native-guide-needle'), `${copies(opened[0])}`)
    check('a matching read attaches the imported rule once, as an instruction that governs its files', copies(opened.at(-1)) === 1 && (opened.at(-1) ?? '').includes(HEAD), `${copies(opened.at(-1))}`)
    await first.prompt('/compact')
    await first.waitFor('the fold turn ended', row => row.type === 'outcome' && row.turn === 2, 120_000)
    const beforeNext = sent().length
    await first.prompt('Read the second file.')
    await first.waitFor('the turn after the fold ended', row => row.type === 'outcome' && row.turn === 3, 120_000)
    const after = sent().slice(beforeNext)
    check('the first request after a compaction holds nothing of the rule: it is not restored as a file read', after.length > 0 && copies(after[0]) === 0 && !(after[0] ?? '').includes(RAW), `${copies(after[0])} cop(ies)`)
    check('the next matching read attaches it again, once, under its instruction head and not as the raw file', copies(after.at(-1)) === 1 && (after.at(-1) ?? '').includes(HEAD) && !(after.at(-1) ?? '').includes(RAW), `${copies(after.at(-1))} cop(ies)`)
  } finally {
    await first.stop()
  }
  const beforeResume = sent().length
  const second = boot(['--resume', session])
  try {
    await second.initialize()
    await second.prompt('Read the first file again.')
    await second.waitFor('the resumed turn ended', row => row.type === 'outcome', 120_000)
    const resumed = sent().slice(beforeResume)
    check('the session resumed in a new process is the same one', String(second.rows.find(row => row.type === 'session')?.session_id ?? '') === session && session !== '')
    check('its first request holds the rule once, from the conversation', resumed.length > 0 && copies(resumed[0]) === 1, `${copies(resumed[0])} cop(ies)`)
    check('a matching read there leaves one copy: the composition made again from disk attaches no second', copies(resumed.at(-1)) === 1 && resumed.length > 1, `${copies(resumed.at(-1))} cop(ies) in request ${resumed.length}`)
  } finally {
    await second.stop()
  }
} finally {
  await api.close()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`imported-rule-across-a-fold: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
