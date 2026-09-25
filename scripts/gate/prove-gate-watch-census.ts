#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'
import { loadImpactManifest, selectImpact, type ImpactManifest } from '../verify/impactManifest.ts'
import { calleeName, declarationOf, parseSource, slash, stringText, unwrap, visit } from './sourceCensus.ts'

const REAL_ROOT = resolve(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')

export const WHOLE_TREE: Record<string, string> = {
  accounts: 'prove-keychain-miss-is-quiet walks src (the keychain-miss law)',
  bash: 'prove-shell-engine-census walks scripts (the shell-engine compatibility census)',
  build: 'prove-boot-crash-surface and prove-win32-seam-ratchet walk src (boot modules, win32 seams)',
  cache: 'prove-cache-clock-benchmark lists every suite dir under scripts (the benchmark corpus)',
  'cockpit-interaction': 'prove-status-single-face censuses src (one status face)',
  'command-catalogue': 'prove-no-literal-disabled-branches, prove-settings-popup-commands and prove-surface-truth walk src and scripts (command surfaces)',
  compositor: 'prove-uiux-wave0-census walks scripts (its proof roster)',
  'consistency-census': 'prove-ordering-pin-teeth walks scripts; a whole-tree ratchet owed by every fold',
  'core-runtime': 'prove-provider-contract walks src (provider edges)',
  critters: 'prove-small-critter-estate scans src/**/*.{ts,tsx} (the critter estate)',
  daemon: 'prove-daemon-dir-seam walks src (daemon-dir readers)',
  eval: 'prove-schema-conformance walks src (eval schemas)',
  gate: 'the gate censuses read every runner and proof under scripts; a whole-tree ratchet owed by every fold',
  identity: 'prove-docs-altitude walks the whole tree (doc surfaces); a whole-tree ratchet owed by every fold',
  'ink-runtime': 'prove-deep-import-policy walks src (deep ink imports)',
  interaction: 'prove-board-coverage walks src (master-detail boards)',
  mcp: 'prove-disable-disconnects and prove-sdk-doorway walk src (MCP client seams)',
  'model-policy': 'prove-model-pin-census and prove-neutral-model-doors walk src (model pins and doors)',
  orphans: 'prove-reachability-manifest walks src and scripts (the reachability graph)',
  permissions: 'prove-mode-alias walks src (permission-mode spellings)',
  projectdirs: 'prove-no-literal-homes walks src (literal home paths)',
  provauth: 'prove-signin-roads-pinned walks scripts (sign-in road pins)',
  'provider-compat': 'prove-route-law and prove-transport-reached-via-router walk src (provider routes)',
  substrate: 'prove-live-e2e-hermetic walks scripts (hermetic-fixture hygiene)',
  switchboard: 'prove-seat-lifecycle walks src (seat ghosts)',
  'switchboard-5': 'prove-concourse-resume walks src (concourse resume seams)',
  'switchboard-5-drives': 'prove-exit-everywhere walks src (ctrl-c handlers)',
  'switchboard-6': 'prove-status-prune walks src (retention numbers)',
  'switchboard-6-drives': 'prove-esc-led-sends walks scripts (esc-led drives)',
  'transcript-rows': 'prove-workshop-cell-card walks src (workshop cell cards)',
  'tree-ownership': 'prove-suite-membership reads every runner under scripts (the membership law)',
  ui: 'prove-branch-chip, prove-terminal-handback and prove-tty-suspend walk src (chip and terminal owners)',
  'ui-2': 'prove-no-new-hex walks src (hex colours); prove-vshot-send-hygiene walks scripts (vshot sends)',
  'ui-3': 'prove-width-oracle-sot walks src (width oracles)',
  verify: 'prove-impact-manifest loads every runner under scripts and reads git ls-files; a whole-tree ratchet owed by every fold',
  'visual-contract': 'prove-focal-ramp walks src (focal ramps)',
  voice: 'prove-voice-owners walks src (voice owners)',
}

const ENV_GATED = /\$\{[A-Z_]+:-0\}"?\s*=\s*"1"/
const RUNNER_TOKEN = /[A-Za-z0-9_@./*-]+\.(?:ts|tsx|mjs|js|sh|py)\b/g
const SHELL_PATH = /(?<![A-Za-z0-9_@./-])(?:\.{1,2}\/)?(?:src|scripts|docs|assets|design-system|bin|\.github)\/[A-Za-z0-9_@./*-]+/g
const PY_STRING = /['"]([^'"\s]+)['"]/g
const LITERAL_SHAPE = /^(?:\.{1,2}\/)?[A-Za-z0-9_@][A-Za-z0-9_@./*+-]*$/
const ROOT_ANCHORS = new Set(['ROOT', 'REPO', 'root', 'repo', 'repoRoot', 'REPO_ROOT', 'repo_root', 'REAL_ROOT'])
const DIR_ANCHORS = new Set(['__dirname', 'HERE', 'here', 'DIR', 'dir', 'SUITE_DIR'])
const JOINERS = new Set(['join', 'resolve'])
const TEXT_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'replace', 'replaceAll', 'split', 'test', 'match', 'matchAll', 'has', 'get', 'set', 'delete', 'localeCompare', 'padEnd', 'padStart', 'concat', 'add', 'push', 'log', 'error', 'warn'])
const DIR_READER = /^(?:Glob|readdir|opendir|scan|walk|glob|ls|list|collect|census|gather|crawl|enumerate|discover|files|tree|load|git)/i
const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
const WHOLE_DIRS = new Set(['', 'src', 'scripts'])
const MAX_DEPTH = 5

type ReadKind = 'file' | 'dir' | 'glob'
type ReadHow = 'import' | 'text' | 'runner'
type Read = { path: string; kind: ReadKind; via: string; how: ReadHow }
type Tree = { list: string[]; files: Set<string>; dirs: Set<string> }
type FileReads = { imports: string[]; files: string[]; dirs: string[] }
export type Miss = { suite: string; law: 1 | 2; text: string }
export type Unwatched = { path: string; kind: ReadKind; via: string; files: string[] }
export type SuiteRow = { suite: string; executed: string[]; reads: Read[]; misses: string[]; whole: string | null; unwatched: Unwatched[] }
export type Census = { suites: SuiteRow[]; globs: number; misses: Miss[] }

const globs = new Map<string, InstanceType<typeof Bun.Glob>>()
function globOf(pattern: string): InstanceType<typeof Bun.Glob> {
  let g = globs.get(pattern)
  if (!g) {
    g = new Bun.Glob(pattern)
    globs.set(pattern, g)
  }
  return g
}
const matchesAny = (path: string, patterns: string[]): boolean => patterns.some(p => globOf(p).match(path))

function treeOf(list: string[]): Tree {
  const files = new Set(list)
  const dirs = new Set<string>()
  for (const f of list) {
    let d = posix.dirname(f)
    while (d !== '.' && !dirs.has(d)) {
      dirs.add(d)
      d = posix.dirname(d)
    }
  }
  return { list, files, dirs }
}

export function trackedOf(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .map(slash)
}

function walkAll(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(slash(relative(root, full)))
    }
  }
  walk(root)
  return out
}

function insideRoot(root: string, abs: string): string | null {
  const rel = slash(relative(root, abs))
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return null
  return rel === '.' ? '' : rel
}

function classify(tree: Tree, rel: string, via: string, how: ReadHow): Read | null {
  if (rel.includes('*')) return tree.list.some(t => globOf(rel).match(t)) ? { path: rel, kind: 'glob', via, how } : null
  if (tree.files.has(rel)) return { path: rel, kind: 'file', via, how }
  if (rel === '' || tree.dirs.has(rel)) return { path: rel, kind: 'dir', via, how }
  return null
}

function filesOf(tree: Tree, read: Read): string[] {
  if (read.kind === 'file') return [read.path]
  if (read.kind === 'glob') return tree.list.filter(t => globOf(read.path).match(t))
  if (read.path === '') return tree.list
  const prefix = `${read.path}/`
  return tree.list.filter(t => t.startsWith(prefix))
}

const wholeScope = (read: Read): string | null => {
  if (read.kind === 'dir') return WHOLE_DIRS.has(read.path) ? read.path : null
  if (read.kind !== 'glob') return null
  const m = /^(?:(src|scripts)\/)?\*\*(?:\/.*)?$/.exec(read.path)
  return m ? (m[1] ?? '') : null
}
const isWhole = (read: Read): boolean => wholeScope(read) !== null
const underScope = (path: string, scope: string): boolean => scope === '' || path.startsWith(`${scope}/`)

function resolveImport(root: string, tree: Tree, fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = insideRoot(root, resolve(dirname(fromFile), spec))
  if (base === null) return null
  const stem = base.replace(/\.js$/, '')
  for (const cand of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.mjs`, `${base}.js`]) if (tree.files.has(cand)) return cand
  return null
}

function isTextContext(n: ts.Node): boolean {
  const p = n.parent
  if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return true
  if (ts.isComputedPropertyName(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p)) return true
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === n) return true
  if (ts.isBinaryExpression(p) && COMPARISONS.has(p.operatorToken.kind)) return true
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true
  if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
    const callee = unwrap(p.expression)
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true
    if (ts.isIdentifier(callee) && callee.text === 'require') return true
    if (ts.isPropertyAccessExpression(callee) && TEXT_METHODS.has(callee.name.text)) return true
  }
  return false
}

function typeOnly(s: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(s)) return s.isTypeOnly
  const clause = s.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const named = clause.namedBindings
  return clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(el => el.isTypeOnly)
}

function isCallArgument(n: ts.Node): ts.CallExpression | ts.NewExpression | null {
  const p = n.parent
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n as ts.Expression)) return p
  return null
}

function scriptReads(root: string, tree: Tree, file: string): FileReads {
  const src = parseSource(root, join(root, file))
  const fileDir = posix.dirname(file)
  const out: FileReads = { imports: [], files: [], dirs: [] }
  const consumed = new Set<ts.Node>()
  const literalPath = (text: string, base: string): string | null => {
    if (!LITERAL_SHAPE.test(text)) return null
    if (text.startsWith('./') || text.startsWith('../')) return insideRoot(root, resolve(root, base, text))
    return text.includes('/') ? insideRoot(root, resolve(root, text)) : null
  }
  const pathOf = (e: ts.Expression, depth: number): string | null => {
    if (depth > MAX_DEPTH) return null
    const x = unwrap(e)
    const t = stringText(x)
    if (t !== undefined) return literalPath(t, fileDir)
    if (ts.isIdentifier(x)) {
      const decl = declarationOf(x)
      if (decl && ts.isVariableDeclaration(decl)) {
        const init = decl.initializer ? unwrap(decl.initializer) : undefined
        if (!init) return null
        if (ts.isBinaryExpression(init) && (init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || init.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return pathOf(init.right, depth + 1)
        return pathOf(init, depth + 1)
      }
      if (decl && !ts.isImportSpecifier(decl) && !ts.isImportClause(decl)) return null
      if (ROOT_ANCHORS.has(x.text)) return ''
      if (DIR_ANCHORS.has(x.text)) return fileDir
      return null
    }
    if (ts.isPropertyAccessExpression(x) && ts.isMetaProperty(x.expression) && (x.name.text === 'dir' || x.name.text === 'dirname')) return fileDir
    if (ts.isCallExpression(x)) {
      const name = calleeName(x)
      if (name === 'cwd' && ts.isPropertyAccessExpression(unwrap(x.expression))) return ''
      if (!name || !JOINERS.has(name) || x.arguments.length === 0) return null
      const args = x.arguments.map(a => unwrap(a))
      let i = 0
      let base = ''
      if (stringText(args[0]!) === undefined) {
        const b = pathOf(args[0]!, depth + 1)
        if (b === null) return null
        base = b
        i = 1
      }
      const segs: string[] = []
      for (; i < args.length; i++) {
        const seg = stringText(args[i]!)
        if (seg === undefined) return null
        segs.push(seg)
      }
      return insideRoot(root, resolve(root, base, ...segs))
    }
    if (ts.isTemplateExpression(x) && x.head.text === '' && x.templateSpans.length === 1) {
      const span = x.templateSpans[0]!
      const base = pathOf(span.expression, depth + 1)
      if (base === null || !span.literal.text.startsWith('/')) return null
      return insideRoot(root, resolve(root, base, span.literal.text.slice(1)))
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const base = pathOf(x.left, depth + 1)
      const tail = stringText(unwrap(x.right))
      if (base === null || tail === undefined || !tail.startsWith('/')) return null
      return insideRoot(root, resolve(root, base, tail.slice(1)))
    }
    return null
  }
  const spec = (s: string): void => {
    const target = resolveImport(root, tree, src.path, s)
    if (target) out.imports.push(target)
  }
  const scannedGlob = (call: ts.CallExpression | ts.NewExpression): string | null => {
    const callee = unwrap(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || !/^scan(?:Sync)?$/.test(callee.name.text)) return null
    const receiver = unwrap(callee.expression)
    const pattern = ts.isNewExpression(receiver) && receiver.arguments?.[0] ? stringText(unwrap(receiver.arguments[0])) : undefined
    return pattern ?? null
  }
  const emit = (n: ts.Node, p: string | null): void => {
    if (p === null) return
    const rel = posix.normalize(p).replace(/^\.$/, '')
    if (tree.files.has(rel)) {
      out.files.push(rel)
      return
    }
    if (rel !== '' && !rel.includes('*') && !tree.dirs.has(rel)) return
    const call = isCallArgument(n)
    if (!call || !DIR_READER.test(calleeName(call) ?? '')) return
    if (rel.includes('*')) {
      out.files.push(rel)
      return
    }
    const pattern = scannedGlob(call)
    if (pattern !== null) out.files.push(posix.normalize(posix.join(rel, pattern)))
    else out.dirs.push(rel)
  }
  for (const s of src.sf.statements) {
    if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) && !typeOnly(s)) spec(s.moduleSpecifier.text)
  }
  visit(src.sf, n => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression)
      const first = n.arguments[0]
      if (first && (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))) {
        const t = stringText(unwrap(first))
        if (t !== undefined) spec(t)
        return
      }
      const name = calleeName(n)
      if (name && JOINERS.has(name)) {
        for (const a of n.arguments) if (stringText(unwrap(a)) !== undefined) consumed.add(unwrap(a))
        emit(n, pathOf(n, 0))
      }
      return
    }
    if (ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      emit(n, pathOf(n, 0))
      return
    }
    if (ts.isIdentifier(n) && isCallArgument(n)) {
      const p = pathOf(n, 0)
      if (p !== null && !tree.files.has(posix.normalize(p))) emit(n, p)
      return
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !consumed.has(n) && !isTextContext(n)) emit(n, literalPath(n.text, fileDir))
  })
  return out
}

function shellCode(text: string): string[] {
  const out: string[] = []
  let gated = false
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (t.startsWith('#') || t === '') continue
    if (gated) {
      if (/^\s*fi\b/.test(raw)) gated = false
      continue
    }
    if (/^\s*if\b/.test(raw) && ENV_GATED.test(raw)) {
      gated = true
      continue
    }
    if (ENV_GATED.test(raw)) continue
    out.push(raw.replace(/\s#\s.*$/, ''))
  }
  return out
}

function substitute(line: string, dir: string): string {
  return line
    .replace(/"?\$\(dirname "\$\{?BASH_SOURCE\[0\]\}?"\)"?/g, dir)
    .replace(/"?\$\(dirname "\$0"\)"?/g, dir)
    .replace(/"?\$\{?(?:here|HERE|dir|DIR|SUITE_DIR|suite_dir)\}?"?(?=\/)/g, dir)
    .replace(/"?\$\{?(?:root|ROOT|repo|REPO|repo_root|REPO_ROOT)\}?"?\//g, '')
}

function shellReads(root: string, file: string): FileReads {
  const dir = posix.dirname(file)
  const out: FileReads = { imports: [], files: [], dirs: [] }
  for (const line of shellCode(readFileSync(join(root, file), 'utf8'))) {
    for (const tok of substitute(line, dir).match(SHELL_PATH) ?? []) {
      const rel = tok.startsWith('.') ? insideRoot(root, resolve(root, dir, tok)) : posix.normalize(tok)
      if (rel !== null) out.files.push(rel.replace(/\/$/, ''))
    }
  }
  return out
}

function pythonReads(root: string, file: string): FileReads {
  const out: FileReads = { imports: [], files: [], dirs: [] }
  const text = readFileSync(join(root, file), 'utf8').replace(/^\s*#.*$/gm, '')
  for (const m of text.matchAll(PY_STRING)) if (LITERAL_SHAPE.test(m[1]!) && m[1]!.includes('/') && !m[1]!.startsWith('.')) out.files.push(posix.normalize(m[1]!))
  return out
}

function runnerTargets(root: string, tree: Tree, suite: string): Set<string> {
  const dir = `scripts/${suite}`
  const out = new Set<string>()
  for (const line of shellCode(readFileSync(join(root, dir, 'run-all.sh'), 'utf8'))) {
    for (const tok of substitute(line, dir).match(RUNNER_TOKEN) ?? []) {
      const rel = tok.startsWith('/') ? insideRoot(root, tok) : posix.normalize(tok)
      if (rel === null || !rel.startsWith('scripts/') || rel.startsWith('scripts/lib/') || rel === `${dir}/run-all.sh`) continue
      if (rel.includes('*')) for (const t of tree.list) if (globOf(rel).match(t)) out.add(t)
      if (tree.files.has(rel)) out.add(rel)
    }
  }
  return out
}

type Members = { parent: string; files: string[] }

function membersOf(root: string, tree: Tree, suite: string): Members | null {
  const list = `scripts/${suite}/members.txt`
  if (!tree.files.has(list)) return null
  const parent = /scripts\/([A-Za-z0-9_-]+)\/\$name/.exec(readFileSync(join(root, 'scripts', suite, 'run-all.sh'), 'utf8'))?.[1]
  if (!parent) return null
  const files: string[] = []
  for (const line of readFileSync(join(root, list), 'utf8').split('\n')) {
    const name = line.split('#')[0]!.trim()
    if (name && tree.files.has(`scripts/${parent}/${name}`)) files.push(`scripts/${parent}/${name}`)
  }
  return { parent, files }
}

export function census(root: string, tracked: string[], manifest: ImpactManifest, whole: Record<string, string>): Census {
  const tree = treeOf(tracked)
  const misses: Miss[] = []
  let globCount = 0
  for (const suite of manifest.suites) {
    const runner = `scripts/${suite}/run-all.sh`
    const lines = readFileSync(join(root, runner), 'utf8').split('\n')
    const declared = manifest.watches[suite] ?? []
    globCount += declared.length
    for (const g of declared) if (!tree.list.some(t => globOf(g).match(t))) misses.push({ suite, law: 1, text: `${runner}: gate-watch ${g} matches no tracked path` })
    let header = true
    lines.forEach((line, i) => {
      if (header && line !== '' && !line.startsWith('#')) header = false
      if (!header && /^# gate-watch:/.test(line)) misses.push({ suite, law: 1, text: `${runner}:${i + 1}: a gate-watch line below the header block is never read` })
    })
  }
  const members = new Map<string, Members>()
  for (const suite of manifest.suites) {
    const m = membersOf(root, tree, suite)
    if (m) members.set(suite, m)
  }
  const readCache = new Map<string, FileReads>()
  const readsOf = (file: string): FileReads => {
    let r = readCache.get(file)
    if (!r) {
      if (/\.(?:ts|tsx|mjs|js)$/.test(file)) r = scriptReads(root, tree, file)
      else if (file.endsWith('.sh')) r = shellReads(root, file)
      else if (file.endsWith('.py')) r = pythonReads(root, file)
      else r = { imports: [], files: [], dirs: [] }
      readCache.set(file, r)
    }
    return r
  }
  const claims = (suite: string, path: string): boolean => path.startsWith(`scripts/${suite}/`) || matchesAny(path, manifest.watches[suite] ?? [])
  const rows: SuiteRow[] = []
  for (const suite of manifest.suites) {
    const runner = `scripts/${suite}/run-all.sh`
    const own = `scripts/${suite}/`
    const descend = new Set([own])
    const executed = runnerTargets(root, tree, suite)
    const shard = members.get(suite)
    if (shard) {
      descend.add(`scripts/${shard.parent}/`)
      for (const f of shard.files) executed.add(f)
    }
    const complement = /cat scripts\/([A-Za-z0-9_-]+)-\*\/members\.txt/.exec(readFileSync(join(root, runner), 'utf8'))?.[1]
    if (complement) for (const [sib, m] of members) if (sib.startsWith(`${complement}-`)) for (const f of m.files) executed.delete(f)
    const reads: Read[] = []
    const seen = new Set<string>()
    const add = (rel: string, via: string, how: ReadHow): void => {
      const key = `${rel}\0${via}`
      if (seen.has(key)) return
      seen.add(key)
      const r = classify(tree, rel, via, how)
      if (r) reads.push(r)
    }
    const queue = [...executed]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const file = queue.shift()!
      if (visited.has(file)) continue
      visited.add(file)
      if (!file.startsWith(own)) add(file, runner, 'runner')
      if (![...descend].some(d => file.startsWith(d))) continue
      const r = readsOf(file)
      for (const imp of r.imports) {
        if ([...descend].some(d => imp.startsWith(d))) queue.push(imp)
        else add(imp, file, 'import')
      }
      for (const f of r.files) add(f, file, 'text')
      for (const d of r.dirs) add(d, file, 'text')
    }
    const wholeReads = reads.filter(isWhole)
    const reason = whole[suite]
    const row: SuiteRow = { suite, executed: [...executed].sort(), reads, misses: [], whole: wholeReads.length > 0 && reason ? reason : null, unwatched: [] }
    const scopes = new Set(row.whole === null ? [] : wholeReads.map(r => wholeScope(r)!))
    if (row.whole === null) for (const r of wholeReads) row.misses.push(`${r.via} reads the whole tree (${r.path || '.'}); the suite is not registered as a whole-tree reader`)
    if (wholeReads.length === 0 && reason) row.misses.push(`registered as a whole-tree reader (${reason}) but no proof it runs reads the whole tree`)
    {
      const perPath = new Map<string, { via: string; files: string[]; unwatched: string[] }>()
      for (const read of reads) {
        if (isWhole(read)) continue
        const files = filesOf(tree, read)
        const unwatched = files.filter(f => !claims(suite, f) && ![...scopes].some(s => underScope(f, s)))
        if (unwatched.length === 0) continue
        const key = read.kind === 'file' ? read.path : `${read.path}${read.kind === 'dir' ? '/**' : ''}`
        if (perPath.has(key)) continue
        perPath.set(key, { via: read.via, files, unwatched })
        row.unwatched.push({ path: read.path, kind: read.kind, via: read.via, files: unwatched })
      }
      for (const [key, hit] of [...perPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const sample = hit.unwatched[0]!
        const who = (selectImpact(manifest, [sample]).perPath[sample] ?? []).filter(c => c !== suite && !c.startsWith('('))
        const scope = hit.files.length > 1 ? ` (${hit.unwatched.length} of ${hit.files.length} files outside the watch, e.g. ${sample})` : ''
        row.misses.push(`${hit.via} reads ${key}${scope} — the gate wakes ${who.length > 0 ? who.join(', ') : 'nothing'} for ${sample}, not ${suite}`)
      }
    }
    for (const text of row.misses) misses.push({ suite, law: 2, text })
    rows.push(row)
  }
  return { suites: rows, globs: globCount, misses }
}

function selfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'gate-watch-census-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  const bun = '"${BUN:-$HOME/.bun/bin/bun}"'
  w('src/alpha/a.ts', 'export const a = 1\n')
  w('src/beta/b.ts', 'export const b = 2\n')
  w('src/beta/c.ts', 'export const c = 3\n')
  w('src/beta/data.json', '{}\n')
  w('src/gamma/g.ts', 'export const g = 4\n')
  w('src/types.ts', 'export type T = number\n')
  w('src/keys/one.ts', 'export const one = 1\n')
  w('src/keys/two.ts', 'export const two = 2\n')
  w('src/keys/three.ts', 'export const three = 3\n')
  w('README.md', '# fixture\n')
  w('scripts/lib/helper.ts', 'export const lib = 1\n')
  w('scripts/lib/suite-env.sh', 'suite_env_guard() { :; }\n')
  w('scripts/alpha/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/alpha/** src/gone/**\nset -u\n. "$(dirname "$0")/../lib/suite-env.sh"\nfor f in "$here"/prove-*.ts; do ${bun} run "$f"; done\n`)
  w('scripts/alpha/helper.ts', "import { g } from '../../src/gamma/g.ts'\nexport const h = g\n")
  w('scripts/alpha/prove-a.ts', [
    "import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { tmpdir } from 'node:os'",
    "import { join } from 'node:path'",
    "import { a } from '../../src/alpha/a.ts'",
    "import { b } from '../../src/beta/b.ts'",
    "import type { T } from '../../src/types.ts'",
    "import { h } from './helper.ts'",
    "import { lib } from '../lib/helper.ts'",
    "const ROOT = join(import.meta.dir, '..', '..')",
    "const scratch = mkdtempSync(join(tmpdir(), 'fixture-'))",
    "writeFileSync(join(scratch, 'README.md'), 'x')",
    "const data = readFileSync(join(ROOT, 'src/beta/data.json'), 'utf8')",
    "const keys = (...parts: string[]): string => readFileSync(join(ROOT, 'src', ...parts), 'utf8')",
    "const label: Record<string, number> = { 'src/alpha/a.ts': 1 }",
    "const same = data === 'src/beta/c.ts'",
    "export const out: T = a + b + h + lib + keys('alpha', 'a.ts').length + label['src/alpha/a.ts'] + (same ? 1 : 0)",
    '',
  ].join('\n'))
  w('scripts/beta/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/beta/**\nset -u\nclaimed=$(cat scripts/beta-*/members.txt 2>/dev/null | grep -v '^#')\nfor f in scripts/beta/prove-*.ts; do ${bun} run "$f"; done\n`)
  w('scripts/beta/prove-b.ts', [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const ROOT = join(import.meta.dir, '..', '..')",
    "const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')",
    "const { one } = await import('../../src/keys/one.ts')",
    "export const out = read('src/beta/b.ts').length + one",
    '',
  ].join('\n'))
  w('scripts/beta/prove-c.ts', "import { c } from '../../src/beta/c.ts'\nexport const out = c\n")
  w('scripts/beta/prove-e.ts', "import { readdirSync } from 'node:fs'\nimport { join } from 'node:path'\nconst ROOT = join(import.meta.dir, '..', '..')\nconst KEYS = join(ROOT, 'src', 'keys')\nexport const out = readdirSync(KEYS).length\n")
  w('scripts/beta-2/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: scripts/beta/** src/beta/**\nset -u\nwhile read -r name; do f="scripts/beta/$name"; bun "$f"; done < scripts/beta-2/members.txt\n')
  w('scripts/beta-2/members.txt', '# members\nprove-b.ts\n')
  w('scripts/beta-3/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/beta/**\nset -u\nwhile read -r name; do f="scripts/beta/$name"; bun "$f"; done < scripts/beta-3/members.txt\n')
  w('scripts/beta-3/members.txt', 'prove-c.ts\n')
  w('scripts/gamma/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n# gate-watch: src/gamma/**\n${bun} run "$here/prove-g.ts"\n`)
  w('scripts/gamma/prove-g.ts', "export const out = 'src/gamma/g.ts'.length\n")
  w('scripts/whole/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n${bun} run "$here/prove-w.ts"\n`)
  w('scripts/whole/prove-w.ts', "import { readdirSync, readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { lib } from '../lib/helper.ts'\nconst ROOT = join(import.meta.dir, '..', '..')\nconst one = readFileSync(join(ROOT, 'src/keys/one.ts'), 'utf8')\nexport const out = readdirSync(join(ROOT, 'src')).length + lib + one.length\n")
  w('scripts/listed/run-all.sh', `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n${bun} run "$here/prove-l.ts"\n`)
  w('scripts/listed/prove-l.ts', "import { readdirSync } from 'node:fs'\nimport { join } from 'node:path'\nconst ROOT = join(import.meta.dir, '..', '..')\nconst walk = (d: string): string[] => readdirSync(d)\nexport const out = walk(ROOT).length\n")
  w('scripts/delta/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/keys/one.ts\nset -u\nbash "$here/prove-d.sh"\n')
  w('scripts/delta/prove-d.sh', '#!/usr/bin/env bash\ngrep -q one src/keys/one.ts && grep -q two "$root/src/keys/two.ts"\n')
  const manifest = loadImpactManifest(root)
  const got = census(root, walkAll(root), manifest, { whole: 'walks src for the fixture', gamma: 'a stale registration' })
  rmSync(root, { recursive: true, force: true })
  const want = [
    '1 alpha scripts/alpha/run-all.sh: gate-watch src/gone/** matches no tracked path',
    '1 gamma scripts/gamma/run-all.sh:4: a gate-watch line below the header block is never read',
    '2 alpha scripts/alpha/helper.ts reads src/gamma/g.ts — the gate wakes nothing for src/gamma/g.ts, not alpha',
    '2 alpha scripts/alpha/prove-a.ts reads scripts/lib/helper.ts — the gate wakes nothing for scripts/lib/helper.ts, not alpha',
    '2 alpha scripts/alpha/prove-a.ts reads src/beta/b.ts — the gate wakes beta, beta-2, beta-3 for src/beta/b.ts, not alpha',
    '2 alpha scripts/alpha/prove-a.ts reads src/beta/data.json — the gate wakes beta, beta-2, beta-3 for src/beta/data.json, not alpha',
    '2 beta scripts/beta/prove-e.ts reads src/keys/** (3 of 3 files outside the watch, e.g. src/keys/one.ts) — the gate wakes delta for src/keys/one.ts, not beta',
    '2 beta-2 scripts/beta/prove-b.ts reads src/keys/one.ts — the gate wakes delta for src/keys/one.ts, not beta-2',
    '2 beta-3 scripts/beta-3/run-all.sh reads scripts/beta/prove-c.ts — the gate wakes beta, beta-2 for scripts/beta/prove-c.ts, not beta-3',
    '2 delta scripts/delta/prove-d.sh reads src/keys/two.ts — the gate wakes nothing for src/keys/two.ts, not delta',
    '2 gamma registered as a whole-tree reader (a stale registration) but no proof it runs reads the whole tree',
    '2 listed scripts/listed/prove-l.ts reads the whole tree (.); the suite is not registered as a whole-tree reader',
    '2 whole scripts/whole/prove-w.ts reads scripts/lib/helper.ts — the gate wakes nothing for scripts/lib/helper.ts, not whole',
  ]
  const seen = got.misses.map(m => `${m.law} ${m.suite} ${m.text}`).sort()
  const wholeOk = got.suites.find(s => s.suite === 'whole')?.whole === 'walks src for the fixture'
  const betaOk = got.suites.find(s => s.suite === 'beta')?.executed.join(',') === 'scripts/beta/prove-e.ts'
  const ok = seen.join('\n') === want.join('\n') && wholeOk && betaOk
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] §0 self-test on a synthetic estate: ${got.misses.length} misses (want ${want.length}) · the registered whole-tree reader passes (${String(wholeOk)}) · the complement parent drops the members (${String(betaOk)})`)
  if (!ok) {
    for (const s of seen) console.log(`         seen: ${s}`)
    for (const s of want) console.log(`         want: ${s}`)
  }
  return ok
}

if (import.meta.main) {
  let failures = selfTest() ? 0 : 1
  const manifest = loadImpactManifest(REAL_ROOT)
  const c = census(REAL_ROOT, trackedOf(REAL_ROOT), manifest, WHOLE_TREE)
  const law1 = c.misses.filter(m => m.law === 1)
  const law2 = c.misses.filter(m => m.law === 2)
  console.log(`  census: ${c.suites.length} suites · ${c.globs} gate-watch globs · ${c.suites.reduce((n, s) => n + s.executed.length, 0)} executed files · ${c.suites.reduce((n, s) => n + s.reads.length, 0)} static reads`)
  if (REPORT) {
    for (const s of c.suites) {
      const outside = s.reads.filter(r => !r.path.startsWith(`scripts/${s.suite}/`))
      console.log(`  ${s.suite.padEnd(28)} ${String(s.executed.length).padStart(3)} executed  ${String(outside.length).padStart(4)} reads outside its dir${s.whole ? `  · whole-tree reader: ${s.whole}` : ''}`)
      for (const r of outside) console.log(`${' '.repeat(34)}${r.how.padEnd(7)}${r.kind === 'file' ? '' : `${r.kind} `}${r.path}  ← ${r.via}`)
    }
  }
  if (law1.length === 0) console.log(`  [PASS] §1 every gate-watch glob names a tracked path and every gate-watch line is read (${c.globs} globs / ${c.suites.length} runners)`)
  for (const m of law1) console.log(`  [FAIL] §1 ${m.text}`)
  const listed = c.suites.filter(s => s.whole !== null)
  if (law2.length === 0) console.log(`  [PASS] §2 every proof reads inside its suite's watch (${listed.length} whole-tree readers registered: ${listed.map(s => s.suite).join(' ')})`)
  for (const m of law2) console.log(`  [FAIL] §2 ${m.suite}: ${m.text}`)
  failures += c.misses.length
  console.log(`\n${failures === 0 ? '✅' : '❌'} prove-gate-watch-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}
