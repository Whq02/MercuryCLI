#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const distAt = process.argv.indexOf('--dist')
const DIST = distAt !== -1 ? process.argv[distAt + 1]! : join(ROOT, 'dist', 'mercury.mjs')
const { GRAMMAR_REGISTRY } = await import('../../src/services/structure/grammarRegistry.ts')
const { LANGUAGE_FIXTURES } = await import('../ast-tools/lib/fixtures.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const OPTIMISER_COST_HELD_AT_MB = 400
const MEASURED_OPTIMISER_COST_MB: Record<string, number> = {
  swift: 2928,
  powershell: 2094,
  bash: 541,
  kotlin: 473,
  cpp: 291,
  c: 167,
  'c-sharp': 155,
  css: 120,
  ruby: 87,
  php: 30,
  javascript: 19,
  tsx: 18,
  typescript: 11,
  rust: 10,
  java: 8,
  toml: 6,
  go: 2,
  regex: 1,
  html: 0,
  vue: 0,
  python: 0,
  ini: 0,
  json: 0,
}

function vendoredNode(): string | null {
  const os = process.platform === 'win32' ? 'win' : process.platform
  const dir = join(ROOT, 'vendor', 'node', 'extracted', `${os}-${process.arch}`)
  for (const candidate of [join(dir, 'bin', 'node'), join(dir, 'node.exe')]) {
    if (existsSync(candidate)) return candidate
  }
  return Bun.which('node')
}
const NODE = vendoredNode()

section('§1 — the rows: a grammar is held when V8\'s optimising tier costs it 400 MB or more of resident memory')
{
  const held = GRAMMAR_REGISTRY.filter(g => g.baseline === true).map(g => g.name).sort()
  const measured = GRAMMAR_REGISTRY.filter(g => MEASURED_OPTIMISER_COST_MB[g.name] !== undefined)
  check('every registry row has its measured optimiser cost here', measured.length === GRAMMAR_REGISTRY.length, GRAMMAR_REGISTRY.filter(g => MEASURED_OPTIMISER_COST_MB[g.name] === undefined).map(g => g.name).join(','))
  const above = measured.filter(g => MEASURED_OPTIMISER_COST_MB[g.name]! >= OPTIMISER_COST_HELD_AT_MB).map(g => g.name).sort()
  check(`the held rows are exactly the rows measured at ${OPTIMISER_COST_HELD_AT_MB} MB or more`, JSON.stringify(held) === JSON.stringify(above), `held ${held.join(',')} · measured above ${above.join(',')}`)
  const costs = Object.values(MEASURED_OPTIMISER_COST_MB).sort((a, b) => a - b)
  const below = Math.max(...costs.filter(c => c < OPTIMISER_COST_HELD_AT_MB))
  const over = Math.min(...costs.filter(c => c >= OPTIMISER_COST_HELD_AT_MB))
  check('the threshold sits in a gap of the measured costs (nothing between 291 and 473 among these rows)', below === 291 && over === 473, `${below} · ${over}`)
  const free = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'json', 'c', 'cpp', 'c-sharp', 'css']
  check('the common languages and the heavy ones under the threshold keep the optimising tier', free.every(n => GRAMMAR_REGISTRY.find(g => g.name === n)?.baseline !== true), free.filter(n => GRAMMAR_REGISTRY.find(g => g.name === n)?.baseline === true).join(','))
  const lock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'grammars.lock.json'), 'utf8')) as { grammars: Array<{ wasm: string; optimiserCostMb?: number }> }
  const lockRows = lock.grammars.map(l => ({ lock: l, row: GRAMMAR_REGISTRY.find(g => g.wasm === l.wasm) }))
  check('every lock row carries the measured cost of its grammar, the number this proof holds', lockRows.every(r => r.row !== undefined && r.lock.optimiserCostMb === MEASURED_OPTIMISER_COST_MB[r.row.name]), lockRows.filter(r => r.row === undefined || r.lock.optimiserCostMb !== MEASURED_OPTIMISER_COST_MB[r.row.name]).map(r => `${r.lock.wasm}=${r.lock.optimiserCostMb}`).join(','))
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'grammar-hold-')))

