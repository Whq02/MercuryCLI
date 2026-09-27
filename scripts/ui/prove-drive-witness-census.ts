#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { census } from '../gate/prove-suite-class-census.ts'
import { calleeName, declarationOf, importTarget, lineOf, stringText, unwrap, visit } from '../gate/sourceCensus.ts'

type Kind = 'send' | 'sample' | 'resize' | 'wait' | 'stderr'
export type Offender = { file: string; line: number; kind: Kind; fix: string; source: string }
const ROOT = resolve(import.meta.dir, '..', '..')
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
      if ((p.has('stableTicks') || p.has('readySettleTicks') || (p.has('argv') && p.has('out') && p.has('total'))) && !nonempty(p.get('readyText'))) {
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
    if (!carried) add(n, 'stderr', 'use spawnCaptureSync from scripts/lib/captureDriver.ts, or print stderr on the exit row and retain the refusal receipt')
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
  console.log(`drive witness self-tests: ${cases.length - failed}/${cases.length}`)
  return failed
}

if (import.meta.main) {
  const failed = selfTest()
  if (process.argv.includes('--self-test')) process.exit(failed ? 1 : 0)
  const result = driveCensus(ROOT)
  for (const h of result.offenders) console.log(`${h.file}:${h.line} [${h.kind}] ${h.fix}\n    ${h.source}`)
  for (const [site, reason] of Object.entries(ALLOW)) console.log(`${site} [unconditional first key] ${reason}`)
  console.log(`drive witness census: ${result.offenders.length} offenders in ${new Set(result.offenders.map(h => h.file)).size} files; ${result.drives} drive sources, ${result.suites} suites, ${result.files} reachable files; ${Object.keys(ALLOW).length} unconditional exceptions`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(result))
  process.exit(failed || result.offenders.length ? 1 : 0)
}
