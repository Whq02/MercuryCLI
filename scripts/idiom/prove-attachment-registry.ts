#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const { BODY_SHAPE_KINDS } = await import('../../src/fabric/validate.js')

const ROOT = join(import.meta.dir, '..', '..')
const UNION_SOURCE = 'src/utils/attachments/types.ts'
const UNION_NAME = 'Attachment'
const REGISTRY_SOURCE = 'src/fabric/validate.ts'
const REGISTRY_NAME = 'ATTACHMENT_BODY_SHAPES'
const FIXTURE_SOURCE = 'scripts/idiom/prove-body-shape-registry.ts'
const FIXTURE_NAME = 'ATTACHMENTS'
const PRODUCER_ROOT = 'src'
const PRODUCER_CALL = 'createAttachmentMessage'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}

function parse(rel: string): ts.SourceFile {
  const full = join(ROOT, rel)
  return ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function sourceFilesUnder(rel: string, carrying: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && readFileSync(full, 'utf8').includes(carrying)) found.push(relative(ROOT, full))
    }
  }
  walk(join(ROOT, rel))
  return found.sort()
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function objectLiteralNamed(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name || decl.initializer === undefined) continue
      let init: ts.Expression = decl.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      return ts.isObjectLiteralExpression(init) ? init : null
    }
  }
  return null
}

function keysOf(literal: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = []
  for (const p of literal.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue
    const key = propertyName(p.name)
    if (key !== null) keys.push(key)
  }
  return keys
}

type Member = { kind: string; fields: string[]; via: string; line: number }

function unionMembers(sf: ts.SourceFile, root: string): { members: Member[]; shapeless: string[] } {
  const aliases = new Map<string, ts.TypeNode>()
  for (const st of sf.statements) if (ts.isTypeAliasDeclaration(st)) aliases.set(st.name.text, st.type)
  const members: Member[] = []
  const shapeless: string[] = []
  const walk = (node: ts.TypeNode, via: string, seen: Set<string>): void => {
    if (ts.isUnionTypeNode(node)) {
      for (const t of node.types) walk(t, via, seen)
      return
    }
    if (ts.isParenthesizedTypeNode(node)) {
      walk(node.type, via, seen)
      return
    }
    if (ts.isTypeLiteralNode(node)) {
      let kind: string | null = null
      const fields: string[] = []
      for (const m of node.members) {
        if (!ts.isPropertySignature(m) || m.name === undefined) continue
        const name = propertyName(m.name)
        if (name === null) continue
        if (name === 'type' && m.type !== undefined && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) kind = m.type.literal.text
        else fields.push(name)
      }
      if (kind === null) shapeless.push(`${via} literal at ${UNION_SOURCE}:${lineOf(sf, node)}`)
      else members.push({ kind, fields, via, line: lineOf(sf, node) })
      return
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text
      const target = aliases.get(name)
      if (target === undefined) {
        shapeless.push(`${via} refers to ${name}, not an alias in ${UNION_SOURCE}`)
        return
      }
      if (!seen.has(name)) walk(target, name, new Set([...seen, name]))
      return
    }
    shapeless.push(`${via} carries a ${ts.SyntaxKind[node.kind]} at ${UNION_SOURCE}:${lineOf(sf, node)}`)
  }
  const union = aliases.get(root)
  if (union === undefined) shapeless.push(`no type alias ${root} in ${UNION_SOURCE}`)
  else walk(union, root, new Set([root]))
  return { members, shapeless }
}

type Row = { kind: string; fields: string[] | null; line: number }

function registryRows(sf: ts.SourceFile): Row[] | null {
  const literal = objectLiteralNamed(sf, REGISTRY_NAME)
  if (literal === null) return null
  const rows: Row[] = []
  for (const p of literal.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const kind = propertyName(p.name)
    if (kind === null) continue
    let fields: string[] | null = null
    const init = p.initializer
    if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'looseObject') {
      const arg = init.arguments[0]
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) fields = keysOf(arg)
    }
    rows.push({ kind, fields, line: lineOf(sf, p) })
  }
  return rows
}

type Producer = { kind: string; fields: string[]; file: string; line: number }

