#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-spawn-window-discipline.ts — the win32 console
//  flash class: EVERY child-process spawn carries an explicit windowsHide.
//
//  The defect (operator sighting, Windows Terminal): accepting
//  the concourse git offer made two-three console windows flash open and
//  vanish — on win32 every console child spawned without windowsHide from a
//  console-less parent (the daemon) paints its own transient conhost window,
//  one per spawn. It is a CLASS, not a site: any spawn missing the flag
//  flashes the same way on some journey.
//
//  The discipline pinned here, CALL-SHAPED (the TypeScript AST is walked and
//  real CallExpressions are graded — a comment can never satisfy or trip
//  these checks, unlike the raw-regex needle shape):
//    (1) every child_process call site in src/ (static import, namespace
//        import, destructured require()/await import()) carries an EXPLICIT
//        `windowsHide` property in an inline options literal — `true` passes
//        outright, anything else must match the named allowlist
//    (2) the allowlist has teeth: exact per-row occurrence counts — a row
//        whose sites vanish or multiply fails the run (self-cleaning), and
//        every non-true site must consume a row
//    (3) the consent-path anchor: the daemon git wrapper that produced the
//        sighting (concourseWorktrees.ts) is hidden at every site
//    (4) execa containment: the only spawn library this product owns rides
//        exactly {execFileNoThrow.ts, imagePaste.ts}, and every execa call
//        carries windowsHide: true (through the wrapper's options object —
//        explicit in OUR code so a library major bump cannot change the
//        spawn discipline underneath us)
//    (5) no foreign spawn libraries creep in (cross-spawn, open, tinyexec,
//        shelljs, child-process-promise) — import-graded, not text-graded
//    (6) Bun.spawn stays contained to the one bun-runtime-only site
//
//  Deliberate windowsHide: false is the OTHER half of the same truth:
//  `windowsHide: true` is CREATE_NO_WINDOW, which severs the child from THIS
//  console (win32Console.ts's inert-seam class) — so interactive children
//  that ARE the screen (terminal editors, tmux attach, the panel shell) and
//  the one spawn that deliberately opens a visible window (the host-setup
//  winget install) are allowlisted false, each with its reason.
//
//  Out of the walk's reach, recorded here: vendor internals (the MCP SDK's
//  StdioClientTransport already passes windowsHide on win32; puppeteer
//  launches GUI chrome — no conhost), embedded skill-content scripts (run in
//  an operator console), and a deliberately aliased spawn (evasion, not rot).
//  Real-conhost effect proves only on hardware (NEEDS-REAL-BOX — the Windows
//  field channel owns the visual confirmation).
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const CP_EXPORTS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])

/** One graded call site. `value` is the windowsHide initializer's exact
 *  source text; '<indirect>' = options are not an inline literal (a shape
 *  owner elsewhere); '<absent>' = an options literal with no windowsHide;
 *  '<no-options>' = no options argument at all. */
interface Site {
  path: string
  line: number
  callee: string
  value: string
}

/** Non-`true` sites the discipline deliberately admits. Counts are exact:
 *  a vanished site fails its row (stale allowlist), a new one fails the
 *  walk. Every row names its reason — the row IS the recorded decision. */
const ALLOWLIST: ReadonlyArray<{ path: string; callee: string; value: string; count: number; reason: string }> = [
  {
    path: 'src/utils/editor.ts',
    callee: 'spawnSync',
    value: 'false',
    count: 2,
    reason: 'interactive terminal editor on THIS console (alternate screen); CREATE_NO_WINDOW would sever it',
  },
  {
    path: 'src/utils/promptEditor.ts',
    callee: 'spawn',
    value: 'false',
    count: 1,
    reason: 'the external prompt editor takes over this console (stdio inherit)',
  },
  {
    path: 'src/utils/terminalPanel.ts',
    callee: 'spawnSync',
    value: 'false',
    count: 2,
    reason: 'tmux attach + the fallback panel shell ARE the screen (stdio inherit)',
  },
  {
    path: 'src/utils/worktree.ts',
    callee: 'spawnSync',
    value: 'options?.inherit !== true',
    count: 1,
    reason: 'runTmuxSync: hidden except the interactive attach leg (computed, self-describing)',
  },
  {
    path: 'src/ink/session/windowsHostSetup.ts',
    callee: 'execFile',
    value: 'false',
    count: 1,
    reason: 'deliberately OPENS a visible console: cmd /c start — the winget install in its own window (the card labels it so)',
  },
  {
    path: 'src/utils/runtime/win32Console.ts',
    callee: 'spawnSync',
    value: '<indirect>',
    count: 1,
    reason: 'options own one shape owner (chcpSpawnShape); prove-win32-console §7 pins windowsHide === false there — chcp must aim at OUR console',
  },
  {
    path: 'src/utils/ripgrep.ts',
    callee: 'Bun.spawn',
    value: '<absent>',
    count: 1,
    reason: 'bun-runtime-only argv0 road (Bun.spawn does not exist under node; the shipped product never executes it)',
  },
]

