#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { declarationOf, functionOf, importOf, unwrap } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-source-patterns.ts'
const TABLE = 'scripts/gate/source-patterns.tsv'
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const PAYLOADS = 'src/extensions/bundled/'
const SKIPPED = new Set(['node_modules', 'dist', '.git'])
const DOOR = 'flagEnv'

const SLEEP = 'await sleep(ms, signal) from utils/sleep.ts'
const CLOCK = 'a module that must own a timer takes its clock from the caller (now, setTimeout, clearTimeout), as StreamTimers in the stream idle budget and the clock of the render scheduler do'
const TICK = 'for a tick, subscribeUiClock(ms, fn) from utils/cockpit/uiClock.ts (one timer for each cadence), and in a component useInterval, useAnimationTimer or useAnimationFrame from ink/hooks (the frame clock)'
const YIELD = `await the promise the work depends on, or ${SLEEP} with 0 to let the event loop turn; a scheduler that must defer takes the function from its caller, as the render scheduler takes queueMicrotask in its clock`
const RENDER = 'compute the value while rendering (plain code or useMemo); read an outside store with useSyncExternalStore; put an action in the handler of the key or event that causes it'
const NAME_THE_FAILURE = 'catch the one failure that is expected and let the rest throw (isENOENT, isFsInaccessible and isAbortError in utils/errors.ts test for it); a failure that may be passed over is still recorded, with logForDebugging or logError'

const HABITS = {
  setTimeout: `to wait, ${SLEEP}; to bound a call, AbortSignal.timeout(ms) or the inactivity deadline in utils/deadline.ts; ${TICK}; ${CLOCK}`,
  setInterval: `${TICK}; off the screen, a loop that awaits sleep(ms, signal) from utils/sleep.ts and ends with its signal; ${CLOCK}`,
  setImmediate: YIELD,
  queueMicrotask: YIELD,
  'process.nextTick': YIELD,
  useEffect: `${RENDER}; a repeating tick is useInterval or useAnimationFrame from ink/hooks`,
  useLayoutEffect: `${RENDER}; a size is read from the layout the renderer already measured (useTerminalSize, useTerminalViewport), not measured again after the paint`,
  useInsertionEffect: `${RENDER}; a write to the terminal belongs to the renderer, not to a component`,
  'as-unknown-as': 'narrow the value with a type guard or parse it with its schema; a declared type that is wrong is corrected where it is declared; satisfies checks a literal against a type with no cast',
  'ts-ignore': 'type the value at the line: a declaration for the module that has none, a guard for the union',
  'lint-directive': 'delete the comment: the tree has no linter and no formatter, and nothing reads it',
  'empty-catch': NAME_THE_FAILURE,
  'empty-catch-handler': NAME_THE_FAILURE,
  'process.env': `a flag is read with ${DOOR} or flagEnabled once its row stands in the flag registry; a function that needs the environment takes it from its caller as a parameter`,
} as const
type Habit = keyof typeof HABITS
const NAMES = Object.keys(HABITS) as Habit[]
const OUT_OF_REACH = 'a habit reached through a wrapper or an alias declared in another module, a module loaded by require or a dynamic import, a cast through unknown made in two statements, a handler that is not empty and still passes the failure over, a file under ' + PAYLOADS + ' (payloads that run outside the product and cannot import its doors); the module that exports ' + DOOR + ' is the door of the environment, and its own reads are not counted'

