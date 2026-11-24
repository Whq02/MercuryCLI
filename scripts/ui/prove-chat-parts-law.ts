#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

const SELF = 'scripts/ui/prove-chat-parts-law.ts'
const DOOR = 'src/screen/chat/Chat.tsx'
const PARTS = 'src/screen/chat/'
const NOT_PARTS = [
  DOOR,
  'src/screen/chat/CrashResumeDialog.tsx',
  'src/screen/chat/CrewmateTranscript.tsx',
  'src/screen/chat/MercuryTurnRollup.tsx',
  'src/screen/chat/ResumeSession.tsx',
  'src/screen/chat/SwitchboardTagBar.tsx',
  'src/screen/chat/exportRenderer.tsx',
  'src/screen/chat/interruptKeys.ts',
  'src/screen/chat/messagePredicates.ts',
  'src/screen/chat/submitTrace.ts',
  'src/screen/chat/toolJsxArbitration.ts',
  'src/screen/chat/useAuthWallHold.ts',
  'src/screen/chat/useCommandKeybindings.tsx',
  'src/screen/chat/useFinishMarks.ts',
  'src/screen/chat/useGlobalKeybindings.tsx',
  'src/screen/chat/useSessionTitleMint.ts',
  'src/screen/chat/useTurnEndPing.ts',
]
const isPart = (file: string): boolean => file.startsWith(PARTS) && !NOT_PARTS.includes(file)
const UNIT = 'Chat'
const DOOR_EXPORTS = ['Chat', 'Props', 'Screen']

const HOOK_CALLS_IN_CHAT: Record<string, number> = {
  useEffect: 1,
  useRef: 3,
  useState: 3,
  useSyncExternalStore: 6,
  useAppState: 6,
  useAppStateStore: 1,
  useSetAppState: 1,
  useNotifications: 1,
  useTerminalSize: 1,
  useLayoutChrome: 1,
  useCompactWorkControls: 1,
  useMercuryTokens: 1,
  useTheme: 1,
  useEngineModel: 1,
  useFocusedTranscript: 1,
  useFocusedTailAnchor: 1,
  useMcpConnectionNotices: 1,
  useMergedCommands: 1,
  useMergedTools: 1,
  useApiKeyVerification: 1,
  useAgentNeedsYou: 1,
  useTurnEndPing: 1,
}

type Edge = { from: string; to: string; line: number; spec: string }
type HookCall = { name: string; line: number }
type Exported = { name: string; line: number }
type Guarded = { file: string; line: number; hook: string; under: string }
type Reading = { files: number; edges: Edge[]; hooks: HookCall[] | null; exported: Exported[] | null; guarded: Guarded[]; parts: string[]; partNames: string[] }
type Fault = { law: string; where: string; fix: string }