function* walkDir(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) yield* walkDir(p)
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) yield p
  }
}

const sites: Site[] = []
const execaImporters: string[] = []
const execaCallGaps: string[] = []
const foreignSpawnImports: string[] = []
const FOREIGN_SPAWN_LIBS = new Set(['cross-spawn', 'open', 'tinyexec', 'shelljs', 'child-process-promise'])

for (const file of walkDir(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8')
  if (!/child_process|execa|Bun\.spawn|cross-spawn|shelljs|tinyexec/.test(text)) continue
  const rel = file.slice(ROOT.length + 1)
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

  // ---- import binding: local names for child_process exports ----
  const cpLocal = new Map<string, string>()
  const cpNamespaces = new Set<string>()
  let importsExeca = false
  const execaLocals = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const mod = (stmt.moduleSpecifier as ts.StringLiteral).text
    const clause = stmt.importClause
    if (clause?.isTypeOnly) continue
    if (FOREIGN_SPAWN_LIBS.has(mod)) foreignSpawnImports.push(`${rel} imports '${mod}'`)
    if (mod === 'execa') {
      importsExeca = true
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const spec of clause.namedBindings.elements)
          if (!spec.isTypeOnly && (spec.propertyName ?? spec.name).text === 'execa') execaLocals.add(spec.name.text)
    }
    if (mod !== 'child_process' && mod !== 'node:child_process') continue
    if (!clause) continue
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) cpNamespaces.add(clause.namedBindings.name.text)
      else
        for (const spec of clause.namedBindings.elements) {
          if (spec.isTypeOnly) continue
          const orig = (spec.propertyName ?? spec.name).text
          if (CP_EXPORTS.has(orig)) cpLocal.set(spec.name.text, orig)
        }
    }
  }
  if (importsExeca) execaImporters.push(rel)

  // ---- dynamic loads at any depth:
  //   const { execFileSync } = require('node:child_process') as typeof import(...)
  //   const { spawnSync } = await import('node:child_process')
  //   const cp = require('node:child_process')            (namespace form) ----
  const unwrap = (e: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression
    return e
  }
  const isCpLoad = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    if (!ts.isCallExpression(u)) return false
    const arg = u.arguments[0]
    const cpMod = arg !== undefined && ts.isStringLiteralLike(arg) && (arg.text === 'child_process' || arg.text === 'node:child_process')
    if (!cpMod) return false
    return (ts.isIdentifier(u.expression) && u.expression.text === 'require') || u.expression.kind === ts.SyntaxKind.ImportKeyword
  }
  const bindDynamic = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && isCpLoad(node.initializer)) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const orig = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null
          if (orig && CP_EXPORTS.has(orig) && ts.isIdentifier(el.name)) cpLocal.set(el.name.text, orig)
        }
      } else if (ts.isIdentifier(node.name)) cpNamespaces.add(node.name.text)
    }
    ts.forEachChild(node, bindDynamic)
  }
  bindDynamic(sf)

  // ---- object-literal variables (for options passed by name: execaOptions) ----
  const literalVars = new Map<string, ts.ObjectLiteralExpression>()
  const collectVars = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer)
      if (ts.isObjectLiteralExpression(init)) literalVars.set(node.name.text, init)
    }
    ts.forEachChild(node, collectVars)
  }
  collectVars(sf)

  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const hideValueOf = (obj: ts.ObjectLiteralExpression): string | null => {
    for (const p of obj.properties)
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'windowsHide') return p.initializer.getText(sf)
    return null
  }
  const gradeOptions = (call: ts.CallExpression): string => {
    const objs = call.arguments.filter(a => ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression[]
    if (objs.length > 0) {
      for (const obj of objs) {
        const v = hideValueOf(obj)
        if (v !== null) return v
      }
      return '<absent>'
    }
    // No inline literal: an identifier naming an in-file literal still counts
    // (the wrapper shape); anything else is indirect.
    for (const a of call.arguments) {
      if (ts.isIdentifier(a) && literalVars.has(a.text)) {
        const v = hideValueOf(literalVars.get(a.text)!)
        return v ?? '<absent>'
      }
    }
    return call.arguments.some(a => !ts.isStringLiteralLike(a) && !ts.isArrayLiteralExpression(a) && !ts.isFunctionLike(a)) ? '<indirect>' : '<no-options>'
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let name: string | null = null
      if (ts.isIdentifier(callee) && cpLocal.has(callee.text)) name = cpLocal.get(callee.text)!
      else if (ts.isIdentifier(callee) && execaLocals.has(callee.text)) name = 'execa'
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        if (cpNamespaces.has(callee.expression.text) && CP_EXPORTS.has(callee.name.text)) name = callee.name.text
        else if (callee.expression.text === 'Bun' && (callee.name.text === 'spawn' || callee.name.text === 'spawnSync')) name = `Bun.${callee.name.text}`
      }
      if (name) {
        const value = gradeOptions(node)
        sites.push({ path: rel, line: lineOf(node), callee: name, value })
        if (name === 'execa' && value !== 'true') execaCallGaps.push(`${rel}:${lineOf(node)} execa windowsHide=${value}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

//
section('(1) the walk — every child_process call site carries explicit windowsHide')
{
  const cpSites = sites.filter(s => s.callee !== 'execa')
  check('the walk found the estate (≥100 call sites — an empty walk is a broken walk, not a green one)', cpSites.length >= 100, `found ${cpSites.length}`)
  const nonTrue = cpSites.filter(s => s.value !== 'true')
  // Grade every non-true site against the allowlist; leftovers fail here
  // (per-row occurrence counts are §2's teeth).
  const orphans: string[] = []
  for (const s of nonTrue) {
    const admitted = ALLOWLIST.some(r => r.path === s.path && r.callee === s.callee && r.value === s.value)
    if (!admitted) orphans.push(`${s.path}:${s.line} ${s.callee} windowsHide=${s.value}`)
  }
  check('no un-allowlisted site (absent, indirect, or a value the allowlist does not admit)', orphans.length === 0, orphans.slice(0, 8).join(' · '))
}

//
section('(2) allowlist teeth — exact occurrence counts, no stale rows')
for (const row of ALLOWLIST) {
  const matches = sites.filter(s => s.path === row.path && s.callee === row.callee && s.value === row.value)
  check(
    `${row.path} ${row.callee} windowsHide=${row.value} ×${row.count} — ${row.reason}`,
    matches.length === row.count,
    `found ${matches.length}`,
  )
}

//
section('(3) the sighting anchors — both operator journeys ride hidden spawns')
{
  // Journey 1 (git-tree consent) AND journey 2 (the board's recurring
  // per-row probes — coordinatorBoard's forkCommitState/classifyWorktreeDirt)
  // both spawn through this one daemon wrapper, console-less on win32.
  const consent = sites.filter(s => s.path === 'src/daemon/concourseWorktrees.ts')
  check('both git wrapper legs are walked (sync probe + async add/prune)', consent.length >= 2, `found ${consent.length}`)
  check('every concourseWorktrees spawn is hidden (git offer + the board beat run HERE)', consent.length > 0 && consent.every(s => s.value === 'true'))
  // The worker-side recurring road: verification digests run git per settle
  // beat inside console-less daemon workers.
  const verif = sites.filter(s => s.path === 'src/utils/verification/verificationState.ts')
  check('every verificationState git spawn is hidden (the per-beat worker road)', verif.length >= 4 && verif.every(s => s.value === 'true'), `found ${verif.length}`)
  // FN-014 rows 3+4: both recurring git spawners take the RESOLVED gitExe()
  // — a bare 'git' literal re-pays the PATH walk per spawn (and under bun's
  // frozen-at-start PATH, the absolute path is the sounder spelling too).
  {
    const { readFileSync } = await import('node:fs')
    for (const rel of ['src/daemon/concourseWorktrees.ts', 'src/utils/verification/verificationState.ts'] as const) {
      const src = readFileSync(rel, 'utf8')
      check(`${rel}: git spawns take gitExe(), never the bare literal`, !/(?:spawn|spawnSync|execFile|execFileSync)\(\s*'git'/.test(src))
    }
  }
}

//
section('(4) execa containment — one spawn library, ridden only through named doors')
{
  const allowedImporters = new Set(['src/utils/execFileNoThrow.ts', 'src/utils/imagePaste.ts'])
  const strays = execaImporters.filter(f => !allowedImporters.has(f))
  check('direct execa imports stay exactly {execFileNoThrow.ts, imagePaste.ts}', strays.length === 0, strays.join(' · '))
  check('both named doors still import execa (a moved wrapper must move this pin)', allowedImporters.size === execaImporters.length, execaImporters.join(' · '))
  check('every execa call carries windowsHide: true (wrapper options object included)', execaCallGaps.length === 0, execaCallGaps.join(' · '))
}

//
section('(5) no foreign spawn library creeps in (import-graded)')
check('zero imports of cross-spawn/open/tinyexec/shelljs/child-process-promise in src/', foreignSpawnImports.length === 0, foreignSpawnImports.join(' · '))

//
section('(6) Bun.spawn stays contained')
{
  const bun = sites.filter(s => s.callee.startsWith('Bun.'))
  check('exactly one Bun.spawn site, in ripgrep.ts (the bun-runtime argv0 road)', bun.length === 1 && bun[0]!.path === 'src/utils/ripgrep.ts', bun.map(s => `${s.path}:${s.line}`).join(' · '))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SPAWN WINDOW DISCIPLINE PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
