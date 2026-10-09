#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'quit-no-crash-'))
const bunExe = process.execPath

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (title: string): void => console.log(`\n${title}`)

function crashRecords(home: string): string[] {
  try {
    return readdirSync(join(home, 'crashes')).filter(f => f.startsWith('crash-'))
  } catch {
    return []
  }
}

function runBunChild(name: string, body: string): { status: number | null; home: string; err: string } {
  const home = join(SCRATCH, `${name}-home`)
  mkdirSync(home, { recursive: true })
  const script = join(SCRATCH, `${name}.ts`)
  writeFileSync(script, body)
  const r = spawnSync(bunExe, ['run', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'production' },
    cwd: ROOT,
  })
  return { status: r.status, home, err: (r.stderr ?? '').slice(0, 600) }
}

const PEER_GONE = `Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' })`
const SHUTDOWN_CHILD = (rejection: string): string => `
  import { registerCleanup } from '${ROOT}/src/utils/cleanupRegistry.ts'
  import { gracefulShutdown, setupGracefulShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
  setupGracefulShutdown()
  registerCleanup(async () => {
    void Promise.reject(${rejection})
    await new Promise(resolve => setTimeout(resolve, 150))
  })
  await gracefulShutdown(0)
`

section('§1 a peer that closed its pipe during a requested shutdown is not a crash')
{
  const quit = runBunChild('quit-epipe', SHUTDOWN_CHILD(PEER_GONE))
  check('the child exits 0 through the shutdown road', quit.status === 0, `status=${String(quit.status)} ${quit.err}`)
  const records = crashRecords(quit.home)
  check('a broken-pipe rejection raised inside gracefulShutdown files NO crash record', records.length === 0, records.join(', '))
}
{
  const fault = runBunChild('quit-fault', SHUTDOWN_CHILD(`new Error('boom-in-cleanup')`))
  check('control: the child exits 0', fault.status === 0, `status=${String(fault.status)} ${fault.err}`)
  const records = crashRecords(fault.home)
  check('control: an ordinary rejection during shutdown still files its record (forensics kept)', records.length === 1 && records[0]!.includes('unhandled-rejection'), records.join(', '))
  if (records[0] !== undefined) {
    const body = readFileSync(join(fault.home, 'crashes', records[0]), 'utf8')
    check('control: …carrying the real error', body.includes('boom-in-cleanup'))
  }
}
{
  const live = runBunChild('live-epipe', `
    import { setupGracefulShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
    setupGracefulShutdown()
    void Promise.reject(${PEER_GONE})
    setTimeout(() => process.exit(0), 400)
  `)
  check('control: the child exits 0', live.status === 0, `status=${String(live.status)} ${live.err}`)
  const records = crashRecords(live.home)
  check('control: the same broken pipe OUTSIDE a shutdown still files its record', records.length === 1 && records[0]!.includes('unhandled-rejection'), records.join(', '))
}

section("§2 the field's shape under the product's runtime (node): the quit stops a language server whose pipe is already closed")
{
  const nodeCandidates = [
    process.env.MERCURY_NODE_BIN,
    join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node'),
    join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node'),
  ].filter((p): p is string => p !== undefined && p !== '' && existsSync(p))
  const nodeBin = nodeCandidates[0] ?? 'node'
  const probe = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  check(`a node binary answers (${nodeBin})`, probe.status === 0 && /^v\d+/.test(probe.stdout.trim()), `${String(probe.status)} ${probe.stderr}`)

  const outDir = join(SCRATCH, 'node-bundle')
  mkdirSync(outDir, { recursive: true })
  const entry = join(outDir, 'entry.ts')
  const marker = join(SCRATCH, 'server-closed-its-stdin')
  const serverBody = `require('fs').closeSync(0); require('fs').writeFileSync(process.argv[1], 'closed'); setInterval(() => {}, 1000)`
  writeFileSync(entry, `
    import { existsSync } from 'node:fs'
    import { registerCleanup } from '${ROOT}/src/utils/cleanupRegistry.ts'
    import { gracefulShutdown, setupGracefulShutdown } from '${ROOT}/src/utils/gracefulShutdown.ts'
    import { createLSPClient } from '${ROOT}/src/services/lsp/LSPClient.ts'
    setupGracefulShutdown()
    const client = createLSPClient('field-r29a-08')
    await client.start(${JSON.stringify(nodeBin)}, ['-e', ${JSON.stringify(serverBody)}, ${JSON.stringify(marker)}])
    const started = Date.now()
    while (!existsSync(${JSON.stringify(marker)}) && Date.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 20))
    registerCleanup(() => client.stop({ gracefulTimeoutMs: 1500 }))
    await gracefulShutdown(0)
  `)
  const exts = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    naming: 'quit.node.mjs',
    target: 'node',
    format: 'esm',
    sourcemap: 'none',
    plugins: [
      {
        name: 'product-resolution',
        setup(build) {
          build.onResolve({ filter: /^src\// }, args => {
            const base = resolve(ROOT, args.path)
            const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
            for (const candidate of [base, ...exts.map(e => stripped + e), ...exts.map(e => stripped + '/index' + e)]) {
              if (existsSync(candidate)) return { path: candidate }
            }
            return undefined
          })
          build.onResolve({ filter: /\.node$/ }, args => ({ path: args.path, external: true }))
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: join(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js') }))
        },
      },
    ],
    loader: { '.md': 'text', '.txt': 'text', '.sh': 'text', '.py': 'text', '.html': 'text', '.xml': 'text', '.dot': 'text' },
  })
  check('the shutdown road and the LSP client bundle for node', built.success, built.logs.map(String).join('\n').slice(0, 800))
  const bundle = built.outputs[0]?.path
  if (built.success && bundle !== undefined) {
    const home = join(SCRATCH, 'node-home')
    mkdirSync(home, { recursive: true })
    const r = spawnSync(nodeBin, [bundle], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: 'production' },
      cwd: ROOT,
    })
    check('the server closed its stdin before the quit (the race the field met, made certain)', existsSync(marker))
    check('the quit exits 0', r.status === 0, `status=${String(r.status)} signal=${String(r.signal)} ${(r.stderr ?? '').slice(0, 600)}`)
    const records = crashRecords(home)
    check('no crash record: the write EPIPE to the gone language server is not a crash', records.length === 0, records.map(f => `${f}: ${readFileSync(join(home, 'crashes', f), 'utf8').slice(0, 200)}`).join(' | '))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-quit-files-no-crash: all green' : `\nprove-quit-files-no-crash: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
