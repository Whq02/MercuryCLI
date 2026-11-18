#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

const SELF = 'scripts/ui/prove-chat-parts-law.ts'
const DOOR = 'src/screens/Chat.tsx'
const PARTS = 'src/screens/chat/'
const UNIT = 'Chat'
const DOOR_EXPORTS = ['Chat', 'Props', 'Screen']

const HOOK_CALLS_IN_CHAT: Record<string, number> = {
  useEffect: 32,
  useRef: 27,
  useCallback: 15,
  useState: 18,
  useSyncExternalStore: 9,
  useAppState: 8,
  useMemo: 6,
  useLayoutEffect: 1,
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
  useMcpConnectivityStatus: 1,
  useMergedCommands: 1,
  useMergedTools: 1,
  useApiKeyVerification: 1,
  useChatDraft: 1,
  useSeatReceipts: 1,
  useAgentNeedsYou: 1,
  useFinishMarks: 1,
  useSessionTitleMint: 1,
  useSettingsChange: 1,
  useAgentsChange: 1,
  useSkillsChange: 1,
  useKickOffCheckAndDisableSovereignIfNeeded: 1,
  useExtensions: 1,
  useCostSummary: 1,
  useFpsMetrics: 1,
  useSettingsErrors: 1,
  useRateLimitWarningNotification: 1,
  useDeprecationWarningNotification: 1,
  useLspInitializationNotification: 1,
  useChatAsks: 1,
  useChatAsksCard: 1,
  useChatTitle: 1,
  useTurnEndPing: 1,
  useChatScrollPin: 1,
  useChatScroll: 1,
  useChatSearch: 1,
  useChatScrollFollow: 1,
  useMessageCursorActive: 1,
  useHoldsEscape: 1,
  useMessageActions: 1,
  useStdin: 1,
}

type Edge = { from: string; to: string; line: number; spec: string }
type HookCall = { name: string; line: number }
type Reading = { files: number; edges: Edge[]; hooks: HookCall[] | null; exported: string[] | null; parts: string[] }
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
  let exported: string[] | null = null
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
    if (rel !== DOOR) continue
    exported = []
    for (const statement of sf.statements) {
      const marked = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      if (!marked) continue
      if (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) exported.push(statement.name?.text ?? 'default')
      else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) exported.push(declaration.name.getText(sf))
      else exported.push(statement.getText(sf).slice(0, 40))
    }
    const unit = sf.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === UNIT)
    if (!unit) continue
    hooks = []
    const isFunction = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
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
  return { files: listed.length, edges, hooks, exported, parts: listed.filter(file => file.startsWith(PARTS)).sort() }
}

