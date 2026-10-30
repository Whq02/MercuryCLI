import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, extname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { installLiveFixture, proofHome, root, serverPath } from './fixture.ts'

type Runtime = { binary: string; tag: string }
const runtimeDir = join(root, 'runtime')
const readRuntime = (): Runtime => JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as Runtime

const freePort = (): Promise<number> =>
  new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })

const engineArgs = (port: number): string[] => [
  '--model-dir', join(root, 'models'),
  '--listen-ip', '127.0.0.1',
  '--listen-port', String(port),
  '--hires-upscalers-dir', join(root, 'models', 'upscalers'),
  '--offload-to-cpu', '--max-vram', '-1', '--flash-attn', 'on', '--vae-tiling',
]

async function status(child: ChildProcess, port: number, output: () => string): Promise<unknown> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/models/status`, { method: 'POST', signal: AbortSignal.timeout(1_000) })
      if (response.ok) return await response.json()
    } catch {}
    assert.equal(child.exitCode, null, `the stand-in ended before it answered: ${output()}`)
    assert.ok(Date.now() < deadline, `the stand-in did not answer within 30 s: ${output()}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function serves(command: string, args: string[], port: number): Promise<void> {
  let output = ''
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  try {
    assert.deepEqual(await status(child, port, () => output.slice(-600)), { state: 'empty', recipe: null })
    const calls = readFileSync(join(root, 'engine-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { route: string; pid: number })
    assert.deepEqual([calls.at(-1)!.route, calls.at(-1)!.pid], ['models/status', child.pid])
  } finally {
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

try {
  installLiveFixture({ platform: 'win32' })
  const bundled = JSON.parse(readFileSync(join(dirname(serverPath), 'catalog.json'), 'utf8')) as { runtime: { tag: string; platforms: Record<string, Array<{ binary: string }>> } }
  const win32 = readRuntime()
  assert.equal(dirname(win32.binary), runtimeDir)
  assert.equal(basename(win32.binary), bundled.runtime.platforms['win32-x64']![0]!.binary)
  assert.equal(extname(win32.binary), '.exe')
  assert.equal(win32.tag, bundled.runtime.tag)
  assert.notEqual(readFileSync(win32.binary).subarray(0, 2).toString('latin1'), '#!')
  assert.ok(statSync(win32.binary).size > 1024 * 1024)
  assert.deepEqual(readdirSync(runtimeDir).filter(name => /\.(?:cmd|bat)$/i.test(name)), [])
  const port = await freePort()
  await serves(win32.binary, engineArgs(port), port)

  if (process.platform !== 'win32') {
    installLiveFixture()
    const posix = readRuntime()
    assert.equal(posix.binary, join(runtimeDir, 'sd-server'))
    assert.equal(readFileSync(posix.binary, 'utf8').split('\n')[0], '#!/usr/bin/env node')
    assert.ok(statSync(posix.binary).mode & 0o100)
    const nicePort = await freePort()
    await serves('/usr/bin/nice', ['-n', '10', posix.binary, ...engineArgs(nicePort)], nicePort)
  }
  console.log('media fixture engine shape: on win32 the stand-in is a compiled sd-server.exe the engine host spawns directly, with no .cmd or shell between; on POSIX it stays the shebang script nice execs; both read their root from --model-dir and answer models/status')
} finally {
  removeScratch(proofHome)
}
