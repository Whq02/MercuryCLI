#!/usr/bin/env bun
//  drives set (pty) from each suite's `# gate-class:` header, so a header that
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

const REPORT = process.argv.includes('--report')
const REAL_ROOT = resolve(import.meta.dir, '..', '..')
const SELF = resolve(import.meta.path)

type Ext = 'ts' | 'tsx' | 'mjs' | 'js' | 'py' | 'sh'
const EXT_RE = /\.(ts|tsx|mjs|js|py|sh)$/
const extOf = (p: string): Ext | null => (EXT_RE.exec(p)?.[1] as Ext | undefined) ?? null

const PY_PTY = /\b(?:pty\.fork|pty\.openpty|os\.openpty|os\.forkpty|pty\.spawn)\s*\(/
const NODE_PTY = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]node-pty['"]/
const SPAWN_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|subprocess\.(?:run|Popen|call|check_output)|Bun\.spawn(?:Sync)?)\b/
const SHELL_PYTHON = /(?:^|[\s"'(])python3?\b/
const spawnShape = (line: string, ext: Ext | null): boolean => SPAWN_CALL.test(line) || (ext === 'sh' && SHELL_PYTHON.test(line))
const PREFLIGHT = '--preflight'
const SHELL_FILE_TEST = /(?:\[\[?|\btest)\s+(?:!\s+)?-[a-zA-Z]\s+(?:"[^"]*"|'[^']*'|\S+)(?:\s+\]\]?)?/g
const READ = /\b(?:readFileSync|readFile|existsSync|statSync|readdirSync|Bun\.file)\s*\(/
const ASSIGN = /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=[^=]|^\s*[A-Za-z_$][\w$.]*\s*=[^=]/
const ENGINE_RESOLVER = /\b(?:captureEngineEntry|CAPTURE_ENGINE_ENTRY)\b/
const ENV_GATED = /\$\{[A-Z_]+:-0\}"?\s*=\s*"1"/
const TYPE_IMPORT = /^\s*(?:import|export)\s+type\b/
const DIR_ANCHORS = new Set(['import.meta.dir', '__dirname', 'HERE', 'here', 'DIR', 'dir'])
const ROOT_ANCHORS = new Set(['ROOT', 'REPO', 'repo', 'root', 'repoRoot', 'REPO_ROOT', 'repo_root'])
const CLASSES = new Set(['pure', 'cpu', 'pty', 'exclusive'])
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
  spawn: boolean
}

const IMPORT_LINE = /^\s*import\s|^\s*export\s+(?:\*|\{)[^;]*\bfrom\b|^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\b/

function contextOf(lines: string[], ext: Ext | null): { ctx: LineCtx[]; fileSpawns: boolean } {
  const startsSpawn = (l: string): boolean => spawnShape(l, ext) && !IMPORT_LINE.test(l)
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
    if (raw.includes(PREFLIGHT)) continue
    const line = raw
      .replace(SHELL_FILE_TEST, ' ')
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
    if (line.includes(PREFLIGHT)) return
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

function evidenceOf(lines: string[], ctx: LineCtx[], fileSpawns: boolean, engines: string[], ext: Ext | null): string[] {
  const ev: string[] = []
  const pyHit = lines.find(l => PY_PTY.test(l))
  if (pyHit) ev.push(`opens a pty: ${pyHit.trim().slice(0, 72)}`)
  if (lines.some(l => NODE_PTY.test(l))) ev.push('imports node-pty')
  if (!fileSpawns) return ev
  for (let i = 0; i < lines.length; i++) {
    const c = ctx[i]!
    if (c.read || !c.spawn) continue
    if (lines[i]!.includes(PREFLIGHT)) continue
    const eng = engines.find(n => lines[i]!.includes(n))
    if (eng) {
      ev.push(`spawns ${eng}`)
      break
    }
  }
  const resolvedDrive = lines.some((l, i) => ctx[i]!.spawn && !ctx[i]!.read && ENGINE_RESOLVER.test(l) && !l.includes(PREFLIGHT) && !IMPORT_LINE.test(l))
  if (!ev.some(e => e.startsWith('spawns')) && resolvedDrive) ev.push('spawns the resolved capture engine')
  return ev
}

export interface SuiteCensus {
  suite: string
  cls: string
  files: number
  drivers: string[]
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
  const members = new Map<string, Set<string>>()
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
      a = { lines, ...contextOf(lines, extOf(p)) }
      cache.set(p, a)
    }
    return a
  }
  const memo = new Map<string, { chain: string[]; evidence: string } | null>()
  const visiting = new Set<string>()
  const chainOf = (f: string): { chain: string[]; evidence: string } | null => {
    if (memo.has(f)) return memo.get(f)!
    if (visiting.has(f) || f === SELF) return null
    visiting.add(f)
    const a = analysed(f)
    const ev = evidenceOf(a.lines, a.ctx, a.fileSpawns, engines, extOf(f))
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

function selfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'suite-census-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  const bun = '"${BUN:-$HOME/.bun/bin/bun}"'
  const forkCall = ['pty', 'fork()'].join('.')
  w('scripts/ui/engine.py', `import os, pty\npid, fd = ${forkCall}\n`)
  w('scripts/lib/arena.ts', "import { spawn } from 'node:child_process'\nexport type Row = { a: number }\nexport const run = (r: string) => spawn('/usr/bin/python3', [join(r, 'scripts/ui/engine.py')])\n")
  w('scripts/lib/tui.ts', "import { spawnSync } from 'node:child_process'\nconst ENGINE = join(ROOT, 'scripts/ui/engine.py')\nspawnSync('/usr/bin/python3', [ENGINE])\n")
  w('scripts/via-import/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nclaimed=$(cat scripts/via-import-*/members.txt 2>/dev/null | grep -v '^#')\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\n`)
  w('scripts/via-import/prove-a.ts', "import { run } from '../lib/arena.ts'\nrun('.')\n")
  w('scripts/via-import/prove-b.ts', 'export const b = 1\n')
  w('scripts/via-import-2/run-all.sh', '#!/usr/bin/env bash\n# gate-class: cpu\nwhile read -r name; do f="scripts/via-import/$name"; bun "$f"; done < scripts/via-import-2/members.txt\n')
  w('scripts/via-import-2/members.txt', '# members\nprove-a.ts\n')
  w('scripts/reads-only/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n${bun} run "$here/prove-c.ts"\n`)
  w('scripts/reads-only/prove-c.ts', "import { readFileSync } from 'node:fs'\nimport { spawnSync } from 'node:child_process'\nconst src = readFileSync(join(ROOT, 'scripts/ui/engine.py'), 'utf8')\nspawnSync('true', [])\n")
  w('scripts/type-only/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-h.ts"\n`)
  w('scripts/type-only/prove-h.ts', "import type { Row } from '../lib/arena.ts'\nexport const h: Row = { a: 1 }\n")
  w('scripts/data-row/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-i.ts"\n`)
  w('scripts/data-row/prove-i.ts', "import { spawnSync } from 'node:child_process'\nconst ROWS = [\n  { n: 1, proof: 'scripts/lib/tui.ts' },\n]\nspawnSync('git', ['status'])\n")
  w('scripts/gated/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nglobs=("$here"/prove-*.ts)\n[ "\${UI_RENDER:-0}" = "1" ] && globs+=("$here"/render-*.ts)\nfor f in "\${globs[@]}"; do ${bun} run "$f"; done\n`)
  w('scripts/gated/prove-d.ts', 'export const d = 1\n')
  w('scripts/gated/render-x.ts', "import { spawnSync } from 'node:child_process'\nspawnSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'engine.py')])\n")
  w('scripts/py-direct/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pty\n/usr/bin/python3 "$here/prove-e.py"\n')
  w('scripts/py-direct/prove-e.py', `import pty\npid, fd = ${forkCall}\n`)
  w('scripts/named-list/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nfor prover in prove-f prove-g; do ${bun} run "$here/$prover.ts"; done\n`)
  w('scripts/named-list/prove-f.ts', 'export const f = 1\n')
  w('scripts/named-list/prove-g.ts', "import { spawnSync } from 'node:child_process'\nconst ENGINE = join(REPO, 'scripts/ui/engine.py')\nspawnSync('/usr/bin/python3', [ENGINE])\n")
  w('scripts/multi-line/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-j.ts"\n`)
  w('scripts/multi-line/prove-j.ts', "import { spawnSync } from 'node:child_process'\nconst res = spawnSync(\n  BUN,\n  ['run', 'scripts/lib/tui.ts', '--cols', '80'],\n)\n")
  w('scripts/lib/resolver.ts', "export type Driver = { kind: 'posix'; python: string; engine: 'scripts/ui/engine.py' }\nexport const ENTRY = { posix: 'scripts/ui/engine.py' } as const\nexport function captureEngineEntry(d: Driver, root: string): string { return join(root, ENTRY[d.kind]) }\nexport function resolveDriver(): Driver { const python = findOnPath('python3') ?? '/usr/bin/python3'; return { kind: 'posix', python, engine: 'scripts/ui/engine.py' } }\n")
  w('scripts/names-only/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-l.ts"\n`)
  w('scripts/names-only/prove-l.ts', "import { resolveDriver } from '../lib/resolver.ts'\nexport const l = resolveDriver().python\n")
  w('scripts/preflight-only/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n/usr/bin/python3 "$root/scripts/ui/engine.py" --preflight || exit 78\n${bun} run "$here/prove-k.ts"\n`)
  w('scripts/preflight-only/prove-k.ts', "import { spawnSync } from 'node:child_process'\nimport { captureEngineEntry, resolveDriver } from '../lib/resolver.ts'\nconst d = resolveDriver()\nconst res = spawnSync(d.python, [captureEngineEntry(d, ROOT), '--preflight'], { encoding: 'utf8' })\nexport const k = res.status\n")
  w('scripts/file-test/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n[ -f "$root/scripts/ui/engine.py" ] || exit 1\nif test -x "$root/scripts/ui/engine.py"; then echo present; fi\n${bun} run "$here/prove-n.ts"\n`)
  w('scripts/file-test/prove-n.ts', 'export const n = 1\n')
  w('scripts/resolved-drive/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-m.ts"\n`)
  w('scripts/resolved-drive/prove-m.ts', "import { spawnSync } from 'node:child_process'\nimport { captureEngineEntry, resolveDriver } from '../lib/resolver.ts'\nconst d = resolveDriver()\nspawnSync(d.python, [captureEngineEntry(d, ROOT), '--preflight'], { encoding: 'utf8' })\nspawnSync(d.python, [captureEngineEntry(d, ROOT), cfgPath], { encoding: 'utf8' })\n")
  const c = census(root)
  rmSync(root, { recursive: true, force: true })
  const drives = [...new Set(c.suites.filter(s => s.chain.length > 0).map(s => s.suite))].sort()
  const want = ['multi-line', 'named-list', 'py-direct', 'resolved-drive', 'via-import-2']
  const okEngines = c.engines.join(',') === 'engine.py,prove-e.py'
  const okDrives = drives.join(',') === want.join(',')
  const parentDropsMember = c.suites.find(s => s.suite === 'via-import')?.files === 1
  const chainOk = c.suites.find(s => s.suite === 'via-import-2')?.chain.join(' → ') === 'scripts/via-import/prove-a.ts → scripts/lib/arena.ts'
  const resolvedEvidence = c.suites.find(s => s.suite === 'resolved-drive')?.evidence
  const resolvedOk = resolvedEvidence === 'spawns the resolved capture engine'
  const ok = okEngines && okDrives && parentDropsMember === true && chainOk && resolvedOk
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] §3 self-test: engines derived (${c.engines.join(',')}) · drives = {${drives.join(', ')}} (want {${want.join(', ')}}) · the complement runner drops the member (${String(parentDropsMember)}) · the member's chain runs through the helper (${String(chainOk)}) · the resolver spawned for real reads as a drive (${resolvedEvidence ?? 'no evidence'})`,
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