const slash = (path: string): string => path.split('\\').join('/')
const CODE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function readTree(root: string): Reading {
  const listed = ts.sys.readDirectory(join(root, 'src'), CODE, undefined, undefined).map(file => slash(relative(root, file)))
  const known = new Set(listed)
  const program = ts.createProgram(
    listed.map(file => join(root, file)),
    { allowJs: true, noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, skipLibCheck: true, noEmit: true },
  )
  const resolveSpec = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = posix.normalize(posix.join(posix.dirname(from), spec))
    const tries = [base, base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'), ...CODE.map(end => base + end), ...CODE.map(end => `${base}/index${end}`)]
    return tries.find(candidate => known.has(candidate)) ?? null
  }
  const edges: Edge[] = []
  let hooks: HookCall[] | null = null
  let exported: Exported[] | null = null
  const guarded: Guarded[] = []
  const partNames: string[] = []
  const isFunction = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  for (const sf of program.getSourceFiles()) {
    const rel = slash(relative(root, sf.fileName))
    if (!known.has(rel)) continue
    const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    const note = (spec: ts.Expression | undefined, at: ts.Node): void => {
      if (!spec || !ts.isStringLiteralLike(spec)) return
      const to = resolveSpec(rel, spec.text)
      if (to !== null) edges.push({ from: rel, to, line: lineOf(at), spec: spec.text })
    }
    const walk = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) note(node.moduleSpecifier, node)
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) note(node.arguments[0], node)
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) note(node.argument.literal as ts.Expression, node)
      ts.forEachChild(node, walk)
    }
    walk(sf)
    if (rel === DOOR || isPart(rel)) {
      const nameOf = (fn: ts.Node, holder: ts.Node | undefined): string => {
        if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) if (fn.name) return fn.name.getText(sf)
        return holder && ts.isVariableDeclaration(holder) ? holder.name.getText(sf) : ''
      }
      const returnsEarly = (node: ts.Node): boolean => {
        if (ts.isReturnStatement(node)) return true
        if (isFunction(node)) return false
        return ts.forEachChild(node, returnsEarly) === true
      }
      const rule = (node: ts.Node, above: ts.Node[]): void => {
        const callee = ts.isCallExpression(node) ? node.expression.getText(sf).replace(/\s+/g, '') : ''
        if (/^(?:React\.)?use[A-Z]\w*$/.test(callee)) {
          let under = ''
          let child: ts.Node = node
          let at = above.length - 1
          for (; at >= 0 && !isFunction(above[at]!); at--) {
            const up = above[at]!
            if (ts.isIfStatement(up) && child !== up.expression) under ||= 'an if'
            else if (ts.isConditionalExpression(up) && child !== up.condition) under ||= 'a ? :'
            else if (ts.isBinaryExpression(up) && child === up.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(up.operatorToken.kind)) under ||= `a ${up.operatorToken.getText(sf)}`
            else if (ts.isIterationStatement(up, false)) under ||= 'a loop'
            else if (ts.isCaseClause(up) || ts.isDefaultClause(up)) under ||= 'a switch'
            else if (ts.isCatchClause(up)) under ||= 'a catch'
            else if (ts.isBlock(up) && at > 0 && isFunction(above[at - 1]!) && up.statements.slice(0, up.statements.indexOf(child as ts.Statement)).some(returnsEarly)) under ||= 'an early return'
            child = up
          }
          if (under === '' && at >= 0 && !/^(?:use[A-Z]|[A-Z])/.test(nameOf(above[at]!, above[at - 1]))) under = 'a nested function'
          if (under !== '') guarded.push({ file: rel, line: lineOf(node), hook: callee.replace(/^React\./, ''), under })
        }
        ts.forEachChild(node, child => rule(child, [...above, node]))
      }
      rule(sf, [])
    }
    if (rel !== DOOR) continue
    exported = []
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
      if (!isPart(resolveSpec(rel, statement.moduleSpecifier.text) ?? '')) continue
      const bindings = statement.importClause?.namedBindings
      if (statement.importClause?.name) partNames.push(statement.importClause.name.text)
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) partNames.push(element.name.text)
    }
    for (const statement of sf.statements) {
      const line = lineOf(statement)
      if (ts.isExportAssignment(statement)) {
        exported.push({ name: 'default', line })
        continue
      }
      if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause
        if (clause === undefined) exported.push({ name: '*', line })
        else if (ts.isNamespaceExport(clause)) exported.push({ name: clause.name.getText(sf), line })
        else for (const element of clause.elements) exported.push({ name: element.name.getText(sf), line })
        continue
      }
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
      if (!modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) exported.push({ name: 'default', line })
      else if (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) exported.push({ name: statement.name?.getText(sf) ?? 'default', line })
      else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) exported.push({ name: declaration.name.getText(sf), line })
      else exported.push({ name: statement.getText(sf).slice(0, 40), line })
    }
    const unit = sf.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === UNIT)
    if (!unit) continue
    hooks = []
    const direct = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf).replace(/\s+/g, '')
        if (/^(?:React\.)?use[A-Z]\w*$/.test(callee)) hooks!.push({ name: callee.replace(/^React\./, ''), line: lineOf(node) })
        ts.forEachChild(node.expression, direct)
        for (const argument of node.arguments) if (!isFunction(argument)) direct(argument)
        return
      }
      if (isFunction(node)) return
      ts.forEachChild(node, direct)
    }
    if (unit.body) for (const statement of unit.body.statements) direct(statement)
  }
  return { files: listed.length, edges, hooks, exported, guarded, parts: listed.filter(isPart).sort(), partNames }
}

