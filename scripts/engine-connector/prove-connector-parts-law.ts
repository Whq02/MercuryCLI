#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..', '..')
const FOLDER = 'src/engine/connector'
const DOOR = `${FOLDER}/daemonConnector.ts`
const PARTS_DIR = `${FOLDER}/daemon`
const SELF = 'scripts/engine-connector/prove-connector-parts-law.ts'

const PARTS: Readonly<Record<string, { file: string; type: string }>> = {
  admissionPart: { file: 'admission.ts', type: 'AdmissionPart' },
  asksPart: { file: 'asks.ts', type: 'AsksPart' },
  carrierPart: { file: 'carrier.ts', type: 'CarrierPart' },
  completionPart: { file: 'completion.ts', type: 'CompletionPart' },
  deliveryPart: { file: 'delivery.ts', type: 'DeliveryPart' },
  dialsPart: { file: 'dials.ts', type: 'DialsPart' },
  factsPart: { file: 'facts.ts', type: 'FactsPart' },
  foldPart: { file: 'fold.ts', type: 'FoldPart' },
  livePart: { file: 'live.ts', type: 'LivePart' },
  sendsPart: { file: 'sends.ts', type: 'SendsPart' },
  tailPart: { file: 'tail.ts', type: 'TailPart' },
  transcriptPart: { file: 'transcript.ts', type: 'TranscriptPart' },
  verbsPart: { file: 'verbs.ts', type: 'VerbsPart' },
  workPart: { file: 'work.ts', type: 'WorkPart' },
}

const OF_THE_DOOR: readonly string[] = ['carrier', 'record', 'hands', 'attached', 'factsFeed', 'asksFeed', 'tailFeed', 'progressFeed', 'turnInFlight', 'verbChain']

const REACHED_BY_PROOFS: readonly string[] = ['textRows', 'liveStateWord']

const AWAITING_THEIR_PART: Readonly<Record<string, readonly string[]>> = {}

const STEPPED_BY_A_HAND: Readonly<Record<string, string>> = { readFacts: 'factsRead' }

const REACHED_THROUGH_A_CAST: ReadonlyArray<{ script: string; name: string; reason: string }> = [
  { script: 'scripts/engine-connector/prove-parked-resume-freshness.ts', name: 'readFacts', reason: 'the product builds the connector there (focusResumedSession) and nothing is handed at construction' },
  { script: 'scripts/ui/prove-refused-admission-status.ts', name: 'readFacts', reason: 'the product builds the connector there (focusResumedSession) and nothing is handed at construction' },
]

