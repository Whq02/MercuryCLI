#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
const { ROW_TYPES, PARTIAL_ROW_TYPES, OUTCOME_STATUSES, INPUT_ROW_TYPES } = await import('../../src/rows/vocabulary.ts')
const errors = await import('../../src/runner/wire/errors.ts')
const { InitializeParamsSchema } = await import('../../src/runner/wire/methods.ts')

console.log('§1 the README lists every output row type the product writes, once each, in the vocabulary\'s order')
{
  const start = readme.indexOf('The output row types, by their `type` field:')
  check('the catalogue has its heading', start >= 0)
  const body = start >= 0 ? readme.slice(start, readme.indexOf('\n\n`--partial`', start)) : ''
  const listed = [...body.matchAll(/^- `([a-z_]+)` — /gm)].map(m => m[1])
  check('the catalogue names exactly the vocabulary\'s row types, in order', JSON.stringify(listed) === JSON.stringify([...ROW_TYPES]), `listed ${listed.join(',')} · vocabulary ${ROW_TYPES.join(',')}`)
  for (const type of ROW_TYPES) check(`\`${type}\` has one line`, listed.filter(t => t === type).length === 1)
  check('the partial rows are the vocabulary\'s', PARTIAL_ROW_TYPES.every(t => new RegExp(`\`${t}\``).test(readme)), PARTIAL_ROW_TYPES.filter(t => !new RegExp(`\`${t}\``).test(readme)).join(','))
  check('the outcome statuses are the vocabulary\'s', OUTCOME_STATUSES.every(s => new RegExp(`\`${s}\``).test(readme)), OUTCOME_STATUSES.filter(s => !new RegExp(`\`${s}\``).test(readme)).join(','))
  check('the input row types are the vocabulary\'s', INPUT_ROW_TYPES.every(t => new RegExp(`\`${t}\``).test(readme)))
}

console.log('§2 the runner paragraph teaches the initialize object, the id rule and every code the door answers')
const exampleLine = readme.split('\n').find(l => l.startsWith('{"jsonrpc":"2.0","id":1,"method":"initialize"')) ?? ''
{
  check('the README shows one initialize request as a JSON line', exampleLine !== '')
  let params: unknown = null
  try { params = (JSON.parse(exampleLine) as { params?: unknown }).params } catch {}
  const parsed = InitializeParamsSchema().safeParse(params)
  check('…whose params the wire schema accepts (host as an object, the three capabilities)', parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues).slice(0, 200))
  check('the id rule is taught: a positive integer, anything else -32600 with id null', /positive\s+integer/.test(readme) && /`-32600`/.test(readme) && /`id: null`/.test(readme))
  for (const [name, code] of [['method not found', errors.RPC_METHOD_NOT_FOUND], ['invalid params', errors.RPC_INVALID_PARAMS], ['invalid request', errors.RPC_INVALID_REQUEST], ['parse error', errors.RPC_PARSE_ERROR]] as const) {
    check(`the code list names ${name} (${code})`, readme.includes(`\`${code}\``))
  }
  check('the code list names the not-initialized and refusal codes', readme.includes('`-32002`') && readme.includes('`-32010`'))
}

console.log('§3 the README\'s own initialize line opens a real runner; an id of 0 is answered -32600 with id null')
{
  const home = mkdtempSync(join(tmpdir(), 'readme-runner-'))
  const configDir = join(home, '.mercury')
  mkdirSync(configDir, { recursive: true })
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  }
  const child = spawn('node', [DIST, 'runner'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: Array<Record<string, unknown>> = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      try { lines.push(JSON.parse(part) as Record<string, unknown>) } catch {}
    }
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const waitFor = (pred: (l: Record<string, unknown>) => boolean, ms: number): Promise<Record<string, unknown> | null> =>
    new Promise(resolveWait => {
      const started = Date.now()
      const tick = (): void => {
        const hit = lines.find(pred)
        if (hit) return resolveWait(hit)
        if (Date.now() - started > ms) return resolveWait(null)
        setTimeout(tick, 50)
      }
      tick()
    })
  const flat = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocol: 1, name: 'my-host', version: '1.0.0', capabilities: { holds_asks: true, elicitation: false, partial_rows: false } } })
  child.stdin.write(flat + '\n')
  const flatAnswer = await waitFor(l => l.id === 7 && 'error' in l, 60_000)
  const flatError = (flatAnswer?.error ?? null) as { code?: number; data?: unknown } | null
  check('a flat name and version (no host object) is refused -32602 naming host', flatError?.code === errors.RPC_INVALID_PARAMS && /host/.test(JSON.stringify(flatAnswer)), JSON.stringify(flatAnswer ?? stderr.slice(0, 200)))
  child.stdin.write(exampleLine + '\n')
  const answer = await waitFor(l => l.id === 1 && ('result' in l || 'error' in l), 60_000)
  const result = (answer?.result ?? null) as { protocol?: number; runner?: { version?: string; pid?: number } } | null
  check('the README\'s initialize line is answered with protocol 1 and the runner\'s version and pid', result?.protocol === 1 && typeof result.runner?.version === 'string' && typeof result.runner?.pid === 'number', JSON.stringify(answer ?? stderr.slice(0, 200)))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/facts', params: {} }) + '\n')
  const refused = await waitFor(l => l.id === null && 'error' in l, 20_000)
  const error = (refused?.error ?? null) as { code?: number; message?: string } | null
  check('a request with id 0 answers -32600 with id null and the id rule in its message', error?.code === errors.RPC_INVALID_REQUEST && /positive integer/.test(error.message ?? ''), JSON.stringify(refused))
  child.stdin.end()
  await new Promise(resolveExit => { const k = setTimeout(() => { child.kill('SIGKILL'); resolveExit(null) }, 15_000); child.on('exit', () => { clearTimeout(k); resolveExit(null) }) })
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-readme-headless-words: ALL LAWS HOLD' : `\nprove-readme-headless-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
