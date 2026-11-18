#!/usr/bin/env bun
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..', '..')
const DOOR = 'src/services/engine-connector/daemonConnector.ts'
const PARTS_DIR = 'src/services/engine-connector/daemon'
const SELF = 'scripts/engine-connector/prove-connector-parts-law.ts'

const PARTS: Readonly<Record<string, { file: string; type: string }>> = {
  completion: { file: 'completion.ts', type: 'CompletionPart' },
}

const OF_THE_DOOR: readonly string[] = ['carrier', 'record', 'attached', 'factsFeed', 'asksFeed', 'tailFeed', 'progressFeed', 'turnInFlight', 'verbChain']

const AWAITING_THEIR_PART: Readonly<Record<string, readonly string[]>> = {
  fold: ['liveFoldStatus', 'foldExitLatch', 'foldLatchTimer', 'foldLingerTimer', 'foldLingerOver', 'foldListeners'],
  work: ['workListeners', 'workSnapshot', 'workStamp', 'checkpointListeners', 'checkpointSnapshot', 'checkpointStamp'],
  asks: ['askEntries', 'confirms', 'askListeners'],
  admission: ['admission', 'refusedAdmission', 'awaitingRunnerFacts', 'openedAtMs', 'startShownSinceMs', 'seedFactsAtMs'],
  tail: ['tailStore', 'tailAtMs', 'tailMessageId', 'interruptedMessageId', 'withdrawnMessageId', 'tailSeq', 'tailSinceMs', 'textRows', 'arrivalSeq'],
  live: ['effectiveLive', 'liveListeners', 'liveTurnChars', 'liveTurnOutputTokens', 'liveTurnThinkingChars', 'liveTurnThinkingBlocks', 'liveFirstByteAtMs', 'liveStateWord', 'liveAgentsWaiting', 'liveWait', 'liveWaitOwnAge', 'lastEventAtMs', 'streamBlock', 'blockSinceMs', 'toolBudgets', 'livenessTicker', 'interrupting', 'interruptPressedAtMs', 'hardStopping', 'progressAtMs', 'publishedProgressSeqs'],
  facts: ['facts', 'factsBusy', 'busyStallDeadline', 'BUSY_STALL_MS', 'carrierGoneTicks', 'carrierGoneAtFactsMs', 'carrierProbeInFlight', 'carrierSeen', 'CARRIER_GONE_TICKS', 'modelListeners', 'permissionListeners'],
  sends: ['sends', 'echoRows', 'deliveredNotices', 'sendSeq', 'textRetiredRowUuids', 'retainedSend', 'runnerGeneration', 'lostLineNotice', 'settleWaiters'],
  transcript: ['rawRecords', 'recordSigs', 'painted', 'keptRecords', 'answeredRows', 'liveState', 'displayRows', 'clearModelReceipt', 'rowsAfterTail', 'lastSize', 'lastLen', 'transcriptUnreadableFp', 'chainCursor', 'liveFold', 'releaseTranscript', 'transcriptWatcher', 'transcriptTimer', 'transcriptTimerMs', 'tickInFlight', 'tickDirty', 'transcriptPath', 'recordListeners'],
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const slash = (p: string): string => p.split('\\').join('/')
const rel = (file: string): string => slash(relative(ROOT, file))
const abs = (file: string): string => join(ROOT, file)

type Finding = { law: 'field' | 'import' | 'reach' | 'list' | 'private'; at: string; what: string }
type Planted = Readonly<Record<string, (text: string, source: ts.SourceFile) => string>>

const options: ts.CompilerOptions = { ...ts.parseJsonConfigFileContent(ts.readConfigFile(abs('tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT).options, noEmit: true }
const roots = (extra: readonly string[] = []): string[] => [abs(DOOR), ...extra.map(abs)]
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

function read(program: ts.Program, door: 'read' | 'declarations only' = 'declarations only'): Finding[] {
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
  for (const [name, part] of Object.entries(PARTS)) {
    const field = connector.members.find(member => ts.isPropertyDeclaration(member) && member.name.getText(doorFile) === name)
    const type = field === undefined ? undefined : checker.getTypeAtLocation(field)
    const declaration = type?.getSymbol()?.declarations?.[0]
    const from = declaration === undefined ? '' : rel(declaration.getSourceFile().fileName)
    if (type?.getSymbol()?.name !== part.type || from !== `${PARTS_DIR}/${part.file}`) found.push({ law: 'list', at: DOOR, what: `the field ${name} is not the part ${part.type} of ${PARTS_DIR}/${part.file}` })
  }

  const owners = new Map<ts.ClassDeclaration, string>()
  for (const source of partFiles(program)) {
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
  const readers = door === 'read' ? [...partFiles(program), doorFile] : partFiles(program)
  for (const source of readers) {
    const here = rel(source.fileName)
    const at = (n: ts.Node): string => `${here}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) || ts.isImportTypeNode(node)) {
        const spec = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isImportTypeNode(node) ? (ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined) : node.arguments[0]
        if (here !== DOOR && spec !== undefined && ts.isStringLiteralLike(spec)) {
          const target = ts.resolveModuleName(spec.text, source.fileName, options, ts.sys).resolvedModule?.resolvedFileName
          if (target !== undefined && rel(target) === DOOR) found.push({ law: 'import', at: at(node), what: `a file under ${PARTS_DIR}/ imports the door: a part is handed what it needs at construction and never holds the connector` })
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
  return found
}

const told = (found: readonly Finding[]): string => found.map(f => `\n      ${f.at} ${f.what}`).join('')

section('§1 the law on planted trees: a field added to the class, a part that imports the door, a part that reads another part')
{
  const first = Object.values(PARTS)[0]!
  const firstFile = `${PARTS_DIR}/${first.file}`
  const firstPart = classNamed(estate.getSourceFile(abs(firstFile))!, first.type)!
  const firstField = fieldsOf(firstPart)[0]!.name
  const afterBrace = (text: string, source: ts.SourceFile, name: string): number => {
    const node = classNamed(source, name)!
    return node.members.pos
  }
  const fieldAdded = read(programWith({ [DOOR]: (text, source) => `${text.slice(0, afterBrace(text, source, 'DaemonSessionConnector'))}\n  private plantedByTheLaw = 0${text.slice(afterBrace(text, source, 'DaemonSessionConnector'))}` }))
  check('a field added to DaemonSessionConnector is refused by its name and line', fieldAdded.length === 1 && fieldAdded[0]!.law === 'field' && fieldAdded[0]!.what.includes('plantedByTheLaw') && fieldAdded[0]!.at.startsWith(`${DOOR}:`), told(fieldAdded))

  const importsDoor = read(programWith({ [firstFile]: text => `import type { DaemonSessionRecordV1 } from '../daemonConnector.js'\nexport type PlantedByTheLaw = DaemonSessionRecordV1\n${text}` }))
  check('a part that imports the door is refused at the import', importsDoor.length === 1 && importsDoor[0]!.law === 'import' && importsDoor[0]!.at === `${firstFile}:1`, told(importsDoor))

  const neighbour = `${PARTS_DIR}/plantedByTheLaw.ts`
  const reads = (how: string): Finding[] => read(programWith({}, { [neighbour]: `import { ${first.type} } from './${first.file.replace(/\.ts$/, '.js')}'\nexport class PlantedPart {\n  constructor(private readonly other: ${first.type}) {}\n  peek(): unknown {\n    return ${how}\n  }\n}\n` }))
  const dotted = reads(`this.other.${firstField}`)
  check(`a part that reads another part's field with a dot is refused at the line (${firstField} of ${first.type})`, dotted.length === 1 && dotted[0]!.law === 'reach' && dotted[0]!.at === `${neighbour}:5` && dotted[0]!.what.includes(firstField), told(dotted))
  const bracketed = reads(`this.other['${firstField}']`)
  check('…and through brackets, where the compiler lets a private name pass', bracketed.length === 1 && bracketed[0]!.law === 'reach' && bracketed[0]!.at === `${neighbour}:5`, told(bracketed))
  const handed = read(programWith({}, { [neighbour]: `export class PlantedPart {\n  constructor(private readonly needs: { busy(): boolean }) {}\n  peek(): boolean {\n    return this.needs.busy()\n  }\n}\n` }))
  check('a part that calls what it was handed passes', handed.length === 0, told(handed))

  const open = read(programWith({}, { [neighbour]: `export class PlantedPart {\n  shown = 0\n}\n` }))
  check('a part with a field that is not private is refused', open.length === 1 && open[0]!.law === 'private' && open[0]!.at === `${neighbour}:2`, told(open))

  const doorReads = read(programWith({ [DOOR]: (text, source) => `${text.slice(0, afterBrace(text, source, 'DaemonSessionConnector'))}\n  plantedPeek(): unknown {\n    return this.${Object.keys(PARTS)[0]}['${firstField}']\n  }${text.slice(afterBrace(text, source, 'DaemonSessionConnector'))}` }), 'read')
  check("the door that reads a part's field is refused", doorReads.length === 1 && doorReads[0]!.law === 'reach' && doorReads[0]!.what.includes(firstField), told(doorReads))
}

section('§2 the estate: the class holds the parts and what the door needs; no part imports the door or reads another part')
{
  const found = read(estate, 'read')
  const door = estate.getSourceFile(abs(DOOR))!
  const connector = classNamed(door, 'DaemonSessionConnector')!
  const declared = fieldsOf(connector)
  const awaiting = Object.values(AWAITING_THEIR_PART).flat().length
  const by = (law: Finding['law']): Finding[] => found.filter(f => f.law === law)
  check(`no field is declared on DaemonSessionConnector beyond the list (${declared.length} with the record its constructor holds: ${Object.keys(PARTS).length} parts, ${OF_THE_DOOR.length} of the door, ${awaiting} awaiting their part)`, by('field').length === 0, told(by('field')))
  check('the list holds no field the class has let go, and each part is the class its file declares', by('list').length === 0, told(by('list')))
  check(`no file under ${PARTS_DIR}/ imports the door (${partFiles(estate).length} files read)`, by('import').length === 0, told(by('import')))
  check("no part reads a field of another part, and the door reads no part's field", by('reach').length === 0, told(by('reach')))
  check('every field of a part is private', by('private').length === 0, told(by('private')))
  const methods = connector.members.filter(ts.isMethodDeclaration)
  const privates = methods.filter(method => (ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Private) !== 0).length
  const lines = (n: ts.Node, source: ts.SourceFile): number => source.getLineAndCharacterOfPosition(n.getEnd()).line - source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1
  console.log(`  the door: ${declared.length - 1} fields declared in the class body · ${methods.length} methods (${privates} private) · the class ${lines(connector, door)} lines · the file ${door.getLineAndCharacterOfPosition(door.getEnd()).line} lines`)
  for (const source of partFiles(estate)) {
    source.forEachChild(node => {
      if (ts.isClassDeclaration(node)) console.log(`  ${rel(source.fileName)}: ${node.name?.text} · ${fieldsOf(node).length} fields · ${node.members.filter(ts.isMethodDeclaration).length} methods · ${source.getLineAndCharacterOfPosition(source.getEnd()).line} lines`)
    })
  }
}

console.log(failures === 0 ? '\nprove-connector-parts-law: the law holds' : `\nprove-connector-parts-law: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
