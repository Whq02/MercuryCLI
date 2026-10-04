#!/usr/bin/env bun
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'sdk-generate-'))

const argv = process.argv.slice(2)
const argValue = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const ROOT = resolve(argValue('--root') ?? resolve(import.meta.dir, '..', '..'))
const OUT_DIR = resolve(argValue('--out') ?? join(ROOT, 'sdk', 'src'))
const VOCABULARY = 'src/rows/vocabulary.ts'
const PERMISSIONS = 'src/types/permissions.ts'
const EFFORT = 'src/utils/effortLadder.ts'
const MAIN = 'src/main.tsx'
const GENERATOR = 'scripts/sdk/generate.ts'
const ROW = {
  assets: 'sdk/src/rows.ts sdk/src/door.ts',
  generator: `bun ${GENERATOR}`,
  check: 'bun scripts/sdk/prove-rows-drift.ts',
  sources: `${VOCABULARY} ${PERMISSIONS} ${EFFORT} ${MAIN}`,
}
if (argv.includes('--register')) {
  const { registerGeneratedAsset } = (await import(join(ROOT, 'scripts/lib/generated-assets-map.mjs'))) as { registerGeneratedAsset: (row: typeof ROW) => { action: string; line: string } }
  const result = registerGeneratedAsset(ROW)
  console.log(`generated-assets: ${result.action} — ${result.line.split('\t')[0]}`)
  process.exit(0)
}

const { z } = await import('zod/v4')
const vocabulary = (await import(join(ROOT, VOCABULARY))) as Record<string, unknown>
const permissions = (await import(join(ROOT, PERMISSIONS))) as { PERMISSION_MODES: readonly string[] }
const effort = (await import(join(ROOT, EFFORT))) as { EFFORT_LEVELS: readonly string[] }

type Schema = Record<string, unknown>
const KEYWORDS = new Set(['type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'propertyNames', 'items', 'oneOf', 'anyOf', 'minimum', 'maximum'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function fail(message: string): never {
  throw new Error(`generate: ${message}`)
}

function audit(schema: unknown, path: string): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) fail(`${path}: a schema must be an object`)
  const node = schema as Schema
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) fail(`${path}: the keyword "${key}" is outside the set the package interprets`)
  }
  const type = node.type
  if (type !== undefined) {
    for (const t of Array.isArray(type) ? type : [type]) if (!TYPES.has(String(t))) fail(`${path}: unknown type ${String(t)}`)
  }
  if (node.properties !== undefined) for (const [name, inner] of Object.entries(node.properties as Record<string, unknown>)) audit(inner, `${path}.${name}`)
  if (typeof node.additionalProperties === 'object' && node.additionalProperties !== null) audit(node.additionalProperties, `${path}.*`)
  if (node.propertyNames !== undefined) audit(node.propertyNames, `${path}.<keys>`)
  if (node.items !== undefined) audit(node.items, `${path}[]`)
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = node[key]
    if (options === undefined) continue
    if (!Array.isArray(options) || options.length === 0) fail(`${path}.${key}: an empty union`)
    options.forEach((option, index) => audit(option, `${path}.${key}[${index}]`))
  }
}

function jsonSchemaOf(factory: () => unknown, name: string): Schema {
  const schema = z.toJSONSchema(factory() as never, { io: 'input', unrepresentable: 'throw' }) as Schema
  delete schema.$schema
  audit(schema, name)
  return schema
}