type Space = 'global' | 'timers' | 'react' | 'process'
const TIMERS: Array<[string, Habit]> = [['setTimeout', 'setTimeout'], ['setInterval', 'setInterval'], ['setImmediate', 'setImmediate']]
const EFFECTS: Array<[string, Habit]> = [['useEffect', 'useEffect'], ['useLayoutEffect', 'useLayoutEffect'], ['useInsertionEffect', 'useInsertionEffect']]
const MEMBERS: Record<Space, Map<string, Habit>> = {
  global: new Map([...TIMERS, ['queueMicrotask', 'queueMicrotask']]),
  timers: new Map(TIMERS),
  react: new Map(EFFECTS),
  process: new Map([['nextTick', 'process.nextTick'], ['env', 'process.env']]),
}
const MODULES = new Map<string, Space>([['node:timers', 'timers'], ['timers', 'timers'], ['node:timers/promises', 'timers'], ['timers/promises', 'timers'], ['react', 'react'], ['node:process', 'process'], ['process', 'process']])
const AMBIENT = new Map<string, Space>([['globalThis', 'global'], ['global', 'global'], ['window', 'global'], ['self', 'global'], ['process', 'process']])
const BARE = new Map<string, Habit>([...MEMBERS.global, ...MEMBERS.react])
const SUPPRESSION = /@ts-(?:ignore|expect-error|nocheck)\b/
const LINT = /\b(?:eslint-(?:disable|enable|env)|biome-ignore|prettier-ignore|oxlint-(?:disable|enable)|tslint:(?:disable|enable)|deno-lint-ignore|deno-fmt-ignore|dprint-ignore|jshint|jslint)\b|^\/\*\s*globals?\s/
const DIRECTIVE_WORD = /@ts-(?:ignore|expect-error|nocheck)|eslint-|biome-ignore|prettier-ignore|oxlint-|tslint:|deno-lint-ignore|deno-fmt-ignore|dprint-ignore|jshint|jslint|\/\*\s*globals?\s/

type Hit = { habit: Habit; file: string; line: number; column: number }
type Rows = Map<Habit, Map<string, number>>
type Over = { file: string; row: number; lines: number[] }
type Verdict = { over: Over[]; total: number; allowed: number; files: number; slack: number }

function scriptKind(file: string): ts.ScriptKind {
  if (/\.(?:tsx|jsx)$/.test(file)) return ts.ScriptKind.TSX
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function moduleOf(decl: ts.Node): { space: Space; name: string } | undefined {
  const spec = ts.isNamespaceImport(decl) ? decl.parent.parent.moduleSpecifier : undefined
  const ref = spec && ts.isStringLiteral(spec) ? { module: spec.text, name: '*' } : importOf(decl)
  const space = ref ? MODULES.get(ref.module) : undefined
  return ref && space ? { space, name: ref.name } : undefined
}

function spaceOf(e: ts.Expression): Space | undefined {
  const x = unwrap(e)
  if (ts.isPropertyAccessExpression(x)) return spaceOf(x.expression) === 'global' ? AMBIENT.get(x.name.text) : undefined
  if (!ts.isIdentifier(x)) return undefined
  const decl = declarationOf(x)
  if (!decl) return AMBIENT.get(x.text)
  const from = moduleOf(decl)
  return from && (from.name === '*' || from.name === 'default') ? from.space : undefined
}

function isUse(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id
  if (ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeOfExpression(p)) return false
  const named = p as { name?: ts.Node; propertyName?: ts.Node }
  return named.name !== id && named.propertyName !== id
}

function habitOfName(id: ts.Identifier, aliases: Map<string, Habit>): Habit | undefined {
  const alias = aliases.get(id.text)
  const bare = BARE.get(id.text)
  if ((!alias && !bare) || !isUse(id)) return undefined
  const decl = declarationOf(id)
  if (!decl) return bare
  const from = moduleOf(decl)
  if (from) return MEMBERS[from.space].get(from.name)
  const imported = importOf(decl)
  return imported && imported.name === id.text ? bare : undefined
}

const yieldsNothing = (e: ts.Expression): boolean => {
  const x = unwrap(e)
  return (ts.isIdentifier(x) && x.text === 'undefined') || (ts.isVoidExpression(x) && ts.isLiteralExpression(unwrap(x.expression)))
}

function idle(fn: ts.FunctionLikeDeclaration): boolean {
  const body = fn.body
  if (!body) return false
  if (!ts.isBlock(body)) return yieldsNothing(body)
  return body.statements.every(s => ts.isEmptyStatement(s) || (ts.isReturnStatement(s) && (!s.expression || yieldsNothing(s.expression))))
}

function idleHandler(e: ts.Expression | undefined): boolean {
  if (!e) return false
  const x = unwrap(e)
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return idle(x)
  const fn = ts.isIdentifier(x) ? functionOf(declarationOf(x)) : undefined
  return fn !== undefined && idle(fn)
}

function commentsOf(sf: ts.SourceFile, each: (pos: number, text: string) => void): void {
  const text = sf.text
  const scan = (from: number, to: number): void => {
    let i = from === 0 && text.startsWith('#!') ? Math.max(text.indexOf('\n'), 0) : from
    while (i < to) {
      const line = text.startsWith('//', i)
      if (!line && !text.startsWith('/*', i)) {
        i++
        continue
      }
      const close = line ? text.indexOf('\n', i) : text.indexOf('*/', i + 2)
      const end = close < 0 ? to : Math.min(to, line ? close : close + 2)
      each(i, text.slice(i, end))
      i = end
    }
  }
  const walk = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const kids = node.getChildren(sf)
    if (kids.length === 0) scan(node.pos, node.getStart(sf))
    else for (const kid of kids) walk(kid)
  }
  walk(sf)
}