let failures = 0
let sectionOpened = ''
const planHint = `to fix: read() in ${SELF} did not refuse this planted tree with exactly the one finding named; change the law there, or the plant above the check, and not the estate`
const estateHint = `to fix: change the file and line each finding names, under ${FOLDER}/ (the door ${DOOR} and the parts in ${PARTS_DIR}/), or the lists at the top of ${SELF}`
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  const hint = sectionOpened.startsWith('§1') ? planHint : sectionOpened.startsWith('§2') ? estateHint : ''
  const shown = [detail, hint].filter(Boolean).join(' | ')
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && shown ? ` — ${shown}` : ''}`)
}
const section = (t: string): void => {
  sectionOpened = t
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const slash = (p: string): string => p.split('\\').join('/')
const rel = (file: string): string => slash(relative(ROOT, file))
const abs = (file: string): string => join(ROOT, file)

type Law = 'field' | 'accessor' | 'import' | 'reach' | 'list' | 'private' | 'names' | 'needs' | 'built' | 'door' | 'unread' | 'state' | 'cast' | 'layer'
type Script = { file: string; text: string }
type Finding = { law: Law; at: string; what: string }
type Planted = Readonly<Record<string, (text: string, source: ts.SourceFile) => string>>
type Carried = { kind: 'class' | 'call'; name: string }
type Tally = { members: number; built: number; bindings: number; files: number }
type Chain = { layers: ts.ClassDeclaration[]; unread: ts.ExpressionWithTypeArguments | undefined }

const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(abs('tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT)
const options: ts.CompilerOptions = { ...parsed.options, noEmit: true }
const roots = (extra: readonly string[] = []): string[] => [...parsed.fileNames, ...extra.map(abs)]
const estate = ts.createProgram(roots(), options, ts.createCompilerHost(options, true))

function programWith(planted: Planted, added: Readonly<Record<string, string>> = {}): ts.Program {
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  const addedAt = new Map(Object.entries(added).map(([file, text]) => [slash(abs(file)), text]))
  host.fileExists = file => addedAt.has(slash(file)) || fileExists(file)
  host.readFile = file => addedAt.get(slash(file)) ?? readFile(file)
  host.getSourceFile = (file, version, onError, fresh) => {
    const name = rel(file)
    const add = addedAt.get(slash(file))
    if (add !== undefined) return ts.createSourceFile(file, add, version, true)
    const plant = planted[name]
    const real = estate.getSourceFile(file)
    if (plant !== undefined && real !== undefined) return ts.createSourceFile(file, plant(real.text, real), version, true)
    return real ?? getSourceFile(file, version, onError, fresh)
  }
  return ts.createProgram(roots(Object.keys(added)), options, host, estate)
}

function classNamed(source: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined
  source.forEachChild(node => {
    if (ts.isClassDeclaration(node) && node.name?.text === name) found = node
  })
  return found
}

function interfaceNamed(source: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  return source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name)
}

function layersUnder(program: ts.Program, connector: ts.ClassDeclaration): Chain {
  const checker = program.getTypeChecker()
  const layers: ts.ClassDeclaration[] = []
  let at = connector
  for (;;) {
    const parent = at.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    if (parent === undefined) return { layers, unread: undefined }
    const symbol = checker.getSymbolAtLocation(parent.expression)
    const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
    const next = (target?.declarations ?? []).find(ts.isClassDeclaration)
    if (next === undefined || next === connector || layers.includes(next) || !rel(next.getSourceFile().fileName).startsWith('src/')) return { layers, unread: parent }
    layers.push(next)
    at = next
  }
}

function fieldsOf(node: ts.ClassDeclaration): Array<{ name: string; private: boolean; line: number }> {
  const out: Array<{ name: string; private: boolean; line: number }> = []
  const source = node.getSourceFile()
  const at = (n: ts.Node): number => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1
  const isPrivate = (n: ts.Node): boolean => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Private) !== 0 || (ts.isPropertyDeclaration(n) && ts.isPrivateIdentifier(n.name))
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member)) out.push({ name: member.name.getText(source), private: isPrivate(member), line: at(member) })
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (ts.isParameterPropertyDeclaration(parameter, member)) out.push({ name: parameter.name.getText(source), private: isPrivate(parameter), line: at(parameter) })
      }
    }
  }
  return out
}

function partFiles(program: ts.Program): ts.SourceFile[] {
  return program.getSourceFiles().filter(source => rel(source.fileName).startsWith(`${PARTS_DIR}/`))
}

const specifiersSeen = new WeakMap<ts.SourceFile, ts.StringLiteralLike[]>()
function specifiersOf(source: ts.SourceFile): ts.StringLiteralLike[] {
  const seen = specifiersSeen.get(source)
  if (seen !== undefined) return seen
  const out: ts.StringLiteralLike[] = []
  const visit = (node: ts.Node): void => {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node)
          ? ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined
    if (spec !== undefined && ts.isStringLiteralLike(spec)) out.push(spec)
    ts.forEachChild(node, visit)
  }
  visit(source)
  specifiersSeen.set(source, out)
  return out
}

function read(program: ts.Program, door: 'read' | 'declarations only' = 'declarations only', tally: Tally = { members: 0, built: 0, bindings: 0, files: 0 }): Finding[] {
  const found: Finding[] = []
  const checker = program.getTypeChecker()
  const doorFile = program.getSourceFile(abs(DOOR))
  const connector = doorFile === undefined ? undefined : classNamed(doorFile, 'DaemonSessionConnector')
  if (doorFile === undefined || connector === undefined) return [{ law: 'list', at: DOOR, what: 'DaemonSessionConnector is not declared in the door' }]

  const allowed = new Set<string>([...Object.keys(PARTS), ...OF_THE_DOOR, ...Object.values(AWAITING_THEIR_PART).flat()])
  const declared = fieldsOf(connector)
  for (const field of declared) {
    if (!allowed.has(field.name)) found.push({ law: 'field', at: `${DOOR}:${field.line}`, what: `the field ${field.name} is declared on DaemonSessionConnector beyond the list: state belongs to a part under ${PARTS_DIR}/, and the class holds the parts and what the door needs` })
  }
  const names = new Set(declared.map(field => field.name))
  for (const name of allowed) {
    if (!names.has(name)) found.push({ law: 'list', at: SELF, what: `the list holds ${name} and the class declares no such field: take it off the list, which only falls` })
  }
  const accessors = new Set<string>()
  for (const member of connector.members) {
    if (!ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue
    const name = member.name.getText(doorFile)
    accessors.add(name)
    if (!REACHED_BY_PROOFS.includes(name)) found.push({ law: 'accessor', at: `${DOOR}:${doorFile.getLineAndCharacterOfPosition(member.getStart(doorFile)).line + 1}`, what: `the accessor ${name} is declared on DaemonSessionConnector and no proof reaches that name: an accessor stands on the class only for a field a proof reads or writes through a cast, and that list only falls` })
  }
  for (const name of REACHED_BY_PROOFS) {
    if (!accessors.has(name)) found.push({ law: 'list', at: SELF, what: `the list of names proofs reach holds ${name} and the class declares no such accessor: take it off the list, which only falls` })
  }
  for (const [name, part] of Object.entries(PARTS)) {
    const field = connector.members.find(member => ts.isPropertyDeclaration(member) && member.name.getText(doorFile) === name)
    const type = field === undefined ? undefined : checker.getTypeAtLocation(field)
    const declaration = type?.getSymbol()?.declarations?.[0]
    const from = declaration === undefined ? '' : rel(declaration.getSourceFile().fileName)
    if (type?.getSymbol()?.name !== part.type || from !== `${PARTS_DIR}/${part.file}`) found.push({ law: 'list', at: DOOR, what: `the field ${name} is not the part ${part.type} of ${PARTS_DIR}/${part.file}` })
  }

  const parts = partFiles(program)
  const place = (n: ts.Node): string => {
    const source = n.getSourceFile()
    return `${rel(source.fileName)}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`
  }
  const chain = layersUnder(program, connector)
  if (chain.unread !== undefined) found.push({ law: 'layer', at: place(chain.unread), what: `the chain under DaemonSessionConnector reaches ${chain.unread.expression.getText(chain.unread.getSourceFile())}, which is no class of src this law can read: a layer under the class is a class declaration of the estate, so that what it holds is read here` })
  for (const layer of chain.layers) {
    const source = layer.getSourceFile()
    for (const member of layer.members) {
      if (ts.isMethodDeclaration(member)) continue
      if (ts.isPropertyDeclaration(member) && (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Abstract) !== 0) continue
      const held = ts.isConstructorDeclaration(member)
        ? 'a constructor'
        : ts.isPropertyDeclaration(member)
          ? member.initializer !== undefined
            ? `the field ${member.name.getText(source)} with an initialiser`
            : `the property ${member.name.getText(source)}, which is not abstract`
          : `${member.name?.getText(source) ?? 'a member with no name'}, which is neither a method nor the abstract declaration of a field`
      found.push({ law: 'layer', at: place(member), what: `the layer ${layer.name?.text ?? 'with no name'} under DaemonSessionConnector declares ${held}: a layer holds methods and the abstract declarations of what the class holds; a field, its initialiser and the constructor stand on DaemonSessionConnector, where this law reads them and the order they are built in` })
    }
  }
  const resolved = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol)
  const targetOf = (spec: ts.StringLiteralLike): string | undefined => {
    const file = checker.getSymbolAtLocation(spec)?.declarations?.find(ts.isSourceFile)
    if (file !== undefined) return rel(file.fileName)
    const target = ts.resolveModuleName(spec.text, spec.getSourceFile().fileName, options, ts.sys).resolvedModule?.resolvedFileName
    return target === undefined ? undefined : rel(target)
  }
  const plain = (type: ts.Type): boolean => (type.isUnion() ? type.types.every(plain) : (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)
  const carriedBy = (type: ts.Type, calls: boolean, seen = new Set<ts.Type>(), depth = 0, path = ''): Carried | undefined => {
    if (seen.has(type) || depth > 8) return undefined
    seen.add(type)
    if (type.isUnionOrIntersection()) {
      for (const one of type.types) {
        const carried = carriedBy(one, calls, seen, depth, path)
        if (carried !== undefined) return carried
      }
      return undefined
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return undefined
    const symbol = type.getSymbol()
    const declarations = symbol?.declarations ?? []
    if (declarations.some(d => ts.isClassDeclaration(d) && rel(d.getSourceFile().fileName).startsWith(`${FOLDER}/`))) return { kind: 'class', name: symbol!.name }
    const given = [...(((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 ? checker.getTypeArguments(type as ts.TypeReference) : []), ...(type.aliasTypeArguments ?? [])]
    const foreign = declarations.length > 0 && declarations.every(d => d.getSourceFile().isDeclarationFile)
    if (!foreign) {
      if (calls && type.getCallSignatures().length > 0) return { kind: 'call', name: path }
      for (const property of checker.getPropertiesOfType(type)) {
        const carried = carriedBy(checker.getTypeOfSymbol(property), calls, seen, depth + 1, property.name)
        if (carried !== undefined) return carried
      }
      for (const info of checker.getIndexInfosOfType(type)) {
        const carried = carriedBy(info.type, calls, seen, depth + 1, path)
        if (carried !== undefined) return carried
      }
    }
    for (const one of given) {
      const carried = carriedBy(one, calls, seen, depth + 1, path)
      if (carried !== undefined) return carried
    }
    return undefined
  }
  const said = (carried: Carried): string => (carried.kind === 'class' ? `${carried.name}, a class of ${FOLDER}/` : carried.name === '' ? 'a call' : `an object that carries a call of its own (${carried.name})`)

  const owners = new Map<ts.ClassDeclaration, string>()
  for (const source of parts) {
    source.forEachChild(node => {
      if (!ts.isClassDeclaration(node)) return
      owners.set(node, rel(source.fileName))
      for (const field of fieldsOf(node)) {
        if (!field.private) found.push({ law: 'private', at: `${rel(source.fileName)}:${field.line}`, what: `the field ${field.name} of ${node.name?.text ?? 'a part'} is not private: a part holds its fields privately and answers through its methods` })
      }
    })
  }
  const fieldOwner = (symbol: ts.Symbol | undefined): { file: string; name: string } | undefined => {
    for (const declaration of symbol?.declarations ?? []) {
      const isField = ts.isPropertyDeclaration(declaration) || (ts.isParameter(declaration) && ts.isConstructorDeclaration(declaration.parent) && ts.isParameterPropertyDeclaration(declaration, declaration.parent))
      if (!isField) continue
      const owner = ts.isPropertyDeclaration(declaration) ? declaration.parent : declaration.parent.parent
      if (ts.isClassDeclaration(owner) && owners.has(owner)) return { file: owners.get(owner)!, name: symbol!.name }
    }
    return undefined
  }
  const readers = door === 'read' ? [...parts, doorFile] : parts
  for (const source of readers) {
    const here = rel(source.fileName)
    const at = (n: ts.Node): string => `${here}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`
    const named = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) || ts.isImportTypeNode(node)) {
        const spec = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isImportTypeNode(node) ? (ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined) : node.arguments[0]
        if (here !== DOOR && spec !== undefined && ts.isStringLiteralLike(spec)) {
          if (targetOf(spec) === DOOR) found.push({ law: 'import', at: at(node), what: `a file under ${PARTS_DIR}/ imports the door: a part is handed what it needs at construction and never holds the connector` })
        }
      }
      if (here !== DOOR && ts.isIdentifier(node)) {
        const symbol = resolved(checker.getSymbolAtLocation(node))
        for (const declaration of symbol?.declarations ?? []) {
          const from = rel(declaration.getSourceFile().fileName)
          const what = from === here ? undefined : from === DOOR ? `which the door declares` : ts.isClassDeclaration(declaration) && from.startsWith(`${FOLDER}/`) ? `the class of ${from}` : undefined
          const key = `${at(node)} ${symbol!.name}`
          if (what === undefined || named.has(key)) continue
          named.add(key)
          found.push({ law: 'names', at: at(node), what: `a file under ${PARTS_DIR}/ names ${symbol!.name}, ${what}: a part is handed what it needs at construction, as calls, and holds neither the connector nor another part; take the name out and ask for the call in the part's needs` })
        }
      }
      const member = ts.isPropertyAccessExpression(node) ? node.name : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression : ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) ? (node.propertyName ?? node.name) : undefined
      if (member !== undefined) {
        const owner = fieldOwner(checker.getSymbolAtLocation(member))
        if (owner !== undefined && owner.file !== here) {
          found.push({ law: 'reach', at: at(node), what: here === DOOR ? `the door reads the field ${owner.name} of the part in ${owner.file}: the door calls a part's methods` : `a part reads the field ${owner.name} of the part in ${owner.file}: it is handed a call at construction instead` })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  for (const source of parts) {
    const here = rel(source.fileName)
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        const word = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 ? 'const' : (statement.declarationList.flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var'
        for (const declaration of statement.declarationList.declarations) {
          tally.bindings++
          const name = declaration.name.getText(source)
          const type = checker.getTypeAtLocation(declaration.name)
          const init = declaration.initializer
          const frozen = init !== undefined && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && ts.isIdentifier(init.expression.expression) && init.expression.expression.text === 'Object' && init.expression.name.text === 'freeze'
          const still = plain(type) || checker.getNonNullableType(type).getCallSignatures().length > 0 || frozen
          if (word !== 'const') found.push({ law: 'state', at: place(declaration), what: `the module-level binding ${name} (${word}) can hold state beside the class: what a part remembers is a private field of its class, where this law reads it; a constant is a const` })
          else if (!still) found.push({ law: 'state', at: place(declaration), what: `the module-level const ${name} holds an object that can change, state beside the class: what a part remembers is a private field of its class; a constant is a plain value, a function or Object.freeze(…)` })
        }
      }
      if (!ts.isClassDeclaration(statement)) continue
      const className = statement.name?.text ?? 'a part'
      for (const member of statement.members) {
        if (!ts.isPropertyDeclaration(member) || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0) continue
        tally.bindings++
        if ((ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Readonly) === 0 || !plain(checker.getTypeAtLocation(member))) found.push({ law: 'state', at: place(member), what: `the static field ${member.name.getText(source)} of ${className} is shared by every connector: a static of a part is a readonly plain value, and what a part remembers is a field of its instance` })
      }
      const maker = statement.members.find(ts.isConstructorDeclaration)
      const taken = maker?.parameters ?? []
      if (maker === undefined || taken.length === 0) continue
      const first = taken[0]!
      const needs = first.type !== undefined && ts.isTypeReferenceNode(first.type) ? (resolved(checker.getSymbolAtLocation(first.type.typeName))?.declarations ?? []).find(ts.isInterfaceDeclaration) : undefined
      if (taken.length !== 1 || first.name.getText(source) !== 'needs' || !ts.isParameterPropertyDeclaration(first, maker) || needs === undefined || needs.getSourceFile() !== source) {
        found.push({ law: 'needs', at: place(maker), what: `${className} takes ${taken.map(parameter => parameter.name.getText(source)).join(', ')} at construction: a part takes one thing, private readonly needs, typed by an interface declared in ${here}, each member a call or a plain value` })
        continue
      }
      for (const member of needs.members) {
        tally.members++
        const name = member.name?.getText(source) ?? 'a member with no name'
        const refuse = (role: string, carried: Carried): void => void found.push({ law: 'needs', at: place(member), what: `the member ${name} of ${needs.name.text} ${role} ${said(carried)}: a part is handed calls that answer plain values, never the connector, another part, or an object that holds another part's state; ask in ${needs.name.text} for the one call the part needs` })
        const signatures = ts.isMethodSignature(member) ? [checker.getSignatureFromDeclaration(member)].filter((s): s is ts.Signature => s !== undefined) : ts.isPropertySignature(member) ? checker.getNonNullableType(checker.getTypeAtLocation(member)).getCallSignatures() : undefined
        if (signatures === undefined) {
          found.push({ law: 'needs', at: place(member), what: `the member ${name} of ${needs.name.text} is neither a call nor a plain value: write it as name(): what it answers` })
          continue
        }
        if (signatures.length === 0) {
          const carried = carriedBy(checker.getTypeAtLocation(member), true)
          if (carried !== undefined) refuse('is', carried)
          continue
        }
        for (const signature of signatures) {
          for (const parameter of signature.getParameters()) {
            const carried = carriedBy(checker.getTypeOfSymbolAtLocation(parameter, member), false)
            if (carried !== undefined) refuse('takes', carried)
          }
          const carried = carriedBy(signature.getReturnType(), true)
          if (carried !== undefined) refuse('answers', carried)
        }
      }
    }
  }

  const partBuilt = (expression: ts.Expression): ts.ClassDeclaration | undefined => (resolved(checker.getSymbolAtLocation(expression))?.declarations ?? []).find((d): d is ts.ClassDeclaration => ts.isClassDeclaration(d) && owners.has(d))
  const visitDoor = (node: ts.Node): void => {
    const built = ts.isNewExpression(node) ? partBuilt(node.expression) : undefined
    if (ts.isNewExpression(node) && built !== undefined) {
      tally.built++
      const name = built.name?.text ?? 'a part'
      const given = node.arguments ?? []
      const literal = given.length === 1 && ts.isObjectLiteralExpression(given[0]!) ? given[0] : undefined
      if (given.length > 0 && literal === undefined) {
        found.push({ law: 'built', at: place(node), what: `${name} is built on ${given.length === 1 ? 'something that is not an object literal' : `${given.length} arguments`}: the door hands a part its needs as one literal, { name: () => … }, a call for each, and never itself or another part` })
      }
      for (const property of literal?.properties ?? []) {
        if (ts.isSpreadAssignment(property)) {
          found.push({ law: 'built', at: place(property), what: `${name} is built on a literal that spreads another object into its needs: write each call out, name: () => …` })
          continue
        }
        const key = property.name?.getText(doorFile) ?? ''
        const signatures = ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property) ? [checker.getSignatureFromDeclaration(property)].filter((s): s is ts.Signature => s !== undefined) : checker.getTypeAtLocation(ts.isPropertyAssignment(property) ? property.initializer : property.name).getCallSignatures()
        const carried = signatures.length > 0 ? signatures.map(signature => carriedBy(signature.getReturnType(), true)).find(c => c !== undefined) : carriedBy(checker.getTypeAtLocation(ts.isPropertyAssignment(property) ? property.initializer : property.name), true)
        if (carried !== undefined) found.push({ law: 'built', at: place(property), what: `the door hands ${name} ${key}, which ${signatures.length > 0 ? 'answers' : 'is'} ${said(carried)}: hand a call that does the one thing and answers a plain value` })
      }
    }
    ts.forEachChild(node, visitDoor)
  }
  visitDoor(doorFile)

  const reached = new Set<string>()
  const follow = (source: ts.SourceFile): void => {
    for (const spec of specifiersOf(source)) {
      const target = targetOf(spec)
      if (target === undefined || !target.startsWith(`${PARTS_DIR}/`) || reached.has(target)) continue
      reached.add(target)
      const next = program.getSourceFile(abs(target))
      if (next !== undefined) follow(next)
    }
  }
  follow(doorFile)
  for (const source of parts) {
    if (!reached.has(rel(source.fileName))) found.push({ law: 'unread', at: `${rel(source.fileName)}:1`, what: `the file stands under ${PARTS_DIR}/ and the door does not import it, itself or through a file of that folder: a part is built by ${DOOR}; build it there or take the file out` })
  }
  for (const source of program.getSourceFiles()) {
    const here = rel(source.fileName)
    if (source.isDeclarationFile || !here.startsWith('src/')) continue
    tally.files++
    if (here === DOOR || here.startsWith(`${PARTS_DIR}/`)) continue
    for (const spec of specifiersOf(source)) {
      if (!spec.text.includes('daemon')) continue
      const target = targetOf(spec)
      if (target !== undefined && target.startsWith(`${PARTS_DIR}/`)) found.push({ law: 'door', at: place(spec), what: `${here} imports ${target}: the parts stand behind one door, ${DOOR}, and no other file of src reaches a part; call the connector, or have the door export what is needed` })
    }
  }
  return found
}