function judge(read: Reading, held: Record<string, number>): { faults: Fault[]; slack: string[]; total: number } {
  const faults: Fault[] = []
  const slack: string[] = []
  for (const edge of read.edges) {
    if (edge.to.startsWith(PARTS) && edge.from !== DOOR && !edge.from.startsWith(PARTS)) {
      faults.push({ law: 'one door', where: `${edge.from}:${edge.line} imports '${edge.spec}'`, fix: `a part of the chat screen is reached through ${DOOR} only: take what ${edge.from} needs from the screen's door, or move it out of ${PARTS} into the folder that owns it` })
    }
    if (edge.from.startsWith(PARTS) && edge.to === DOOR) {
      faults.push({ law: 'no way back', where: `${edge.from}:${edge.line} imports '${edge.spec}'`, fix: `a part never imports the screen: hand ${edge.from} what it needs as a named argument from ${UNIT}, or keep the shared type in a file under ${PARTS}` })
    }
  }
  if (read.hooks === null || read.exported === null) {
    faults.push({ law: 'the door', where: DOOR, fix: `the file must stand and declare the function ${UNIT}` })
    return { faults, slack, total: 0 }
  }
  const lost = DOOR_EXPORTS.filter(name => !read.exported!.includes(name))
  const more = read.exported.filter(name => !DOOR_EXPORTS.includes(name))
  if (lost.length > 0 || more.length > 0) {
    faults.push({ law: 'the door', where: `${DOOR} exports ${read.exported.join(', ') || 'nothing'}`, fix: `the door exports ${DOOR_EXPORTS.join(', ')} and nothing else${lost.length > 0 ? `: put back ${lost.join(', ')}` : ''}${more.length > 0 ? `: ${more.join(', ')} belongs in a file under ${PARTS} or stays unexported` : ''}` })
  }
  const found = new Map<string, number[]>()
  for (const hook of read.hooks) found.set(hook.name, [...(found.get(hook.name) ?? []), hook.line])
  const heldSum = Object.values(held).reduce((sum, count) => sum + count, 0)
  const risen = read.hooks.length > heldSum
  for (const [name, lines] of found) {
    const allowed = held[name] ?? 0
    if (lines.length > allowed && risen) {
      faults.push({
        law: 'the count only falls',
        where: `${DOOR}: ${UNIT} calls ${name} ${lines.length} time${lines.length === 1 ? '' : 's'} (lines ${lines.join(', ')}) and the law holds ${allowed}`,
        fix: `a hook is called in a part under ${PARTS} that owns its state, and ${UNIT} calls the part: move the new ${name} call there; the sum of HOOK_CALLS_IN_CHAT in ${SELF} (${heldSum}) is never raised`,
      })
    } else if (lines.length !== allowed) slack.push(`${name}: ${lines.length} in ${UNIT}, ${allowed} held`)
  }
  for (const [name, allowed] of Object.entries(held)) if (!found.has(name) && allowed > 0) slack.push(`${name}: 0 in ${UNIT}, ${allowed} held`)
  return { faults, slack, total: read.hooks.length }
}

let failures = 0
function check(label: string, ok: boolean, detail: string[] = []): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
const told = (faults: Fault[], law: string): string[] => faults.filter(fault => fault.law === law).flatMap(fault => [fault.where, `  instead: ${fault.fix}`])

const at = process.argv.indexOf('--root')
const ROOT = at < 0 ? resolve(import.meta.dir, '..', '..') : resolve(process.argv[at + 1] ?? '.')
const heldTotal = Object.values(HOOK_CALLS_IN_CHAT).reduce((sum, count) => sum + count, 0)

