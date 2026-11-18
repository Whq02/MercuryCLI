#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { EXT_RE, PREFLIGHT, codeLines, extOf, isFile, join, relative, resolve, runnerLaunches, shellTargets, type Ext } from '../lib/runnerLaunches.ts'

const REPORT = process.argv.includes('--report')
const WRITE = process.argv.includes('--write')
const REAL_ROOT = resolve(import.meta.dir, '..', '..')
const SELF = resolve(import.meta.path)
const TABLE = 'scripts/gate/suite-class-census.tsv'


const PY_PTY = /\b(?:pty\.fork|pty\.openpty|os\.openpty|os\.forkpty|pty\.spawn)\s*\(/
const NODE_PTY = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]node-pty['"]/
const SPAWN_CALL = /\b(?:spawn|spawnSync|spawnCaptureSync|execFile|execFileSync|exec|execSync|subprocess\.(?:run|Popen|call|check_output)|Bun\.spawn(?:Sync)?)\b/
const SHELL_PYTHON = /(?:^|[\s"'(])python3?\b/
const spawnShape = (line: string, ext: Ext | null): boolean => SPAWN_CALL.test(line) || (ext === 'sh' && SHELL_PYTHON.test(line))
const READ = /\b(?:readFileSync|readFile|existsSync|statSync|readdirSync|Bun\.file)\s*\(/
const PY_READ = /\bopen\s*\(|\bos\.path\.(?:exists|isfile|isdir|getsize|getmtime)\s*\(|\.read_(?:text|bytes)\s*\(/
const ASSIGN = /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=[^=]|^\s*[A-Za-z_$][\w$.]*\s*=[^=]/
const ENGINE_RESOLVER = /\b(?:captureEngineEntry|CAPTURE_ENGINE_ENTRY)\b/
const RESOLVER_CALL = /(?<!function\s)\bcaptureEngineEntry\s*\(/
const TYPE_IMPORT = /^\s*(?:import|export)\s+type\b/
const DIR_ANCHORS = new Set(['import.meta.dir', '__dirname', 'HERE', 'here', 'DIR', 'dir'])
const ROOT_ANCHORS = new Set(['ROOT', 'REPO', 'repo', 'root', 'repoRoot', 'REPO_ROOT', 'repo_root'])
const CLASSES = new Set(['pure', 'cpu', 'pty', 'exclusive'])
const SPAWN_WINDOW = 6
const BUILT_REACH = 80
const REBOUND_ANCHOR = /\b(?:const|let|var)\s+(here|HERE|DIR|dir)\s*=\s*(?!.*(?:import\.meta|__dirname|dirname\())/g
const NAMED = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=[^=]/
const CONTINUES = /^\s*(?:[?:.+]|\|\||&&)/
const HANDED = /(?:^|[(,[])\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[,)\]]|$)/g
const FIELD_READ = /[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\b(?!\s*\()/g
const BUN_SPAWN = /\bBun\.spawn\s*\(/
const TERMINAL_OPTION = /(?:^|[{,\s])terminal\s*:\s*\{/
const BUN_TERMINAL = 'opens a pseudo-terminal: Bun.spawn with a terminal'
const WIN_ONLY_GUARD = /^(\s*)if\s*\(\s*process\.platform\s*!==\s*['"]win32['"]\s*\)\s*(?:return|throw|process\.exit)\b/
const WIN_ONLY_BLOCK = /^(\s*)if\s*\(\s*process\.platform\s*===\s*['"]win32['"]\s*\)\s*\{\s*$/
const CAPTURE_SLOT = 'a capture slot'
const LAUNCHES: Array<{ thing: string; sign: RegExp }> = [
  { thing: 'a container engine', sign: /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"]docker['"]/ },
  { thing: 'an application', sign: /(?<![.\w])installPinned\s*\(|craft_connect['"]\s*,\s*\{\s*mode:\s*['"]launch['"]/ },
]
const CLASS_LAW =
  "the terminal class: a proof is of it when it runs the product's screen in a pseudo-terminal, whatever opens it (the capture engine, ptydrive.py, ptyrun.py, Bun's terminal through scripts/lib/ptyRecorder.ts); a pseudo-terminal the product itself gives a child (the service pty host) is not"
const ARM_LAW =
  "a platform arm: lines a proof reaches on Windows only (after `if (process.platform !== 'win32') return`, or inside `if (process.platform === 'win32') {`) open nothing on the hosts the gate runs on and are not read"
const SCARCE_LAW =
  'a -drives suite holds proofs that need a scarce shared thing, named from what the proof launches: a capture slot, a container engine, an application; a member of a terminal suite that needs none is quiet'

const unquoted = (line: string): string => line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
const depthOf = (line: string): number => {
  const b = unquoted(line)
  return (b.match(/[([{]/g)?.length ?? 0) - (b.match(/[)\]}]/g)?.length ?? 0)
}
const indentOf = (line: string): number => line.length - line.trimStart().length

interface LineCtx {
  read: boolean
  spawn: boolean
  call: boolean
}

const IMPORT_LINE = /^\s*import\s|^\s*export\s+(?:\*|\{)[^;]*\bfrom\b|^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\b/

function windowsOnly(lines: string[]): boolean[] {
  const out = lines.map(() => false)
  lines.forEach((line, i) => {
    const guard = WIN_ONLY_GUARD.exec(line)
    const block = guard ? null : WIN_ONLY_BLOCK.exec(line)
    if (!guard && !block) return
    const indent = (guard ?? block)![1]!.length
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim() === '') continue
      if (guard ? indentOf(lines[j]!) < indent : indentOf(lines[j]!) <= indent) break
      out[j] = true
    }
  })
  return out
}

function contextOf(lines: string[], ext: Ext | null): { ctx: LineCtx[]; fileSpawns: boolean } {
  const arm = ext === 'py' || ext === 'sh' ? lines.map(() => false) : windowsOnly(lines)
  const startsSpawn = (l: string, i: number): boolean => !arm[i] && spawnShape(l, ext) && !IMPORT_LINE.test(l)
  const fileSpawns = lines.some(startsSpawn)
  let window = 0
  const call = lines.map((l, i) => {
    if (startsSpawn(l, i)) window = SPAWN_WINDOW + 1
    const on = window > 0 && !arm[i]
    if (window > 0) window--
    return on
  })
  const handed = new Set<string>()
  lines.forEach((l, i) => {
    if (call[i]) for (const m of unquoted(l).matchAll(HANDED)) handed.add(m[1]!)
  })
  const built = lines.map(() => false)
  if (fileSpawns) {
    lines.forEach((l, i) => {
      const name = NAMED.exec(l)?.[1]
      if (name === undefined || !handed.has(name) || arm[i]) return
      let depth = depthOf(l)
      for (let j = i + 1; j < lines.length && j <= i + BUILT_REACH && (depth > 0 || CONTINUES.test(lines[j]!)); j++) {
        built[j] = true
        depth += depthOf(lines[j]!)
      }
    })
  }
  const reads = ext === 'py' ? PY_READ : READ
  const ctx = lines.map((l, i) => ({ read: reads.test(l) || arm[i]!, spawn: call[i]! || built[i]! || (fileSpawns && !arm[i] && ASSIGN.test(l)), call: call[i]! }))
  return { ctx, fileSpawns }
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

function resolveModule(p: string): string | null {
  for (const c of [p, p.replace(/\.js$/, '.ts'), `${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) if (isFile(c)) return c
  return null
}

function edgesOf(root: string, file: string, lines: string[], ctx: LineCtx[]): Set<string> {
  const ext = extOf(file)
  if (ext === 'sh') return shellTargets(root, file)
  const scriptsDir = join(root, 'scripts')
  const dir = dirname(file)
  const out = new Set<string>()
  const add = (p: string): void => {
    const full = resolve(p)
    if (!full.startsWith(`${scriptsDir}/`)) return
    const r = resolveModule(full)
    if (r) out.add(r)
  }
  const rebound = new Set(lines.flatMap(l => [...l.matchAll(REBOUND_ANCHOR)].map(m => m[1]!)))
  const ownDir = (anchor: string): boolean => DIR_ANCHORS.has(anchor) && !rebound.has(anchor)
  const anchored = (anchor: string, rest: string): string | null => (ROOT_ANCHORS.has(anchor) ? join(root, rest) : ownDir(anchor) ? join(dir, rest) : null)
  const fields = new Set<string>()
  lines.forEach((line, i) => {
    if (ctx[i]!.call && !ctx[i]!.read) for (const m of unquoted(line).matchAll(FIELD_READ)) fields.add(m[1]!)
  })
  lines.forEach((line, i) => {
    const c = ctx[i]!
    if (c.read) return
    for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*['"`](scripts\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|py|sh))['"`]/g)) if (fields.has(m[1]!)) add(join(root, m[2]!))
    if (!TYPE_IMPORT.test(line)) {
      for (const m of line.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) add(join(dir, m[1]!))
      for (const m of line.matchAll(/(?:from|import|require)\s*\(?\s*`\$\{([A-Za-z_.]+)\}\/([^`$]+)`/g)) {
        const p = anchored(m[1]!, m[2]!)
        if (p) add(p)
      }
    }
    if (!c.spawn) return
    if (line.includes(PREFLIGHT)) return
    for (const m of line.matchAll(/['"`](scripts\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|py|sh))['"`]/g)) add(join(root, m[1]!))
    for (const m of line.matchAll(/`\$\{([A-Za-z_.]+)\}\/([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|py|sh))`/g)) {
      const p = anchored(m[1]!, m[2]!)
      if (p) add(p)
    }
    for (const m of line.matchAll(/\b(?:join|resolve)\(\s*([A-Za-z_.]+)\s*((?:,\s*['"][^'"]+['"])+)\s*\)/g)) {
      const anchor = m[1]!
      const segs = [...m[2]!.matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]!)
      const base = ownDir(anchor) ? dir : ROOT_ANCHORS.has(anchor) ? root : null
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
  if (lines.some((l, i) => BUN_SPAWN.test(l) && !ctx[i]!.read && lines.slice(i, i + SPAWN_WINDOW + 1).some(t => TERMINAL_OPTION.test(t)))) ev.push(BUN_TERMINAL)
  const resolvedCall = lines.some((l, i) => !ctx[i]!.read && RESOLVER_CALL.test(l) && !l.includes(PREFLIGHT) && !IMPORT_LINE.test(l))
  if (!fileSpawns) {
    if (resolvedCall) ev.push('spawns the resolved capture engine')
    return ev
  }
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
  if (!ev.some(e => e.startsWith('spawns')) && (resolvedDrive || resolvedCall)) ev.push('spawns the resolved capture engine')
  return ev
}

interface SuiteCensus {
  suite: string
  cls: string
  files: number
  executed: string[]
  drivers: string[]
  chain: string[]
  evidence: string
  why: Record<string, string>
  needs: Record<string, string>
}

export function census(root: string): { engines: string[]; suites: SuiteCensus[] } {
  const scriptsDir = join(root, 'scripts')
  const all = walk(scriptsDir)
  const engines = all
    .filter(p => p.endsWith('.py') && codeLines(p).some(l => PY_PTY.test(l)))
    .map(p => basename(p))
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort()
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
  const launchOf = (f: string): string | null => {
    if (f === SELF) return null
    const a = analysed(f)
    return LAUNCHES.find(({ sign }) => a.lines.some((l, i) => !a.ctx[i]!.read && sign.test(l)))?.thing ?? null
  }
  const out: SuiteCensus[] = []
  for (const { suite: s, launched } of runnerLaunches(root)) {
    const cls = readFileSync(join(scriptsDir, s, 'run-all.sh'), 'utf8').match(/^# gate-class:\s*(\S+)/m)?.[1] ?? 'undeclared'
    const drivers: string[] = []
    const executed: string[] = []
    const why: Record<string, string> = {}
    const needs: Record<string, string> = {}
    let first: { chain: string[]; evidence: string } | null = null
    for (const rel of launched) {
      const f = join(root, rel)
      executed.push(rel)
      const c = chainOf(f)
      if (!c) {
        const thing = launchOf(f)
        if (thing !== null) needs[rel] = thing
        continue
      }
      drivers.push(rel)
      why[rel] = `${c.chain.join(' → ')} — ${c.evidence}`
      needs[rel] = CAPTURE_SLOT
      first ??= c
    }
    out.push({ suite: s, cls, files: launched.length, executed, drivers, chain: first?.chain ?? [], evidence: first?.evidence ?? '', why, needs })
  }
  return { engines, suites: out }
}

function quietMembers(suites: SuiteCensus[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const s of suites) {
    if (s.cls !== 'pty') continue
    const members = s.executed.filter(f => s.needs[f] === undefined)
    if (members.length > 0) out.set(s.suite, members)
  }
  return out
}

function committedTable(root: string): { text: string; commit: string } | null {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
  const top = git('rev-parse', '--show-toplevel')?.trim()
  if (!top || realpathSync(top) !== realpathSync(root)) return null
  const dirty = (git('status', '--porcelain', '--', TABLE) ?? '').trim() !== ''
  const commit = (git('log', '-1', '--first-parent', '--format=%H', dirty ? 'HEAD' : 'HEAD^', '--', TABLE) ?? '').trim()
  if (commit === '') return null
  const text = git('show', `${commit}:${TABLE}`)
  return text === null ? null : { text, commit }
}

function risen(table: Map<string, number>, committed: Map<string, number>): string[] {
  const out: string[] = []
  for (const [suite, row] of table) {
    const was = committed.get(suite)
    if (was === undefined) out.push(`${suite} ${row} is a new row`)
    else if (row > was) out.push(`${suite} ${row} stands above the committed ${was}`)
  }
  return out
}

function tableOf(text: string): Map<string, number> | null {
  const rows = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^([A-Za-z0-9_-]+)\t([1-9][0-9]*)$/.exec(line)
    if (!m || rows.has(m[1]!)) return null
    rows.set(m[1]!, Number(m[2]))
  }
  return rows
}

const render = (quiet: Map<string, string[]>): string =>
  [...quiet]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([suite, members]) => `${suite}\t${members.length}\n`)
    .join('')

interface Over {
  suite: string
  members: string[]
  row: number
}

function judge(quiet: Map<string, string[]>, table: Map<string, number>): { over: Over[]; total: number; allowed: number; slack: number } {
  const over: Over[] = []
  let total = 0
  for (const [suite, members] of quiet) {
    total += members.length
    const row = table.get(suite) ?? 0
    if (members.length > row) over.push({ suite, members, row })
  }
  let allowed = 0
  let slack = 0
  for (const [suite, row] of table) {
    allowed += row
    if ((quiet.get(suite)?.length ?? 0) < row) slack++
  }
  return { over, total, allowed, slack }
}

const WRITE_COMMAND = `bun ${relative(REAL_ROOT, SELF)} --write`
const WRITE_WORDS = `${WRITE_COMMAND} lowers a row and never raises or adds one`

function told(o: Over): string {
  const plain = o.suite.endsWith('-drives') ? o.suite.slice(0, -'-drives'.length) : null
  const repair =
    plain === null
      ? `list the members that drive in scripts/${o.suite}-drives/members.txt, run by scripts/${o.suite}-drives/run-all.sh through scripts/lib/drive-members.sh, and give scripts/${o.suite}/run-all.sh the class the rest need (pure or cpu)`
      : `move each to the plain suite scripts/${plain}/run-all.sh and off scripts/${o.suite}/members.txt`
  return `${o.suite} is a terminal suite and ${o.members.length} of its members ${o.members.length === 1 ? 'needs' : 'need'} nothing scarce (${o.row === 0 ? 'it has no row' : `its row in ${TABLE} allows ${o.row}`}): ${o.members.join(' ')} — ${repair}; a member that does open a terminal, or launch another scarce thing, in a form this census does not follow is mended in this census, with a planted case; ${WRITE_WORDS}`
}

function toldDrivers(s: SuiteCensus): string {
  const twinOf = (member: string): string => `scripts/${member.split('/')[1]}-drives/members.txt`
  return `${s.suite} is declared ${s.cls} and ${s.drivers.length} of its members ${s.drivers.length === 1 ? 'drives' : 'drive'} a terminal — list each in the twin of the folder it stands in (a runner that calls drive_members from scripts/lib/drive-members.sh; make the twin if none stands) and take it off the list of scripts/${s.suite}/run-all.sh:${s.drivers.map(d => `\n      ${d} → ${twinOf(d)} (${s.why[d] ?? 'no chain'})`).join('')}`
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
  w('scripts/py-launch/run-all.sh', '#!/usr/bin/env bash\n# gate-class: cpu\n/usr/bin/python3 "$here/prove-ai.py"\n/usr/bin/python3 "$here/prove-aj.py"\n/usr/bin/python3 "$here/prove-ak.py"\n')
  w('scripts/py-launch/prove-ai.py', "import subprocess\nr = subprocess.run(\n    ['bun', 'run', 'scripts/lib/tui.ts',\n     '--cols', '80'],\n    cwd=REPO, capture_output=True, text=True)\n")
  w('scripts/py-launch/prove-aj.py', "import os\nimport subprocess\ntext = open(os.path.join(REPO, 'scripts', 'lib', 'tui.ts')).read()\nr = subprocess.run(['git', 'status'], cwd=REPO)\n")
  w('scripts/py-launch/prove-ak.py', "import os\nimport subprocess\nTUI = os.path.join(REPO, 'scripts', 'lib', 'tui.ts')\nr = subprocess.run(['bun', 'run', TUI], cwd=REPO)\n")
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
  w('scripts/template-import/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-o.ts"\n`)
  w('scripts/template-import/prove-o.ts', "const ROOT = join(import.meta.dir, '..', '..')\nconst { run } = await import(`${ROOT}/scripts/lib/arena.ts`)\nrun('.')\n")
  w('scripts/template-spawn/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-p.ts"\n`)
  w('scripts/template-spawn/prove-p.ts', "import { spawnSync } from 'node:child_process'\nconst ROOT = join(import.meta.dir, '..', '..')\nconst res = spawnSync(\n  process.execPath,\n  [`${ROOT}/scripts/ui/engine.py`, '--cols', '80'],\n)\n")
  w('scripts/lib/spawnCapture.ts', "import { spawnSync } from 'node:child_process'\nexport const spawnCaptureSync: typeof spawnSync = ((...args: Parameters<typeof spawnSync>) => spawnSync(...args)) as typeof spawnSync\n")
  w('scripts/capture-door/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-q.ts"\n`)
  w('scripts/capture-door/prove-q.ts', "import { spawnCaptureSync } from '../lib/spawnCapture.ts'\nconst capture = spawnCaptureSync(d.python, [join(import.meta.dir, '../ui/engine.py'), cfg], { encoding: 'utf8' })\n")
  w('scripts/lib/child.ts', "import { spawn } from 'node:child_process'\nexport const runChild = (argv: string[], cwd: string) => spawn(argv[0]!, argv.slice(1), { cwd })\n")
  w('scripts/handed-on/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-r.ts"\n`)
  w('scripts/handed-on/prove-r.ts', "import { runChild } from '../lib/child.ts'\nimport { captureEngineEntry, resolveDriver } from '../lib/resolver.ts'\nconst d = resolveDriver()\nconst result = await runChild([d.python, captureEngineEntry(d, ROOT), cfgPath], cwd)\n")
  w('scripts/carried/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-s.ts"\n`)
  w('scripts/carried/prove-s.ts', "import { spawnSync } from 'node:child_process'\nimport { captureEngineEntry, resolveDriver } from '../lib/resolver.ts'\nconst d = resolveDriver()\nconst found = ((): { python: string; entry: string } => {\n  return { python: d.python, entry: captureEngineEntry(d, ROOT) }\n})()\nwriteFileSync(cfgPath, JSON.stringify({ cols: 40 }))\nspawnSync(found.python, [found.entry, cfgPath], { encoding: 'utf8' })\n")
  w('scripts/shared-terminal/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pty\n${bun} run "$here/prove-t.ts"\n${bun} run "$here/prove-u.ts"\n`)
  w('scripts/shared-terminal/prove-t.ts', "import { spawnSync } from 'node:child_process'\nspawnSync(d.python, [join(ROOT, 'scripts', 'ui', 'engine.py')])\n")
  w('scripts/shared-terminal/prove-u.ts', 'export const u = 1\n')
  w('scripts/slice/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nclaimed=$(cat scripts/slice-*/members.txt 2>/dev/null | grep -v '^#')\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\nbash "$here/prove-x.sh"\n`)
  w('scripts/slice/prove-v.ts', "import { spawnSync } from 'node:child_process'\nconst dir = join(scratch, 'scripts', 'stub')\nconst runner = join(dir, 'run-all.sh')\nspawnSync('bash', [runner])\n")
  w('scripts/slice/prove-w.ts', "import { spawnSync } from 'node:child_process'\nspawnSync(d.python, [join(ROOT, 'scripts', 'ui', 'engine.py')])\n")
  w('scripts/slice/prove-x.sh', '#!/usr/bin/env bash\nbash "$here/guard.sh"\n')
  w('scripts/slice/guard.sh', `#!/usr/bin/env bash\nsay "declare them in the owning suite's run-all.sh,"\n`)
  w('scripts/slice-2/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pty\nwhile read -r name; do f="scripts/slice/$name"; bun "$f"; done < scripts/slice-2/members.txt\n')
  w('scripts/slice-2/members.txt', 'prove-w.ts\n')
  w('scripts/args-above/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-y.ts"\n`)
  w('scripts/args-above/prove-y.ts', "import { spawnSync } from 'node:child_process'\nconst runnerArgs = typing\n  ? [\n      join(HERE, '..', 'ui', 'engine.py'),\n      '--cols', '120',\n    ]\n  : [\n      join(HERE, '..', 'ui', 'engine.py'),\n      '--rows', '40',\n    ]\nconst note = 'a line that hands nothing on'\nconst res = spawnSync(\n  d.python,\n  runnerArgs,\n  { encoding: 'utf8' },\n)\n")
  w('scripts/path-table/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-z.ts"\n`)
  w('scripts/path-table/prove-z.ts', "import { spawnSync } from 'node:child_process'\nconst families = [\n  { id: 'stills', script: 'scripts/lib/tui.ts', args: ['--frames'] },\n]\nfor (const family of families) {\n  const run = spawnSync(process.execPath, [join(ROOT, family.script), ...family.args], { encoding: 'utf8' })\n}\n")
  w('scripts/lib/recorder.ts', 'export function recordPty(options: { argv: string[]; cwd: string }): unknown {\n  const child = Bun.spawn(options.argv, {\n    cwd: options.cwd,\n    terminal: {\n      cols: 120,\n      rows: 40,\n    },\n  })\n  return child\n}\n')
  w('scripts/recorded/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-ab.ts"\n`)
  w('scripts/recorded/prove-ab.ts', "import { recordPty } from '../lib/recorder.ts'\nconst recording = recordPty({ argv: ['node', bundle], cwd })\n")
  w('scripts/win-arm/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\n${bun} run "$here/prove-ac.ts"\n`)
  w('scripts/win-arm/prove-ac.ts', "async function consoleRun(): Promise<number> {\n  if (process.platform !== 'win32') return 0\n  const proc = Bun.spawn({\n    cmd: [node, probe],\n    terminal: {\n      cols: 80,\n    },\n  })\n  return proc.exited\n}\nexport const ran = await consoleRun()\n")
  w('scripts/via-here/run-all.sh', `#!/usr/bin/env bash\n# gate-class: cpu\nclaimed=$(cat "$here"/../via-here-*/members.txt 2>/dev/null | grep -v '^#')\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\n`)
  w('scripts/via-here/prove-ad.ts', "import { run } from '../lib/arena.ts'\nrun('.')\n")
  w('scripts/via-here/prove-ae.ts', 'export const ae = 1\n')
  w('scripts/via-here-drives/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pty\nwhile read -r name; do f="scripts/via-here/$name"; bun "$f"; done < scripts/via-here-drives/members.txt\n')
  w('scripts/via-here-drives/members.txt', 'prove-ad.ts\n')
  w('scripts/other-things-drives/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pty\n${bun} run "$here/prove-af.ts"\n${bun} run "$here/prove-ag.ts"\n${bun} run "$here/prove-ah.ts"\n`)
  w('scripts/other-things-drives/prove-af.ts', "import { spawnSync } from 'node:child_process'\nconst ran = spawnSync('docker', ['run', '--rm', image])\n")
  w('scripts/other-things-drives/prove-ag.ts', 'const installation = await installPinned(adapter, { dataDir })\n')
  w('scripts/other-things-drives/prove-ah.ts', "const names = ['craft_install', 'craft_connect']\nawait shared.installPinned(adapter, { fetcher })\n")
  const c = census(root)
  rmSync(root, { recursive: true, force: true })
  const drives = [...new Set(c.suites.filter(s => s.chain.length > 0).map(s => s.suite))].sort()
  const want = ['args-above', 'capture-door', 'carried', 'handed-on', 'multi-line', 'named-list', 'path-table', 'py-direct', 'py-launch', 'recorded', 'resolved-drive', 'shared-terminal', 'slice-2', 'template-import', 'template-spawn', 'via-here-drives', 'via-import-2']
  const okEngines = c.engines.join(',') === 'engine.py,prove-e.py'
  const okDrives = drives.join(',') === want.join(',')
  const parentDropsMember = c.suites.find(s => s.suite === 'via-import')?.files === 1
  const chainOk = c.suites.find(s => s.suite === 'via-import-2')?.chain.join(' → ') === 'scripts/via-import/prove-a.ts → scripts/lib/arena.ts'
  const resolvedEvidence = c.suites.find(s => s.suite === 'resolved-drive')?.evidence
  const resolvedOk = resolvedEvidence === 'spawns the resolved capture engine'
  const evidenceOfSuite = (suite: string): string => c.suites.find(s => s.suite === suite)?.evidence ?? 'no evidence'
  const formsOk = evidenceOfSuite('capture-door') === 'spawns engine.py' && evidenceOfSuite('handed-on') === 'spawns the resolved capture engine' && evidenceOfSuite('carried') === 'spawns the resolved capture engine'
  const suiteOf = (suite: string): SuiteCensus | undefined => c.suites.find(s => s.suite === suite)
  const laterFormsOk =
    evidenceOfSuite('args-above') === 'spawns engine.py' &&
    suiteOf('path-table')?.chain.join(' → ') === 'scripts/path-table/prove-z.ts → scripts/lib/tui.ts' &&
    suiteOf('recorded')?.chain.join(' → ') === 'scripts/recorded/prove-ab.ts → scripts/lib/recorder.ts' && evidenceOfSuite('recorded') === BUN_TERMINAL &&
    suiteOf('win-arm')?.drivers.length === 0 &&
    suiteOf('via-here')?.files === 1 && suiteOf('via-here')?.drivers.length === 0
  const pythonOk =
    suiteOf('py-launch')?.drivers.join(' ') === 'scripts/py-launch/prove-ai.py scripts/py-launch/prove-ak.py' &&
    suiteOf('py-launch')?.why['scripts/py-launch/prove-ai.py'] === 'scripts/py-launch/prove-ai.py → scripts/lib/tui.ts — spawns engine.py'
  const allQuiet = quietMembers(c.suites)
  const quietRead = [...allQuiet].map(([suite, members]) => `${suite}: ${members.join(' ')}`).join(' · ')
  const others = suiteOf('other-things-drives')?.needs ?? {}
  const needsOk =
    others['scripts/other-things-drives/prove-af.ts'] === 'a container engine' &&
    others['scripts/other-things-drives/prove-ag.ts'] === 'an application' &&
    others['scripts/other-things-drives/prove-ah.ts'] === undefined &&
    suiteOf('shared-terminal')?.needs['scripts/shared-terminal/prove-t.ts'] === CAPTURE_SLOT
  const quiet = new Map([...allQuiet].filter(([suite]) => suite === 'shared-terminal'))
  const held = judge(quiet, new Map([['shared-terminal', 1]]))
  const bare = judge(quiet, new Map())
  const fallen = judge(quiet, new Map([['shared-terminal', 2], ['gone', 3]]))
  const judgeOk =
    quietRead === 'other-things-drives: scripts/other-things-drives/prove-ah.ts · shared-terminal: scripts/shared-terminal/prove-u.ts' &&
    held.over.length === 0 && held.total === 1 && held.allowed === 1 && held.slack === 0 &&
    bare.over.length === 1 && bare.over[0]!.suite === 'shared-terminal' && bare.over[0]!.row === 0 && bare.over[0]!.members.join() === 'scripts/shared-terminal/prove-u.ts' &&
    fallen.over.length === 0 && fallen.allowed === 5 && fallen.slack === 2 &&
    tableOf('a\t1\nb\t2\n')?.get('b') === 2 && tableOf('a\t0\n') === null && tableOf('a\t1\na\t2\n') === null && tableOf('a 1\n') === null &&
    render(quiet) === 'shared-terminal\t1\n' &&
    told(bare.over[0]!).includes('scripts/shared-terminal-drives/members.txt') &&
    told({ suite: 'shared-drives', members: ['scripts/shared/prove-u.ts'], row: 0 }).includes('the plain suite scripts/shared/run-all.sh') &&
    risen(new Map([['a', 2], ['b', 1], ['c', 1]]), new Map([['a', 1], ['b', 1]])).join(' · ') === 'a 2 stands above the committed 1 · c 1 is a new row' &&
    risen(new Map([['a', 1]]), new Map([['a', 2], ['b', 3]])).length === 0 &&
    toldDrivers(suiteOf('shared-terminal')!).includes('scripts/shared-terminal/prove-t.ts → scripts/shared-terminal-drives/members.txt')
  const ok = okEngines && okDrives && parentDropsMember === true && chainOk && resolvedOk && formsOk && laterFormsOk && pythonOk && needsOk && judgeOk
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] §3 self-test: engines derived (${c.engines.join(',')}) · drives = {${drives.join(', ')}} (want {${want.join(', ')}}) · the complement runner drops the member (${String(parentDropsMember)}) · the member's chain runs through the helper (${String(chainOk)}) · the resolver spawned for real reads as a drive (${resolvedEvidence ?? 'no evidence'}) · the capture door, the entry handed to a helper and the entry carried to a later spawn read as drives (${['capture-door', 'handed-on', 'carried'].map(evidenceOfSuite).join(' / ')}) · an argument list built above the spawn, a table of paths a spawn runs and Bun's terminal through a recorder read as drives, a Windows-only arm as none, and the "$here"/../ spelling of a complement drops the twin's member (${String(laterFormsOk)}: ${['args-above', 'path-table', 'recorded'].map(evidenceOfSuite).join(' / ')} · win-arm ${suiteOf('win-arm')?.drivers.length ?? '?'} · via-here ${suiteOf('via-here')?.files ?? '?'}) · a Python member that starts a script through subprocess, by its path or by a path it joined, drives through that script, and one that only opens the script's file does not (${String(pythonOk)}: ${suiteOf('py-launch')?.drivers.map(d => basename(d)).join(' ') ?? 'no such suite'}) · a container engine and an application are named from what a member launches and a member that only names them is quiet (${String(needsOk)}) · a terminal suite's member that needs nothing is named, and the table judges a held row, no row, a fallen row, and a row new or higher than the committed one (${String(judgeOk)}: ${quietRead || 'none named'})`,
  )
  return ok
}

if (import.meta.main) {
  const selfOk = selfTest()
  let failures = selfOk ? 0 : 1
  const c = census(REAL_ROOT)
  console.log(`  census: ${c.suites.length} suites · engines derived: ${c.engines.join(' ')}`)
  console.log(`  ${CLASS_LAW}`)
  console.log(`  ${ARM_LAW}`)
  console.log(`  ${SCARCE_LAW}`)
  const wrong = c.suites.filter(s => s.chain.length > 0 && s.cls !== 'pty')
  const needless = c.suites.filter(s => s.cls === 'pty' && Object.keys(s.needs).length === 0)
  const unclassed = c.suites.filter(s => !CLASSES.has(s.cls))
  const wrongDrive = c.suites.filter(s => s.suite.endsWith('-drives') && s.cls !== 'pty')
  failures += wrongDrive.length
  console.log(`  [${wrongDrive.length ? 'FAIL' : 'PASS'}] every local *-drives suite declares the hosted pty class${wrongDrive.length ? `: ${wrongDrive.map(s => s.suite).join(', ')}` : ''}`)
  const otherThings = (s: SuiteCensus): Array<[string, string]> => Object.entries(s.needs).filter(([, thing]) => thing !== CAPTURE_SLOT)
  if (REPORT) {
    for (const s of c.suites) {
      const mark = s.chain.length > 0 ? 'drive' : '     '
      console.log(`  ${mark}  ${s.cls.padEnd(9)} ${s.suite.padEnd(24)} ${s.drivers.length.toString().padStart(3)}/${s.files.toString().padEnd(3)} drive  ${s.chain.length > 0 ? `${s.chain.join(' → ')} — ${s.evidence}` : ''}`)
      if (s.drivers.length > 0 && s.drivers.length < s.files) console.log(`${' '.repeat(56)}drivers: ${s.drivers.map(d => basename(d)).join(' ')}`)
      for (const [member, thing] of otherThings(s)) console.log(`${' '.repeat(56)}needs ${thing}: ${basename(member)}`)
    }
  }
  for (const s of wrong) {
    failures++
    console.log(`  [FAIL] §1 ${toldDrivers(s)}`)
  }
  if (wrong.length === 0) console.log(`  [PASS] §1 no pure/cpu/exclusive suite drives a terminal (${c.suites.filter(s => s.chain.length > 0).length} drives, all pty)`)
  for (const s of unclassed) {
    failures++
    console.log(`  [FAIL] ${s.suite} declares no valid # gate-class header (${s.cls})`)
  }
  if (needless.length > 0) console.log(`  info: terminal suites in which this census finds no member that needs a scarce thing (the class by declaration): ${needless.map(s => s.suite).join(' ')}`)
  const terminal = c.suites.filter(s => s.cls === 'pty')
  const named = terminal.flatMap(s => otherThings(s).map(([member, thing]) => `${s.suite} ${basename(member)} (${thing})`))
  if (named.length > 0) console.log(`  members of terminal suites that need another scarce thing than a capture slot: ${named.length} — ${named.join(' · ')}`)
  const plainOthers = c.suites.filter(s => s.cls !== 'pty').flatMap(s => otherThings(s).map(([member, thing]) => `${s.suite} ${basename(member)} (${thing})`))
  if (plainOthers.length > 0) console.log(`  info: members of plain suites that launch one (no rule holds them yet): ${plainOthers.length} — ${plainOthers.join(' · ')}`)
  const quietNow = quietMembers(c.suites)
  const quietTotal = [...quietNow.values()].reduce((n, members) => n + members.length, 0)
  const text = existsSync(join(REAL_ROOT, TABLE)) ? readFileSync(join(REAL_ROOT, TABLE), 'utf8') : null
  const table = text === null ? null : tableOf(text)
  const held = committedTable(REAL_ROOT)
  const committed = held === null ? null : tableOf(held.text)
  const found = table === null ? null : judge(quietNow, table)
  console.log(`  terminal suites: ${terminal.length} · ${terminal.reduce((n, s) => n + s.files, 0)} members · ${quietTotal} need nothing scarce, in ${quietNow.size} suites${found === null ? '' : ` (${TABLE} allows ${found.allowed})`}`)
  if (REPORT) for (const [suite, members] of quietNow) console.log(`  quiet  ${suite.padEnd(24)} ${members.map(m => basename(m)).join(' ')}`)
  const committedWords = held === null ? 'no committed table to compare with: not a checkout, or the first table' : `the committed table of ${held.commit.slice(0, 10)}`
  if (WRITE) {
    const ceiling = committed ?? table
    const against = ceiling === null ? null : judge(quietNow, ceiling)
    if (!selfOk) console.log('  nothing written: the census failed on its own estate')
    else if ((text !== null && table === null) || (held !== null && committed === null)) {
      failures++
      console.log(`  [FAIL] §4 ${TABLE} reads as rows of a suite and its count — put the committed table back, then write`)
    } else if (against !== null && against.over.length > 0) {
      failures++
      console.log(`  [FAIL] §4 no row rises and none is added (${against.total} now, ${against.allowed} in ${committed === null ? 'the table' : committedWords}), nothing written — ${against.over.map(told).join(' · ')}`)
    } else {
      writeFileSync(join(REAL_ROOT, TABLE), render(quietNow))
      console.log(`  wrote ${TABLE}: ${quietNow.size} rows, ${quietTotal} members${against === null ? '' : ` (${committed === null ? 'it' : committedWords} allowed ${against.allowed})`}`)
    }
  } else if (found === null || table === null) {
    failures++
    console.log(`  [FAIL] §4 ${TABLE} reads as rows of a suite and its count — ${text === null ? `no table: ${WRITE_COMMAND} writes the first one` : 'a row is not a suite and a count of 1 or more, or a suite stands twice'}`)
  } else {
    for (const o of found.over) {
      failures++
      console.log(`  [FAIL] §4 ${told(o)}`)
    }
    if (found.over.length === 0) console.log(`  [PASS] §4 every member of a terminal suite needs a scarce thing, but for the ${found.total} that ${TABLE} holds in ${quietNow.size} suites (a suite with no row holds none)`)
    const up = committed === null ? [] : risen(table, committed)
    for (const row of up) {
      failures++
      console.log(`  [FAIL] §4 ${TABLE}: ${row} (${committedWords}) — a row is never added or raised by hand: put the committed table back (git checkout ${held!.commit.slice(0, 10)} -- ${TABLE}), move the member as §4 says (to the plain suite, or the driving member to the twin), and let ${WRITE_COMMAND} lower the table`)
    }
    if (up.length === 0) console.log(`  [PASS] §4 no row of ${TABLE} is new or higher than committed (${committedWords})`)
    if (found.slack > 0) console.log(`  rows above their suite's count: ${found.slack} (${WRITE_WORDS})`)
  }
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-suite-class-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