function scriptsOnDisk(): Script[] {
  const out: Script[] = []
  for (const name of readdirSync(abs('scripts'), { recursive: true }) as string[]) {
    const file = `scripts/${slash(name)}`
    if (!/\.(?:[cm]?ts|tsx|[cm]?js)$/.test(file) || file.includes('/node_modules/')) continue
    out.push({ file, text: readFileSync(abs(file), 'utf8') })
  }
  return out
}

function castsIn(scripts: readonly Script[]): Finding[] {
  const found: Finding[] = []
  const names = Object.keys(STEPPED_BY_A_HAND)
  const reached = new Set<string>()
  for (const script of scripts) {
    if (!names.some(name => script.text.includes(name))) continue
    const source = ts.createSourceFile(script.file, script.text, ts.ScriptTarget.ES2022, true, script.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const first = new Map<string, number>()
    const visit = (node: ts.Node): void => {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : (ts.isPropertySignature(node) || ts.isMethodSignature(node)) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
            ? node.name.text
            : undefined
      if (name !== undefined && names.includes(name) && !first.has(name)) first.set(name, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const [name, line] of first) {
      reached.add(`${script.file} ${name}`)
      if (REACHED_THROUGH_A_CAST.some(row => row.script === script.file && row.name === name)) continue
      const hand = STEPPED_BY_A_HAND[name]!
      found.push({ law: 'cast', at: `${script.file}:${line}`, what: `the script reaches ${name} of the connector as a member, through a cast: a proof steps the door by what it hands in at construction; hand in ${hand}, new DaemonSessionConnector(record, { ${hand}: read => { … } }), and call the read it is handed` })
    }
  }
  for (const row of REACHED_THROUGH_A_CAST) {
    if (!reached.has(`${row.script} ${row.name}`)) found.push({ law: 'list', at: SELF, what: `the list of scripts that reach a private name of the door through a cast holds ${row.script} for ${row.name} and the script no longer reaches it: take the row off the list, which only falls` })
  }
  return found
}

const told = (found: readonly Finding[]): string => found.map(f => `\n      ${f.at} ${f.what}`).join('')
const lawsOf = (found: readonly Finding[]): string => [...new Set(found.map(f => f.law))].sort().join(' ')

const tally: Tally = { members: 0, built: 0, bindings: 0, files: 0 }
const onDisk = scriptsOnDisk()
const standing = [...read(estate, 'read', tally), ...castsIn(onDisk)]
const stands = new Set(standing.map(f => `${f.law}\n${f.what}`))
const planted = (program: ts.Program, door: 'read' | 'declarations only' = 'declarations only'): Finding[] => read(program, door).filter(f => !stands.has(`${f.law}\n${f.what}`))

section('§1 the law on planted trees: each plant is refused by its own line')
{
  const [first, second] = Object.values(PARTS) as [{ file: string; type: string }, { file: string; type: string }]
  const firstFile = `${PARTS_DIR}/${first.file}`
  const secondFile = `${PARTS_DIR}/${second.file}`
  const firstPart = classNamed(estate.getSourceFile(abs(firstFile))!, first.type)!
  const firstField = fieldsOf(firstPart)[0]!.name
  const firstNeeds = `${first.type.replace(/Part$/, '')}Needs`
  const secondNeeds = `${second.type.replace(/Part$/, '')}Needs`
  const lineAt = (text: string, position: number): number => text.slice(0, position).split('\n').length
  const intoClass = (name: string, added: string) => (text: string, source: ts.SourceFile): string => {
    const at = classNamed(source, name)!.members.pos
    return `${text.slice(0, at)}${added}${text.slice(at)}`
  }
  const intoNeeds = (name: string, added: string) => (text: string, source: ts.SourceFile): string => {
    const at = interfaceNamed(source, name)!.members.pos
    return `${text.slice(0, at)}${added}${text.slice(at)}`
  }
  const classLine = (file: string, name: string): number => {
    const source = estate.getSourceFile(abs(file))!
    return lineAt(source.text, classNamed(source, name)!.members.pos) + 1
  }
  const needsLine = (file: string, name: string): number => {
    const source = estate.getSourceFile(abs(file))!
    return lineAt(source.text, interfaceNamed(source, name)!.members.pos) + 1
  }
  const only = (found: readonly Finding[], law: Law, at: string, word: string): boolean => {
    const mine = found.filter(f => f.law === law)
    return mine.length === 1 && mine[0]!.at === at && mine[0]!.what.includes(word)
  }

  const fieldAdded = planted(programWith({ [DOOR]: intoClass('DaemonSessionConnector', '\n  private plantedByTheLaw = 0') }))
  check('a field added to DaemonSessionConnector is refused by its name and line', lawsOf(fieldAdded) === 'field' && only(fieldAdded, 'field', `${DOOR}:${classLine(DOOR, 'DaemonSessionConnector')}`, 'plantedByTheLaw'), told(fieldAdded))

  const accessorAdded = planted(programWith({ [DOOR]: intoClass('DaemonSessionConnector', '\n  private get plantedByTheLaw(): number {\n    return 0\n  }') }))
  check('an accessor added to DaemonSessionConnector for a name no proof reaches is refused by its name and line', lawsOf(accessorAdded) === 'accessor' && only(accessorAdded, 'accessor', `${DOOR}:${classLine(DOOR, 'DaemonSessionConnector')}`, 'plantedByTheLaw'), told(accessorAdded))

  const chain = layersUnder(estate, classNamed(estate.getSourceFile(abs(DOOR))!, 'DaemonSessionConnector')!)
  if (chain.layers.length === 0) check('the class stands alone: no layer stands under it to plant in', chain.unread === undefined)
  for (const layer of chain.layers) {
    const name = layer.name!.text
    const file = rel(layer.getSourceFile().fileName)
    const fieldInLayer = planted(programWith({ [file]: intoClass(name, '\n  private plantedByTheLaw = 0') }))
    check(`a field with an initialiser added to the layer ${name} under the class is refused by the layer, its name and its line`, lawsOf(fieldInLayer) === 'layer' && only(fieldInLayer, 'layer', `${file}:${classLine(file, name)}`, 'plantedByTheLaw') && fieldInLayer[0]!.what.includes(`the layer ${name} `), told(fieldInLayer))
  }
  const deepest = chain.layers.at(-1)
  if (deepest !== undefined) {
    const name = deepest.name!.text
    const file = rel(deepest.getSourceFile().fileName)
    const at = `${file}:${classLine(file, name)}`
    const makerInLayer = planted(programWith({ [file]: intoClass(name, '\n  constructor() {}') }))
    check(`…and so is a constructor (${name})`, lawsOf(makerInLayer) === 'layer' && only(makerInLayer, 'layer', at, 'a constructor'), told(makerInLayer))
    const bareInLayer = planted(programWith({ [file]: intoClass(name, '\n  protected plantedByTheLaw: number | undefined') }))
    check('…and a property that is not abstract, with no initialiser', lawsOf(bareInLayer) === 'layer' && only(bareInLayer, 'layer', at, 'the property plantedByTheLaw, which is not abstract'), told(bareInLayer))
    const accessorInLayer = planted(programWith({ [file]: intoClass(name, '\n  protected get plantedByTheLaw(): number {\n    return 0\n  }') }))
    check('…and an accessor', lawsOf(accessorInLayer) === 'layer' && only(accessorInLayer, 'layer', at, 'plantedByTheLaw, which is neither a method nor the abstract declaration of a field'), told(accessorInLayer))
    const lawfulInLayer = planted(programWith({ [file]: intoClass(name, '\n  protected abstract readonly plantedByTheLaw: number\n  plantedCall(): number {\n    return this.plantedByTheLaw\n  }') }))
    check('a layer that gains an abstract declaration and a method passes', lawfulInLayer.length === 0, told(lawfulInLayer))
  }

  const importsDoor = planted(programWith({ [firstFile]: text => `import type { DaemonSessionRecordV1 } from '../daemonConnector.js'\nexport type PlantedByTheLaw = DaemonSessionRecordV1\n${text}` }))
  check('a part that imports the door is refused at the import', only(importsDoor, 'import', `${firstFile}:1`, 'imports the door') && lawsOf(importsDoor) === 'import names', told(importsDoor))

  const through = planted(programWith({ [firstFile]: text => `import type { DaemonSessionConnector } from '../plantedByTheLaw.js'\nexport type PlantedByTheLaw = DaemonSessionConnector\n${text}` }, { [`${FOLDER}/plantedByTheLaw.ts`]: `export type { DaemonSessionConnector } from './daemonConnector.js'\n` }))
  check('…and so is a part that names what the door declares through a file that exports it again', lawsOf(through) === 'names' && through.some(f => f.at === `${firstFile}:1` && f.what.includes('DaemonSessionConnector') && f.what.includes('which the door declares')), told(through))

  const peek = (how: string): Finding[] => planted(programWith({ [secondFile]: intoClass(second.type, `\n  plantedPeek(other: import('./${first.file.replace(/\.ts$/, '.js')}').${first.type}): unknown {\n    return ${how}\n  }`) }))
  const peekLine = `${secondFile}:${classLine(secondFile, second.type) + 1}`
  const dotted = peek(`other.${firstField}`)
  check(`a part that reads another part's field with a dot is refused at the line (${firstField} of ${first.type})`, only(dotted, 'reach', peekLine, firstField) && lawsOf(dotted) === 'names reach', told(dotted))
  const bracketed = peek(`other['${firstField}']`)
  check('…and through brackets, where the compiler lets a private name pass', only(bracketed, 'reach', peekLine, firstField) && lawsOf(bracketed) === 'names reach', told(bracketed))
  const handed = planted(programWith({ [firstFile]: intoClass(first.type, `\n  plantedCall(): unknown {\n    return this.needs\n  }`) }))
  check('a part that uses what it was handed passes', handed.length === 0, told(handed))

  const open = planted(programWith({ [firstFile]: intoClass(first.type, '\n  plantedShown = 0') }))
  check('a part with a field that is not private is refused', lawsOf(open) === 'private' && only(open, 'private', `${firstFile}:${classLine(firstFile, first.type)}`, 'plantedShown'), told(open))

  const doorReads = planted(programWith({ [DOOR]: intoClass('DaemonSessionConnector', `\n  plantedPeek(): unknown {\n    return this.${Object.keys(PARTS)[0]}['${firstField}']\n  }`) }), 'read')
  check("the door that reads a part's field is refused", lawsOf(doorReads) === 'reach' && only(doorReads, 'reach', `${DOOR}:${classLine(DOOR, 'DaemonSessionConnector') + 1}`, firstField), told(doorReads))

  const doorSource = estate.getSourceFile(abs(DOOR))!
  let builtAt: ts.NewExpression | undefined
  const findBuilt = (node: ts.Node): void => {
    if (builtAt === undefined && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === first.type) builtAt = node
    ts.forEachChild(node, findBuilt)
  }
  findBuilt(doorSource)
  const builtLine = builtAt === undefined ? 0 : lineAt(doorSource.text, builtAt.getStart(doorSource))
  const whole = planted(programWith({ [DOOR]: text => (builtAt?.arguments?.[0] === undefined ? text : `${text.slice(0, builtAt.arguments[0].getStart(doorSource))}this as never${text.slice(builtAt.arguments[0].getEnd())}`) }))
  check(`the door handed whole to a part as its needs is refused where the part is built (${first.type})`, lawsOf(whole) === 'built' && only(whole, 'built', `${DOOR}:${builtLine}`, 'not an object literal'), told(whole))

  const peer = planted(programWith({ [secondFile]: intoNeeds(secondNeeds, `\n  plantedPeer(): import('./${first.file.replace(/\.ts$/, '.js')}').${first.type}`) }))
  check(`a part handed another part is refused at the member of its needs (${first.type} in ${secondNeeds})`, only(peer, 'needs', `${secondFile}:${needsLine(secondFile, secondNeeds)}`, `${first.type}, a class of ${FOLDER}/`) && lawsOf(peer) === 'names needs', told(peer))

  const store = planted(programWith({ [firstFile]: intoNeeds(firstNeeds, '\n  plantedStore(): { update(f: (current: string | null) => string | null): void }') }))
  check("a part handed an object that holds another part's state is refused at the member of its needs", lawsOf(store) === 'needs' && only(store, 'needs', `${firstFile}:${needsLine(firstFile, firstNeeds)}`, 'carries a call of its own (update)'), told(store))

  const second_door = `${FOLDER}/plantedByTheLaw.ts`
  const twoDoors = planted(programWith({}, { [second_door]: `import { ${first.type} } from './daemon/${first.file.replace(/\.ts$/, '.js')}'\nexport const plantedByTheLaw = (needs: ConstructorParameters<typeof ${first.type}>[0]): ${first.type} => new ${first.type}(needs)\n` }))
  check('a second door, a file of src outside the folder that imports a part, is refused at its import', lawsOf(twoDoors) === 'door' && only(twoDoors, 'door', `${second_door}:1`, 'one door'), told(twoDoors))

  const orphan = `${PARTS_DIR}/plantedByTheLaw.ts`
  const unread = planted(programWith({}, { [orphan]: `import { ${first.type} } from './${first.file.replace(/\.ts$/, '.js')}'\n\nexport class PlantedPart {\n  shown = 0\n  constructor(private readonly other: ${first.type}) {}\n  peek(): unknown {\n    return this.other['${firstField}']\n  }\n}\n` }))
  check('a file under the folder that the door does not import is read all the same, and refused for standing there', only(unread, 'unread', `${orphan}:1`, 'the door does not import it') && only(unread, 'private', `${orphan}:4`, 'shown') && only(unread, 'reach', `${orphan}:7`, firstField) && lawsOf(unread) === 'names needs private reach unread', told(unread))

  const state = planted(programWith({ [firstFile]: text => `let plantedByTheLaw: unknown = null\nexport const plantedSet = (value: unknown): void => void (plantedByTheLaw = value)\nconst plantedKept = new Map<string, number>()\nexport const plantedKeep = (key: string): void => void plantedKept.set(key, 1)\n${text}` }))
  check('state kept beside the class in a part file, a let or a const that holds a collection, is refused by its line', lawsOf(state) === 'state' && state.length === 2 && state[0]!.at === `${firstFile}:1` && state[0]!.what.includes('plantedByTheLaw (let)') && state[1]!.at === `${firstFile}:3` && state[1]!.what.includes('plantedKept'), told(state))
  const shared = planted(programWith({ [firstFile]: intoClass(first.type, '\n  private static plantedCount = 0') }))
  check('…and so is a static field a part could count in', lawsOf(shared) === 'state' && only(shared, 'state', `${firstFile}:${classLine(firstFile, first.type)}`, 'plantedCount'), told(shared))

  const plantedScript = 'scripts/engine-connector/prove-planted-by-the-law.ts'
  const fresh = (found: readonly Finding[]): Finding[] => found.filter(f => !stands.has(`${f.law}\n${f.what}`))
  const called = fresh(castsIn([...onDisk, { file: plantedScript, text: 'const door = {} as unknown\n;(door as { readFacts(): void }).readFacts()\n' }]))
  check('a script that calls the facts read of a connector through a cast is refused by its line, with the hand to take', lawsOf(called) === 'cast' && only(called, 'cast', `${plantedScript}:2`, 'hand in factsRead'), told(called))
  const keyed = fresh(castsIn([...onDisk, { file: plantedScript, text: "const door: any = {}\n\ndoor['readFacts']()\n" }]))
  check('…and so is one that reaches it through brackets', lawsOf(keyed) === 'cast' && only(keyed, 'cast', `${plantedScript}:3`, 'hand in factsRead'), told(keyed))
  const own = fresh(castsIn([...onDisk, { file: plantedScript, text: 'const readFacts = (): number => 1\nreadFacts()\n' }]))
  check('a script that calls a function of its own under that name passes', own.length === 0, told(own))
  const listed = REACHED_THROUGH_A_CAST[0]
  const let_go = listed === undefined ? [] : fresh(castsIn(onDisk.map(script => (script.file === listed.script ? { file: script.file, text: '' } : script))))
  check('a listed script that no longer reaches the name is told to leave the list', listed === undefined || (lawsOf(let_go) === 'list' && let_go.length === 1 && let_go[0]!.what.includes(listed.script)), told(let_go))
}

section('§2 the estate: the class holds the parts and what the door needs; the parts stand behind the one door and hold what they were handed')
{
  const found = standing
  const door = estate.getSourceFile(abs(DOOR))!
  const connector = classNamed(door, 'DaemonSessionConnector')!
  const declared = fieldsOf(connector)
  const awaiting = Object.values(AWAITING_THEIR_PART).flat().length
  const by = (law: Law): Finding[] => found.filter(f => f.law === law)
  check(`no field is declared on DaemonSessionConnector beyond the list (${declared.length} with the record and the hands its constructor holds: ${Object.keys(PARTS).length} parts, ${OF_THE_DOOR.length} of the door, ${awaiting} awaiting their part)`, by('field').length === 0, told(by('field')))
  check('the list holds no field the class has let go, and each part is the class its file declares', by('list').length === 0, told(by('list')))
  check(`the class declares an accessor only for a name a proof reaches through a cast (${REACHED_BY_PROOFS.length}: ${REACHED_BY_PROOFS.join(', ') || 'none'})`, by('accessor').length === 0, told(by('accessor')))
  const chain = layersUnder(estate, connector)
  const declaredAbstract = chain.layers.reduce((n, layer) => n + layer.members.filter(ts.isPropertyDeclaration).length, 0)
  check(`the layers under the class hold methods and abstract declarations alone: no field with an initialiser, no constructor, no property that is not abstract (${chain.layers.length} layers: ${chain.layers.map(layer => layer.name?.text).join(', ') || 'none'}; ${declaredAbstract} abstract declarations read)`, by('layer').length === 0, told(by('layer')))
  check(`no file under ${PARTS_DIR}/ imports the door (${partFiles(estate).length} files read)`, by('import').length === 0, told(by('import')))
  check(`no file under ${PARTS_DIR}/ names what the door declares, or a class another file of ${FOLDER}/ declares`, by('names').length === 0, told(by('names')))
  check("no part reads a field of another part, and the door reads no part's field", by('reach').length === 0, told(by('reach')))
  check('every field of a part is private', by('private').length === 0, told(by('private')))
  check(`every part takes its needs as an interface of its own file, each member a call or a plain value and none a class of ${FOLDER}/ (${tally.members} members read)`, by('needs').length === 0 && tally.members > 0, told(by('needs')))
  check(`the door builds each part on one literal of calls that answer plain values (${tally.built} built)`, by('built').length === 0 && tally.built === Object.keys(PARTS).length, `${tally.built === Object.keys(PARTS).length ? '' : `${tally.built} parts are built in ${DOOR} where the list PARTS of ${SELF} holds ${Object.keys(PARTS).length}: the door builds each part once`}${told(by('built'))}`)
  check(`one door: no file of src outside ${PARTS_DIR}/ but the door imports a part (${tally.files} files of src read)`, by('door').length === 0 && tally.files > 0, told(by('door')))
  check(`every file under ${PARTS_DIR}/ is imported by the door, itself or through a file of that folder (${partFiles(estate).length} files)`, by('unread').length === 0, told(by('unread')))
  check(`no file under ${PARTS_DIR}/ keeps state beside its class (${tally.bindings} module-level bindings and statics read)`, by('state').length === 0, told(by('state')))
  check(`no script reaches a read of the door through a cast but the listed (${onDisk.length} scripts read; ${REACHED_THROUGH_A_CAST.length} listed: ${REACHED_THROUGH_A_CAST.map(row => `${row.script} reaches ${row.name}, ${row.reason}`).join(' · ') || 'none'})`, by('cast').length === 0 && onDisk.length > 0, told(by('cast')))
  const classes = [connector, ...chain.layers]
  const methods = classes.flatMap(one => one.members.filter(ts.isMethodDeclaration))
  const privates = methods.filter(method => (ts.getCombinedModifierFlags(method) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0).length
  const lines = (n: ts.Node, source: ts.SourceFile): number => source.getLineAndCharacterOfPosition(n.getEnd()).line - source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1
  console.log(`  the door: ${connector.members.filter(ts.isPropertyDeclaration).length} fields declared in the class body · ${methods.length} methods in the chain (${classes.map(one => `${one.name?.text} ${one.members.filter(ts.isMethodDeclaration).length}`).join(', ')}; ${privates} not public) · the class ${lines(connector, door)} lines${chain.layers.map(layer => `, ${layer.name?.text} ${lines(layer, layer.getSourceFile())}`).join('')} · the file ${door.getLineAndCharacterOfPosition(door.getEnd()).line} lines`)
  for (const source of partFiles(estate)) {
    source.forEachChild(node => {
      if (ts.isClassDeclaration(node)) console.log(`  ${rel(source.fileName)}: ${node.name?.text} · ${fieldsOf(node).length} fields · ${node.members.filter(ts.isMethodDeclaration).length} methods · ${source.getLineAndCharacterOfPosition(source.getEnd()).line} lines`)
    })
  }
}

console.log(failures === 0 ? '\nprove-connector-parts-law: the law holds' : `\nprove-connector-parts-law: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