const source = readFileSync(join(ROOT, VOCABULARY), 'utf8')
const schemaNames = [...source.matchAll(/^export const (\w+Schema) = lazySchema\(/gm)].map(m => m[1]!)
if (schemaNames.length === 0) fail('no lazySchema exports found in the vocabulary')
const named = new Map<string, { typeName: string; schema: Schema; text: string }>()
for (const exportName of schemaNames) {
  const factory = vocabulary[exportName]
  if (typeof factory !== 'function') fail(`${exportName} is not a schema factory`)
  const schema = jsonSchemaOf(factory as () => unknown, exportName)
  named.set(exportName, { typeName: exportName.replace(/Schema$/, ''), schema, text: JSON.stringify(schema) })
}
const byText = new Map<string, string>()
for (const [, entry] of named) if (!byText.has(entry.text)) byText.set(entry.text, entry.typeName)

const lists = ['ROW_TYPES', 'PARTIAL_ROW_TYPES', 'INPUT_ROW_TYPES', 'OUTCOME_STATUSES', 'STOP_WORDS', 'ERROR_CLASSES'] as const
const listValues: Record<(typeof lists)[number], readonly string[]> = {} as never
for (const name of lists) {
  const value = vocabulary[name]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(`${name} is not a list of strings`)
  listValues[name] = value as string[]
}
const rowsSchema = vocabulary.ROWS_SCHEMA
if (typeof rowsSchema !== 'number') fail('ROWS_SCHEMA is not a number')
const exitCodeOf = vocabulary.exitCodeOf
if (typeof exitCodeOf !== 'function') fail('exitCodeOf is not a function')

const literal = (value: unknown): string => JSON.stringify(value).replace(/"/g, "'")
const isIdentifier = (key: string): boolean => /^[A-Za-z_$][\w$]*$/.test(key)
const keyOf = (key: string): string => (isIdentifier(key) ? key : literal(key))

function typeOf(schema: Schema, indent: string, top: boolean): string {
  if (!top) {
    const name = byText.get(JSON.stringify(schema))
    if (name !== undefined) return name
  }
  const keys = Object.keys(schema)
  if (keys.length === 0) return 'unknown'
  const union = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined
  if (union !== undefined) return union.map(option => typeOf(option, indent, false)).join(' | ')
  const type = schema.type
  if (Array.isArray(type)) return type.map(t => (t === 'null' ? 'null' : typeOf({ ...schema, type: t }, indent, false))).join(' | ')
  if (schema.const !== undefined) return literal(schema.const)
  if (schema.enum !== undefined) return (schema.enum as unknown[]).map(literal).join(' | ')
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const item = typeOf(schema.items as Schema, indent, false)
      return item.includes(' | ') || item.includes(' ') ? `Array<${item}>` : `${item}[]`
    }
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      const required = new Set((schema.required ?? []) as string[])
      const extra = schema.additionalProperties
      const names = Object.keys(properties)
      if (names.length === 0 && typeof extra === 'object' && extra !== null) return `Record<string, ${typeOf(extra as Schema, indent, false)}>`
      const inner = `${indent}  `
      const lines = names.map(name => `${inner}${keyOf(name)}${required.has(name) ? '' : '?'}: ${typeOf(properties[name]!, inner, false)}`)
      if (typeof extra === 'object' && extra !== null) lines.push(`${inner}[key: string]: ${typeOf(extra as Schema, inner, false)}`)
      return `{\n${lines.join('\n')}\n${indent}}`
    }
    default:
      return fail(`unprintable schema ${JSON.stringify(schema)}`)
  }
}

const rowTypeSet = new Set([...listValues.ROW_TYPES, ...listValues.PARTIAL_ROW_TYPES])
const inputTypeSet = new Set(listValues.INPUT_ROW_TYPES)
const rowSchemas = new Map<string, string>()
const inputSchemas = new Map<string, string>()
for (const [exportName, entry] of named) {
  const type = ((entry.schema.properties as Record<string, Schema> | undefined)?.type as Schema | undefined)?.const
  if (typeof type !== 'string') continue
  if (rowTypeSet.has(type)) {
    if (rowSchemas.has(type)) fail(`two schemas carry the row type ${type}`)
    rowSchemas.set(type, exportName)
  } else if (inputTypeSet.has(type)) {
    if (inputSchemas.has(type)) fail(`two schemas carry the input row type ${type}`)
    inputSchemas.set(type, exportName)
  } else fail(`${exportName} carries a type ${type} that no list declares`)
}
for (const type of rowTypeSet) if (!rowSchemas.has(type)) fail(`row type ${type} has no schema`)
for (const type of inputTypeSet) if (!inputSchemas.has(type)) fail(`input row type ${type} has no schema`)
const unionMembers = (exportName: string, members: Map<string, string>): void => {
  const union = named.get(exportName)?.schema.oneOf as Schema[] | undefined
  if (union === undefined) fail(`${exportName} is not a union`)
  const expected = [...members.values()].map(name => named.get(name)!.text).sort()
  const found = union.map(option => JSON.stringify(option)).sort()
  if (JSON.stringify(expected) !== JSON.stringify(found)) fail(`${exportName} does not unite exactly the declared row schemas`)
}
unionMembers('RowSchema', rowSchemas)
unionMembers('InputRowSchema', inputSchemas)

