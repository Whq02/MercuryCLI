#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const home = mkdtempSync(join(tmpdir(), 'flag-contra-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'flag-contra-cwd-'))
const configDir = join(home, '.mercury')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, '.config.json'), JSON.stringify({
  theme: 'dark',
  hasCompletedOnboarding: true,
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}))
const nodeDir = dirname(process.execPath)
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
  TERM: 'xterm-256color',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
}
const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (out += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 60_000)
    c.on('exit', code => {
      clearTimeout(k)
      resolve({ code, out })
    })
  })

console.log('§1 --continue beside --resume refuses (nothing silently discarded)')
{
  const r = await run(['--continue', '--resume', 'some-title', 'run', 'hi'])
  check('exit 2 (a usage error), both flags named', r.code === 2 && /--continue and --resume name two different sessions/.test(r.out), `${r.code} · ${r.out.trim().slice(0, 120)}`)
}

console.log('§2 --extension with a missing path refuses, naming it')
{
  const missing = join(cwd, 'no-such-extension-dir')
  const r = await run(['--extension', missing, 'run', 'hi'])
  check('exit 2 (a usage error), the path named', r.code === 2 && r.out.includes('--extension path') && r.out.includes(missing), `${r.code} · ${r.out.trim().slice(0, 120)}`)
}

console.log('§3 run --resume with a target that is neither an id nor a .jsonl path refuses as a usage error, in the run verb\'s words')
{
  const text = await run(['run', '--resume', 'notauuid', '--format', 'text', 'hi'])
  check('exit 2 (a usage error), like the other usage refusals', text.code === 2, `${text.code} · ${text.out.trim().slice(0, 160)}`)
  check('the sentence names the run verb and what it needs', /mercury run --resume needs a session id \(a UUID\) or a \.jsonl transcript path: "notauuid" is neither/.test(text.out), text.out.trim().slice(0, 160))
  check('no mode word on the line', !/print mode/.test(text.out), text.out.trim().slice(0, 160))
  const rows = await run(['run', '--resume', 'notauuid', '--format', 'rows', 'hi'])
  const outcome = rows.out.split('\n').map(l => { try { return JSON.parse(l) as { type?: string; status?: string; error?: { message?: string; class?: string } } } catch { return null } }).find(r => r?.type === 'outcome')
  check('--format rows: a refused outcome row carries the same sentence, class load, exit 2', rows.code === 2 && outcome?.status === 'refused' && outcome.error?.class === 'load' && /mercury run --resume needs a session id/.test(outcome.error?.message ?? '') && !/print mode/.test(outcome.error?.message ?? ''), `${rows.code} · ${rows.out.trim().slice(0, 200)}`)
}

console.log('§4 run --help says exactly what run --resume takes — the words the parser then holds it to')
{
  const optionLine = (text: string, flag: string): string => {
    const lines = text.split('\n')
    const at = lines.findIndex(l => l.includes(flag))
    if (at < 0) return ''
    let joined = lines[at] ?? ''
    for (let i = at + 1; i < lines.length && /^\s{20,}\S/.test(lines[i] ?? '') && !/^\s+-/.test(lines[i] ?? ''); i++) joined += ` ${(lines[i] ?? '').trim()}`
    return joined.replace(/\s+/g, ' ').trim()
  }
  const help = await run(['run', '--help'])
  const resumeLine = optionLine(help.out, '--resume')
  check('run --help exits 0 and carries a --resume line', help.code === 0 && resumeLine !== '', `${help.code} · ${help.out.trim().slice(0, 120)}`)
  check('the line names a session id (a UUID) or a .jsonl transcript path', /^-r, --resume <value> Resume a session by its id \(a UUID\) or its \.jsonl transcript path$/.test(resumeLine), resumeLine)
  check('…and promises no title and no picker (the chat\'s roads, not run\'s)', !/title|picker/.test(resumeLine), resumeLine)
  const runner = await run(['runner', '--help'])
  const runnerLine = optionLine(runner.out, '--resume')
  check('runner --help holds the same line', runnerLine === resumeLine, runnerLine)
  const root = await run(['--help'])
  const rootLine = optionLine(root.out, '--resume')
  check('the chat\'s --help keeps the id, title or picker (where they exist)', /^-r, --resume \[value\] Resume a conversation \(session id, title, or picker\)$/.test(rootLine), rootLine)
  const bare = await run(['run', '--format', 'text', 'hi', '--resume'])
  check('a bare run --resume is the parser\'s ordinary missing-argument refusal (exit 2)', bare.code === 2 && /option '-r, --resume <value>' argument missing/.test(bare.out), `${bare.code} · ${bare.out.trim().slice(0, 160)}`)
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-flag-contradictions: ALL LAWS HOLD' : `\nprove-flag-contradictions: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