function habitsIn(file: string, text: string): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const out: Hit[] = []
  const hit = (habit: Habit, pos: number): void => {
    const at = sf.getLineAndCharacterOfPosition(pos)
    out.push({ habit, file, line: at.line + 1, column: at.character + 1 })
  }
  const aliases = new Map<string, Habit>()
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
    const space = MODULES.get(s.moduleSpecifier.text)
    const named = s.importClause?.namedBindings
    if (!space || !named || !ts.isNamedImports(named)) continue
    for (const el of named.elements) {
      const habit = MEMBERS[space].get((el.propertyName ?? el.name).text)
      if (habit) aliases.set(el.name.text, habit)
    }
  }
  const member = (owner: ts.Expression, name: string, at: ts.Node): void => {
    const space = spaceOf(owner)
    const habit = MEMBERS.react.get(name) ?? (space ? MEMBERS[space].get(name) : undefined)
    if (habit) hit(habit, at.getStart(sf))
  }
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const habit = habitOfName(n, aliases)
      if (habit) hit(habit, n.getStart(sf))
    } else if (ts.isPropertyAccessExpression(n)) {
      member(n.expression, n.name.text, n.name)
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      member(n.expression, n.argumentExpression.text, n.argumentExpression)
    } else if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) member(n.initializer, key.text, el)
      }
    } else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
      const inner = unwrapParens(n.expression)
      if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && (inner.type.kind === ts.SyntaxKind.UnknownKeyword || inner.type.kind === ts.SyntaxKind.AnyKeyword)) hit('as-unknown-as', inner.type.getStart(sf))
    } else if (ts.isCatchClause(n)) {
      if (n.block.statements.every(ts.isEmptyStatement)) hit('empty-catch', n.getStart(sf))
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text
      if (method === 'catch' && idleHandler(n.arguments[0])) hit('empty-catch-handler', n.expression.name.getStart(sf))
      if (method === 'then' && idleHandler(n.arguments[1])) hit('empty-catch-handler', n.arguments[1]!.getStart(sf))
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  if (DIRECTIVE_WORD.test(text)) {
    commentsOf(sf, (pos, comment) => {
      if (SUPPRESSION.test(comment)) hit('ts-ignore', pos)
      if (LINT.test(comment)) hit('lint-directive', pos)
    })
  }
  const door = sf.statements.some(s => ts.isFunctionDeclaration(s) && s.name?.text === DOOR && (ts.getModifiers(s) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword))
  return out.filter(h => !(door && h.habit === 'process.env')).sort((a, b) => a.line - b.line || a.column - b.column)
}

function unwrapParens(e: ts.Expression): ts.Expression {
  let cur = e
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression
  return cur
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (SKIPPED.has(name)) continue
      const path = `${rel}/${name}`
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (CODE.test(name) && !path.startsWith(PAYLOADS)) out.push(path)
    }
  }
  walk('src')
  return out
}

function rowsOf(hits: Hit[]): Rows {
  const rows: Rows = new Map(NAMES.map(habit => [habit, new Map<string, number>()]))
  for (const h of hits) rows.get(h.habit)!.set(h.file, (rows.get(h.habit)!.get(h.file) ?? 0) + 1)
  return rows
}

const inOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const sum = (counts: Map<string, number>): number => [...counts.values()].reduce((n, c) => n + c, 0)

const render = (rows: Rows): string =>
  NAMES.flatMap(habit =>
    [...rows.get(habit)!]
      .sort(([a], [b]) => inOrder(a, b))
      .map(([file, count]) => `${habit}\t${file}\t${count}\n`),
  ).join('')