section('§0 the reader on a planted estate: each breach is refused by its own line')
{
  const estate = mkdtempSync(join(tmpdir(), 'chat-parts-law-'))
  const plant = (file: string, lines: string[]): void => {
    mkdirSync(dirname(join(estate, file)), { recursive: true })
    writeFileSync(join(estate, file), lines.join('\n') + '\n')
  }
  plant('src/screens/Chat.tsx', ["import { useEffect, useState } from 'react'", "import { usePart } from './chat/usePart.js'", 'export type Screen = 1', 'export type Props = {}', 'export function Chat(): null {', '  const [a] = useState(0)', '  usePart()', '  useEffect(() => {', '    const inner = () => useState(1)', '    void inner', '  }, [a])', '  return null', '}'])
  plant('src/screens/chat/usePart.ts', ["import { useState } from 'react'", "import type { Kind } from './kind.js'", 'export function usePart(): Kind {', '  return useState(0)[0] as Kind', '}'])
  plant('src/screens/chat/kind.ts', ['export type Kind = number'])
  plant('src/components/Elsewhere.tsx', ["import { usePart } from '../screens/chat/usePart.js'", 'export const reach = usePart'])
  plant('src/components/Lazy.ts', ['export async function lazy(): Promise<unknown> {', "  return import('../screens/chat/usePart.js')", '}'])
  plant('src/screens/chat/back.ts', ["import type { Screen } from '../Chat.js'", 'export type Back = Screen'])
  const read = readTree(estate)
  const held = { useState: 1, usePart: 1, useEffect: 1 }
  const whole = judge(read, held)
  check('the planted screen is read: 3 hook calls written directly in Chat, the one inside a nested function is not counted', read.hooks?.map(hook => `${hook.name}@${hook.line}`).join(' ') === 'useState@6 usePart@7 useEffect@8', read.hooks?.map(hook => `${hook.name}@${hook.line}`) ?? [])
  check(
    'a file outside the screen that imports a part is refused with its line, by a static and by a lazy import',
    told(whole.faults, 'one door').filter(line => !line.startsWith('  instead')).join(' | ') === "src/components/Elsewhere.tsx:1 imports '../screens/chat/usePart.js' | src/components/Lazy.ts:2 imports '../screens/chat/usePart.js'",
    told(whole.faults, 'one door'),
  )
  check('a part that imports the screen is refused with its line', told(whole.faults, 'no way back')[0] === "src/screens/chat/back.ts:1 imports '../Chat.js'", told(whole.faults, 'no way back'))
  check('a part that imports another part, and the screen that imports its parts, are let through', !whole.faults.some(fault => fault.where.startsWith('src/screens/chat/usePart.ts') || fault.where.startsWith('src/screens/Chat.tsx:')))
  const risen = judge(read, { ...held, useState: 0 })
  check('one hook call more than the law holds is refused with the hook and its line', told(risen.faults, 'the count only falls')[0] === 'src/screens/Chat.tsx: Chat calls useState 1 time (lines 6) and the law holds 0', told(risen.faults, 'the count only falls'))
  check('a count below the number held passes and is named', judge(read, { ...held, useEffect: 3 }).slack.join() === 'useEffect: 1 in Chat, 3 held' && !judge(read, { ...held, useEffect: 3 }).faults.some(fault => fault.law === 'the count only falls'))
  plant('src/screens/Chat.tsx', ['export function Chat(): null {', '  return null', '}', 'export const leaked = 1'])
  check('a door that loses an export or gains one is refused', told(judge(readTree(estate), {}).faults, 'the door')[0] === 'src/screens/Chat.tsx exports Chat, leaked', told(judge(readTree(estate), {}).faults, 'the door'))
  rmSync(estate, { recursive: true, force: true })
}

section(`§1 the tree at ${ROOT}`)
const read = readTree(ROOT)
const verdict = judge(read, HOOK_CALLS_IN_CHAT)
check(`no file outside ${DOOR} and ${PARTS} imports a file under ${PARTS} (${read.parts.length} files there, ${read.files} files read under src)`, told(verdict.faults, 'one door').length === 0, told(verdict.faults, 'one door'))
check(`no file under ${PARTS} imports ${DOOR}`, told(verdict.faults, 'no way back').length === 0, told(verdict.faults, 'no way back'))
check(`${DOOR} exports ${DOOR_EXPORTS.join(', ')} and nothing else`, told(verdict.faults, 'the door').length === 0, told(verdict.faults, 'the door'))
check(`the hook calls written directly in ${UNIT} are no more than the law holds (${verdict.total} found, ${heldTotal} held)`, verdict.total <= heldTotal, told(verdict.faults, 'the count only falls'))
if (verdict.slack.length > 0) console.log(`  the rows differ from the file: ${verdict.slack.join(' · ')} — write them into HOOK_CALLS_IN_CHAT of ${SELF}; its sum only falls`)

if (at < 0) {
  section('§2 the door as a running module')
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
  const door = (await import('../../src/screens/Chat.tsx')) as Record<string, unknown>
  check(`${DOOR} loads and its one runtime export is the component ${UNIT}`, Object.keys(door).join() === UNIT && typeof door[UNIT] === 'function', [Object.keys(door).join(', ')])
}

console.log(`\n${failures === 0 ? 'prove-chat-parts-law: ALL PASS' : `prove-chat-parts-law: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