const engineDir = join(scratch, 'engine')
const vscodeWasm = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const packDir = join(ROOT, 'vendor', 'grammars', 'extracted')
const carried: Array<{ name: string; wasm: string; baseline: boolean; sample: string }> = []
const RICHER_SAMPLES: Record<string, string> = {
  bash: 'greet() {\n  local who="$1"\n  if [ -z "$who" ]; then\n    echo "nobody" >&2\n    return 1\n  fi\n  printf "hi %s\\n" "$who"\n}\nfor f in *.txt; do\n  wc -l "$f"\ndone\n',
  powershell: 'function Get-Mean {\n  param([double[]]$Values)\n  if ($Values.Count -eq 0) { return $null }\n  ($Values | Measure-Object -Average).Average\n}\nforeach ($t in @(4.2, 0.9)) { Write-Output "tide $t" }\n',
  kotlin: 'data class Tide(val at: Long, val height: Double)\n\nfun mean(tides: List<Tide>): Double? = if (tides.isEmpty()) null else tides.map { it.height }.average()\n\nfun main() {\n    println(mean(listOf(Tide(1, 4.2))))\n}\n',
  swift: 'struct Tide { let at: Int; let height: Double }\n\nfunc mean(_ tides: [Tide]) -> Double? {\n    guard !tides.isEmpty else { return nil }\n    return tides.map(\\.height).reduce(0, +) / Double(tides.count)\n}\n\nprint(mean([Tide(at: 1, height: 4.2)]) ?? 0)\n',
}
if (NODE) {
  const source = readFileSync(join(ROOT, 'src', 'services', 'structure', 'wasmTiering.ts'), 'utf8')
  writeFileSync(join(scratch, 'tiering.mjs'), new Bun.Transpiler({ loader: 'ts' }).transformSync(source))
  mkdirSync(engineDir)
  for (const f of ['tree-sitter.js', 'tree-sitter.wasm']) copyFileSync(join(vscodeWasm, f), join(engineDir, f))
  writeFileSync(join(engineDir, 'package.json'), '{"type":"commonjs"}\n')
  for (const g of GRAMMAR_REGISTRY) {
    const from = [join(vscodeWasm, g.wasm), join(packDir, g.wasm)].find(p => existsSync(p))
    const sample = RICHER_SAMPLES[g.name] ?? (LANGUAGE_FIXTURES as Array<{ lang: string; good: string }>).find(f => f.lang === g.name)?.good
    if (!from || sample === undefined) continue
    copyFileSync(from, join(engineDir, g.wasm))
    carried.push({ name: g.name, wasm: join(engineDir, g.wasm), baseline: g.baseline === true, sample })
  }
  writeFileSync(
    join(scratch, 'sustained.mjs'),
    `import { createRequire } from 'node:module'
import { join } from 'node:path'
import { withOptimisingTierHeld } from './tiering.mjs'
const [dir, wasm, mode, warmWasm, rounds, sample] = process.argv.slice(2)
const raw = createRequire(join(dir, 'tree-sitter.js'))(join(dir, 'tree-sitter.js'))
const mod = raw && raw.Parser ? raw : raw.default
const log = console.log
console.log = console.warn = console.error = () => {}
const resident = () => Math.round(process.memoryUsage().rss / 1048576)
await mod.Parser.init({ locateFile: f => join(dir, f) })
const parser = new mod.Parser()
parser.setLanguage(await mod.Language.load(warmWasm))
parser.parse('def warm(a):\\n    return [a, "s", 1.5]\\n').delete()
const language = await mod.Language.load(wasm)
const afterLoad = resident()
let peak = afterLoad
const once = () => {
  parser.setLanguage(language)
  parser.parse(sample).delete()
}
for (let i = 0; i < Number(rounds); i++) {
  if (mode === 'held') withOptimisingTierHeld(once)
  else once()
  if (i % 50 === 0) peak = Math.max(peak, resident())
}
for (let i = 0; i < 10; i++) {
  await new Promise(resolve => setTimeout(resolve, 250))
  peak = Math.max(peak, resident())
}
console.log = log
console.log(JSON.stringify({ afterLoadMb: afterLoad, peakMb: peak }))
process.exit(0)
`,
  )
}

