#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const CONTRACT = 'src/services/providers/callModelContract.ts'
const ROUTER = 'src/services/providers/callModelRouter.ts'
const TABLE = 'src/services/providers/primaryBackend.ts'
const HOME_ROAD = 'src/services/providers/anthropic/streamCore.ts'
const ROADS_DIR = 'src/services/providers'
const SRC_DIR = join(ROOT, 'src')
const ROADS_ABS = join(ROOT, 'src/services/providers')

const FAMILY_ROADS = [
  'openaiCallModel',
  'zaiCallModel',
  'moonshotCallModel',
  'deepseekCallModel',
  'xaiCallModel',
  'metaCallModel',
  'compatCallModel',
  'huggingfaceCallModel',
  'localCallModel',
  'openrouterCallModel',
  'geminiCallModel',
].sort()
const SEAM_ROADS = ['routedCallModel']
const SHARED_RUNTIMES = ['compatChatCallModel']
const PARAMS_FIELDS = ['messages', 'systemPrompt', 'thinkingConfig', 'tools', 'signal', 'options']
const YIELD_MEMBERS = ['StreamEvent', 'AssistantMessage', 'SystemAPIErrorMessage', 'SystemStreamCutMessage']
const TYPE_IMPORTS: Record<string, string[]> = {
  '../../Tool.js': ['Tools'],
  '../../types/message.js': YIELD_MEMBERS.concat('Message').sort(),
  '../../utils/systemPromptType.js': ['SystemPrompt'],
  '../../utils/thinking.js': ['ThinkingConfig'],
  './anthropic/streamCore.js': ['Options'],
}
const ONE_SHAPE = /^export async function\* ([A-Za-z]+CallModel)\(params: CallModelParams\): CallModelStream \{$/gm
const CONTRACT_IMPORT = /^import type \{ CallModelParams, CallModelStream \} from '(?:\.\.?\/)+callModelContract\.js'$/m

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}
function stripComments(src: string): string {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/[^\n]*/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '')
}
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (!/\.(ts|tsx)$/.test(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isFile()) out.push(relative(ROOT, full))
  }
  return out.sort()
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',')
}

section('§1 the contract module — one declaration, every type imported from where it lives')
{
  check(`${CONTRACT} exists`, existsSync(join(ROOT, CONTRACT)))
  const text = existsSync(join(ROOT, CONTRACT)) ? read(CONTRACT) : ''
  const sf = ts.createSourceFile(CONTRACT, text, ts.ScriptTarget.Latest, true)
  const imports = new Map<string, string[]>()
  const aliases = new Map<string, ts.TypeNode>()
  let runtimeStatements = 0
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause
      const typeOnly = clause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      const names = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map(e => e.name.text).sort() : []
      if (!typeOnly) runtimeStatements++
      imports.set((st.moduleSpecifier as ts.StringLiteral).text, names)
      continue
    }
    if (ts.isTypeAliasDeclaration(st) && ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      aliases.set(st.name.text, st.type)
      continue
    }
    runtimeStatements++
  }
  check('the module is types only: every import is `import type`, every statement an exported type alias (nothing runs)', runtimeStatements === 0, String(runtimeStatements))
  check('it exports exactly CallModelParams · CallModelYield · CallModelStream · CallModel', sameSet([...aliases.keys()], ['CallModelParams', 'CallModelYield', 'CallModelStream', 'CallModel']), [...aliases.keys()].join(', '))
  for (const [spec, names] of Object.entries(TYPE_IMPORTS)) {
    check(`imports { ${names.join(', ')} } from ${spec} (the type lives there; nothing is redeclared)`, sameSet(imports.get(spec) ?? [], names), (imports.get(spec) ?? ['absent']).join(', '))
  }
  check('imports nothing else', sameSet([...imports.keys()], Object.keys(TYPE_IMPORTS)), [...imports.keys()].join(', '))
  const params = aliases.get('CallModelParams')
  const fields = params && ts.isTypeLiteralNode(params) ? params.members.map(m => (m.name as ts.Identifier).text) : []
  check('CallModelParams is the six-field request record the turn machine sends', fields.join(',') === PARAMS_FIELDS.join(','), fields.join(','))
  const requiredFields = params && ts.isTypeLiteralNode(params) ? params.members.every(m => !(m as ts.PropertySignature).questionToken) : false
  check('every field of the record is required (a road cannot be handed less)', requiredFields)
  const yieldType = aliases.get('CallModelYield')
  const members = yieldType && ts.isUnionTypeNode(yieldType) ? yieldType.types.map(t => t.getText(sf)) : []
  check('CallModelYield is the union the turn machine reads: stream events, settlements, API errors, stream cuts', sameSet(members, YIELD_MEMBERS), members.join(' | '))
  check('CallModelStream is AsyncGenerator<CallModelYield, void> (the generator ends; settlement is a yield)', aliases.get('CallModelStream')?.getText(sf).replace(/\s/g, '') === 'AsyncGenerator<CallModelYield,void>', aliases.get('CallModelStream')?.getText(sf))
  check('CallModel is (params: CallModelParams) => CallModelStream — interruption rides params.signal, nothing else is passed', aliases.get('CallModel')?.getText(sf).replace(/\s/g, '') === '(params:CallModelParams)=>CallModelStream', aliases.get('CallModel')?.getText(sf))
  check('the contract names no implementation (no queryModelWithStreaming, no family name)', !/queryModelWithStreaming|openai|zai|gemini|compat/i.test(text))
}