function producerLiterals(rel: string): Producer[] {
  const sf = parse(rel)
  const found: Producer[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PRODUCER_CALL && node.arguments[0] !== undefined) {
      let inner: ts.Expression = node.arguments[0]
      while (ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isParenthesizedExpression(inner)) inner = inner.expression
      if (ts.isObjectLiteralExpression(inner)) {
        let kind: string | null = null
        const fields: string[] = []
        for (const p of inner.properties) {
          if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue
          const key = propertyName(p.name)
          if (key === null) continue
          if (key === 'type' && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) kind = p.initializer.text
          else fields.push(key)
        }
        if (kind !== null) found.push({ kind, fields, file: rel, line: lineOf(sf, inner) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort()
const missing = (have: Iterable<string>, want: Iterable<string>): string[] => {
  const set = new Set(have)
  return sorted(new Set([...want].filter(k => !set.has(k))))
}
const named = (xs: string[]): string => (xs.length === 0 ? '' : `${xs.length}: ${xs.join(', ')}`)

section(`§A the ${UNION_NAME} union, read from ${UNION_SOURCE}`)
const { members, shapeless } = unionMembers(parse(UNION_SOURCE), UNION_NAME)
const kinds = members.map(m => m.kind)
const duplicated = sorted(new Set(kinds.filter((k, i) => kinds.indexOf(k) !== i)))
console.log(`  ${members.length} members: ${sorted(kinds).join(', ')}`)
check('the union has members and each is read from a type literal that carries its type discriminant', members.length > 0 && shapeless.length === 0, shapeless.join('; '))
check('no kind is declared twice in the union', duplicated.length === 0, named(duplicated))

section(`§B the registry ${REGISTRY_NAME} in ${REGISTRY_SOURCE} names the union, both ways`)
const rows = registryRows(parse(REGISTRY_SOURCE))
const rowKinds = rows === null ? [] : rows.map(r => r.kind)
console.log(`  ${rowKinds.length} rows: ${sorted(rowKinds).join(', ')}`)
check(`${REGISTRY_NAME} is an object literal the census can read`, rows !== null)
check('the exported BODY_SHAPE_KINDS.attachment and the source-read rows are the same kinds', sorted(rowKinds).join(',') === sorted(BODY_SHAPE_KINDS.attachment).join(','), `source ${sorted(rowKinds).join(',')} vs runtime ${sorted(BODY_SHAPE_KINDS.attachment).join(',')}`)
const rowsMissing = missing(rowKinds, kinds)
const rowsStray = missing(kinds, rowKinds)
check('every member of the union has a registry row', rowsMissing.length === 0, `union members without a row — ${named(rowsMissing)}`)
check('every registry row names a member of the union', rowsStray.length === 0, `rows without a union member — ${named(rowsStray)}`)

section(`§C the fixture table ${FIXTURE_NAME} in ${FIXTURE_SOURCE} names the union, both ways`)
const fixtureLiteral = objectLiteralNamed(parse(FIXTURE_SOURCE), FIXTURE_NAME)
const fixtureKinds = fixtureLiteral === null ? [] : keysOf(fixtureLiteral)
console.log(`  ${fixtureKinds.length} fixtures: ${sorted(fixtureKinds).join(', ')}`)
check(`${FIXTURE_NAME} is an object literal the census can read`, fixtureLiteral !== null)
const fixturesMissing = missing(fixtureKinds, kinds)
const fixturesStray = missing(kinds, fixtureKinds)
check('every member of the union has a fixture', fixturesMissing.length === 0, `union members without a fixture — ${named(fixturesMissing)}`)
check('every fixture names a member of the union', fixturesStray.length === 0, `fixtures without a union member — ${named(fixturesStray)}`)

section('§D each registry row is a loose object naming only fields its union member declares')
{
  const byKind = new Map(members.map(m => [m.kind, m]))
  const unreadable: string[] = []
  const undeclared: string[] = []
  for (const row of rows ?? []) {
    const member = byKind.get(row.kind)
    if (member === undefined) continue
    if (row.fields === null) {
      unreadable.push(`${row.kind} (${REGISTRY_SOURCE}:${row.line})`)
      continue
    }
    for (const field of row.fields) if (!member.fields.includes(field)) undeclared.push(`${row.kind}.${field} (${REGISTRY_SOURCE}:${row.line}; the member at ${UNION_SOURCE}:${member.line} declares ${member.fields.join(', ') || 'no field'})`)
  }
  check('every row is a z.looseObject({...}) literal the census can read', unreadable.length === 0, named(unreadable))
  check('no row names a field its union member does not declare', undeclared.length === 0, named(undeclared))
}

section(`§E every producer literal handed to ${PRODUCER_CALL} under ${PRODUCER_ROOT}/ names a member of the union and only fields that member declares`)
{
  const byKind = new Map(members.map(m => [m.kind, m]))
  const files = sourceFilesUnder(PRODUCER_ROOT, `${PRODUCER_CALL}(`)
  const producers = files.flatMap(producerLiterals)
  console.log(`  ${producers.length} producer literals in ${files.length} files, ${new Set(producers.map(p => p.kind)).size} kinds`)
  check('the census reads producer literals', producers.length > 0)
  const strayKinds = sorted(new Set(producers.filter(p => !byKind.has(p.kind)).map(p => `${p.kind} (${p.file}:${p.line})`)))
  check('every producer literal names a member of the union', strayKinds.length === 0, named(strayKinds))
  const undeclared: string[] = []
  for (const p of producers) {
    const member = byKind.get(p.kind)
    if (member === undefined) continue
    for (const field of p.fields) if (!member.fields.includes(field)) undeclared.push(`${p.kind}.${field} (${p.file}:${p.line}; the member at ${UNION_SOURCE}:${member.line} declares ${member.fields.join(', ') || 'no field'})`)
  }
  check('no producer literal writes a field its union member does not declare', undeclared.length === 0, named(sorted(undeclared)))
}

console.log(`\n${failures === 0 ? 'prove-attachment-registry: ALL LAWS HOLD' : `prove-attachment-registry: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