function sustained(g: { wasm: string; sample: string }, mode: 'held' | 'free'): { afterLoadMb: number; peakMb: number } | null {
  const rounds = Math.min(8000, Math.max(200, Math.ceil(400_000 / g.sample.length)))
  const warm = carried.find(c => c.name === 'python') ?? carried.find(c => !c.baseline)
  if (!NODE || !warm) return null
  const run = spawnSync(NODE, [join(scratch, 'sustained.mjs'), engineDir, g.wasm, mode, warm.wasm, String(rounds), g.sample], { encoding: 'utf8', timeout: 180_000, env: process.env })
  try {
    return JSON.parse((run.stdout ?? '').trim().split('\n').at(-1) ?? '')
  } catch {
    return null
  }
}

if (process.argv.includes('--measure')) {
  section(`the whole table again: every grammar this checkout carries, free against held (${carried.length} rows; minutes, and gigabytes for the free runs of the held rows)`)
  if (!NODE) {
    console.log('  [SKIP] no node binary')
  } else {
    for (const g of carried) {
      const free = sustained(g, 'free')
      const held = sustained(g, 'held')
      const cost = free && held ? free.peakMb - held.peakMb : NaN
      console.log(`  ${g.name.padEnd(12)} free ${String(free?.peakMb ?? '?').padStart(5)} MB · held ${String(held?.peakMb ?? '?').padStart(5)} MB · optimiser cost ${String(cost).padStart(5)} MB · recorded ${String(MEASURED_OPTIMISER_COST_MB[g.name] ?? '?').padStart(5)} MB · ${g.baseline ? 'HELD' : 'free'}`)
      check(`${g.name}: the row's switch agrees with this reading (${cost} MB against the ${OPTIMISER_COST_HELD_AT_MB} MB threshold)`, Number.isFinite(cost) && cost >= OPTIMISER_COST_HELD_AT_MB === g.baseline, `${cost} MB, baseline ${g.baseline}`)
    }
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log(failures > 0 ? `\ngrammar memory hold --measure: ${failures} FAILURE(S)` : '\ngrammar memory hold --measure: green')
  process.exit(failures > 0 ? 1 : 0)
}

section('§2 — the put-back is exact: V8\'s own tiering state is read back after every sequence')
if (!NODE) {
  console.log('  [SKIP] no node binary (the product runtime) — the tiering state is V8\'s and cannot be read under another engine')
} else {
  const heldGrammars = carried.filter(g => g.baseline)
  writeFileSync(
    join(scratch, 'readback.mjs'),
    `import { createRequire } from 'node:module'
import { join } from 'node:path'
import { HELD_TIER_NODE_FLAGS, optimisingTierCanBeHeld, withOptimisingTierHeld } from './tiering.mjs'
const BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00, 0x0a, 0x20, 0x01, 0x1e, 0x01, 0x02, 0x7f, 0x03, 0x40, 0x20, 0x02, 0x20, 0x01, 0x6a, 0x21, 0x02, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x20, 0x01, 0x20, 0x00, 0x49, 0x0d, 0x00, 0x0b, 0x20, 0x02, 0x0b])
const isTurbo = new Function('f', 'return %IsTurboFanFunction(f)')
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
let serial = 0
function tiersUp() {
  const bytes = BYTES.slice()
  bytes[24] = 0x61 + (serial % 26)
  bytes[25] = 0x61 + (Math.floor(serial / 26) % 26)
  serial++
  const spin = Object.values(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports)[0]
  for (let i = 0; i < 60; i++) spin(1000000)
  for (let waited = 0; waited < 1200; waited += 100) {
    if (isTurbo(spin)) return true
    pause(100)
    spin(1000)
  }
  return false
}
const out = {}
out.before = tiersUp()
out.insideOne = withOptimisingTierHeld(() => tiersUp())
out.afterOne = tiersUp()
out.nested = withOptimisingTierHeld(() => {
  const inner = withOptimisingTierHeld(() => tiersUp())
  return { inner, stillHeldAfterInner: tiersUp() }
})
out.afterNested = tiersUp()
for (let i = 0; i < 500; i++) withOptimisingTierHeld(() => i)
out.afterBackToBack = tiersUp()
try {
  withOptimisingTierHeld(() => {
    throw new Error('a parse that throws')
  })
} catch {}
out.afterThrow = tiersUp()
out.nestedThrow = withOptimisingTierHeld(() => {
  try {
    withOptimisingTierHeld(() => {
      throw new Error('an inner parse that throws')
    })
  } catch {}
  return { stillHeldAfterInnerThrow: tiersUp() }
})
out.afterNestedThrow = tiersUp()
out.value = withOptimisingTierHeld(() => 42)
const plain = { versions: { v8: '13.6', node: '24.22.1' }, execArgv: [], nodeOptions: undefined, released: false }
out.holdable = {
  plain: optimisingTierCanBeHeld(plain),
  bun: optimisingTierCanBeHeld({ ...plain, versions: { ...plain.versions, bun: '1.3.11' } }),
  noV8: optimisingTierCanBeHeld({ ...plain, versions: { node: '24.22.1' } }),
  userLiftoff: optimisingTierCanBeHeld({ ...plain, execArgv: ['--liftoff-only'] }),
  userTierUp: optimisingTierCanBeHeld({ ...plain, execArgv: ['--no-wasm-tier-up'] }),
  userDynamic: optimisingTierCanBeHeld({ ...plain, nodeOptions: '--max-old-space-size=4096 --wasm_dynamic_tiering' }),
  otherFlags: optimisingTierCanBeHeld({ ...plain, execArgv: ['--max-old-space-size=4096', '--enable-source-maps'] }),
  released: optimisingTierCanBeHeld({ ...plain, released: true }),
}
out.flags = [...HELD_TIER_NODE_FLAGS]
const dir = process.argv[2]
const grammars = JSON.parse(process.argv[3])
const raw = createRequire(join(dir, 'tree-sitter.js'))(join(dir, 'tree-sitter.js'))
const mod = raw && raw.Parser ? raw : raw.default
const log = console.log
console.log = console.warn = console.error = () => {}
await mod.Parser.init({ locateFile: f => join(dir, f) })
out.trees = {}
for (const g of grammars) {
  const parser = new mod.Parser()
  parser.setLanguage(await mod.Language.load(g.wasm))
  const read = () => {
    const tree = parser.parse(g.sample)
    const text = (tree.rootNode.hasError ? 'ERROR ' : '') + tree.rootNode.toString()
    tree.delete()
    return text
  }
  const held = withOptimisingTierHeld(read)
  for (let i = 0; i < 40; i++) withOptimisingTierHeld(read)
  const free = read()
  let last = free
  for (let i = 0; i < 300; i++) last = read()
  out.trees[g.name] = { clean: !held.startsWith('ERROR'), heldEqualsFree: held === free, freeStable: free === last, nodes: held.split('(').length - 1 }
}
out.afterGrammars = tiersUp()
console.log = log
console.log(JSON.stringify(out))
`,
  )
  const run = spawnSync(NODE, ['--allow-natives-syntax', join(scratch, 'readback.mjs'), engineDir, JSON.stringify(heldGrammars)], { encoding: 'utf8', timeout: 180_000, env: process.env })
  let out: Record<string, any> = {}
  try {
    out = JSON.parse((run.stdout ?? '').trim().split('\n').at(-1) ?? '{}')
  } catch {
    out = {}
  }
  check('the child that reads V8\'s tiering state ran', run.status === 0 && out.before !== undefined, `${run.status} ${(run.stderr ?? '').slice(-300)}`)
  check('before any hold a fresh wasm function reaches the optimising tier (the reading has teeth)', out.before === true)
  check('inside a hold a fresh wasm function stays at baseline', out.insideOne === false)
  check('after the hold the optimising tier is back', out.afterOne === true)
  check('a hold inside a hold: held inside the inner one, and STILL held after the inner one ends', out.nested?.inner === false && out.nested?.stillHeldAfterInner === false, JSON.stringify(out.nested))
  check('and back when the outermost ends', out.afterNested === true)
  check('five hundred holds back to back leave the optimising tier on', out.afterBackToBack === true)
  check('a parse that throws puts it back', out.afterThrow === true)
  check('a throw inside an inner hold leaves the outer hold standing, and the outermost end puts it back', out.nestedThrow?.stillHeldAfterInnerThrow === false && out.afterNestedThrow === true, JSON.stringify(out.nestedThrow))
  check('the held body\'s value comes back', out.value === 42)
  check('the two flags are the pair that holds at runtime', JSON.stringify(out.flags) === JSON.stringify(['--no-wasm-tier-up', '--no-wasm-dynamic-tiering']), JSON.stringify(out.flags))
  const h = out.holdable ?? {}
  check('held on plain node', h.plain === true)
  check('never held under another engine than V8 (bun, or no v8 at all)', h.bun === false && h.noV8 === false, JSON.stringify(h))
  check('never held when the user started node with tiering flags of his own', h.userLiftoff === false && h.userTierUp === false && h.userDynamic === false, JSON.stringify(h))
  check('other node flags do not turn the hold off', h.otherFlags === true)
  check('the one switch releases every grammar', h.released === false)
  check(`the held grammars this checkout carries were read (${heldGrammars.map(g => g.name).join(', ')})`, heldGrammars.length >= 2 && heldGrammars.every(g => out.trees?.[g.name] !== undefined), JSON.stringify(Object.keys(out.trees ?? {})))
  for (const g of heldGrammars) {
    const t = out.trees?.[g.name]
    check(`${g.name}: the tree parsed held is the tree parsed free, node for node, and clean`, t?.clean === true && t?.heldEqualsFree === true && t?.freeStable === true && t?.nodes > 10, JSON.stringify(t))
  }
  check('after the grammars were parsed held and free the optimising tier is on', out.afterGrammars === true)
  for (const g of heldGrammars) {
    const reading = sustained(g, 'held')
    check(
      `${g.name}: under sustained parsing with the hold the process stays within 150 MB of its size after the load${reading ? ` (${reading.afterLoadMb} MB to ${reading.peakMb} MB)` : ''}`,
      reading !== null && reading.peakMb - reading.afterLoadMb < 150,
      JSON.stringify(reading),
    )
  }
}

function residentMb(pid: number): number {
  try {
    if (process.platform === 'linux') {
      const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find(l => l.startsWith('VmRSS:')) ?? ''
      return Math.round(Number(line.replace(/[^0-9]/g, '')) / 1024)
    }
    if (process.platform === 'win32') {
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' })
      return Math.round(Number((ps.stdout ?? '').trim()) / 1048576)
    }
    const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
    return Math.round(Number((ps.stdout ?? '').trim()) / 1024)
  } catch {
    return -1
  }
}

interface Served {
  pid: number
  search(pattern: string, path: string): Promise<{ ms: number; matches: number; text: string }>
  stderr(): string
  close(): Promise<void>
}

async function serve(cwd: string, extraEnv: Record<string, string> = {}, nodeFlags: string[] = []): Promise<Served> {
  const home = mkdtempSync(join(scratch, 'home-'))
  const cfg = join(home, 'cfg')
  mkdirSync(join(cfg, 'tmp'), { recursive: true })
  const child = spawn(NODE!, [...nodeFlags, DIST, '--log-stderr', 'mcp', 'serve'], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot !== undefined && { SystemRoot: process.env.SystemRoot }),
      HOME: home,
      USERPROFILE: home,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: cfg,
      MERCURY_TMPDIR: join(cfg, 'tmp'),
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CREDENTIAL_STORE: 'file',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map<number, (msg: any) => void>()
  let buffer = ''
  let err = ''
  child.stdout.on('data', d => {
    buffer += String(d)
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      try {
        const msg = JSON.parse(line)
        if (typeof msg.id === 'number' && waiting.has(msg.id)) {
          waiting.get(msg.id)!(msg)
          waiting.delete(msg.id)
        }
      } catch {
      }
    }
  })
  child.stderr.on('data', d => {
    err += String(d)
  })
  let nextId = 1
  const request = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 120 s`)), 120_000)
      waiting.set(id, msg => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'grammar-hold', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return {
    pid: child.pid!,
    async search(pattern, path) {
      const started = performance.now()
      const res = await request('tools/call', { name: 'AstSearch', arguments: { pattern, path, mode: 'count' } })
      const ms = Math.round(performance.now() - started)
      const text = ((res.result?.content ?? []) as Array<{ text?: string }>).map(c => c.text ?? '').join('\n')
      let matches = -1
      try {
        matches = Number(JSON.parse(text).matchCount)
      } catch {
      }
      return { ms, matches, text }
    },
    stderr: () => err,
    close: () =>
      new Promise<void>(resolve => {
        child.on('close', () => resolve())
        child.kill()
      }),
  }
}

const WARM_LINE = 'grammar engine: shared runtime warmed with'
const warmLines = (text: string): number => text.split('\n').filter(l => l.includes(WARM_LINE)).length
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

section('§3 — the built product under its own runtime: a Swift project searched six times')
if (!NODE || !existsSync(DIST)) {
  console.log(`  [SKIP] ${!NODE ? 'no node binary' : `${DIST} is not built`} — the product-level reading needs both`)
} else {
  const project = join(scratch, 'project')
  const FILES = 60
  const STEPS = 6
  mkdirSync(join(project, 'swift'), { recursive: true })
  mkdirSync(join(project, 'ts'), { recursive: true })
  mkdirSync(join(project, 'one'), { recursive: true })
  for (let i = 0; i < FILES; i++) {
    const swiftSteps = Array.from({ length: STEPS }, (_, k) => `
    func step${k}(_ values: [Double], seed: Double) -> Double {
        var total = seed
        for value in values where value > 0 {
            total += value * ${k + 1}.0
        }
        if total > 100 {
            print("large \\(total)")
        } else if total < 0 {
            print("negative")
        }
        let label = total.isNaN ? "nan" : String(format: "%.2f", total)
        print(label)
        return values.isEmpty ? seed : total / Double(values.count)
    }
`).join('')
    const swift = `import Foundation

struct Row${i}: Codable, Equatable {
    let at: Int
    let height: Double
    var note: String?
}

final class Harbour${i} {
    private var rows: [Row${i}] = []
    let name: String

    init(name: String) {
        self.name = name
    }
${swiftSteps}
    var mean: Double? {
        guard !rows.isEmpty else { return nil }
        return rows.map(\\.height).reduce(0, +) / Double(rows.count)
    }
}
`
    writeFileSync(join(project, 'swift', `Harbour${i}.swift`), swift)
    if (i === 0) writeFileSync(join(project, 'one', 'Harbour.swift'), swift)
    const tsSteps = Array.from({ length: STEPS }, (_, k) => `
  step${k}(values: number[], seed: number): number {
    let total = seed
    for (const value of values) {
      if (value > 0) total += value * ${k + 1}
    }
    if (total > 100) {
      console.log(\`large \${total}\`)
    } else if (total < 0) {
      console.log('negative')
    }
    const label = Number.isNaN(total) ? 'nan' : total.toFixed(2)
    console.log(label)
    return values.length === 0 ? seed : total / values.length
  }
`).join('')
    writeFileSync(join(project, 'ts', `harbour${i}.ts`), `export interface Row${i} {
  at: number
  height: number
  note?: string
}

export class Harbour${i} {
  private rows: Row${i}[] = []
  constructor(readonly name: string) {}
${tsSteps}
  get mean(): number | undefined {
    if (this.rows.length === 0) return undefined
    return this.rows.map(r => r.height).reduce((a, b) => a + b, 0) / this.rows.length
  }
}
`)
  }
  const EXPECTED = FILES * STEPS * 3

  const a = await serve(project)
  const tsBefore = [await a.search('console.log($X)', 'ts'), await a.search('console.log($X)', 'ts'), await a.search('console.log($X)', 'ts')]
  check(`TypeScript first: ${EXPECTED} matches in ${FILES} files, three times`, tsBefore.every(r => r.matches === EXPECTED), tsBefore.map(r => r.matches).join(','))
  const before = residentMb(a.pid)
  const swiftRuns = []
  for (let i = 0; i < 6; i++) swiftRuns.push(await a.search('print($X)', 'swift'))
  check(`Swift: ${EXPECTED} matches in ${FILES} files, six times`, swiftRuns.every(r => r.matches === EXPECTED), swiftRuns.map(r => r.matches).join(','))
  await sleep(2500)
  const after = residentMb(a.pid)
  check(
    `the process's resident memory stays within 500 MB of where it stood before the Swift searches (${before} MB to ${after} MB)`,
    before > 0 && after > 0 && after - before < 500,
    `${before} MB before, ${after} MB after`,
  )
  const tsAfter = [await a.search('console.log($X)', 'ts'), await a.search('console.log($X)', 'ts'), await a.search('console.log($X)', 'ts')]
  const fastestBefore = Math.min(...tsBefore.map(r => r.ms))
  const fastestAfter = Math.min(...tsAfter.map(r => r.ms))
  check(
    `a TypeScript search after the held parses is no slower than before them (${fastestBefore} ms, then ${fastestAfter} ms)`,
    tsAfter.every(r => r.matches === EXPECTED) && fastestAfter <= fastestBefore * 1.5 + 150,
    `${fastestBefore} ms before, ${fastestAfter} ms after`,
  )
  check('a free grammar parsed first: no warm-up was needed', warmLines(a.stderr()) === 0, String(warmLines(a.stderr())))
  await a.close()

  section('§4 — the warm-up: once a process, only when a held grammar is the first to parse')
  const b = await serve(project)
  const first = await b.search('print($X)', 'one')
  check('a held grammar parsed first finds its matches', first.matches === STEPS * 3, String(first.matches))
  check('and the shared runtime was warmed once, by the first free grammar of the registry', warmLines(b.stderr()) === 1 && b.stderr().includes(`${WARM_LINE} python before the first held parse`), b.stderr().split('\n').filter(l => l.includes('grammar engine')).join(' | ').slice(0, 300))
  await b.search('print($X)', 'one')
  await b.search('console.log($X)', 'ts')
  await b.search('print($X)', 'one')
  check('later parses, held or free, do not warm again', warmLines(b.stderr()) === 1, String(warmLines(b.stderr())))
  await b.close()

  section('§5 — off, cleanly: the one switch, and a node line that carries tiering flags of the user\'s own')
  const c = await serve(project, { MERCURY_GRAMMAR_BASELINE: '0' })
  const released = await c.search('print($X)', 'one')
  check('with MERCURY_GRAMMAR_BASELINE=0 the search answers the same', released.matches === STEPS * 3, String(released.matches))
  check('and nothing is held: no warm-up', warmLines(c.stderr()) === 0, String(warmLines(c.stderr())))
  await c.close()
  const d = await serve(project, {}, ['--no-wasm-tier-up'])
  const own = await d.search('print($X)', 'one')
  check('with a tiering flag on the node line the search answers the same', own.matches === STEPS * 3, String(own.matches))
  check('and Mercury leaves the user\'s flags alone: no warm-up, no hold', warmLines(d.stderr()) === 0, String(warmLines(d.stderr())))
  await d.close()
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\ngrammar memory hold: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\ngrammar memory hold: green')
