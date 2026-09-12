import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { gridToPng } from './gridToPng.ts'
import { fixture, option, ROOT } from './viewportFixture.ts'

const scratch = option('--scratch')
const out = resolve(option('--out'))
const label = option('--label')
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Use a plain file label')
const dist = option('--dist')
if (!isAbsolute(dist)) throw new Error('The bundle path must be absolute')
const node = process.argv.includes('--node') ? option('--node') : Bun.which('node')
if (!node) throw new Error('Node is required')
const scene = process.argv.includes('--scene') ? option('--scene') : 'boot'
if (!['boot', 'notice', 'all'].includes(scene)) throw new Error('Choose boot, notice, or all')
const sizes = process.argv.includes('--size') ? [option('--size')] : ['120x40', '80x24']
if (sizes.some(size => !['120x40', '80x24'].includes(size))) throw new Error('Choose 120x40 or 80x24')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.reason)
mkdirSync(out, { recursive: true })
const receipt: Record<string, unknown> = {
  label, dist, sha256: createHash('sha256').update(readFileSync(dist)).digest('hex'),
  platform: process.platform, node, captures: [],
}
const receiptPath = join(out, `${label}-${scene}-capture-receipt.json`)
if (existsSync(receiptPath)) throw new Error(`Refusing to overwrite ${receiptPath}`)
const captures = receipt.captures as unknown[]

function saveDiagnostics(world: ReturnType<typeof fixture>, tag: string): void {
  const directory = join(out, `${tag}-diagnostics`)
  mkdirSync(directory)
  const copied: string[] = []
  const missing: string[] = []
  for (const name of ['daemon.log', 'daemon.log.1', 'supervisor.json']) {
    const source = join(world.daemon, name)
    if (!existsSync(source)) { missing.push(name); continue }
    copyFileSync(source, join(directory, name))
    copied.push(name)
  }
  const debug = join(world.config, 'debug')
  if (existsSync(debug)) {
    mkdirSync(join(directory, 'debug'))
    for (const entry of readdirSync(debug, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      copyFileSync(join(debug, entry.name), join(directory, 'debug', entry.name))
      copied.push(`debug/${entry.name}`)
    }
  } else { missing.push('debug') }
  writeFileSync(join(directory, 'paths.json'), JSON.stringify({
    cwd: world.cwd, config: world.config, daemon: world.daemon,
    daemonOverride: world.env.MERCURY_DAEMON_DIR, temporaryDirectory: world.env.TMPDIR,
    copied, missing,
  }, null, 2) + '\n')
}

let failures = 0
for (const size of sizes) {
  const [cols, rows] = size.split('x').map(Number) as [number, number]
  for (const kind of scene === 'all' ? ['boot', 'notice'] : [scene]) {
    const tag = `${label}-${kind}-${size}`
    const output = join(out, `${tag}.json`)
    if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`)
    const world = fixture(scratch)
    let api: Awaited<ReturnType<typeof startFixtureApi>> | undefined
    const gate = { requireAwait: true, minTick: 3, awaitSettleTicks: 4 }
    const prompt = 'Update the local note.'
    const target = join(world.cwd, ...Array(4).fill('long-directory-name'), '.mercury', 'NEXT-SESSION.md')
    try {
      if (kind === 'notice') {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'before\n')
        api = await startFixtureApi([
          { whenSaid: prompt, kind: 'tool_use', name: 'Read', input: { file_path: target } },
          { whenSaid: prompt, kind: 'tool_use', name: 'Edit', input: { file_path: target, old_string: 'before', new_string: 'after' } },
          { whenSaid: prompt, kind: 'text', text: 'Finished.' },
        ])
      }
      const cfg = join(world.root, 'capture.json')
      const sends = kind === 'boot' ? [
        { ...gate, awaitText: '↑↓ choose', data: '\x1b[1;2C', mark: 'before' },
        { ...gate, awaitText: 'no sessions running', data: '\x1b[1;2D', mark: 'concourse' },
        { ...gate, awaitText: '↑↓ choose', data: '', mark: 'after' },
      ] : [
        { ...gate, awaitText: '↑↓ choose', data: '\r', mark: 'boot' },
        { ...gate, awaitText: 'Type a prompt', data: prompt, mark: 'session' },
        { ...gate, awaitText: prompt, data: '\r' },
        { ...gate, awaitText: 'sensitive file', data: '', mark: 'notice' },
      ]
      const readyText = kind === 'boot' ? '↑↓ choose' : 'sensitive file'
      writeFileSync(cfg, JSON.stringify({ argv: [node, dist], cwd: world.cwd, cols, rows, total: 500,
        sends, readyText, readySettleTicks: 3, out: output }))
      const env = { ...world.env, VSHOT_TEE: join(out, `${tag}.tee.bin`), ...(api ? { ANTHROPIC_BASE_URL: api.url } : {}) }
      const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfg], {
        cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let log = ''
      child.stdout.on('data', bytes => { log += String(bytes) })
      child.stderr.on('data', bytes => { log += String(bytes) })
      const result = await new Promise<{ status: number | null; signal: string | null }>(resolve => {
        const wall = setTimeout(() => { log += '\nCapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(150_000))
        child.once('error', error => { log += String(error) })
        child.once('close', (status, signal) => { clearTimeout(wall); resolve({ status, signal }) })
      })
      writeFileSync(join(out, `${tag}.log`), log)
      const payload = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null
      const marks = payload?.marks ?? []
      for (const mark of marks) {
        const frame = join(out, `${tag}-${mark.label}.json`)
        writeFileSync(frame, JSON.stringify({ cols, rows, grid: mark.grid }))
        writeFileSync(frame.replace(/\.json$/, '.txt'), mark.grid.map((r: Array<{ c: string }>) => r.map(c => c.c).join('').trimEnd()).join('\n') + '\n')
        await gridToPng(frame, frame.replace(/\.json$/, '.png'))
      }
      const labels = marks.map((m: { label: string }) => m.label)
      const expected = kind === 'boot' ? ['before', 'concourse', 'after'] : ['boot', 'session', 'notice']
      const complete = result.status === 0 && expected.every(mark => labels.includes(mark))
      if (!complete) failures++
      captures.push({ kind, cols, rows, exit: result.status, signal: result.signal, endReason: payload?.endReason, marks: labels, complete })
      console.log(`${tag}: capture exit ${result.status}; marks ${labels.join(', ')}`)
    } finally {
      try {
        if (api) writeFileSync(join(out, `${tag}-requests.json`), JSON.stringify(api.requests, null, 2))
        await api?.close()
      } finally {
        try {
          saveDiagnostics(world, tag)
        } catch (error) {
          console.error(`Could not preserve diagnostics; fixture retained at ${world.root}`)
          throw error
        }
        world.dispose()
      }
    }
  }
}
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
process.exitCode = failures ? 1 : 0
