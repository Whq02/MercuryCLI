#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { census } from '../gate/prove-suite-class-census.ts'
import { calleeName, declarationOf, importTarget, lineOf, stringText, unwrap, visit } from '../gate/sourceCensus.ts'

type Kind = 'send' | 'sample' | 'resize' | 'wait' | 'stderr'
export type Offender = { file: string; line: number; kind: Kind; fix: string; source: string }
const ROOT = resolve(import.meta.dir, '..', '..')
const BASELINE = join(import.meta.dir, 'drive-witness.baseline.json')
const ALLOW: Readonly<Record<string, string>> = {}
const ENGINE = new RegExp(String.raw`vshot(?:-win)?\.py|${['capture', 'EngineEntry'].join('')}|${['CAPTURE', 'ENGINE_ENTRY'].join('_')}`)
const ENGINE_FIXTURE = ['vshot', '.py'].join('')
const WIN_FIXTURE = ['vshot-win', '.py'].join('')
const WITNESSES = ['awaitText', 'awaitRaw', 'awaitPattern', 'targetText']

function expanded(e: ts.Expression, seen = new Set<ts.Node>()): string {
  const x = unwrap(e)
  if (seen.has(x)) return ''
  seen.add(x)
  let text = x.getText()
  visit(x, n => {
    if (!ts.isIdentifier(n)) return
    const d = declarationOf(n)
    if (d && ts.isVariableDeclaration(d) && d.initializer && !seen.has(d)) {
      seen.add(d)
      text += ' ' + expanded(d.initializer, seen)
    }
  })
  return text
}

function properties(obj: ts.ObjectLiteralExpression, seen = new Set<ts.Node>()): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>()
  if (seen.has(obj)) return out
  seen.add(obj)
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) out.set(p.name.getText().replace(/^['"]|['"]$/g, ''), p.initializer)
    else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, p.name)
    else if (ts.isSpreadAssignment(p)) {
      let e = unwrap(p.expression)
      if (ts.isIdentifier(e)) {
        const d = declarationOf(e)
        if (d && ts.isVariableDeclaration(d) && d.initializer) e = unwrap(d.initializer)
      }
      if (ts.isObjectLiteralExpression(e)) for (const [k, v] of properties(e, seen)) out.set(k, v)
    }
  }
  return out
}

function insideSends(n: ts.Node): boolean {
  for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/^['"]|['"]$/g, '') === 'sends') return true
    if (ts.isVariableDeclaration(p) && /sends/i.test(p.name.getText())) return true
    if (ts.isFunctionLike(p)) break
  }
  return false
}

function nonempty(e: ts.Expression | undefined): boolean {
  if (!e) return false
  const x = unwrap(e)
  return stringText(x) !== '' && x.kind !== ts.SyntaxKind.FalseKeyword && x.kind !== ts.SyntaxKind.NullKeyword
}