function tableOf(text: string): Rows | null {
  const table = rowsOf([])
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^([^\t]+)\t(src\/[^\t]+)\t([1-9][0-9]*)$/.exec(line)
    const files = m ? table.get(m[1] as Habit) : undefined
    if (!m || !files || files.has(m[2]!)) return null
    files.set(m[2]!, Number(m[3]))
  }
  return table
}

function judge(habit: Habit, hits: Hit[], table: Rows): Verdict {
  const allowed = table.get(habit)!
  const lines = new Map<string, number[]>()
  for (const h of hits) if (h.habit === habit) lines.set(h.file, [...(lines.get(h.file) ?? []), h.line])
  const over = [...lines]
    .filter(([file, at]) => at.length > (allowed.get(file) ?? 0))
    .map(([file, at]) => ({ file, row: allowed.get(file) ?? 0, lines: at }))
    .sort((a, b) => inOrder(a.file, b.file))
  const total = [...lines.values()].reduce((n, at) => n + at.length, 0)
  const slack = [...allowed].filter(([file, row]) => (lines.get(file)?.length ?? 0) < row).length
  return { over, total, allowed: sum(allowed), files: lines.size, slack }
}

const told = (habit: Habit, over: Over[]): string =>
  `${over.length} file${over.length === 1 ? '' : 's'} above — instead: ${HABITS[habit]}. A habit that moved with its code takes its rows along through bun ${SELF} --write, which writes no total above the one it finds:` +
  over
    .slice(0, 40)
    .map(o => `\n      ${o.file} holds ${o.lines.length} of ${habit} and ${o.row === 0 ? 'has no row' : `its row allows ${o.row}`}:` + o.lines.map(line => `\n        ${o.file}:${line} ${habit}`).join(''))
    .join('') +
  (over.length > 40 ? `\n      … and ${over.length - 40} more files` : '')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function plantedEstate(): void {
  const planted: Array<{ file: string; lines: string[]; seen: Array<[number, Habit]> }> = [
    {
      file: 'src/planted/timers.ts',
      lines: [
        "import { setTimeout as delay, setInterval as every } from 'node:timers/promises'",
        "import * as timers from 'node:timers'",
        "import { nextTick, env as ambient } from 'node:process'",
        'const a = setTimeout(() => {}, 10)',
        'const b = globalThis.setTimeout(() => {}, 10)',
        "const c = window['setInterval'](() => {}, 10)",
        'await delay(5)',
        'for await (const tick of every(5)) void tick',
        'timers.setImmediate(() => {})',
        'setImmediate(() => {})',
        'queueMicrotask(() => {})',
        'process.nextTick(() => {})',
        'nextTick(() => {})',
        'const later = { schedule: setTimeout, setTimeout: (fn: () => void) => fn }',
        'const { setInterval: loop } = globalThis',
        'const home = ambient.HOME',
        'export const out = [a, b, c, later, loop, home]',
        'function flagEnv(): void {}',
      ],
      seen: [[4, 'setTimeout'], [5, 'setTimeout'], [6, 'setInterval'], [7, 'setTimeout'], [8, 'setInterval'], [9, 'setImmediate'], [10, 'setImmediate'], [11, 'queueMicrotask'], [12, 'process.nextTick'], [13, 'process.nextTick'], [14, 'setTimeout'], [15, 'setInterval'], [16, 'process.env']],
    },
    {
      file: 'src/planted/lookalikes.ts',
      lines: [
        "const words = 'setTimeout(fn, 5) and useEffect(() => {}) and process.env.HOME and x as unknown as Y and catch {}'",
        'const told = `setInterval(${words}) // eslint-disable-next-line and // @ts-ignore`',
        'let handle: ReturnType<typeof setTimeout> | undefined',
        "const able = typeof setImmediate === 'function'",
        'socket.setTimeout(30_000)',
        'this.clock.setTimeout(() => {}, 5)',
        'clock.queueMicrotask(() => {})',
        'function useEffect(run: () => void): void { run() }',
        'useEffect(() => {})',
        'const run = (setInterval: (fn: () => void) => void): void => setInterval(() => {})',
        'const mySetTimeout = 1, setTimeoutMs = 2, resetTimeout = 3',
        'const options = { env: {}, nextTick: 1 }',
        'options.env.HOME = options.nextTick',
        'const process = { env: { HOME: 1 }, nextTick: (fn: () => void) => fn() }',
        'process.env.HOME = 2; process.nextTick(() => {})',
        'const wide = value as unknown',
        'const narrow = value as Shape as Other',
        'try { work() } catch (error) { report(error) }',
        'work().catch(error => report(error)).then(done, error => report(error))',
        'work().catch(() => null).catch(() => void report())',
        'schema.catch(undefined)',
        'const pattern = /catch \\{\\}|as unknown as|\\/\\/ @ts-ignore/',
        'export const out = [words, told, handle, able, run, mySetTimeout, setTimeoutMs, resetTimeout, wide, narrow, pattern]',
      ],
      seen: [],
    },
    {
      file: 'src/planted/Screen.tsx',
      lines: [
        "import React, { useEffect, useLayoutEffect as useMeasure, useInsertionEffect } from 'react'",
        "import * as R from 'react'",
        'export function Screen(): React.ReactNode {',
        '  useEffect(() => {}, [])',
        '  useMeasure(() => {}, [])',
        '  useInsertionEffect(() => {}, [])',
        '  React.useEffect(() => {}, [])',
        '  R.useLayoutEffect(() => {}, [])',
        '  host.React.useEffect(() => {}, [])',
        '  const { useEffect: sync } = React',
        '  const pick = wide ? useEffect : sync',
        '  return <Box>{/* eslint-disable-next-line react-hooks/exhaustive-deps */}useEffect(run) // @ts-ignore {process.env.HOME}</Box>',
        '}',
      ],
      seen: [[4, 'useEffect'], [5, 'useLayoutEffect'], [6, 'useInsertionEffect'], [7, 'useEffect'], [8, 'useLayoutEffect'], [9, 'useEffect'], [10, 'useEffect'], [11, 'useEffect'], [12, 'lint-directive'], [12, 'process.env']],
    },
    {
      file: 'src/planted/rest.ts',
      lines: [
        '#!/usr/bin/env node',
        '/* eslint-disable no-console */',
        'const shape = value as unknown as Shape',
        'const other = (value as any) as Shape',
        'const old = <Shape>(<unknown>value)',
        '// @ts-ignore deep import',
        "import deep from 'deep/esm/index.js'",
        '// @ts-expect-error narrow assignment',
        'target[key] = next',
        'work() // eslint-disable-line no-console',
        '// biome-ignore lint/suspicious/noExplicitAny: the wire is untyped',
        '// prettier-ignore',
        'try { work() } catch {}',
        'try { work() } catch (error) {',
        '}',
        'try { work() } catch { ; }',
        'work().catch(() => {})',
        'work().catch(() => undefined).catch(function () {})',
        'work().then(done, () => {})',
        'const quiet = (): undefined => undefined',
        'work().catch(quiet)',
        'work().catch(() => { return })',
        'const home = process.env.HOME',
        "const user = process['env'].USER",
        'const { env } = process',
        'const all = { ...globalThis.process.env }',
        'const read = (from: NodeJS.ProcessEnv = process.env): string | undefined => from.HOME',
        'process.env.PLANTED = home',
        'export const out = [shape, other, old, deep, user, env, all, read]',
      ],
      seen: [
        [2, 'lint-directive'], [3, 'as-unknown-as'], [4, 'as-unknown-as'], [5, 'as-unknown-as'], [6, 'ts-ignore'], [8, 'ts-ignore'], [10, 'lint-directive'], [11, 'lint-directive'], [12, 'lint-directive'],
        [13, 'empty-catch'], [14, 'empty-catch'], [16, 'empty-catch'], [17, 'empty-catch-handler'], [18, 'empty-catch-handler'], [18, 'empty-catch-handler'], [19, 'empty-catch-handler'], [21, 'empty-catch-handler'], [22, 'empty-catch-handler'],
        [23, 'process.env'], [24, 'process.env'], [25, 'process.env'], [26, 'process.env'], [27, 'process.env'], [28, 'process.env'],
      ],
    },
    { file: 'src/planted/door.ts', lines: ['export function flagEnv(name: string): string | undefined {', '  return process.env[name]', '}', 'export const later = setTimeout(() => {}, 1)'], seen: [[4, 'setTimeout']] },
    { file: 'src/planted/worker.mjs', lines: ["import { setTimeout as pause } from 'timers/promises'", 'await pause(5)', 'setInterval(() => {}, 5)', 'try { run() } catch {}', 'export const home = process.env.HOME'], seen: [[2, 'setTimeout'], [3, 'setInterval'], [4, 'empty-catch'], [5, 'process.env']] },
  ]
  const hits = planted.flatMap(p => habitsIn(p.file, p.lines.join('\n') + '\n'))
  const seen = hits.map(h => `${h.file}:${h.line} ${h.habit}`)
  const want = planted.flatMap(p => p.seen.map(([line, habit]) => `${p.file}:${line} ${habit}`))
  const differs = [...seen.filter(s => !want.includes(s)).map(s => `seen and not wanted ${s}`), ...want.filter(w => !seen.includes(w)).map(w => `wanted and not seen ${w}`), ...(seen.length === want.length ? [] : [`${seen.length} seen, ${want.length} wanted`])].join(' · ')
  const of = (file: string): string => seen.filter(s => s.startsWith(`${file}:`)).join(' ')
  const wanted = (file: string): string => want.filter(w => w.startsWith(`${file}:`)).join(' ')
  const stands = (file: string): boolean => of(file) === wanted(file)
  check(
    'a timer is seen as a call of the global, as a member of globalThis or window, by a bracketed name, under the name an import from node:timers gives it, as a member of that module, as a value handed on, and taken out of globalThis; process.nextTick and the environment are seen under the names an import from node:process gives them',
    stands('src/planted/timers.ts'),
    differs,
  )
  check(
    'an effect is seen as a call of the hook, under the name the import gives it, as a member of React under either import and of the React a host hands in, taken out of React, and as a value; a lint directive in a JSX comment and an environment read in a JSX expression are seen, and the same words in JSX text are not',
    stands('src/planted/Screen.tsx'),
    differs,
  )
  check(
    'a cast through unknown or any is seen in both spellings; @ts-ignore and @ts-expect-error are seen; a lint directive is seen for eslint, biome and prettier, on its own line, after code and under a shebang; a catch block is seen empty, empty over two lines and holding a lone semicolon; a rejection handler is seen empty, yielding undefined, as a function, as the second argument of then, by the name of an idle function of the file and holding a bare return; the environment is seen read, bracketed, taken out of process, spread, as a default and written',
    stands('src/planted/rest.ts'),
    differs,
  )
  check('a plain JavaScript module is read as the TypeScript ones are', stands('src/planted/worker.mjs'), differs)
  check(`the module that exports ${DOOR} is the door of the environment: its own reads are not counted, its other habits are, and a function of that name that is not exported opens no door`, stands('src/planted/door.ts') && of('src/planted/timers.ts').includes('src/planted/timers.ts:16 process.env'), differs)
  check(
    'a look-alike is not seen: the words in a string, a template or a regular expression; a type query and a typeof test; a method of that name on a socket or a clock; a function, a parameter or a constant of the file under that name; a property named env; a cast to unknown alone and a cast between two types; a catch block and a handler that do something; a handler that yields a value; a schema fallback',
    of('src/planted/lookalikes.ts') === '',
    of('src/planted/lookalikes.ts'),
  )
  check(`every habit of the fence is seen on the planted estate (${NAMES.length})`, NAMES.every(habit => hits.some(h => h.habit === habit)), NAMES.filter(habit => !hits.some(h => h.habit === habit)).join(', '))
  const rows = rowsOf(hits)
  const text = render(rows)
  const table = tableOf(text)
  check('the table is one row for each habit and file with its count, in the order of the habits and then of the files, and reads back as written', table !== null && render(table) === text && text.startsWith('setTimeout\tsrc/planted/door.ts\t1\nsetTimeout\tsrc/planted/timers.ts\t4\nsetTimeout\tsrc/planted/worker.mjs\t1\nsetInterval\t'), text.replaceAll('\n', ' · '))
  check('a table with a habit the fence does not hold, a file outside src, a count of 0 or a row twice does not read', tableOf('sleep\tsrc/a.ts\t1\n') === null && tableOf('setTimeout\tscripts/a.ts\t1\n') === null && tableOf('setTimeout\tsrc/a.ts\t0\n') === null && tableOf('setTimeout\tsrc/a.ts\t1\nsetTimeout\tsrc/a.ts\t1\n') === null)
  if (table === null) return
  check('on its own table the planted estate stands for every habit', NAMES.every(habit => judge(habit, hits, table).over.length === 0 && judge(habit, hits, table).total === judge(habit, hits, table).allowed))
  const unrowed = tableOf(text.replace('process.env\tsrc/planted/Screen.tsx\t1\n', ''))!
  const lone = judge('process.env', hits, unrowed)
  check('a file with no row that holds a habit is named with its line and what to use instead', lone.over.length === 1 && lone.total === lone.allowed + 1 && told('process.env', lone.over).includes('src/planted/Screen.tsx:12 process.env') && told('process.env', lone.over).includes('has no row') && told('process.env', lone.over).includes('flagEnv'), told('process.env', lone.over))
  const lowered = tableOf(text.replace('empty-catch\tsrc/planted/rest.ts\t3\n', 'empty-catch\tsrc/planted/rest.ts\t2\n'))!
  const raised = judge('empty-catch', hits, lowered)
  check('a file that holds one more than its row allows is named with every line it holds', raised.over.length === 1 && ['13', '14', '16'].every(line => told('empty-catch', raised.over).includes(`src/planted/rest.ts:${line} empty-catch`)) && told('empty-catch', raised.over).includes('its row allows 2'), told('empty-catch', raised.over))
  const fallen = judge('setTimeout', hits.filter(h => h.file !== 'src/planted/worker.mjs'), table)
  check('a count that fell stands, and its row is counted as standing above it', fallen.over.length === 0 && fallen.total === 5 && fallen.allowed === 6 && fallen.slack === 1, JSON.stringify(fallen))
}