function judge(read: Reading, held: Record<string, number>): { faults: Fault[]; slack: string[]; total: number; partCalls: number } {
  const faults: Fault[] = []
  const slack: string[] = []
  for (const edge of read.edges) {
    if (isPart(edge.to) && edge.from !== DOOR && !isPart(edge.from)) {
      faults.push({ law: 'one door', where: `${edge.from}:${edge.line} imports '${edge.spec}'`, fix: `a part of the chat screen is reached through ${DOOR} only: take what ${edge.from} needs from the screen's door, or move it out of ${PARTS} into the folder that owns it` })
    }
    if (isPart(edge.from) && edge.to === DOOR) {
      faults.push({ law: 'no way back', where: `${edge.from}:${edge.line} imports '${edge.spec}'`, fix: `a part never imports the screen: hand ${edge.from} what it needs as a named argument from ${UNIT}, or keep the shared type in a file under ${PARTS}` })
    }
  }
  for (const call of read.guarded) {
    faults.push({ law: 'every render', where: `${call.file}:${call.line} calls ${call.hook} under ${call.under}`, fix: `a hook of the chat screen is called on every render, at the top of the hook or component that owns it: call ${call.hook} above the condition and use its value below it` })
  }
  if (read.hooks === null || read.exported === null) {
    faults.push({ law: 'the door', where: DOOR, fix: `the file must stand and declare the function ${UNIT}` })
    return { faults, slack, total: 0, partCalls: 0 }
  }
  const names = read.exported.map(entry => entry.name)
  const lost = DOOR_EXPORTS.filter(name => !names.includes(name))
  const more = read.exported.filter(entry => !DOOR_EXPORTS.includes(entry.name))
  if (lost.length > 0) faults.push({ law: 'the door', where: `${DOOR} exports ${names.join(', ') || 'nothing'}`, fix: `the door exports ${DOOR_EXPORTS.join(', ')} and nothing else: put back ${lost.join(', ')}` })
  for (const entry of more) {
    faults.push({ law: 'the door', where: `${DOOR}:${entry.line} exports ${entry.name}`, fix: `the door exports ${DOOR_EXPORTS.join(', ')} and nothing else, as a value or as a type, declared or handed on from a part: ${entry.name} stays in its file under ${PARTS}, unexported by the door, and ${UNIT} hands it on by name` })
  }
  const found = new Map<string, number[]>()
  const ofParts = new Map<string, number[]>()
  for (const hook of read.hooks) {
    const into = read.partNames.includes(hook.name) ? ofParts : found
    into.set(hook.name, [...(into.get(hook.name) ?? []), hook.line])
  }
  for (const [name, lines] of ofParts) {
    if (lines.length > 1) faults.push({ law: 'one call a part', where: `${DOOR}: ${UNIT} calls the part ${name} ${lines.length} times (lines ${lines.join(', ')})`, fix: `a part of the chat screen is called once: where its effects must stand on two sides of another part's, it is two hooks in its file under ${PARTS}, each called once` })
  }
  const heldSum = Object.values(held).reduce((sum, count) => sum + count, 0)
  for (const [name, lines] of found) {
    const allowed = held[name] ?? 0
    if (lines.length > allowed) {
      faults.push({
        law: 'the count only falls',
        where: `${DOOR}: ${UNIT} calls ${name} ${lines.length} time${lines.length === 1 ? '' : 's'} (lines ${lines.join(', ')}) and the law holds ${allowed}`,
        fix: `a hook is called in a part under ${PARTS} that owns its state, and ${UNIT} calls the part: move the new ${name} call there; no row of HOOK_CALLS_IN_CHAT in ${SELF} is raised, whatever another row lost, and their sum (${heldSum}) only falls`,
      })
    } else if (lines.length !== allowed) slack.push(`${name}: ${lines.length} in ${UNIT}, ${allowed} held`)
  }
  for (const [name, allowed] of Object.entries(held)) if (!found.has(name) && allowed > 0) slack.push(`${name}: 0 in ${UNIT}, ${allowed} held`)
  return { faults, slack, total: [...found.values()].reduce((sum, lines) => sum + lines.length, 0), partCalls: [...ofParts.values()].reduce((sum, lines) => sum + lines.length, 0) }
}