export function inspect(source: string, file: string): Offender[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: Offender[] = []
  const programs: string[] = []
  visit(sf, n => {
    if (ts.isPropertyAssignment(n) && n.name.getText().replace(/^['"]|['"]$/g, '') === 'argv') programs.push(expanded(n.initializer))
  })
  const synthetic = programs.length > 0 && programs.every(p => /\[\s*['"](?:python[23]?|\/usr\/bin\/python[23]?|true)['"]/.test(p) && !/mercury\.mjs|process\.execPath|['"](?:node|bun)['"]/.test(p))
  const add = (n: ts.Node, kind: Kind, fix: string): void => {
    const line = lineOf(n)
    if (synthetic && kind !== 'stderr') return
    if (kind === 'send' && ALLOW[`${file}:${line}`]) return
    hits.push({ file, line, kind, fix, source: n.getText(sf).replace(/\s+/g, ' ').slice(0, 160) })
  }
  visit(sf, n => {
    if (ts.isObjectLiteralExpression(n)) {
      const p = properties(n)
      const needle = WITNESSES.some(k => nonempty(p.get(k)))
      const strict = p.get('requireAwait')?.kind === ts.SyntaxKind.TrueKeyword
      const current = nonempty(p.get('awaitPattern')) || nonempty(p.get('targetText'))
      const witnessed = (strict && needle) || current
      const send = p.has('data') && (insideSends(n) || ['at', 'atMs', 'atTick', 'afterPrevTicks', 'mark', 'awaitText', 'awaitRaw', 'requireAwait'].some(k => p.has(k)))
      if (send && !witnessed) {
        const sample = p.has('mark') && stringText(p.get('data')!) === ''
        add(n, sample ? 'sample' : 'send', 'keep the deadline; requireAwait: true plus the product needle (a clock or an unknown spread is not a witness)')
      }
      if (p.has('cols') && p.has('rows') && ['at', 'atMs', 'atTick'].some(k => p.has(k)) && !nonempty(p.get('afterMark'))) {
        add(n, 'resize', 'anchor the resize/sample to a witnessed mark with afterMark, keeping its authored offset')
      }
      const sends = p.get('sends')
      const last = sends && ts.isArrayLiteralExpression(sends) ? sends.elements.at(-1) : undefined
      const end = last && ts.isObjectLiteralExpression(last) ? properties(last) : undefined
      const endWitness = end !== undefined && end.has('mark') && stringText(end.get('data') ?? n) === '' && end.get('requireAwait')?.kind === ts.SyntaxKind.TrueKeyword && WITNESSES.some(k => nonempty(end.get(k)))
      if ((p.has('stableTicks') || p.has('readySettleTicks') || (p.has('argv') && p.has('out') && p.has('total'))) && !nonempty(p.get('readyText')) && !endWitness) {
        add(n, 'sample', 'declare the final scene needle with readyText; stability or a capture ceiling alone cannot certify readiness')
      }
    }
    if (!ts.isCallExpression(n)) return
    const name = calleeName(n)
    if (name === 'sleep' || name === 'delay' || name === 'setTimeout') {
      const callback = n.arguments[0]
      const timerWait = name !== 'setTimeout' || (callback !== undefined && (ts.isIdentifier(callback) && /^(?:resolve|done|res|r)$/.test(callback.text) || /=>\s*(?:resolve|done|res)\s*\(/.test(callback.getText())))
      if (timerWait) add(n, 'wait', 'observe the screen needle or record change with a profile-scaled ceiling; do not wait for elapsed time')
    }
    if (name !== 'spawnSync') return
    const args = n.arguments[1]
    if (!args || !ENGINE.test(expanded(args)) || expanded(args).includes('--preflight')) return
    const result = ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null
    const stderr = result ? new RegExp(`\\b${result}\\.stderr\\b`) : null
    let carried = false
    visit(sf, sink => {
      if (ts.isCallExpression(sink) && /^(log|error|warn|check|assert|Error|write|writeFileSync)$/.test(calleeName(sink) ?? '')) {
        if (stderr && sink.arguments.some(a => stderr.test(expanded(a)))) carried = true
      }
      if (ts.isNewExpression(sink) && sink.expression.getText() === 'Error' && stderr && sink.arguments?.some(a => stderr.test(expanded(a)))) carried = true
    })
    if (!carried) add(n, 'stderr', 'use spawnCaptureSync from scripts/lib/spawnCapture.ts, or print stderr on the exit row and retain the refusal receipt')
  })
  return hits
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'vendor') continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (/\.(?:tsx?|[cm]?js)$/.test(ent.name)) out.push(full)
    }
  }
  walk(join(root, 'scripts'))
  return out.sort()
}

export function driveCensus(root: string): { files: number; drives: number; suites: number; offenders: Offender[] } {
  const suites = census(root).suites
  const reachable = new Set(suites.flatMap(s => s.cls === 'pty' ? s.executed : s.drivers).map(f => join(root, f)))
  const files = sourceFiles(root)
  const sources = new Map(files.map(f => [f, readFileSync(f, 'utf8')]))
  for (const [f, src] of sources) {
    if (/\b(?:spawn|spawnSync|execFileSync)\s*\(/.test(src) && ENGINE.test(src)) reachable.add(f)
  }
  for (const f of reachable) {
    const src = sources.get(f)
    if (!src) continue
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true)
    visit(sf, n => {
      if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly || !ts.isStringLiteral(n.moduleSpecifier)) return
      const target = importTarget(f, n.moduleSpecifier.text)
      if (target && target.startsWith(join(root, 'scripts') + '/') && sources.has(target)) reachable.add(target)
    })
  }
  const offenders: Offender[] = []
  let drives = 0
  for (const file of [...reachable].sort()) {
    const src = sources.get(file)
    if (!src || file === import.meta.path || file.includes('/scripts/gate/')) continue
    if (!/\b(?:sends|awaitText|readyText|vshot|captureEngineEntry)\b/.test(src)) continue
    drives++
    offenders.push(...inspect(src, relative(root, file).replace(/\\/g, '/')))
  }
  return { files: reachable.size, drives, suites: suites.filter(s => s.cls === 'pty' || s.drivers.length > 0).length, offenders }
}

export function baselineCounts(value: unknown): Readonly<Record<string, number>> {
  const files = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).files : undefined
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new Error('drive witness baseline must contain a files object')
  for (const [file, count] of Object.entries(files)) {
    if (!/^scripts\/(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|[cm]?js)$/.test(file) || file.split('/').some(part => part === '.' || part === '..') || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`invalid drive witness baseline row: ${file} = ${JSON.stringify(count)}`)
    }
  }
  return files as Readonly<Record<string, number>>
}

export function ratchet(offenders: readonly Offender[], pinned: Readonly<Record<string, number>>): { remaining: number; pinned: number; files: number; growing: Array<{ file: string; found: number; pinned: number }> } {
  const counts = new Map<string, number>()
  for (const h of offenders) counts.set(h.file, (counts.get(h.file) ?? 0) + 1)
  const growing = [...counts].filter(([file, found]) => found > (pinned[file] ?? 0)).sort(([a], [b]) => a.localeCompare(b)).map(([file, found]) => ({ file, found, pinned: pinned[file] ?? 0 }))
  return { remaining: offenders.length, pinned: Object.values(pinned).reduce((sum, count) => sum + count, 0), files: counts.size, growing }
}

function selfTest(): number {
  const cases: Array<[string, string, Kind[]]> = [
    ['blind deadline', "const sends = [{ atTick: 40, data: 'x' }]", ['send']],
    ['soft await still fires blind', "const sends = [{ atTick: 40, awaitText: 'READY', data: 'x' }]", ['send']],
    ['strict needle', "const sends = [{ atTick: 40, requireAwait: true, awaitText: 'READY', data: 'x' }]", []],
    ['false strictness', "const sends = [{ requireAwait: false, awaitText: 'READY', data: 'x' }]", ['send']],
    ['empty needle', "const sends = [{ requireAwait: true, awaitText: '', data: 'x' }]", ['send']],
    ['strict without needle', "const sends = [{ requireAwait: true, data: 'x' }]", ['send']],
    ['current frame gate', "const sends = [{ atTick: 40, awaitPattern: 'READY', data: 'x' }]", []],
    ['spread must not hide blind send', "const sends = [{ ...unknown, atTick: 40, data: 'x' }]", ['send']],
    ['resolved spread', "const gate = { requireAwait: true, awaitText: 'READY' }; const sends = [{ ...gate, data: 'x' }]", []],
    ['spread override', "const gate = { requireAwait: true, awaitText: 'READY' }; const sends = [{ ...gate, requireAwait: false, data: 'x' }]", ['send']],
    ['blind mark', "const sends = [{ afterPrevTicks: 3, data: '', mark: 'popup' }]", ['sample']],
    ['blind resize', 'const resizes = [{ atMs: 8000, cols: 80, rows: 24 }]', ['resize']],
    ['marked resize', "const resizes = [{ afterMark: 'ready', afterMs: 8000, cols: 80, rows: 24 }]", []],
    ['stability is not ready', 'const cfg = { stableTicks: 4 }', ['sample']],
    ['needle plus stability', "const cfg = { stableTicks: 4, readyText: 'READY' }", []],
    ['fixed window with a witnessed end sample', "const cfg = { argv: ['node', BIN], out, total: 40, sends: [{ data: '', mark: 'end', requireAwait: true, awaitText: 'FINAL' }] }", []],
    ['data bearing send does not witness its result', "const cfg = { argv: ['node', BIN], out, total: 40, sends: [{ data: 'x', mark: 'before', requireAwait: true, awaitText: 'BEFORE' }] }", ['sample']],
    ['timer wait', 'await new Promise(resolve => setTimeout(resolve, 1000))', ['wait']],
    ['watchdog is not wait', "const deadline = setTimeout(() => child.kill('SIGKILL'), budget)", []],
    ['sleep wait', 'await Bun.sleep(1000)', ['wait']],
    ['swallowed refusal', `const VSHOT = '${ENGINE_FIXTURE}'; const r = spawnSync('python3', [VSHOT, cfg]); check('exit', r.status === 0)`, ['stderr']],
    ['refusal printed', `const VSHOT = '${ENGINE_FIXTURE}'; const r = spawnSync('python3', [VSHOT, cfg]); check('exit', r.status === 0, r.stderr)`, []],
    ['refusal only assigned', `const r = spawnSync('python3', ['${WIN_FIXTURE}', cfg]); const hidden = r.stderr`, ['stderr']],
    ['not a drive', "const r = spawnSync('git', ['status'])", []],
    ['synthetic engine contract is not a product drive', "const CHILD = ['python3', '-c', 'print(1)']; const cfg = { argv: CHILD, total: 8, out: path, sends: [{ atTick: 1, data: 'x' }] }", []],
    ['product alongside synthetic stays covered', "const a = { argv: ['true'] }; const b = { argv: ['node', BIN], sends: [{ atTick: 1, data: 'x' }] }", ['send']],
    ['comments and strings are not sends', "const text = '{ atTick: 1, data: x }'", []],
  ]
  let failed = 0
  for (const [label, source, want] of cases) {
    const got = inspect(source, 'fixture.ts').map(h => h.kind)
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failed++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `: ${JSON.stringify(got)} != ${JSON.stringify(want)}`}`)
  }
  let total = cases.length
  const check = (label: string, ok: boolean): void => {
    total++
    if (!ok) failed++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  }
  const file = 'scripts/fixture/prove-drive.ts'
  const other = 'scripts/fixture/prove-other.ts'
  const blind = inspect("const sends = [{ atTick: 1, data: 'x' }]", file)
  const swallowed = inspect(`const r = spawnSync('python3', ['${ENGINE_FIXTURE}', cfg]); check('exit', r.status === 0)`, file)
  const held = ratchet(blind, { [file]: 1 })
  check('ratchet: a count equal to its file baseline passes and reports the pinned total', held.growing.length === 0 && held.remaining === 1 && held.pinned === 1 && held.files === 1)
  check('ratchet: a lower count passes', ratchet(blind, { [file]: 2 }).growing.length === 0)
  check('ratchet: removing every legacy offender passes', ratchet([], { [file]: 1 }).growing.length === 0)
  check('ratchet: a new blind send in a pinned file fails', ratchet([...blind, ...blind], { [file]: 1 }).growing[0]?.found === 2)
  check('ratchet: a newly swallowed refusal in a pinned file fails', ratchet([...blind, ...swallowed], { [file]: 1 }).growing[0]?.found === 2)
  check('ratchet: an unpinned file has a zero allowance', ratchet(blind, {}).growing[0]?.pinned === 0)
  const shifted = ratchet(blind.map(h => ({ ...h, file: other })), { [file]: 1 })
  check('ratchet: reducing one file cannot fund a new offender in another', shifted.remaining === shifted.pinned && shifted.growing.length === 1 && shifted.growing[0]?.file === other)
  check('ratchet: a lowered baseline prevents restoring a removed offender', ratchet([...blind, ...blind], { [file]: 2 }).growing.length === 0 && ratchet([...blind, ...blind], { [file]: 1 }).growing.length === 1)
  check('baseline: valid per-file counts are accepted', baselineCounts({ files: { [file]: 1 } })[file] === 1)
  for (const bad of [null, {}, { files: [] }, { files: { [file]: -1 } }, { files: { [file]: 0 } }, { files: { [file]: 1.5 } }, { files: { [file]: '1' } }, { files: { '../outside.ts': 1 } }, { files: { 'scripts/../outside.ts': 1 } }]) {
    let refused = false
    try { baselineCounts(bad) } catch { refused = true }
    check(`baseline: malformed counts refuse (${JSON.stringify(bad)})`, refused)
  }
  console.log(`drive witness self-tests: ${total - failed}/${total}`)
  return failed
}

if (import.meta.main) {
  const failed = selfTest()
  if (process.argv.includes('--self-test')) process.exit(failed ? 1 : 0)
  const result = driveCensus(ROOT)
  const pinned = baselineCounts(JSON.parse(readFileSync(BASELINE, 'utf8')))
  const status = ratchet(result.offenders, pinned)
  const growing = new Set(status.growing.map(row => row.file))
  for (const row of status.growing) console.log(`[FAIL] ${row.file}: ${row.found} offenders exceed ${row.pinned} pinned; add witnesses, not baseline headroom`)
  for (const h of result.offenders) {
    if (growing.has(h.file) || process.argv.includes('--report') || process.argv.includes('--json')) console.log(`${h.file}:${h.line} [${h.kind}] ${h.fix}\n    ${h.source}`)
  }
  for (const [site, reason] of Object.entries(ALLOW)) console.log(`${site} [unconditional first key] ${reason}`)
  console.log(`drive witness census: ${result.offenders.length} offenders in ${status.files} files; ${result.drives} drive sources, ${result.suites} suites, ${result.files} reachable files; ${Object.keys(ALLOW).length} unconditional exceptions`)
  console.log(`ratchet: ${status.remaining} legacy witness offender(s) remain of ${status.pinned} pinned across ${Object.keys(pinned).length} files`)
  console.log(`[${status.growing.length ? 'FAIL' : 'PASS'}] no file exceeds its pinned offender count (${status.growing.length} growing files)`)
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...result, ratchet: status }))
  process.exit(failed || status.growing.length ? 1 : 0)
}