const mainSource = readFileSync(join(ROOT, MAIN), 'utf8')
const mainFile = ts.createSourceFile(MAIN, mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
type Option = { flag: string; short?: string; value: 'none' | 'required' | 'optional' | 'variadic'; choices?: readonly string[]; hidden: boolean }
const text = (node: ts.Node): string | undefined => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined)
const parseFlags = (flags: string): Pick<Option, 'flag' | 'short' | 'value'> => {
  const m = /^(?:(-[A-Za-z]), )?(-{1,2}[A-Za-z][\w-]*)(?: (<[^>]+>|\[[^\]]+\]))?$/.exec(flags)
  if (!m) fail(`unreadable option flags ${JSON.stringify(flags)}`)
  const value = m[3] === undefined ? 'none' : m[3].endsWith('...>') ? 'variadic' : m[3].startsWith('<') ? 'required' : 'optional'
  return { flag: m[2]!, ...(m[1] !== undefined ? { short: m[1] } : {}), value }
}
const stringList = (node: ts.Node): string[] | undefined => {
  const inner = ts.isAsExpression(node) ? node.expression : node
  if (!ts.isArrayLiteralExpression(inner)) return undefined
  const items = inner.elements.map(text)
  return items.every((item): item is string => item !== undefined) ? items : undefined
}
const constLists = new Map<string, string[]>()
const declared: Array<{ at: number; option: Option }> = []
const seen = new Set<string>()
const addOption = (at: number, option: Option): void => {
  if (seen.has(option.flag)) fail(`the option ${option.flag} is declared twice`)
  seen.add(option.flag)
  declared.push({ at, option })
}
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'Set') {
    const list = node.initializer.arguments?.[0] ? stringList(node.initializer.arguments[0]) : undefined
    if (list) constLists.set(node.name.text, list)
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    const receiverIsProgram = ((): boolean => {
      let cursor: ts.Expression = node.expression.expression
      for (;;) {
        if (ts.isIdentifier(cursor)) return cursor.text === 'program'
        if (ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
          if (cursor.expression.name.text === 'command') return false
          cursor = cursor.expression.expression
          continue
        }
        return false
      }
    })()
    if (method === 'option' && receiverIsProgram) {
      const flags = text(node.arguments[0]!)
      if (flags === undefined) fail('an option call without a literal flag string')
      const option: Option = { ...parseFlags(flags), hidden: false }
      if (option.flag === '--effort') option.choices = effort.EFFORT_LEVELS
      addOption(node.expression.name.getStart(), option)
    }
    if (method === 'addOption' && receiverIsProgram) {
      let chain: ts.Expression = node.arguments[0]!
      let hidden = false
      let choices: readonly string[] | undefined
      while (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
        const name = chain.expression.name.text
        if (name === 'hideHelp') hidden = true
        else if (name === 'choices') {
          const arg = chain.arguments[0]!
          choices = stringList(arg) ?? (ts.isIdentifier(arg) && arg.text === 'PERMISSION_MODES' ? permissions.PERMISSION_MODES : undefined)
          if (choices === undefined) fail('an option choices list the generator cannot read')
        } else if (name !== 'argParser') fail(`an option chain method the generator does not read: ${name}`)
        chain = chain.expression.expression
      }
      if (ts.isNewExpression(chain) && chain.arguments?.[0]) {
        const flags = text(chain.arguments[0])
        if (flags !== undefined) addOption(node.expression.name.getStart(), { ...parseFlags(flags), ...(choices !== undefined ? { choices } : {}), hidden })
        else if (ts.isIdentifier(chain.arguments[0]) && chain.arguments[0].text === 'flags') {
          const loop = (function up(n: ts.Node): ts.ForOfStatement | undefined {
            return n.parent === undefined ? undefined : ts.isForOfStatement(n.parent) ? n.parent : up(n.parent)
          })(node)
          if (!loop) fail('an addOption(flags) outside a for-of loop')
          const rows = ts.isAsExpression(loop.expression) ? loop.expression.expression : loop.expression
          if (!ts.isArrayLiteralExpression(rows)) fail('a for-of option loop without a literal list')
          for (const row of rows.elements) {
            if (!ts.isArrayLiteralExpression(row)) fail('a for-of option row that is not a tuple')
            const flags = text(row.elements[0]!)
            if (flags === undefined) fail('a for-of option row without a literal flag string')
            addOption(row.getStart(), { ...parseFlags(flags), hidden })
          }
        } else fail('an addOption whose flags the generator cannot read')
      }
    }
  }
  ts.forEachChild(node, visit)
}
visit(mainFile)
const programOptions = declared.sort((a, b) => a.at - b.at).map(entry => entry.option)
if (programOptions.length < 40) fail(`only ${programOptions.length} root options read from ${MAIN}`)
const interactiveBoot = constLists.get('INTERACTIVE_BOOT_OPTIONS')
const runOutput = constLists.get('RUN_OUTPUT_OPTIONS')
if (!interactiveBoot || !runOutput) fail('INTERACTIVE_BOOT_OPTIONS or RUN_OUTPUT_OPTIONS not read')
for (const flag of [...interactiveBoot, ...runOutput]) if (!seen.has(flag)) fail(`${flag} is listed but never declared`)
const headlessResume = [...mainSource.matchAll(/new Option\('(-r, --resume <value>)'/g)].map(m => m[1]!)[0]
if (headlessResume === undefined) fail('the run resume option was not read')
const runOptions: Option[] = programOptions
  .filter(option => !interactiveBoot.includes(option.flag))
  .map(option => (option.flag === '--resume' ? { ...parseFlags(headlessResume), hidden: false } : option))
const formatOption = runOptions.find(option => option.flag === '--format')
if (!formatOption?.choices?.includes('rows')) fail('--format does not offer rows')
const modeOption = runOptions.find(option => option.flag === '--mode')
if (!modeOption?.choices || modeOption.choices.join(',') !== permissions.PERMISSION_MODES.join(',')) fail('--mode does not offer the permission modes')

const schemaText = (schema: Schema, indent: string): string => JSON.stringify(schema, null, 2).split('\n').map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n')
const constList = (name: string, values: readonly string[]): string => `export const ${name} = [${values.map(literal).join(', ')}] as const`

const MARK = `generated by bun ${GENERATOR}`
const rows: string[] = []
rows.push(`export const GENERATED = '${MARK}'`)
rows.push(`export const GENERATED_BY = '${GENERATOR}'`)
rows.push(`export const GENERATED_FROM = [${[VOCABULARY].map(literal).join(', ')}] as const`)
rows.push(`export const ROWS_SCHEMA = ${rowsSchema} as const`)
rows.push(constList('ROW_TYPES', listValues.ROW_TYPES))
rows.push('export type RowType = (typeof ROW_TYPES)[number]')
rows.push(constList('PARTIAL_ROW_TYPES', listValues.PARTIAL_ROW_TYPES))
rows.push('export type PartialRowType = (typeof PARTIAL_ROW_TYPES)[number]')
rows.push(constList('INPUT_ROW_TYPES', listValues.INPUT_ROW_TYPES))
rows.push('export type InputRowType = (typeof INPUT_ROW_TYPES)[number]')
rows.push(constList('OUTCOME_STATUSES', listValues.OUTCOME_STATUSES))
rows.push('export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number]')
rows.push(constList('STOP_WORDS', listValues.STOP_WORDS))
rows.push('export type StopWord = (typeof STOP_WORDS)[number]')
rows.push(constList('ERROR_CLASSES', listValues.ERROR_CLASSES))
rows.push('export type ErrorClass = (typeof ERROR_CLASSES)[number]')
const exitCodes = Object.fromEntries(listValues.OUTCOME_STATUSES.map(status => [status, (exitCodeOf as (s: string) => number)(status)]))
rows.push(`export const OUTCOME_EXIT_CODES = ${JSON.stringify(exitCodes).replace(/"/g, '').replace(/,/g, ', ').replace(/:/g, ': ').replace('{', '{ ').replace('}', ' }')} as const`)
rows.push('export type JsonSchema = {')
rows.push("  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | readonly string[]")
rows.push('  const?: string | number | boolean')
rows.push('  enum?: readonly string[]')
rows.push('  properties?: Readonly<Record<string, JsonSchema>>')
rows.push('  required?: readonly string[]')
rows.push('  additionalProperties?: boolean | JsonSchema')
rows.push('  propertyNames?: JsonSchema')
rows.push('  items?: JsonSchema')
rows.push('  oneOf?: readonly JsonSchema[]')
rows.push('  anyOf?: readonly JsonSchema[]')
rows.push('  minimum?: number')
rows.push('  maximum?: number')
rows.push('}')
for (const [, entry] of named) {
  const body = typeOf(entry.schema, '', true)
  if (entry.schema.type === 'object' && entry.schema.properties !== undefined) rows.push(`export interface ${entry.typeName} ${body}`)
  else rows.push(`export type ${entry.typeName} = ${body}`)
}
rows.push(`export const ROW_SCHEMAS: Readonly<Record<RowType | PartialRowType, JsonSchema>> = {`)
for (const type of [...listValues.ROW_TYPES, ...listValues.PARTIAL_ROW_TYPES]) rows.push(`  ${keyOf(type)}: ${schemaText(named.get(rowSchemas.get(type)!)!.schema, '  ')},`)
rows.push('}')
rows.push(`export const INPUT_ROW_SCHEMAS: Readonly<Record<InputRowType, JsonSchema>> = {`)
for (const type of listValues.INPUT_ROW_TYPES) rows.push(`  ${keyOf(type)}: ${schemaText(named.get(inputSchemas.get(type)!)!.schema, '  ')},`)
rows.push('}')
rows.push('')

const door: string[] = []
door.push(`export const DOOR_GENERATED = '${MARK}'`)
door.push(`export const DOOR_GENERATED_FROM = [${[PERMISSIONS, EFFORT, MAIN].map(literal).join(', ')}] as const`)
door.push(constList('PERMISSION_MODES', permissions.PERMISSION_MODES))
door.push('export type PermissionMode = (typeof PERMISSION_MODES)[number]')
door.push(constList('EFFORT_LEVELS', effort.EFFORT_LEVELS))
door.push('export type EffortLevel = (typeof EFFORT_LEVELS)[number]')
door.push(constList('RUN_FORMATS', formatOption.choices!))
door.push('export type RunFormat = (typeof RUN_FORMATS)[number]')
door.push("export type RunOptionValue = 'none' | 'required' | 'optional' | 'variadic'")
door.push('export type RunOption = { flag: string; short?: string; value: RunOptionValue; choices?: readonly string[]; hidden: boolean }')
door.push('export const RUN_OPTIONS = [')
for (const option of runOptions) {
  const parts = [`flag: ${literal(option.flag)}`]
  if (option.short !== undefined) parts.push(`short: ${literal(option.short)}`)
  parts.push(`value: ${literal(option.value)}`)
  if (option.choices !== undefined) parts.push(`choices: [${option.choices.map(literal).join(', ')}]`)
  parts.push(`hidden: ${option.hidden}`)
  door.push(`  { ${parts.join(', ')} },`)
}
door.push('] as const satisfies readonly RunOption[]')
door.push("export type RunOptionFlag = (typeof RUN_OPTIONS)[number]['flag']")
door.push('')

const outputs: Array<[string, string]> = [
  [join(OUT_DIR, 'rows.ts'), rows.join('\n')],
  [join(OUT_DIR, 'door.ts'), door.join('\n')],
]
if (argv.includes('--check')) {
  let drift = 0
  for (const [path, content] of outputs) {
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      current = ''
    }
    if (current !== content) {
      drift++
      console.log(`DRIFT ${path}`)
    } else console.log(`SAME ${path}`)
  }
  process.exit(drift === 0 ? 0 : 1)
}
for (const [path, content] of outputs) {
  writeFileSync(path, content)
  console.log(`wrote ${path} (${content.length} bytes)`)
}