let failures = 0
let failureHint = ''
function check(label: string, ok: boolean, detail: string[] = []): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) for (const line of detail) console.log(`         ${line}`)
  if (!ok && failureHint !== '') console.log(`         ${failureHint}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
const told = (faults: Fault[], law: string): string[] => faults.filter(fault => fault.law === law).flatMap(fault => [fault.where, `  instead: ${fault.fix}`])

const at = process.argv.indexOf('--root')
const ROOT = at < 0 ? resolve(import.meta.dir, '..', '..') : resolve(process.argv[at + 1] ?? '.')
const heldTotal = Object.values(HOOK_CALLS_IN_CHAT).reduce((sum, count) => sum + count, 0)

section('§0 the reader on a planted estate: each breach is refused by its own line')
failureHint = `the planted estate is read by readTree and judged by judge in ${SELF}: change that reader, not the screen`
{
  const estate = mkdtempSync(join(tmpdir(), 'chat-parts-law-'))
  const plant = (file: string, lines: string[]): void => {
    mkdirSync(dirname(join(estate, file)), { recursive: true })
    writeFileSync(join(estate, file), lines.join('\n') + '\n')
  }
  plant('src/screen/chat/Chat.tsx', ["import { useEffect, useState } from 'react'", "import { usePart } from './usePart.js'", 'export type Screen = 1', 'export type Props = {}', 'export function Chat(): null {', '  const [a] = useState(0)', '  usePart()', '  useEffect(() => {', '    const inner = () => useState(1)', '    void inner', '  }, [a])', '  return null', '}'])
  plant('src/screen/chat/usePart.ts', ["import { useState } from 'react'", "import type { Kind } from './kind.js'", 'export function usePart(): Kind {', '  return useState(0)[0] as Kind', '}'])
  plant('src/screen/chat/kind.ts', ['export type Kind = number'])
  plant('src/components/Elsewhere.tsx', ["import { usePart } from '../screen/chat/usePart.js'", 'export const reach = usePart'])
  plant('src/components/Lazy.ts', ['export async function lazy(): Promise<unknown> {', "  return import('../screen/chat/usePart.js')", '}'])
  plant('src/screen/chat/back.ts', ["import type { Screen } from './Chat.js'", 'export type Back = Screen'])
  const read = readTree(estate)
  const held = { useState: 1, useEffect: 1 }
  const whole = judge(read, held)
  check('the planted screen is read: 3 hook calls written directly in Chat, one of them the call of a part, and the one inside a nested function is not counted', read.hooks?.map(hook => `${hook.name}@${hook.line}`).join(' ') === 'useState@6 usePart@7 useEffect@8' && whole.total === 2 && whole.partCalls === 1 && told(whole.faults, 'the count only falls').length === 0, [...(read.hooks?.map(hook => `${hook.name}@${hook.line}`) ?? []), ...told(whole.faults, 'the count only falls')])
  check(
    'a file outside the screen that imports a part is refused with its line, by a static and by a lazy import',
    told(whole.faults, 'one door').filter(line => !line.startsWith('  instead')).join(' | ') === "src/components/Elsewhere.tsx:1 imports '../screen/chat/usePart.js' | src/components/Lazy.ts:2 imports '../screen/chat/usePart.js'",
    told(whole.faults, 'one door'),
  )
  check('a part that imports the screen is refused with its line', told(whole.faults, 'no way back')[0] === "src/screen/chat/back.ts:1 imports './Chat.js'", told(whole.faults, 'no way back'))
  check('a part that imports another part, and the screen that imports its parts, are let through', !whole.faults.some(fault => (fault.law === 'one door' || fault.law === 'no way back') && (fault.where.startsWith('src/screen/chat/usePart.ts') || fault.where.startsWith('src/screen/chat/Chat.tsx:'))))
  const risen = judge(read, { ...held, useState: 0 })
  check('one hook call more than the law holds is refused with the hook and its line', told(risen.faults, 'the count only falls')[0] === 'src/screen/chat/Chat.tsx: Chat calls useState 1 time (lines 6) and the law holds 0', told(risen.faults, 'the count only falls'))
  const swapped = judge(read, { useState: 0, useEffect: 2 })
  check('a row above its count is refused though another row fell by as much and the sum stands (2 found, 2 held)', swapped.total === 2 && told(swapped.faults, 'the count only falls')[0] === 'src/screen/chat/Chat.tsx: Chat calls useState 1 time (lines 6) and the law holds 0', told(swapped.faults, 'the count only falls'))
  check('a count below the number held passes and is named', judge(read, { ...held, useEffect: 3 }).slack.join() === 'useEffect: 1 in Chat, 3 held' && !judge(read, { ...held, useEffect: 3 }).faults.some(fault => fault.law === 'the count only falls'))
  check('a hook called inside a nested function of the screen is refused with its line', told(whole.faults, 'every render')[0] === 'src/screen/chat/Chat.tsx:9 calls useState under a nested function', told(whole.faults, 'every render'))
  plant('src/screen/chat/useGuarded.ts', ["import { useState } from 'react'", 'export function useGuarded(on: boolean): number {', '  const a = on ? useState(0)[0] : 0', '  if (on) useState(1)', '  const b = on && useState(2)[0]', '  for (const _ of [on]) useState(3)', '  if (!on) return a', '  return useState(4)[0] + Number(b)', '}'])
  check(
    'a hook a part calls under a condition is refused with its line: a ? :, an if, a &&, a loop, an early return',
    told(judge(readTree(estate), held).faults, 'every render').filter(line => line.startsWith('src/screen/chat/') && !line.startsWith('src/screen/chat/Chat.tsx')).join(' | ') === 'src/screen/chat/useGuarded.ts:3 calls useState under a ? : | src/screen/chat/useGuarded.ts:4 calls useState under an if | src/screen/chat/useGuarded.ts:5 calls useState under a && | src/screen/chat/useGuarded.ts:6 calls useState under a loop | src/screen/chat/useGuarded.ts:8 calls useState under an early return',
    told(judge(readTree(estate), held).faults, 'every render'),
  )
  plant('src/screen/chat/Chat.tsx', ["import { usePart } from './usePart.js'", 'export type Screen = 1', 'export type Props = {}', 'export function Chat(): null {', '  usePart()', '  usePart()', '  return null', '}'])
  check('a part called twice is refused with both lines', told(judge(readTree(estate), {}).faults, 'one call a part')[0] === 'src/screen/chat/Chat.tsx: Chat calls the part usePart 2 times (lines 5, 6)', told(judge(readTree(estate), {}).faults, 'one call a part'))
  plant('src/screen/chat/Chat.tsx', ['export function Chat(): null {', '  return null', '}', 'export const leaked = 1'])
  check('a door that loses an export or gains one is refused', told(judge(readTree(estate), {}).faults, 'the door').filter(line => !line.startsWith('  instead')).join(' | ') === 'src/screen/chat/Chat.tsx exports Chat, leaked | src/screen/chat/Chat.tsx:4 exports leaked', told(judge(readTree(estate), {}).faults, 'the door'))
  plant('src/screen/chat/Chat.tsx', ['export type Screen = 1', 'export type Props = {}', 'export function Chat(): null {', '  return null', '}', "export { usePart } from './usePart.js'", "export type { Kind } from './kind.js'", "export * from './kind.js'", 'export default Chat'])
  check(
    "a door that hands on a part's value, a part's type, a whole part or a default is refused, each with its line",
    told(judge(readTree(estate), {}).faults, 'the door').filter(line => !line.startsWith('  instead')).join(' | ') === 'src/screen/chat/Chat.tsx:6 exports usePart | src/screen/chat/Chat.tsx:7 exports Kind | src/screen/chat/Chat.tsx:8 exports * | src/screen/chat/Chat.tsx:9 exports default',
    told(judge(readTree(estate), {}).faults, 'the door'),
  )
  rmSync(estate, { recursive: true, force: true })
}

failureHint = ''
section(`§1 the tree at ${ROOT}`)
const read = readTree(ROOT)
const verdict = judge(read, HOOK_CALLS_IN_CHAT)
check(`no file outside ${DOOR} and ${PARTS} imports a file under ${PARTS} (${read.parts.length} files there, ${read.files} files read under src)`, told(verdict.faults, 'one door').length === 0, told(verdict.faults, 'one door'))
check(`no file under ${PARTS} imports ${DOOR}`, told(verdict.faults, 'no way back').length === 0, told(verdict.faults, 'no way back'))
check(`${DOOR} exports ${DOOR_EXPORTS.join(', ')} and nothing else, by a declaration or by a line that hands a name on`, told(verdict.faults, 'the door').length === 0, told(verdict.faults, 'the door'))
check(`no row of the hook calls written directly in ${UNIT} is above the number the law holds for it (${verdict.total} found, ${heldTotal} held, beside ${verdict.partCalls} calls of parts)`, verdict.total <= heldTotal && told(verdict.faults, 'the count only falls').length === 0, told(verdict.faults, 'the count only falls'))
check(`each part ${UNIT} calls it calls once (${verdict.partCalls} calls of the hooks it imports from ${PARTS})`, told(verdict.faults, 'one call a part').length === 0, told(verdict.faults, 'one call a part'))
check(`every hook call in ${DOOR} and under ${PARTS} runs on every render: none under a condition, a loop, an early return or a nested function`, told(verdict.faults, 'every render').length === 0, told(verdict.faults, 'every render'))
if (verdict.slack.length > 0) console.log(`  the rows differ from the file: ${verdict.slack.join(' · ')} — write them into HOOK_CALLS_IN_CHAT of ${SELF}; no row is raised`)

if (at < 0) {
  section('§2 the door as a running module')
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
  const door = (await import('../../src/screen/chat/Chat.tsx')) as Record<string, unknown>
  check(`${DOOR} loads and its one runtime export is the component ${UNIT}`, Object.keys(door).join() === UNIT && typeof door[UNIT] === 'function', [Object.keys(door).join(', '), `change the runtime exports of ${DOOR} so that only ${UNIT} remains`])
}

console.log(`\n${failures === 0 ? 'prove-chat-parts-law: ALL PASS' : `prove-chat-parts-law: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