section('§0 the reader on a planted estate: each habit is seen with its line, each look-alike is not')
plantedEstate()

section(`§1 the estate: the habits in the code under src, counted for each file and in all, against ${TABLE}`)
const files = sourceFiles(ROOT)
const hits = files.flatMap(file => habitsIn(file, readFileSync(join(ROOT, file), 'utf8')))
const rows = rowsOf(hits)
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
console.log(`  ${files.length} code files under src (${PAYLOADS} aside) · ${hits.length} occurrences of ${NAMES.length} habits (the reads of the module that exports ${DOOR} aside)`)
check(`the code under src is read (${files.length} files)`, files.length > 3000)
if (process.argv.includes('--list')) {
  const asked = NAMES.filter(habit => process.argv.includes(habit))
  for (const h of hits) if (asked.length === 0 || asked.includes(h.habit)) console.log(`${h.habit}\t${h.file}\t${h.line}\t${h.column}`)
} else if (process.argv.includes('--write')) {
  const risen = table === null ? [] : NAMES.filter(habit => sum(rows.get(habit)!) > sum(table.get(habit)!))
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate')
  else if (text !== null && table === null) check(`${TABLE} reads as rows of a habit, a file and its count`, false, 'put the committed table back, then write')
  else if (risen.length > 0) check('no total rises', false, `nothing written — ${risen.map(habit => `${habit} is ${sum(rows.get(habit)!)} now and ${sum(table!.get(habit)!)} in the table — instead: ${HABITS[habit]}`).join(' · ')}`)
  else {
    writeFileSync(join(ROOT, TABLE), render(rows))
    console.log(`  wrote ${TABLE}: ${NAMES.reduce((n, habit) => n + rows.get(habit)!.size, 0)} rows, ${hits.length} occurrences`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a habit, a file and its count`, false, text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row is not a habit of the fence, a file under src and a count of 1 or more, or a habit and file stand twice')
} else {
  let slack = 0
  for (const habit of NAMES) {
    const found = judge(habit, hits, table)
    slack += found.slack
    check(`${habit}: no file holds more than its row allows, a file with no row holds none, and the total is at most the table's (${found.total} in ${found.files} files, ${found.allowed} allowed)`, found.over.length === 0 && found.total <= found.allowed, told(habit, found.over))
  }
  console.log(`  out of reach: ${OUT_OF_REACH}`)
  if (slack > 0) console.log(`  rows above their file's count: ${slack} (bun ${SELF} --write lowers them)`)
}
console.log(failures === 0 ? '\nprove-source-patterns: green' : `\nprove-source-patterns: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