section('§2 every road under src/services/providers is declared against the contract in the one shape')
const roadFiles = filesUnder(ROADS_ABS)
const roadsFound = new Map<string, string>()
const otherCallModelExports: string[] = []
for (const file of roadFiles) {
  const code = stripComments(read(file))
  for (const m of code.matchAll(/^export (?:async function\*?|function|const|let) ([A-Za-z]+CallModel)\b/gm)) {
    const name = m[1]!
    if (SHARED_RUNTIMES.includes(name)) continue
    if (roadsFound.has(name)) otherCallModelExports.push(`${name} twice (${roadsFound.get(name)} and ${file})`)
    roadsFound.set(name, file)
  }
}
{
  check('the census found roads (a zero census would be a broken walker)', roadsFound.size >= 12, String(roadsFound.size))
  check('the family roads are exactly the pinned roster (a new family lands here or the census is red)', sameSet([...roadsFound.keys()].filter(n => !SEAM_ROADS.includes(n)), FAMILY_ROADS), [...roadsFound.keys()].filter(n => !SEAM_ROADS.includes(n)).sort().join(', '))
  check('the seam road routedCallModel is found in the router', roadsFound.get('routedCallModel') === ROUTER, roadsFound.get('routedCallModel') ?? 'absent')
  check('no *CallModel export is declared twice', otherCallModelExports.length === 0, otherCallModelExports.join(' · '))
  for (const [name, file] of [...roadsFound].sort()) {
    const code = stripComments(read(file))
    const shape = [...code.matchAll(ONE_SHAPE)].find(m => m[1] === name)
    check(`${name} (${relative(ROADS_DIR, file)}) is declared \`export async function* ${name}(params: CallModelParams): CallModelStream {\``, shape !== undefined)
    check(`${relative(ROADS_DIR, file)} imports the two contract types from callModelContract.js`, CONTRACT_IMPORT.test(code))
  }
  for (const runtime of SHARED_RUNTIMES) {
    const file = roadFiles.find(f => new RegExp(`^export async function\\* ${runtime}\\(`, 'm').test(stripComments(read(f))))
    check(`${runtime} is the shared runtime under the roads, not a road: it takes the lane profile first and the contract's record second`, file !== undefined && new RegExp(`^export async function\\* ${runtime}\\(\\n  profile: CompatLaneProfile,\\n  params: CompatCallModelParams,`, 'm').test(stripComments(read(file))), file ?? 'absent')
  }
}

