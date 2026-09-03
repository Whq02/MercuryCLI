#!/usr/bin/env bun
// ============================================================================
//  scripts/gate/prove-suite-class-census.ts — a suite's class is what it runs.
//
//  The split verdict plans the release set (pure · cpu · exclusive) and the
//  drives set (pty) from each suite's `# gate-class:` header, so a header that
//  understates a suite moves a real-terminal drive INTO the release verdict,
//  where runner timing reads as a product red. This census derives the truth
//  from the tree: a suite DRIVES when any file its runner executes — followed
//  through member lists, relative imports and script paths named in spawn
//  context — opens a pseudo-terminal itself or spawns one of the PTY engines.
//  The engine set is DERIVED (every Python file under scripts/ that forks a
//  pty), never listed by hand, so a new engine joins the census the day it
//  lands.
//
//  Laws:
//   §1 no pure/cpu/exclusive suite drives — a drive belongs to the pty class;
//   §2 naming is not running: a source-reading line (readFileSync of the
//      engine's text), a type-only import, a data row that cites a proof
//      path, or an env-gated render line the gate never enables executes
//      nothing; a script path or engine name counts only in SPAWN CONTEXT —
//      on a line that starts a child process, inside the call that follows,
//      or assigned to a name in a file that spawns; the resolver that only
//      NAMES the engine entry (scripts/lib/captureDriver.ts) drives nothing
//      by itself, while a file that resolves the entry AND spawns does;
//   §3 the census is self-tested on a synthetic estate before it reads the
//      real one (a checker that cannot fail is not a check).
//
//  --report prints every suite with its evidence chain and exits 0.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

const REPORT = process.argv.includes('--report')
const REAL_ROOT = resolve(import.meta.dir, '..', '..')

type Ext = 'ts' | 'tsx' | 'mjs' | 'js' | 'py' | 'sh'
const EXT_RE = /\.(ts|tsx|mjs|js|py|sh)$/
const extOf = (p: string): Ext | null => (EXT_RE.exec(p)?.[1] as Ext | undefined) ?? null

