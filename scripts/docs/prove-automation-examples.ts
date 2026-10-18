#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { handoffTurn, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'docs-automation-home-'))
const dist = join(ROOT, 'dist', 'mercury.mjs')
const docPath = join(ROOT, 'docs', 'AUTOMATION.md')
const indexPath = join(ROOT, 'docs', 'README.md')
const nodeBin = Bun.which('node') ?? process.execPath
const pythonBin = Bun.which('python3') ?? 'python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(dist)) {
  console.error(`FAIL dist/mercury.mjs absent: ${dist}`)
  process.exit(1)
}
if (!existsSync(docPath)) {
  console.error(`FAIL docs/AUTOMATION.md absent: ${docPath}`)
  process.exit(1)
}

const doc = readFileSync(docPath, 'utf8')
const index = readFileSync(indexPath, 'utf8')
check('docs/README.md indexes AUTOMATION.md', index.includes('[AUTOMATION.md](AUTOMATION.md)'))

const blocks = [...doc.matchAll(/```(ts|py)\n([\s\S]*?)\n```/g)].map(m => ({
  lang: m[1] as 'ts' | 'py',
  code: m[2]!,
}))
check(
  'docs/AUTOMATION.md carries four runnable code blocks (ts, py, ts, py)',
  blocks.length === 4 &&
    blocks[0]?.lang === 'ts' &&
    blocks[1]?.lang === 'py' &&
    blocks[2]?.lang === 'ts' &&
    blocks[3]?.lang === 'py',
  blocks.map(b => b.lang).join(','),
)

if (blocks.length !== 4) {
  process.exit(1)
}

function execAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveExec => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      resolveExec({ status: code, stdout, stderr })
    })
  })
}

async function runBlock(
  label: string,
  block: { lang: 'ts' | 'py'; code: string },
  turnsOf: (home: string) => ScriptedTurn[],
  expectedAnswer: string,
  afterCheck?: (home: string) => void,
): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-auto-')))
  seedFirstRun(home, [home])
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { recursive: true })
  const shim = join(binDir, 'mercury')
  writeFileSync(shim, `#!/bin/sh\nexec "${nodeBin}" "${dist}" "$@"\n`)
  chmodSync(shim, 0o755)
  const api = await startFixtureApi(turnsOf(home))
  try {
    const ext = block.lang === 'ts' ? 'ts' : 'py'
    const scriptFile = join(home, `example.${ext}`)
    writeFileSync(scriptFile, `${block.code}\n`)
    const runtime = block.lang === 'ts' ? nodeBin : pythonBin
    const res = await execAsync(runtime, [scriptFile], {
      cwd: home,
      timeoutMs: 90_000,
      env: {
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        TMPDIR: tmpdir(),
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        ANTHROPIC_API_KEY: 'fixture-key-000',
        ANTHROPIC_BASE_URL: api.url,
      },
    })
    const out = res.stdout.trim()
    const err = res.stderr.trim()
    check(
      `${label}: exits 0 and prints "${expectedAnswer}"`,
      res.status === 0 && out === expectedAnswer,
      `rc=${res.status} stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err.slice(0, 300))}`,
    )
    afterCheck?.(home)
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

await runBlock(
  'one-shot door (TypeScript)',
  blocks[0]!,
  () => [{ kind: 'text', text: 'Repository summary ready.' }, handoffTurn()],
  'Repository summary ready.',
)

await runBlock(
  'one-shot door (Python)',
  blocks[1]!,
  () => [{ kind: 'text', text: 'Repository summary ready.' }, handoffTurn()],
  'Repository summary ready.',
)

await runBlock(
  'session door (TypeScript)',
  blocks[2]!,
  home => [
    {
      kind: 'tool_use',
      name: 'Write',
      input: { file_path: join(home, 'note.txt'), content: 'approved\n' },
      preText: 'Writing note.',
    },
    { kind: 'text', text: 'Runner turn complete.' },
    handoffTurn(),
  ],
  'Runner turn complete.',
  home => {
    check(
      'session door (TypeScript): permission/request allow let Write create note.txt',
      existsSync(join(home, 'note.txt')) && readFileSync(join(home, 'note.txt'), 'utf8') === 'approved\n',
    )
  },
)

await runBlock(
  'session door (Python)',
  blocks[3]!,
  home => [
    {
      kind: 'tool_use',
      name: 'Write',
      input: { file_path: join(home, 'note.txt'), content: 'approved\n' },
      preText: 'Writing note.',
    },
    { kind: 'text', text: 'Runner turn complete.' },
    handoffTurn(),
  ],
  'Runner turn complete.',
  home => {
    check(
      'session door (Python): permission/request allow let Write create note.txt',
      existsSync(join(home, 'note.txt')) && readFileSync(join(home, 'note.txt'), 'utf8') === 'approved\n',
    )
  },
)

if (failures > 0) {
  console.error(`FAIL prove-automation-examples: ${failures} failure(s)`)
  process.exit(1)
}
console.log('PASS prove-automation-examples: all four examples ran against the built mercury and exited 0')
