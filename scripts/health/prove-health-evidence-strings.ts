#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
const TARGET = join(process.env.PROVE_SRC ?? join(REPO, 'src'), 'utils', 'healthReport.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const PRIMITIVE =
  ts.TypeFlags.String |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.TemplateLiteral |
  ts.TypeFlags.StringMapping |
  ts.TypeFlags.Number |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BigInt |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.Boolean |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Void |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.Never |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike

function hasObjectMember(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (depth > 6) return false
  if (type.isUnion()) return type.types.some(t => hasObjectMember(checker, t, depth + 1))
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint ? hasObjectMember(checker, constraint, depth + 1) : false
  }
  if (type.flags & PRIMITIVE) return false
  if (type.isIntersection()) return type.types.every(t => hasObjectMember(checker, t, depth + 1))
  return (type.flags & ts.TypeFlags.Object) !== 0
}

type Finding = { line: number; kind: 'interpolation' | 'join'; text: string; type: string }

function dishonestSpans(program: ts.Program, file: ts.SourceFile): Finding[] {
  const checker = program.getTypeChecker()
  const out: Finding[] = []
  const lineOf = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const type = checker.getTypeAtLocation(span.expression)
        const isArray = checker.isArrayType(type) || checker.isTupleType(type)
        if (isArray || hasObjectMember(checker, type)) {
          out.push({ line: lineOf(span.expression), kind: 'interpolation', text: span.expression.getText(file).slice(0, 80), type: checker.typeToString(type).slice(0, 60) })
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
      const receiver = checker.getTypeAtLocation(node.expression.expression)
      const arrays = receiver.isUnion() ? receiver.types : [receiver]
      for (const arr of arrays) {
        if (!(checker.isArrayType(arr) || checker.isTupleType(arr))) continue
        const elements = checker.getTypeArguments(arr as ts.TypeReference)
        for (const element of elements) {
          if (hasObjectMember(checker, element)) {
            out.push({ line: lineOf(node), kind: 'join', text: node.expression.expression.getText(file).slice(0, 80), type: checker.typeToString(element).slice(0, 60) })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

function programFor(files: string[]): ts.Program {
  const configPath = ts.findConfigFile(REPO, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('tsconfig.json not found')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO)
  return ts.createProgram(files, { ...parsed.options, noEmit: true, skipLibCheck: true })
}

function composerFiles(program: ts.Program, entry: ts.SourceFile): ts.SourceFile[] {
  const checker = program.getTypeChecker()
  const imported = (file: ts.SourceFile): ts.SourceFile[] => {
    const out: ts.SourceFile[] = []
    const visit = (node: ts.Node): void => {
      const spec = ts.isImportDeclaration(node) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
      const target = spec && ts.isStringLiteralLike(spec) ? checker.getSymbolAtLocation(spec)?.valueDeclaration : undefined
      if (target && ts.isSourceFile(target) && !out.includes(target)) out.push(target)
      ts.forEachChild(node, visit)
    }
    visit(file)
    return out
  }
  const list = imported(entry).find(file => {
    const module = checker.getSymbolAtLocation(file)
    return module !== undefined && checker.getExportsOfModule(module).some(symbol => symbol.name === 'HEALTH_SECTIONS')
  })
  return list ? [entry, list, ...imported(list).filter(file => file !== entry)] : [entry]
}

console.log('the health composer: every interpolated value is a string or a number')
const started = Date.now()
const program = programFor([TARGET])
const source = program.getSourceFile(TARGET)
if (!source) throw new Error(`source not loaded: ${TARGET}`)
const composer = composerFiles(program, source)
const findings = composer.flatMap(file => dishonestSpans(program, file).map(f => ({ ...f, file: relative(REPO, file.fileName) })))
check(
  `src/utils/healthReport.ts and the ${composer.length - 1} modules of the row list it imports interpolate no object and join no object array (${Date.now() - started}ms)`,
  composer.length > 2 && findings.length === 0,
  composer.length > 2 ? findings.map(f => `${f.file}:${f.line} ${f.kind} ${f.text} : ${f.type}`).join(' · ') : 'the row list was not reached: src/utils/healthReport.ts imports the module that exports HEALTH_SECTIONS, and this proof follows that import',
)

console.log('poison: a source interpolating an object and joining an object array trips the walker')
const scratch = mkdtempSync(join(tmpdir(), 'health-evidence-poison-'))
const poisonPath = join(scratch, 'poison.ts')
writeFileSync(
  poisonPath,
  [
    'type Row = { name: string; state: string }',
    'const rows: Row[] = [{ name: "a", state: "ok" }]',
    'const one: Row = rows[0]!',
    'export const bad1 = `${rows.length} server(s): ${rows.slice(0, 3).join(", ")}`',
    'export const bad2 = `row ${one}`',
    'export const bad3 = `rows ${rows}`',
    'export const good = `${rows.length} server(s): ${rows.map(r => r.name).join(", ")} · ${one.name} (${one.state}) · ${3 > 2} · ${undefined}`',
    '',
  ].join('\n'),
)
const poisonProgram = programFor([poisonPath])
const poisonSource = poisonProgram.getSourceFile(poisonPath)
const poison = poisonSource ? dishonestSpans(poisonProgram, poisonSource) : []
const poisonLines = poison.map(f => `${f.line}:${f.kind}`).sort()
check('the object join, the object interpolation and the array interpolation are flagged at their lines', JSON.stringify(poisonLines) === JSON.stringify(['4:join', '5:interpolation', '6:interpolation']), JSON.stringify(poisonLines))
check('the honest line (names joined, a string, a boolean, undefined) is clean', !poison.some(f => f.line === 7))
rmSync(scratch, { recursive: true, force: true })

{
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  const probeTargets = process.env.MERCURY_LOCAL_PROBE_TARGETS
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { runHealthReport } = await import('../../src/utils/healthReport.ts')
  const cert = await runHealthReport({ depth: 'fast' })
  if (probeTargets === undefined) delete process.env.MERCURY_LOCAL_PROBE_TARGETS
  else process.env.MERCURY_LOCAL_PROBE_TARGETS = probeTargets
  const printed = cert.sections.flatMap(entry => entry.checks)
  const objects = printed.filter(row => /\[object [A-Za-z]+\]/.test(`${row.evidence} ${row.detail ?? ''} ${row.fix ?? ''}`)).map(row => row.id)
  check(`no row of a fast certificate prints an object as [object …] (${printed.length} rows run here)`, printed.length > 100 && objects.length === 0, objects.join(', '))
  const slots = printed.find(row => row.id === 'provider-slots')
  check(
    "FC-095: the router row's engine word is 'configured' (never LIVE without a probe)",
    slots?.evidence.startsWith('anthropic configured (') === true,
    slots?.evidence,
  )
  check('FC-095: the LIVE spelling is out of the router row', slots !== undefined && !/\bLIVE\b/.test(slots.evidence), slots?.evidence)
  const { authChecks } = await import('../../src/utils/health/sections/auth.ts')
  const before = { key: process.env.ZAI_API_KEY, base: process.env.MERCURY_ZAI_API_BASE, targets: process.env.MERCURY_LOCAL_PROBE_TARGETS }
  process.env.ZAI_API_KEY = 'fixture-zai-key'
  process.env.MERCURY_ZAI_API_BASE = 'http://127.0.0.1:9'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const keyed = await (await authChecks()).find(row => row.id === 'provider-slots')?.run()
  for (const [name, value] of [['ZAI_API_KEY', before.key], ['MERCURY_ZAI_API_BASE', before.base], ['MERCURY_LOCAL_PROBE_TARGETS', before.targets]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const engineLine = / · engines: (.*?) · engine seats/.exec(keyed?.evidence ?? '')?.[1] ?? ''
  const words = engineLine.split(' · ').filter(part => /(?:^|[ ,])zai(?:,|$)/.test(part))
  check(
    "FC-095: with a Z.AI key the engine reads available, and the row's word for it is 'configured' (no probe went out, so never LIVE)",
    keyed?.status === 'ok' && words.length === 1 && words[0]!.startsWith('configured ') && !/\bLIVE\b/.test(keyed.evidence),
    keyed?.evidence,
  )
}

console.log(failures === 0 ? 'HEALTH EVIDENCE STRING LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