section('§3 the Anthropic road meets the contract like every other')
{
  const code = stripComments(read(HOME_ROAD))
  check("streamCore.ts imports the contract's two types", CONTRACT_IMPORT.test(code))
  check('queryModelWithStreaming is declared `(…): CallModelParams): CallModelStream` — the implementation meets the contract, it no longer defines it', /^export async function\* queryModelWithStreaming\(\{\n(?:  [a-zA-Z]+,\n){6}\}: CallModelParams\): CallModelStream \{$/m.test(code))
  check('the Anthropic road declares no parameter record of its own for the streaming entry', !/^export async function\* queryModelWithStreaming\([\s\S]{0,400}\}: \{\n/m.test(code))
}

section('§4 the router: every type from the contract module; the Anthropic function a dispatch value for the home arm only')
{
  const code = stripComments(read(ROUTER))
  check("imports { CallModelParams, CallModelStream } from './callModelContract.js' and nothing typed from the transport", /^import type \{ CallModelParams, CallModelStream \} from '\.\/callModelContract\.js'$/m.test(code))
  check("imports queryModelWithStreaming as a value (the home arm's dispatch target)", /^import \{ queryModelWithStreaming \} from '\.\.\/providers\/anthropic\/index\.js'$/m.test(code))
  const mentions = code.match(/queryModelWithStreaming/g)?.length ?? 0
  check('queryModelWithStreaming appears twice in the router: the import and the home arm `yield* queryModelWithStreaming(params)` — never as a type', mentions === 2 && code.includes('yield* queryModelWithStreaming(params)'), String(mentions))
  check('routedCallModelSettled(params: CallModelParams)', /^export async function routedCallModelSettled\(params: CallModelParams\): Promise<AssistantMessage> \{$/m.test(code))
  check('homeLaneCall(params: CallModelParams): CallModelStream — the admission arm, typed against the contract', /^async function\* homeLaneCall\(params: CallModelParams\): CallModelStream \{$/m.test(code))
  check('the admission owner speaks before the transport in the home arm', code.indexOf('homeLaneAdmissionRefusal(params.options.model)') !== -1 && code.indexOf('homeLaneAdmissionRefusal(params.options.model)') < code.indexOf('yield* queryModelWithStreaming(params)'))
  const switchBody = code.slice(code.indexOf('  switch (verdict.route) {'), code.lastIndexOf('\n  }\n}'))
  const arms = switchBody.split(/^    case '[a-z-]+':$/m).slice(1).map(arm => /yield\* ([A-Za-z]+)\(request\)\n      return/.exec(arm)?.[1] ?? '?')
  check('every route arm dispatches a censused road or the home arm, and every road in the roster is dispatched', arms.length >= 12 && arms.every(a => roadsFound.has(a) || a === 'homeLaneCall') && FAMILY_ROADS.every(r => arms.includes(r)), arms.join(', '))
}

section('§5 the backend table: callModel is a CallModel, every row assigns its road plain (the compile-time check the typecheck suite runs)')
{
  const code = stripComments(read(TABLE))
  check("imports type { CallModel } from './callModelContract.js'", /^import type \{ CallModel \} from '\.\/callModelContract\.js'$/m.test(code))
  check('PrimaryAgentBackend.callModel: CallModel', /^  callModel: CallModel$/m.test(code))
  const rows = [...code.matchAll(/^\s*callModel: ([^\n]+),$/gm)].map(m => m[1]!)
  check('the table has one callModel row per registered backend (anthropic + the family roads)', rows.length === FAMILY_ROADS.length + 1, String(rows.length))
  check('every row is a bare identifier — no `as`, no call, no wrapper', rows.every(r => /^[A-Za-z]+$/.test(r)), rows.filter(r => !/^[A-Za-z]+$/.test(r)).join(' · '))
  check('the rows are exactly queryModelWithStreaming plus the censused family roads', sameSet(rows, FAMILY_ROADS.concat('queryModelWithStreaming')), rows.sort().join(', '))
  check('the table spells no cast onto the contract', !/as unknown as|as CallModel\b|as CallModelStream\b|as typeof/.test(code))
}

section('§6 the borrowed type and the casts onto the contract are gone from src')
{
  const srcFiles = filesUnder(SRC_DIR)
  const borrowed: string[] = []
  const casts: string[] = []
  const typeImports: string[] = []
  for (const file of srcFiles) {
    const code = stripComments(read(file))
    if (/typeof queryModelWithStreaming\b/.test(code)) borrowed.push(file)
    if (/\bas (?:unknown as )?(?:CallModel|CallModelStream|CallModelParams|CallModelYield)\b/.test(code)) casts.push(file)
    if (/import type \{[^}]*\bqueryModelWithStreaming\b[^}]*\}/.test(code)) typeImports.push(file)
  }
  check('the census walked src (a zero census would be a broken walker)', srcFiles.length > 1000, String(srcFiles.length))
  check('`typeof queryModelWithStreaming` is spelled nowhere in src — the Anthropic implementation is no longer anyone\'s type', borrowed.length === 0, borrowed.join(' · '))
  check('no file imports queryModelWithStreaming as a type', typeImports.length === 0, typeImports.join(' · '))
  check('no `as CallModel` / `as unknown as CallModel…` anywhere in src — a road meets the contract by declaration or not at all', casts.length === 0, casts.join(' · '))
  const unknownCasts = roadFiles.filter(f => /\bas unknown as\b[^\n]*CallModel/.test(stripComments(read(f))))
  check('no `as unknown as …CallModel…` under src/services/providers', unknownCasts.length === 0, unknownCasts.join(' · '))
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.log(`❌ ${failures} CALLMODEL-CONTRACT FAILURE(S)`)
  process.exit(1)
}
console.log('✅ callmodel-contract: one declared road contract, every road declared against it, no borrowed type, no cast')
