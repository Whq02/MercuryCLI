#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-health-evidence-strings.ts — every value the health
//  composer interpolates into a row's words is a STRING or a number
// (the `/health` MCP-policy row that read
//  `1 server(s): [object Object]` — the row joined McpServerRow objects).
//
//  One static pass over src/utils/healthReport.ts with the TypeScript
//  checker: every `${…}` span of every template literal, and every receiver
//  of `.join(`, is typed; a span whose type is an object (or a union with an
//  object member), or a `.join(` over an array of objects, is a dishonest
//  row — `[object Object]` on the certificate. Numbers, booleans, strings
//  and string arrays joined stay as they are. Poison control: a scratch
//  source holding `${{ a: 1 }}` and `[{ a: 1 }].join(', ')` trips the same
//  walker at both lines.
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
// PROVE_SRC names another checkout's src (the A/B poison: the pre-fix
// composer's MCP row reads red at its join over McpServerRow objects).
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

/** True when the type (or any union member) is an object — the shape that
 *  stringifies to `[object Object]`. Type parameters and intersections of
 *  primitives are read through their constraints. */
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

/** Walk one source file inside `program`; list the dishonest spans. */
export function dishonestSpans(program: ts.Program, file: ts.SourceFile): Finding[] {
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

// ── the composer ───────────────────────────────────────────────────────────
console.log('the health composer: every interpolated value is a string or a number')
const started = Date.now()
const program = programFor([TARGET])
const source = program.getSourceFile(TARGET)
if (!source) throw new Error(`source not loaded: ${TARGET}`)
const findings = dishonestSpans(program, source)
check(
  `src/utils/healthReport.ts interpolates no object and joins no object array (${Date.now() - started}ms)`,
  findings.length === 0,
  findings.map(f => `L${f.line} ${f.kind} ${f.text} : ${f.type}`).join(' · '),
)

// ── the poison control ─────────────────────────────────────────────────────
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

// ── FC-095: LIVE means liveness — this row probes nothing, so it says
// 'configured' ─────────────────────────────────────────────────────────────
{
  const src95 = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check(
    "FC-095: the router row's engine word is 'configured' (never LIVE without a probe)",
    src95.includes("p.available ? 'configured' : p.reason") && src95.includes('anthropic configured ('),
  )
  check('FC-095: the LIVE spelling is out of the router row', !src95.includes("p.available ? 'LIVE'") && !src95.includes('anthropic LIVE ('))
}

console.log(failures === 0 ? 'HEALTH EVIDENCE STRING LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