// A pseudo-terminal opened by hand (Python's pty module, inline or in a .py).
const PY_PTY = /\b(?:pty\.fork|pty\.openpty|os\.openpty|os\.forkpty|pty\.spawn)\s*\(/
// The node binding, imported (an ABSENCE pin names the package without importing it).
const NODE_PTY = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]node-pty['"]/
// A child process started from this line.
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|subprocess\.(?:run|Popen|call|check_output)|Bun\.spawn(?:Sync)?)\b|(?:^|[\s"'(])python3?\b/
// A line that READS a file (its path is text under test, not a command).
const READ = /\b(?:readFileSync|readFile|existsSync|statSync|readdirSync|Bun\.file)\s*\(/
// A name bound on this line (a path assigned here is spawned elsewhere in the file).
const ASSIGN = /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=[^=]|^\s*[A-Za-z_$][\w$.]*\s*=[^=]/
// The engine-entry resolvers: a file that uses one AND spawns drives the engine.
const ENGINE_RESOLVER = /\b(?:captureEngineEntry|CAPTURE_ENGINE_ENTRY)\b/
// A runner line the gate never enables (`[ "${UI_RENDER:-0}" = "1" ] && …`).
const ENV_GATED = /\$\{[A-Z_]+:-0\}"?\s*=\s*"1"/
const TYPE_IMPORT = /^\s*(?:import|export)\s+type\b/
const DIR_ANCHORS = new Set(['import.meta.dir', '__dirname', 'HERE', 'here', 'DIR', 'dir'])
const ROOT_ANCHORS = new Set(['ROOT', 'REPO', 'repo', 'root', 'repoRoot', 'REPO_ROOT', 'repo_root'])
const CLASSES = new Set(['pure', 'cpu', 'pty', 'exclusive'])
/** Lines after a spawn-shaped line that still belong to its call. */
const SPAWN_WINDOW = 6

function codeLines(path: string): string[] {
  const ext = extOf(path)
  const out: string[] = []
  let block = false
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const t = raw.trim()
    if (ext === 'py' || ext === 'sh') {
      if (t.startsWith('#')) continue
      out.push(raw.replace(/\s#\s.*$/, ''))
      continue
    }
    if (block) {
      if (t.includes('*/')) block = false
      continue
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) block = true
      continue
    }
    if (t.startsWith('//') || t.startsWith('*')) continue
    out.push(raw.replace(/\s\/\/\s.*$/, ''))
  }
  return out
}

interface LineCtx {
  read: boolean
  /** The line starts a child process, sits inside that call, or binds a name in a file that spawns. */
  spawn: boolean
}

// An import statement or a re-export names a module; it starts no process.
const IMPORT_LINE = /^\s*import\s|^\s*export\s+(?:\*|\{)[^;]*\bfrom\b|^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\b/

function contextOf(lines: string[]): { ctx: LineCtx[]; fileSpawns: boolean } {
  const startsSpawn = (l: string): boolean => SPAWN.test(l) && !IMPORT_LINE.test(l)
  const fileSpawns = lines.some(startsSpawn)
  let window = 0
  const ctx = lines.map(l => {
    const starts = startsSpawn(l)
    if (starts) window = SPAWN_WINDOW + 1
    const spawn = starts || window > 0 || (fileSpawns && ASSIGN.test(l))
    if (window > 0) window--
    return { read: READ.test(l), spawn }
  })
  return { ctx, fileSpawns }
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile()
}

function globDir(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return []
  const re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return readdirSync(dir).filter(n => re.test(n)).map(n => join(dir, n)).filter(isFile)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (st.isFile()) out.push(p)
  }
  return out
}

/** Files a shell file executes, resolved against its own dir and the repo root. */
function shellTargets(root: string, file: string): Set<string> {
  const scriptsDir = join(root, 'scripts')
  const dir = dirname(file)
  const out = new Set<string>()
  let gated = false
  for (const raw of codeLines(file)) {
    if (gated) {
      if (/^\s*fi\b/.test(raw)) gated = false
      continue
    }
    if (/^\s*if\b/.test(raw) && ENV_GATED.test(raw)) {
      gated = true
      continue
    }
    if (ENV_GATED.test(raw)) continue
    const loop = /^\s*for\s+\w+\s+in\s+((?:prove-[A-Za-z0-9_-]+\s+)*prove-[A-Za-z0-9_-]+)\s*;/.exec(raw)
    if (loop) {
      for (const n of loop[1]!.split(/\s+/)) {
        const p = join(dir, `${n}.ts`)
        if (isFile(p)) out.add(p)
      }
    }
    const line = raw
      .replace(/"\$\(dirname "\$0"\)"/g, dir)
      .replace(/"?\$\{?(?:here|HERE|DIR|dir|SUITE_DIR)\}?"?(?=\/)/g, dir)
      .replace(/"?\$\{?(?:root|ROOT|REPO|repo|repo_root|REPO_ROOT)\}?"?(?=\/)/g, root)
    for (const tok of line.match(/[A-Za-z0-9_./*-]+\.(?:ts|tsx|mjs|js|py|sh)\b/g) ?? []) {
      let p = tok.startsWith('/') ? tok : tok.startsWith('scripts/') ? join(root, tok) : join(dir, tok)
      p = resolve(p)
      if (!p.startsWith(`${scriptsDir}/`)) continue
      if (p.includes('*')) for (const g of globDir(dirname(p), basename(p))) out.add(g)
      else if (isFile(p)) out.add(p)
    }
  }
  return out
}

function resolveModule(p: string): string | null {
  for (const c of [p, p.replace(/\.js$/, '.ts'), `${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) if (isFile(c)) return c
  return null
}

/** Files a script file reaches: relative value imports, and script paths named in spawn context. */
function edgesOf(root: string, file: string, lines: string[], ctx: LineCtx[]): Set<string> {
  const ext = extOf(file)
  if (ext === 'sh') return shellTargets(root, file)
  if (ext === 'py') return new Set()
  const scriptsDir = join(root, 'scripts')
  const dir = dirname(file)
  const out = new Set<string>()
  const add = (p: string): void => {
    const full = resolve(p)
    if (!full.startsWith(`${scriptsDir}/`)) return
    const r = resolveModule(full)
    if (r) out.add(r)
  }
  lines.forEach((line, i) => {
    const c = ctx[i]!
    if (c.read) return
    if (!TYPE_IMPORT.test(line)) for (const m of line.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) add(join(dir, m[1]!))
    if (!c.spawn) return
    for (const m of line.matchAll(/['"`](scripts\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|py|sh))['"`]/g)) add(join(root, m[1]!))
    for (const m of line.matchAll(/\b(?:join|resolve)\(\s*([A-Za-z_.]+)\s*((?:,\s*['"][^'"]+['"])+)\s*\)/g)) {
      const anchor = m[1]!
      const segs = [...m[2]!.matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]!)
      const base = DIR_ANCHORS.has(anchor) ? dir : ROOT_ANCHORS.has(anchor) ? root : null
      if (base && EXT_RE.test(segs[segs.length - 1]!)) add(join(base, ...segs))
    }
  })
  return out
}

function evidenceOf(lines: string[], ctx: LineCtx[], fileSpawns: boolean, engines: string[]): string[] {
  const ev: string[] = []
  const pyHit = lines.find(l => PY_PTY.test(l))
  if (pyHit) ev.push(`opens a pty: ${pyHit.trim().slice(0, 72)}`)
  if (lines.some(l => NODE_PTY.test(l))) ev.push('imports node-pty')
  if (!fileSpawns) return ev
  for (let i = 0; i < lines.length; i++) {
    const c = ctx[i]!
    if (c.read || !c.spawn) continue
    const eng = engines.find(n => lines[i]!.includes(n))
    if (eng) {
      ev.push(`spawns ${eng}`)
      break
    }
  }
  if (!ev.some(e => e.startsWith('spawns')) && lines.some(l => ENGINE_RESOLVER.test(l))) ev.push('spawns the resolved capture engine')
  return ev
}

export interface SuiteCensus {
  suite: string
  cls: string
  /** Files the runner executes (after member lists and complements). */
  files: number
  /** Executed files that reach a terminal, repo-relative. */
  drivers: string[]
  /** The first driver's evidence chain: executed file → … → the file with the evidence. */
  chain: string[]
  evidence: string
}

export function census(root: string): { engines: string[]; suites: SuiteCensus[] } {
  const scriptsDir = join(root, 'scripts')
  const all = walk(scriptsDir)
  const engines = all
    .filter(p => p.endsWith('.py') && codeLines(p).some(l => PY_PTY.test(l)))
    .map(p => basename(p))
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort()
  const suites = readdirSync(scriptsDir)
    .filter(d => isFile(join(scriptsDir, d, 'run-all.sh')))
    .sort()
  const members = new Map<string, Set<string>>() // suite → member files (the parent's provers)
  for (const s of suites) {
    const mf = join(scriptsDir, s, 'members.txt')
    if (!isFile(mf)) continue
    const parent = /scripts\/([A-Za-z0-9_-]+)\/\$name/.exec(readFileSync(join(scriptsDir, s, 'run-all.sh'), 'utf8'))?.[1]
    if (!parent) continue
    const set = new Set<string>()
    for (const line of readFileSync(mf, 'utf8').split('\n')) {
      const n = line.split('#')[0]!.trim()
      if (n && isFile(join(scriptsDir, parent, n))) set.add(join(scriptsDir, parent, n))
    }
    members.set(s, set)
  }
  const cache = new Map<string, { lines: string[]; ctx: LineCtx[]; fileSpawns: boolean }>()
  const analysed = (p: string): { lines: string[]; ctx: LineCtx[]; fileSpawns: boolean } => {
    let a = cache.get(p)
    if (!a) {
      const lines = codeLines(p)
      a = { lines, ...contextOf(lines) }
      cache.set(p, a)
    }
    return a
  }
  // chainOf(file): the path from this file to the first terminal evidence it
  // reaches, memoised per file (a helper shared by many suites is walked once).
  const memo = new Map<string, { chain: string[]; evidence: string } | null>()
  const visiting = new Set<string>()
  const chainOf = (f: string): { chain: string[]; evidence: string } | null => {
    if (memo.has(f)) return memo.get(f)!
    if (visiting.has(f)) return null
    visiting.add(f)
    const a = analysed(f)
    const ev = evidenceOf(a.lines, a.ctx, a.fileSpawns, engines)
    let res: { chain: string[]; evidence: string } | null = null
    if (ev.length > 0) res = { chain: [relative(root, f)], evidence: ev[0]! }
    else {
      for (const e of edgesOf(root, f, a.lines, a.ctx)) {
        const c = chainOf(e)
        if (c) {
          res = { chain: [relative(root, f), ...c.chain], evidence: c.evidence }
          break
        }
      }
    }
    visiting.delete(f)
    memo.set(f, res)
    return res
  }
  const out: SuiteCensus[] = []
  for (const s of suites) {
    const runner = join(scriptsDir, s, 'run-all.sh')
    const text = readFileSync(runner, 'utf8')
    const cls = text.match(/^# gate-class:\s*(\S+)/m)?.[1] ?? 'undeclared'
    const start = new Set<string>([...shellTargets(root, runner), ...(members.get(s) ?? [])])
    // A complement runner executes the parent's provers NOT claimed by a sibling list.
    const complement = /cat scripts\/([A-Za-z0-9_-]+)-\*\/members\.txt/.exec(text)?.[1]
    if (complement) for (const [sib, set] of members) if (sib.startsWith(`${complement}-`)) for (const f of set) start.delete(f)
    start.delete(runner)
    const drivers: string[] = []
    let first: { chain: string[]; evidence: string } | null = null
    for (const f of [...start].sort()) {
      const c = chainOf(f)
      if (!c) continue
      drivers.push(relative(root, f))
      first ??= c
    }
    out.push({ suite: s, cls, files: start.size, drivers, chain: first?.chain ?? [], evidence: first?.evidence ?? '' })
  }
  return { engines, suites: out }
}

// ── §3 self-test on a synthetic estate ──────────────────────────────────────
function selfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'suite-census-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  const bun = '"${BUN:-$HOME/.bun/bin/bun}"'
  w('scripts/ui/engine.py', 'import os, pty\npid, fd = pty.fork()\n')
  w('scripts/lib/arena.ts', "import { spawn } from 'node:child_process'\nexport type Row = { a: number }\nexport const run = (r: string) => spawn('/usr/bin/python3', [join(r, 'scripts/ui/engine.py')])\n")
  w('scripts/lib/tui.ts', "import { spawnSync } from 'node:child_process'\nconst ENGINE = join(ROOT, 'scripts/ui/engine.py')\nspawnSync('/usr/bin/python3', [ENGINE])\n")
  // the parent runs the complement of its siblings' member lists
  w('scripts/via-import/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nclaimed=$(cat scripts/via-import-*/members.txt 2>/dev/null | grep -v '^#')\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\n`)
  w('scripts/via-import/prove-a.ts', "import { run } from '../lib/arena.ts'\nrun('.')\n")
  w('scripts/via-import/prove-b.ts', 'export const b = 1\n')
  w('scripts/via-import-2/run-all.sh', '#!/usr/bin/env bash\n# gate-class: cpu\nwhile read -r name; do f="scripts/via-import/$name"; bun "$f"; done < scripts/via-import-2/members.txt\n')
  w('scripts/via-import-2/members.txt', '# members\nprove-a.ts\n')
  // naming is not running
  w('scripts/reads-only/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n${bun} run "$here/prove-c.ts"\n`)
  w('scripts/reads-only/prove-c.ts', "import { readFileSync } from 'node:fs'\nimport { spawnSync } from 'node:child_process'\nconst src = readFileSync(join(ROOT, 'scripts/ui/engine.py'), 'utf8')\nspawnSync('true', [])\n")
  w('scripts/type-only/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-h.ts"\n`)
  w('scripts/type-only/prove-h.ts', "import type { Row } from '../lib/arena.ts'\nexport const h: Row = { a: 1 }\n")
  w('scripts/data-row/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-i.ts"\n`)
  w('scripts/data-row/prove-i.ts', "import { spawnSync } from 'node:child_process'\nconst ROWS = [\n  { n: 1, proof: 'scripts/lib/tui.ts' },\n]\nspawnSync('git', ['status'])\n")
  w('scripts/gated/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nglobs=("$here"/prove-*.ts)\n[ "\${UI_RENDER:-0}" = "1" ] && globs+=("$here"/render-*.ts)\nfor f in "\${globs[@]}"; do ${bun} run "$f"; done\n`)
  w('scripts/gated/prove-d.ts', 'export const d = 1\n')
  w('scripts/gated/render-x.ts', "import { spawnSync } from 'node:child_process'\nspawnSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'engine.py')])\n")
  // running
  w('scripts/py-direct/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pty\n/usr/bin/python3 "$here/prove-e.py"\n')
  w('scripts/py-direct/prove-e.py', 'import pty\npid, fd = pty.fork()\n')
  w('scripts/named-list/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nfor prover in prove-f prove-g; do ${bun} run "$here/$prover.ts"; done\n`)
  w('scripts/named-list/prove-f.ts', 'export const f = 1\n')
  w('scripts/named-list/prove-g.ts', "import { spawnSync } from 'node:child_process'\nconst ENGINE = join(REPO, 'scripts/ui/engine.py')\nspawnSync('/usr/bin/python3', [ENGINE])\n")
  w('scripts/multi-line/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-j.ts"\n`)
  w('scripts/multi-line/prove-j.ts', "import { spawnSync } from 'node:child_process'\nconst res = spawnSync(\n  BUN,\n  ['run', 'scripts/lib/tui.ts', '--cols', '80'],\n)\n")
  const c = census(root)
  rmSync(root, { recursive: true, force: true })
  const drives = [...new Set(c.suites.filter(s => s.chain.length > 0).map(s => s.suite))].sort()
  const want = ['multi-line', 'named-list', 'py-direct', 'via-import-2']
  const okEngines = c.engines.join(',') === 'engine.py,prove-e.py'
  const okDrives = drives.join(',') === want.join(',')
  const parentDropsMember = c.suites.find(s => s.suite === 'via-import')?.files === 1
  const chainOk = c.suites.find(s => s.suite === 'via-import-2')?.chain.join(' → ') === 'scripts/via-import/prove-a.ts → scripts/lib/arena.ts'
  const ok = okEngines && okDrives && parentDropsMember === true && chainOk
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] §3 self-test: engines derived (${c.engines.join(',')}) · drives = {${drives.join(', ')}} (want {${want.join(', ')}}) · the complement runner drops the member (${String(parentDropsMember)}) · the member's chain runs through the helper (${String(chainOk)})`,
  )
  return ok
}

if (import.meta.main) {
  let failures = selfTest() ? 0 : 1
  const c = census(REAL_ROOT)
  console.log(`  census: ${c.suites.length} suites · engines derived: ${c.engines.join(' ')}`)
  const wrong = c.suites.filter(s => s.chain.length > 0 && s.cls !== 'pty')
  const quiet = c.suites.filter(s => s.chain.length === 0 && s.cls === 'pty')
  const unclassed = c.suites.filter(s => !CLASSES.has(s.cls))
  if (REPORT) {
    for (const s of c.suites) {
      const mark = s.chain.length > 0 ? 'drive' : '     '
      console.log(`  ${mark}  ${s.cls.padEnd(9)} ${s.suite.padEnd(24)} ${s.drivers.length.toString().padStart(3)}/${s.files.toString().padEnd(3)} drive  ${s.chain.length > 0 ? `${s.chain.join(' → ')} — ${s.evidence}` : ''}`)
      if (s.drivers.length > 0 && s.drivers.length < s.files) console.log(`${' '.repeat(56)}drivers: ${s.drivers.map(d => basename(d)).join(' ')}`)
    }
  }
  for (const s of wrong) {
    failures++
    console.log(`  [FAIL] §1 ${s.suite} is declared ${s.cls} but drives a terminal: ${s.chain.join(' → ')} — ${s.evidence}`)
  }
  if (wrong.length === 0) console.log(`  [PASS] §1 no pure/cpu/exclusive suite drives a terminal (${c.suites.filter(s => s.chain.length > 0).length} drives, all pty)`)
  for (const s of unclassed) {
    failures++
    console.log(`  [FAIL] ${s.suite} declares no valid # gate-class header (${s.cls})`)
  }
  if (quiet.length > 0) console.log(`  info: pty suites with no terminal evidence in this census (wall-clock class by declaration): ${quiet.map(s => s.suite).join(' ')}`)
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-suite-class-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
