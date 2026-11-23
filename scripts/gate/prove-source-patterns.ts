#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { ModuleCache, declarationOf, functionOf, importOf, importedDeclaration, unwrap } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-source-patterns.ts'
const CENSUS = 'scripts/gate/sourceCensus.ts'
const TABLE = 'scripts/gate/source-patterns.tsv'
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const PAYLOADS = 'src/integrations/extensions/bundled/'
const PAYLOAD_LIST = 'scripts/gate/source-patterns-payloads.txt'
const PAYLOAD_FILES = new Set(readFileSync(join(ROOT, PAYLOAD_LIST), 'utf8').split('\n').filter(Boolean).map(name => PAYLOADS + name))
const AT_THE_ROOT = new Set(['node_modules', 'dist', '.git'])
const DOOR = 'flagEnv'
const LOOSE = 'flagEnvLoose'
const PAUSE = 'hand-built-pause'
const ALIAS = 'sleep-alias'
const SLEEP_DOOR = 'src/platform/async/sleep.ts'
const FAILURE_DOOR = 'src/platform/errors/passedOver.ts'
const PASS = 'passedOver'
const PASS_AS = 'passedOverAs'
const TIMER_DOOR = 'src/platform/async/timers.ts'
const AMBIENT_DOOR = 'src/platform/environment/hostEnv.ts'
const EFFECT_DOOR = 'src/screen/effects/effects.ts'
const DEADLINE_DOOR = 'src/platform/async/deadline.ts'
const RACE = 'Promise.race'
const INTERVAL = 'startInterval'
const CLASSES = ['deadline', 'poll-event', 'poll-loop', 'events', 'clock', 'heartbeat', 'periodic', 'later', 'row8']
const MOVING = CLASSES.slice(0, 3)
const REGISTERED = new Set(FLAG_REGISTRY.map(row => row.env))
const DOOR_FILE = ((): string => {
  const self = ts.createSourceFile(SELF, readFileSync(import.meta.path, 'utf8'), ts.ScriptTarget.Latest, false)
  for (const s of self.statements) {
    const named = ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) ? s.importClause?.namedBindings : undefined
    if (named && ts.isNamedImports(named) && named.elements.some(el => el.name.text === 'FLAG_REGISTRY')) return relative(ROOT, resolve(import.meta.dir, (s as ts.ImportDeclaration & { moduleSpecifier: ts.StringLiteral }).moduleSpecifier.text)).split('\\').join('/')
  }
  return ''
})()

const SLEEP = `await sleep(ms, signal) from ${SLEEP_DOOR}`
const CLOCK = 'a module that must own a timer takes its clock from the caller (now, setTimeout, clearTimeout), as StreamTimers in the stream idle budget and the clock of the render scheduler do'
const TICK = 'for a tick, subscribeUiClock(ms, fn) from utils/cockpit/uiClock.ts (one timer for each cadence), and in a component useInterval, useAnimationTimer or useAnimationFrame from ink/hooks (the frame clock)'
const YIELD = `await the promise the work depends on, or ${SLEEP} with 0 to let the event loop turn; a scheduler that must defer takes the function from its caller, as the render scheduler takes queueMicrotask in its clock`
const RENDER = 'compute the value while rendering (plain code or useMemo); read an outside store with useSyncExternalStore; put an action in the handler of the key or event that causes it'
const NAME_THE_FAILURE = `catch the one failure that is expected and let the rest throw (isENOENT, isFsInaccessible and isAbortError in utils/errors.ts test for it); a failure that may be passed over is handed on first: ${PASS}(error) from ${FAILURE_DOOR} as the first statement of the catch, and as a rejection handler ${PASS} itself or ${PASS_AS}(value) for a default (the door counts it, keeps the last one and sends it to the debug log)`
const THROUGH_HOST_ENV = `the ambient environment is hostEnv() from ${AMBIENT_DOOR}: a read by name is hostEnv().NAME, and a child program or a default takes hostEnv() whole`
const BY_THE_TIMER_DOOR = `a timer that is started by hand all the same goes through ${TIMER_DOOR} (startTimeout, startInterval, startImmediate, startMicrotask, and sleepSync for a wait that must stay synchronous), which starts the same timer and returns its handle`
const BY_THE_EFFECT_DOOR = `an effect that stays takes its name from ${EFFECT_DOOR}, the hook that says what it is for`
const TYPE_IT = 'narrow the value with a type guard or parse it with its schema; a declared type that is wrong is corrected where it is declared; satisfies checks a literal against a type with no cast'

const SCREEN_EFFECTS = { useSubscription: RENDER, useLayoutSubscription: RENDER, useDerivedState: RENDER, useLayoutDerivedState: RENDER, useMeasure: 'use the geometry already supplied by the renderer; do not add a second layout pass' } as const

const HABITS = {
  setTimeout: `to wait, ${SLEEP}; to bound a call, AbortSignal.timeout(ms) or the inactivity deadline in utils/deadline.ts; ${TICK}; ${CLOCK}; ${BY_THE_TIMER_DOOR}`,
  setInterval: `${TICK}; off the screen, a loop that awaits sleep(ms, signal) from ${SLEEP_DOOR} and ends with its signal; ${CLOCK}; ${BY_THE_TIMER_DOOR}`,
  setImmediate: `${YIELD}; ${BY_THE_TIMER_DOOR}`,
  queueMicrotask: `${YIELD}; ${BY_THE_TIMER_DOOR}`,
  'process.nextTick': YIELD,
  'Atomics.wait': `a synchronous wait stops the event loop for every caller: in an async caller, ${SLEEP}; a caller that cannot await hands the wait to a worker; ${BY_THE_TIMER_DOOR}`,
  [PAUSE]: `call sleep(ms, signal?, opts?) from ${SLEEP_DOOR} where the pause is made: a promise built over a timer, a call of the timer of timers/promises or of its scheduler, Bun.sleep, a helper that is handed the resolver (each line below names the call). The second argument is the signal of a caller that stops its own work when it aborts, { throwOnAbort: true } rejects on that abort as the timer of timers/promises does, and { unref: true } keeps the timer from holding the process open`,
  [ALIAS]: `import the door under its own name, import { sleep } from ${SLEEP_DOOR}: a local that holds a sleep handed in through a seam takes another name (pause), and the argument of the seam keeps the name sleep for its callers`,
  useEffect: `${RENDER}; a repeating tick is useInterval or useAnimationFrame from ink/hooks; ${BY_THE_EFFECT_DOOR}`,
  useLayoutEffect: `${RENDER}; a size is read from the layout the renderer already measured (useTerminalSize, useTerminalViewport), not measured again after the paint; ${BY_THE_EFFECT_DOOR}`,
  ...SCREEN_EFFECTS,
  useInsertionEffect: `${RENDER}; a write to the terminal belongs to the renderer, not to a component`,
  useImperativeHandle: `${RENDER}; a parent that must act on a child hands it the state, not a handle to call`,
  'lifecycle-method': `a function component: ${RENDER}`,
  'as-unknown-as': TYPE_IT,
  'as-never': `${TYPE_IT}; never stands for a branch that cannot be reached, not for a value that is handed on`,
  'as-any': `${TYPE_IT}; any switches the compiler off for everything the value touches`,
  'ts-ignore': 'type the value at the line: a declaration for the module that has none, a guard for the union',
  'lint-directive': 'delete the comment: the tree has no linter, no formatter and no coverage tool, and nothing reads it',
  'empty-catch': NAME_THE_FAILURE,
  'empty-catch-handler': NAME_THE_FAILURE,
  'catch-default': `${NAME_THE_FAILURE}; a default answered for every failure hides the ones nobody expected`,
  'handler-default': `${NAME_THE_FAILURE}; a default answered for every failure hides the ones nobody expected`,
  'env-read': `a registered flag is read with ${DOOR} or flagEnabled (each line below says whether its name has a row in the flag registry); for another name, ${THROUGH_HOST_ENV}`,
  'env-whole': `a function that needs the environment takes it from its caller as a parameter with no default; ${THROUGH_HOST_ENV}`,
  [LOOSE]: `give the name its row in the flag registry and read it with ${DOOR}`,
  [RACE]: `a work against a timer is withDeadline(work, ms, atLimit, { signal, onAbort, unref }) from ${DEADLINE_DOOR}, and a race against an inactivity deadline's expiry is its within(work); a race of two real events stays, and its row names the class of each race it holds`,
  [INTERVAL]: `a wait for something becomes the event it waits for (a promise that settles, an emitter's event, a child's exit), and where nothing can say so, pollUntil(look, everyMs, limitMs, atLimit, { signal }) from ${DEADLINE_DOOR}; ${TICK}; a heartbeat and a job on a cadence stay, and the row names the class of each timer it holds`,
} as const
type Habit = keyof typeof HABITS
const NAMES = Object.keys(HABITS) as Habit[]
const CLASSED = new Set<Habit>([RACE, INTERVAL])
const DOORS: Array<{ file: string; opens: string; own: readonly Habit[] }> = [
  { file: DOOR_FILE, opens: DOOR, own: ['env-read', 'env-whole'] },
  { file: AMBIENT_DOOR, opens: 'hostEnv', own: ['env-read', 'env-whole'] },
  { file: TIMER_DOOR, opens: 'startTimeout', own: ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Atomics.wait'] },
  { file: EFFECT_DOOR, opens: 'useMount', own: ['useEffect', 'useLayoutEffect'] },
  { file: FAILURE_DOOR, opens: PASS, own: ['empty-catch'] },
  { file: DEADLINE_DOOR, opens: 'withDeadline', own: [RACE] },
]
const OWN = 'own '
const BEYOND: Array<[string, string]> = [
  ['wrapper', 'a named function that arms a timer or runs an effect for what its caller hands in, counted once where it stands and not at its callers'],
  ['exported-alias', 'a name a module exports for a timer, a hook or the environment, counted where it is made and not where another module imports it'],
  ['env-whole', 'what is read from the environment after it is handed on whole to a function, a property or a return: the handing on is counted, as the habit env-whole, and the reads behind it are not'],
  ['two-step-cast', 'a cast of a constant or a parameter typed unknown, which is the cast through unknown made in two statements and most often an honest narrowing'],
  ['any-type', 'the any keyword in a type, which needs no cast'],
  ['computed-member', 'a member of globalThis or process under a name computed at run time, in brackets or through Reflect.get'],
  ['child-sleep', 'a child process named sleep'],
  ['busy-loop', 'a loop that reads the clock in its test and awaits nothing'],
  ['all-settled', 'Promise.allSettled with its result dropped'],
  ['memo-effect', 'a useMemo callback or a useState initialiser with a statement that calls or assigns what is declared outside it'],
  ['only-calls', 'a catch block or a rejection handler that holds only calls, which may report the failure and still pass it over'],
  ['passed-over', `a catch block or a rejection handler that hands its failure to the door first, ${PASS} or ${PASS_AS} from ${FAILURE_DOOR}, and passes it over`],
]
const WRAPPED = new Set<string>(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'process.nextTick', 'useEffect', 'useLayoutEffect', 'useInsertionEffect'])

type Space = 'global' | 'timers' | 'promises' | 'scheduler' | 'react' | 'process' | 'atomics'
const TIMERS: Array<[string, Habit]> = [['setTimeout', 'setTimeout'], ['setInterval', 'setInterval'], ['setImmediate', 'setImmediate']]
const MEMBERS: Record<Space, Map<string, Habit>> = {
  global: new Map([...TIMERS, ['queueMicrotask', 'queueMicrotask']]),
  timers: new Map(TIMERS),
  promises: new Map(TIMERS),
  scheduler: new Map([['wait', 'setTimeout'], ['yield', 'setImmediate']]),
  react: new Map([['useEffect', 'useEffect'], ['useLayoutEffect', 'useLayoutEffect'], ['useInsertionEffect', 'useInsertionEffect'], ['useImperativeHandle', 'useImperativeHandle']]),
  process: new Map([['nextTick', 'process.nextTick'], ['env', 'env-whole']]),
  atomics: new Map([['wait', 'Atomics.wait']]),
}
const INSIDE: Record<Space, Map<string, Space>> = {
  global: new Map([['globalThis', 'global'], ['global', 'global'], ['window', 'global'], ['self', 'global'], ['process', 'process'], ['Atomics', 'atomics']]),
  timers: new Map([['promises', 'promises'], ['scheduler', 'scheduler']]),
  promises: new Map([['scheduler', 'scheduler']]),
  scheduler: new Map(),
  react: new Map(),
  process: new Map(),
  atomics: new Map(),
}
const MODULES = new Map<string, Space>([['node:timers', 'timers'], ['timers', 'timers'], ['node:timers/promises', 'promises'], ['timers/promises', 'promises'], ['react', 'react'], ['node:process', 'process'], ['process', 'process']])
const AMBIENT = INSIDE.global
const BARE = new Map<string, Habit>([...MEMBERS.global, ...MEMBERS.react])
const LIFECYCLE = new Set(['componentDidMount', 'componentDidUpdate', 'componentWillUnmount'])
const CHILD = new Set(['execFileSync', 'execSync', 'spawnSync', 'spawn', 'execFile', 'exec'])
const SUPPRESSION = /@ts-(?:ignore|expect-error|nocheck)\b/i
const LINT = /\b(?:eslint-(?:disable|enable|env)|biome-ignore|prettier-ignore|oxlint-(?:disable|enable)|tslint:(?:disable|enable)|deno-lint-ignore|deno-fmt-ignore|dprint-ignore|jshint|jslint|noinspection|stylelint-(?:disable|enable)|cspell:(?:disable|enable|ignore)|nolint|nosonar)\b|\b(?:istanbul|c8|v8) ignore\b|^\/\*\s*(?:globals?|eslint)\s/i
const DIRECTIVE_WORD = /@ts-(?:ignore|expect-error|nocheck)|eslint|biome-ignore|prettier-ignore|oxlint-|tslint:|deno-lint-ignore|deno-fmt-ignore|dprint-ignore|jshint|jslint|noinspection|stylelint-|cspell:|nolint|nosonar|(?:istanbul|c8|v8) ignore|\/\*\s*globals?\s/i

type Hit = { habit: Habit; file: string; line: number; column: number; print: string; note: string }
type Rows = Map<Habit, Map<string, number>>
type Classed = Map<string, string>
type Over = { file: string; row: number; lines: Array<{ line: number; note: string }> }
type Verdict = { over: Over[]; total: number; allowed: number; files: number; slack: number }
type Side = (file: string) => string | null
type Change = { name: string; touched: string[]; taken: Set<string>; before: Side; after: Side }
type Chain = { from: string; was: Rows; span: Change; links: Change[] }
type Refusal = { habit: Habit; file: string; lines: number[]; why: string; change: string }
type Passed = 'empty' | 'default' | 'calls' | 'door' | undefined

const modules = new ModuleCache(ROOT)

function scriptKind(file: string): ts.ScriptKind {
  if (/\.(?:tsx|jsx)$/.test(file)) return ts.ScriptKind.TSX
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function isUse(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id
  if (ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeOfExpression(p)) return false
  const named = p as { name?: ts.Node; propertyName?: ts.Node }
  return named.name !== id && named.propertyName !== id
}

function unwrapAll(e: ts.Expression): ts.Expression {
  let cur = unwrap(e)
  while (ts.isAwaitExpression(cur)) cur = unwrap(cur.expression)
  return cur
}

function unwrapParens(e: ts.Expression): ts.Expression {
  let cur = e
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression
  return cur
}

function outOf(n: ts.Node): ts.Node {
  let cur = n
  while (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isNonNullExpression(cur.parent) || ts.isSatisfiesExpression(cur.parent)) cur = cur.parent
  return cur
}

const yieldsNothing = (e: ts.Expression): boolean => {
  const x = unwrap(e)
  return (ts.isIdentifier(x) && x.text === 'undefined') || (ts.isVoidExpression(x) && ts.isLiteralExpression(unwrap(x.expression)))
}

const isDefault = (e: ts.Expression): boolean => {
  const x = unwrap(e)
  return x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || ts.isNumericLiteral(x) || ts.isStringLiteralLike(x) || (ts.isArrayLiteralExpression(x) && x.elements.length === 0) || (ts.isObjectLiteralExpression(x) && x.properties.length === 0) || (ts.isPrefixUnaryExpression(x) && ts.isNumericLiteral(x.operand))
}

const saysNothing = (s: ts.Statement): boolean => ts.isEmptyStatement(s) || (ts.isExpressionStatement(s) && (ts.isIdentifier(unwrap(s.expression)) || (ts.isVoidExpression(s.expression) && (ts.isIdentifier(unwrap(s.expression.expression)) || ts.isLiteralExpression(unwrap(s.expression.expression))))))

function stripped(e: ts.Expression): ts.Expression {
  let cur = e
  while (ts.isVoidExpression(cur) || ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression
  return cur
}

function holds(node: ts.Node, test: (n: ts.Node) => boolean): boolean {
  let found = false
  const look = (n: ts.Node): void => {
    if (found || (n !== node && ts.isFunctionLike(n))) return
    if (test(n)) found = true
    else ts.forEachChild(n, look)
  }
  look(node)
  return found
}

function passedOver(statements: readonly ts.Statement[], inFunction: boolean): Passed {
  const rest = statements.filter(s => !saysNothing(s))
  if (rest.every(s => inFunction && ts.isReturnStatement(s) && (!s.expression || yieldsNothing(s.expression)))) return 'empty'
  if (rest.every(s => (ts.isReturnStatement(s) && (!s.expression || yieldsNothing(s.expression) || isDefault(s.expression))) || ts.isContinueStatement(s) || ts.isBreakStatement(s))) return 'default'
  if (rest.every(s => ts.isExpressionStatement(s) && ts.isCallExpression(stripped(s.expression)))) return 'calls'
  return undefined
}

function ofDoor(e: ts.Expression, door: string): string | undefined {
  const x = unwrap(e)
  const decl = ts.isIdentifier(x) ? declarationOf(x) : undefined
  const ref = decl ? importOf(decl) : undefined
  return decl && ref && ref.module.startsWith('.') && resolve(dirname(decl.getSourceFile().fileName), ref.module).replace(/\.js$/, '.ts') === resolve(ROOT, door) ? ref.name : undefined
}

function screenEffect(e: ts.Expression): keyof typeof SCREEN_EFFECTS | undefined {
  const x = unwrap(e)
  let name: string | undefined
  if (ts.isIdentifier(x)) name = ofDoor(x, EFFECT_DOOR)
  else if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) {
    const receiver = unwrap(x.expression)
    const decl = ts.isIdentifier(receiver) && declarationOf(receiver)
    if (decl && ts.isNamespaceImport(decl)) {
      const spec = decl.parent.parent.moduleSpecifier
      if (ts.isStringLiteralLike(spec) && spec.text.startsWith('.') && resolve(dirname(decl.getSourceFile().fileName), spec.text).replace(/\.js$/, '.ts') === resolve(ROOT, EFFECT_DOOR)) name = ts.isPropertyAccessExpression(x) ? x.name.text : ts.isStringLiteralLike(x.argumentExpression) ? x.argumentExpression.text : undefined
    }
  }
  return name && Object.hasOwn(SCREEN_EFFECTS, name) ? name as keyof typeof SCREEN_EFFECTS : undefined
}
const ofFailureDoor = (e: ts.Expression): string | undefined => ofDoor(e, FAILURE_DOOR)

const handsOver = (s: ts.Statement | undefined): boolean => s !== undefined && ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && ofFailureDoor(s.expression.expression) === PASS

function handlerPasses(e: ts.Expression | undefined): Passed {
  if (!e) return undefined
  const x = unwrap(e)
  if (ofFailureDoor(x) === PASS || (ts.isCallExpression(x) && ofFailureDoor(x.expression) === PASS_AS)) return 'door'
  const decl = ts.isIdentifier(x) ? declarationOf(x) : undefined
  const fn = ts.isArrowFunction(x) || ts.isFunctionExpression(x) ? x : decl ? (functionOf(decl) ?? functionOf(importedDeclaration(modules, decl))) : undefined
  if (!fn?.body) return undefined
  if (ts.isBlock(fn.body)) return handsOver(fn.body.statements[0]) ? 'door' : passedOver(fn.body.statements, true)
  return yieldsNothing(fn.body) ? 'empty' : isDefault(fn.body) ? 'default' : ts.isCallExpression(stripped(fn.body)) ? 'calls' : undefined
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

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim()

function printAt(sf: ts.SourceFile, habit: Habit, pos: number): string {
  if (habit === 'ts-ignore' || habit === 'lint-directive') {
    const first = sf.text.indexOf('\n', pos)
    const end = first < 0 ? -1 : sf.text.indexOf('\n', first + 1)
    return squeeze(sf.text.slice(pos, end < 0 ? sf.text.length : end))
  }
  let node: ts.Node = sf
  for (;;) {
    const kid = ts.forEachChild(node, child => (child.getStart(sf) <= pos && pos < child.end ? child : undefined))
    if (!kid) break
    node = kid
  }
  while (node.parent && !((ts.isStatement(node) && !ts.isBlock(node)) || ts.isClassElement(node) || ts.isParameter(node))) node = node.parent
  if (ts.isParameter(node)) {
    const fn = node.parent
    const holder = fn.parent
    const name = (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name ? fn.name.getText(sf) : ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder) ? holder.name.getText(sf) : ''
    return squeeze(`${name}(${node.getText(sf)})`)
  }
  const exported = (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).filter(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword).at(-1)
  return squeeze(sf.text.slice(exported ? exported.end : node.getStart(sf), node.end))
}

function habitsIn(file: string, text: string, prints = false, beyond?: Map<string, number>): Hit[] {
  const sf = ts.createSourceFile(join(ROOT, file), text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const out: Hit[] = []
  const hit = (habit: Habit, at: ts.Node | number, note = ''): void => {
    const pos = typeof at === 'number' ? at : at.getStart(sf)
    const where = sf.getLineAndCharacterOfPosition(pos)
    out.push({ habit, file, line: where.line + 1, column: where.character + 1, print: prints ? printAt(sf, habit, pos) : '', note })
  }
  const tally = (form: string): void => void beyond?.set(form, (beyond.get(form) ?? 0) + 1)

  const habitAt = new Map<ts.Node, Habit>()
  const spaceAt = new Map<ts.Node, Space>()
  const envAt = new Set<ts.Node>()
  const pauseAt = new Set<ts.Node>()
  const pauses = (space: Space | undefined, key: string): boolean => (space === 'promises' && key === 'setTimeout') || (space === 'scheduler' && key === 'wait')
  const opensDoor = (spec: string): boolean => spec.startsWith('.') && resolve(ROOT, file, '..', spec).replace(/\.js$/, '.ts') === resolve(ROOT, SLEEP_DOOR)
  const names = new Set<string>()

  const spaceOf = (e: ts.Expression): Space | undefined => {
    const x = unwrapAll(e)
    if (ts.isIdentifier(x)) {
      const decl = declarationOf(x)
      return decl ? spaceAt.get(decl) : AMBIENT.get(x.text)
    }
    if (ts.isPropertyAccessExpression(x)) {
      const owner = spaceOf(x.expression)
      return owner ? INSIDE[owner].get(x.name.text) : undefined
    }
    if (ts.isCallExpression(x) && x.arguments[0] && ts.isStringLiteralLike(x.arguments[0])) {
      const loads = x.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(x.expression) && x.expression.text === 'require' && !declarationOf(x.expression))
      return loads ? MODULES.get(x.arguments[0].text) : undefined
    }
    return undefined
  }
  const reflected = (x: ts.Node): { owner: ts.Expression; key: string; at: ts.Expression } | undefined => {
    if (!ts.isCallExpression(x) || !ts.isPropertyAccessExpression(x.expression) || x.expression.name.text !== 'get') return undefined
    const [owner, key] = x.arguments
    const target = x.expression.expression
    return ts.isIdentifier(target) && target.text === 'Reflect' && !declarationOf(target) && owner && key && ts.isStringLiteralLike(key) ? { owner, key: key.text, at: key } : undefined
  }
  const isOrigin = (x: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(x) && x.name.text === 'env') return spaceOf(x.expression) === 'process' || (ts.isIdentifier(x.expression) && x.expression.text === 'Bun' && !declarationOf(x.expression)) || (ts.isMetaProperty(x.expression) && x.expression.name.text === 'meta')
    const got = reflected(x)
    if (got) return got.key === 'env' && spaceOf(got.owner) === 'process'
    return ts.isElementAccessExpression(x) && ts.isStringLiteralLike(x.argumentExpression) && x.argumentExpression.text === 'env' && spaceOf(x.expression) === 'process'
  }
  const isEnv = (e: ts.Expression): boolean => {
    const x = unwrap(e)
    if (isOrigin(x)) return true
    if (ts.isIdentifier(x)) {
      const decl = declarationOf(x)
      return decl !== undefined && envAt.has(decl)
    }
    return ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken) && isEnv(x.right)
  }
  const habitOfValue = (e: ts.Expression): Habit | undefined => {
    const x = unwrapAll(e)
    if (ts.isIdentifier(x)) {
      const decl = declarationOf(x)
      return decl ? habitAt.get(decl) : BARE.get(x.text)
    }
    const got = reflected(x)
    const owner = ts.isPropertyAccessExpression(x) ? spaceOf(x.expression) : got ? spaceOf(got.owner) : undefined
    const habit = owner ? MEMBERS[owner].get(ts.isPropertyAccessExpression(x) ? x.name.text : (got?.key ?? '')) : undefined
    return habit === 'env-whole' ? undefined : habit
  }
  const pauseOfValue = (e: ts.Expression): boolean => {
    const x = unwrapAll(e)
    if (ts.isIdentifier(x)) {
      const decl = declarationOf(x)
      return decl !== undefined && pauseAt.has(decl)
    }
    const got = reflected(x)
    return ts.isPropertyAccessExpression(x) ? pauses(spaceOf(x.expression), x.name.text) : got !== undefined && pauses(spaceOf(got.owner), got.key)
  }
  const keyOf = (name: ts.Node | undefined): string | undefined => (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined)
  const takes = (decl: ts.Node, source: ts.Expression, key: string): void => {
    const space = spaceOf(source)
    if (!space) return
    const inner = INSIDE[space].get(key)
    const habit = MEMBERS[space].get(key)
    if (pauses(space, key)) pauseAt.add(decl)
    if (inner) spaceAt.set(decl, inner)
    if (habit === 'env-whole') envAt.add(decl)
    else if (habit) habitAt.set(decl, habit)
  }
  const learn = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
      const space = MODULES.get(n.moduleSpecifier.text)
      const clause = n.importClause
      if (space && clause.name) spaceAt.set(clause, space)
      const named = clause.namedBindings
      if (space && named && ts.isNamespaceImport(named)) spaceAt.set(named, space)
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const imported = (el.propertyName ?? el.name).text
          names.add(el.name.text)
          if (imported === LOOSE) habitAt.set(el, LOOSE)
          else if (!space) {
            const bare = BARE.get(imported)
            if (bare) habitAt.set(el, bare)
          } else {
            const inner = INSIDE[space].get(imported)
            const habit = MEMBERS[space].get(imported)
            if (pauses(space, imported)) pauseAt.add(el)
            if (inner) spaceAt.set(el, inner)
            if (habit === 'env-whole') envAt.add(el)
            else if (habit) habitAt.set(el, habit)
          }
        }
      }
    } else if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) {
      names.add(n.name.text)
      if (n.initializer && !(ts.isBindingElement(n) && n.propertyName)) {
        if (isEnv(n.initializer)) envAt.add(n)
        const space = spaceOf(n.initializer)
        if (space) spaceAt.set(n, space)
        const habit = habitOfValue(n.initializer)
        if (habit) habitAt.set(n, habit)
        if (pauseOfValue(n.initializer)) pauseAt.add(n)
      }
      if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
        const holder = n.parent.parent
        const key = keyOf(n.propertyName ?? n.name)
        if ((ts.isVariableDeclaration(holder) || ts.isParameter(holder)) && holder.initializer && key) takes(n, holder.initializer, key)
      }
    } else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken || n.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken)) {
      const left = unwrapParens(n.left)
      const given = (target: ts.Node, key?: string): void => {
        const decl = ts.isIdentifier(target) ? declarationOf(target) : undefined
        if (!decl) return
        if (key !== undefined) return takes(decl, n.right, key)
        if (isEnv(n.right)) envAt.add(decl)
        const space = spaceOf(n.right)
        if (space) spaceAt.set(decl, space)
        const habit = habitOfValue(n.right)
        if (habit) habitAt.set(decl, habit)
        if (pauseOfValue(n.right)) pauseAt.add(decl)
      }
      if (ts.isIdentifier(left)) given(left)
      else if (ts.isObjectLiteralExpression(left) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        for (const prop of left.properties) {
          if (ts.isPropertyAssignment(prop)) given(prop.initializer, keyOf(prop.name) ?? '')
          else if (ts.isShorthandPropertyAssignment(prop)) given(prop.name, prop.name.text)
        }
      }
    }
    ts.forEachChild(n, learn)
  }
  learn(sf)
  learn(sf)

  const whole = (n: ts.Expression, at: ts.Node): void => {
    const up = outOf(n)
    const p = up.parent
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === up) return
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.initializer === up && ts.isObjectBindingPattern(p.name)) return
    if (ts.isBinaryExpression(p) && p.right === up && (p.operatorToken.kind === ts.SyntaxKind.InKeyword || (p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(unwrapParens(p.left))))) return
    hit('env-whole', at)
  }
  const named = (key: string): string => `${key} ${REGISTERED.has(key) ? `has a row: ${DOOR}('${key}')` : 'has no row'}`
  const member = (owner: ts.Expression, key: string, at: ts.Node, node?: ts.Expression): void => {
    const space = spaceOf(owner)
    const habit = MEMBERS.react.get(key) ?? (space ? MEMBERS[space].get(key) : undefined)
    if (habit === 'env-whole' && node) whole(node, at)
    else if (habit) hit(habit, at)
    else if (key === LOOSE) hit(LOOSE, at)
  }
  const taken = (source: ts.Expression, key: string | undefined, at: ts.Node): void => {
    if (key === undefined) return
    if (isEnv(source)) hit('env-read', at, named(key))
    else member(source, key, at)
  }
  const callsBare = (e: ts.Expression, name: string): boolean => {
    const x = unwrap(e)
    return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === name && (x.arguments.length === 0 || (x.arguments.length === 1 && yieldsNothing(x.arguments[0]!)))
  }
  const settles = (callback: ts.Expression, resolver: string): boolean => {
    const x = unwrap(callback)
    if (ts.isIdentifier(x)) return x.text === resolver
    if (!(ts.isArrowFunction(x) || ts.isFunctionExpression(x)) || x.parameters.length > 0) return false
    if (!ts.isBlock(x.body)) return callsBare(x.body, resolver)
    const rest = x.body.statements.filter(s => !ts.isEmptyStatement(s))
    const only = rest.length === 1 ? rest[0]! : undefined
    return only !== undefined && (ts.isExpressionStatement(only) || ts.isReturnStatement(only)) && only.expression !== undefined && callsBare(only.expression, resolver)
  }
  const unrefed = (e: ts.Expression): ts.Expression | undefined => {
    const x = unwrap(e)
    return ts.isCallExpression(x) && x.arguments.length === 0 && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'unref' ? unwrap(x.expression.expression) : undefined
  }
  const pauseByHand = (n: ts.NewExpression): string | undefined => {
    const made = n.expression
    const executor = n.arguments?.length === 1 ? unwrap(n.arguments[0]!) : undefined
    if (!ts.isIdentifier(made) || made.text !== 'Promise' || declarationOf(made) || !executor || !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))) return undefined
    const resolver = executor.parameters[0]?.name
    if (!resolver || !ts.isIdentifier(resolver)) return undefined
    const armed = (e: ts.Expression): string | undefined => {
      const x = unwrap(e)
      if (!ts.isCallExpression(x) || x.arguments.length < 1 || x.arguments.length > 2 || !settles(x.arguments[0]!, resolver.text)) return undefined
      const habit = habitOfValue(x.expression)
      if (habit === 'setTimeout') return x.arguments[1] ? squeeze(x.arguments[1].getText(sf)) : '0'
      const delay = x.arguments[1] ? unwrap(x.arguments[1]) : undefined
      if (habit !== undefined || !ts.isIdentifier(x.expression) || !delay || ts.isArrowFunction(delay) || ts.isFunctionExpression(delay)) return undefined
      const decl = declarationOf(x.expression)
      const helper = decl ? (functionOf(decl) ?? functionOf(importedDeclaration(modules, decl))) : undefined
      if (helper?.body && !holds(helper.body, y => ts.isCallExpression(y) && habitOfValue(y.expression) === 'setTimeout')) return undefined
      return squeeze(delay.getText(sf))
    }
    const steps = ts.isBlock(executor.body) ? executor.body.statements.filter(s => !ts.isEmptyStatement(s)) : undefined
    const first = steps?.[0]
    const lone = steps === undefined ? (executor.body as ts.Expression) : steps.length === 1 && first && (ts.isExpressionStatement(first) || ts.isReturnStatement(first)) ? first.expression : undefined
    if (lone) {
      const held = unrefed(lone)
      const delay = armed(held ?? lone)
      return delay === undefined ? undefined : `sleep(${delay}${held ? ', undefined, { unref: true }' : ''})`
    }
    const second = steps?.length === 2 ? steps[1]! : undefined
    const kept = first && second && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1 ? first.declarationList.declarations[0]! : undefined
    if (!second || !kept || !ts.isIdentifier(kept.name) || !kept.initializer) return undefined
    const guarded = ts.isIfStatement(second) && !second.elseStatement ? second.thenStatement : second
    const release = ts.isBlock(guarded) ? (guarded.statements.length === 1 ? guarded.statements[0]! : undefined) : guarded
    const handle = release && ts.isExpressionStatement(release) ? unrefed(release.expression) : undefined
    const delay = handle && ts.isIdentifier(handle) && handle.text === kept.name.text ? armed(kept.initializer) : undefined
    return delay === undefined ? undefined : `sleep(${delay}, undefined, { unref: true })`
  }
  const walk = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.AnyKeyword) tally('any-type')
    if (ts.isIdentifier(n)) {
      if ((names.has(n.text) || BARE.has(n.text)) && isUse(n)) {
        const decl = declarationOf(n)
        const habit = decl ? habitAt.get(decl) : BARE.get(n.text)
        if (habit) hit(habit, n)
      }
    } else if (ts.isPropertyAccessExpression(n)) {
      if (isOrigin(n)) whole(n, n.name)
      else if (isEnv(n.expression)) hit('env-read', n.name, named(n.name.text))
      else member(n.expression, n.name.text, n.name)
    } else if (ts.isElementAccessExpression(n)) {
      const key = ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : undefined
      if (isOrigin(n)) whole(n, n.argumentExpression)
      else if (isEnv(n.expression)) hit('env-read', n.argumentExpression, key === undefined ? 'a name computed at run time' : named(key))
      else if (key !== undefined) member(n.expression, key, n.argumentExpression)
      else if (spaceOf(n.expression) === 'global' || spaceOf(n.expression) === 'process') tally('computed-member')
    } else if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) taken(n.initializer, keyOf(el.propertyName ?? el.name), el)
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(unwrapParens(n.left))) {
      for (const prop of (unwrapParens(n.left) as ts.ObjectLiteralExpression).properties) if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) taken(n.right, keyOf(prop.name), prop)
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && isEnv(n.right)) {
      hit('env-read', n.left, ts.isStringLiteralLike(n.left) ? named(n.left.text) : 'a name computed at run time')
    } else if (ts.isImportSpecifier(n) && envAt.has(n)) {
      hit('env-whole', n)
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && MODULES.has(n.moduleSpecifier.text)) {
      const space = MODULES.get(n.moduleSpecifier.text)!
      if (n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const el of n.exportClause.elements) {
          const habit = MEMBERS[space].get((el.propertyName ?? el.name).text)
          if (!habit) continue
          hit(habit, el)
          tally('exported-alias')
        }
      } else {
        for (const habit of new Set(MEMBERS[space].values())) hit(habit, n)
        tally('exported-alias')
      }
    } else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
      const inner = unwrapParens(n.expression)
      const through = (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && (inner.type.kind === ts.SyntaxKind.UnknownKeyword || inner.type.kind === ts.SyntaxKind.AnyKeyword)
      let held: ts.Node = n
      while (ts.isParenthesizedExpression(held.parent)) held = held.parent
      const insideAnother = ts.isAsExpression(held.parent) || ts.isTypeAssertionExpression(held.parent)
      if (through) hit('as-unknown-as', (inner as ts.AsExpression).type)
      else if (n.type.kind === ts.SyntaxKind.NeverKeyword) hit('as-never', n.type)
      if (n.type.kind === ts.SyntaxKind.AnyKeyword && !insideAnother) hit('as-any', n.type)
      if (!through && ts.isIdentifier(inner) && n.type.kind !== ts.SyntaxKind.UnknownKeyword && n.type.kind !== ts.SyntaxKind.AnyKeyword) {
        const decl = declarationOf(inner)
        if (decl && (ts.isVariableDeclaration(decl) || ts.isParameter(decl)) && decl.type?.kind === ts.SyntaxKind.UnknownKeyword) tally('two-step-cast')
      }
    } else if (ts.isCatchClause(n)) {
      const passed = handsOver(n.block.statements[0]) ? 'door' : passedOver(n.block.statements, false)
      if (passed === 'calls') tally('only-calls')
      else if (passed === 'door') tally('passed-over')
      else if (passed) hit(passed === 'empty' ? 'empty-catch' : 'catch-default', n)
    } else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && LIFECYCLE.has(n.name.text) && ts.isClassLike(n.parent)) {
      hit('lifecycle-method', n.name)
    } else if (ts.isAwaitExpression(n)) {
      const x = unwrap(n.expression)
      if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined') || (ts.isCallExpression(x) && x.arguments.length === 0 && squeeze(x.expression.getText(sf)) === 'Promise.resolve')) hit('queueMicrotask', n)
    } else if (ts.isExpressionStatement(n)) {
      let x: ts.Expression = n.expression
      while (ts.isVoidExpression(x) || ts.isAwaitExpression(x)) x = x.expression
      if (ts.isCallExpression(x) && squeeze(x.expression.getText(sf)) === 'Promise.allSettled') tally('all-settled')
    } else if (ts.isNewExpression(n)) {
      const instead = pauseByHand(n)
      if (instead) hit(PAUSE, n, `${instead} from ${SLEEP_DOOR}`)
    } else if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.propertyName?.text === 'sleep' && n.name.text !== 'sleep') {
      const from = n.parent.parent
      const spec = ts.isImportClause(from) ? from.parent.moduleSpecifier : from.moduleSpecifier
      if (spec && ts.isStringLiteral(spec) && opensDoor(spec.text)) hit(ALIAS, n, `import { sleep } from '${spec.text}'`)
    } else if (ts.isBindingElement(n) && n.propertyName && keyOf(n.propertyName) === 'sleep' && keyOf(n.name) !== 'sleep' && ts.isObjectBindingPattern(n.parent) && ts.isVariableDeclaration(n.parent.parent) && n.parent.parent.initializer) {
      const loaded = unwrapAll(n.parent.parent.initializer)
      const spec = ts.isCallExpression(loaded) && loaded.expression.kind === ts.SyntaxKind.ImportKeyword ? loaded.arguments[0] : undefined
      if (spec && ts.isStringLiteralLike(spec) && opensDoor(spec.text)) hit(ALIAS, n, `const { sleep } = await import('${spec.text}')`)
    }
    if (ts.isCallExpression(n)) {
      const effect = screenEffect(n.expression)
      if (effect) hit(effect, n.expression)
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'race' && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Promise' && !declarationOf(n.expression.expression)) hit(RACE, n.expression.name)
      else if (ts.isIdentifier(n.expression) && ofDoor(n.expression, TIMER_DOOR) === INTERVAL) hit(INTERVAL, n.expression)
      const waited = n.arguments.find(a => ts.isObjectLiteralExpression(unwrap(a)))
      const heard = waited ? (unwrap(waited) as ts.ObjectLiteralExpression).properties.find(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && keyOf(p.name) === 'signal') : undefined
      const signal = heard ? (ts.isPropertyAssignment(heard) ? squeeze(heard.initializer.getText(sf)) : 'signal') : undefined
      const first = n.arguments[0] ? squeeze(n.arguments[0].getText(sf)) : '0'
      if (pauseOfValue(n.expression)) hit(PAUSE, n, `sleep(${first}${signal ? `, ${signal}, { throwOnAbort: true }` : ''}) from ${SLEEP_DOOR}`)
      else if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'sleep' && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Bun' && !declarationOf(n.expression.expression)) hit(PAUSE, n, `sleep(${first}) from ${SLEEP_DOOR}`)
      if (ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text
        const target = n.expression.expression
        const first = method === 'catch' ? handlerPasses(n.arguments[0]) : undefined
        const second = method === 'then' ? handlerPasses(n.arguments[1]) : undefined
        if (first === 'calls' || second === 'calls') tally('only-calls')
        if (first === 'door' || second === 'door') tally('passed-over')
        if (first === 'empty' || first === 'default') hit(first === 'empty' ? 'empty-catch-handler' : 'handler-default', n.expression.name)
        if (second === 'empty' || second === 'default') hit(second === 'empty' ? 'empty-catch-handler' : 'handler-default', n.arguments[1]!)
        if (method === 'then' && ts.isCallExpression(target) && target.arguments.length === 0 && squeeze(target.expression.getText(sf)) === 'Promise.resolve') hit('queueMicrotask', n.expression.name)
        const got = reflected(n)
        if (got && isOrigin(n)) whole(n, got.at)
        else if (got && isEnv(got.owner)) hit('env-read', got.at, named(got.key))
        else if (got) member(got.owner, got.key, got.at)
        else if (method === 'get' && ts.isIdentifier(target) && target.text === 'Reflect' && n.arguments[0] && (spaceOf(n.arguments[0]) !== undefined || isEnv(n.arguments[0]))) tally('computed-member')
      }
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ''
      const command = n.arguments[0]
      if (CHILD.has(callee) && command && ts.isStringLiteralLike(command) && /^sleep(?:\s|$)/.test(command.text)) tally('child-sleep')
      const armed = habitOfValue(n.expression) ?? (ts.isPropertyAccessExpression(n.expression) ? MEMBERS.react.get(n.expression.name.text) : undefined)
      if (armed && WRAPPED.has(armed) && command) {
        let fn: ts.Node | undefined = n.parent
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
        const holder = fn && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent))) ? fn : undefined
        const handed = new Set(holder ? holder.parameters.flatMap(p => (ts.isIdentifier(p.name) ? [p.name.text] : [])) : [])
        if (handed.size > 0 && ((ts.isIdentifier(command) && handed.has(command.text)) || ((ts.isArrowFunction(command) || ts.isFunctionExpression(command)) && holds(command, x => ts.isIdentifier(x) && handed.has(x.text))))) tally('wrapper')
      }
      if ((callee === 'useMemo' || callee === 'useState') && command && (ts.isArrowFunction(command) || ts.isFunctionExpression(command)) && ts.isBlock(command.body)) {
        const outside = (target: ts.Expression): boolean => {
          let root = target
          while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isCallExpression(root) || ts.isNonNullExpression(root) || ts.isParenthesizedExpression(root)) root = root.expression
          if (!ts.isIdentifier(root)) return root.kind === ts.SyntaxKind.ThisKeyword
          const decl = declarationOf(root)
          return !decl || decl.pos < command.pos || decl.end > command.end
        }
        const effect = holds(command.body, s => {
          if (!ts.isExpressionStatement(s)) return false
          const x = stripped(s.expression)
          return ts.isCallExpression(x) ? outside(x.expression) : ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && outside(x.left)
        })
        if (effect) tally('memo-effect')
      }
    }
    if (ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isForStatement(n)) {
      const test = ts.isForStatement(n) ? n.condition : n.expression
      if (test && holds(test, x => ts.isCallExpression(x) && /^(?:Date|performance)\.now$/.test(squeeze(x.expression.getText(sf)))) && !holds(n.statement, x => ts.isAwaitExpression(x) || ts.isYieldExpression(x))) tally('busy-loop')
    }
    if (ts.isVariableStatement(n) && (ts.getModifiers(n) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of n.declarationList.declarations) if (d.initializer && (isEnv(d.initializer) || habitOfValue(d.initializer) !== undefined || spaceOf(d.initializer) !== undefined)) tally('exported-alias')
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
  const exports = (s: ts.Statement, name: string): boolean => ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword) && ((ts.isFunctionDeclaration(s) && s.name?.text === name) || (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)))
  const own = DOORS.find(door => door.file === file && sf.statements.some(s => exports(s, door.opens)))?.own ?? []
  for (const h of out) if (own.includes(h.habit)) tally(`${OWN}${file} ${h.habit}`)
  return out.filter(h => !own.includes(h.habit)).sort((a, b) => a.line - b.line || a.column - b.column)
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (rel === 'src' && AT_THE_ROOT.has(name)) continue
      const path = `${rel}/${name}`
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (CODE.test(name) && !PAYLOAD_FILES.has(path)) out.push(path)
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

const rowKey = (habit: Habit, file: string): string => `${habit}\t${file}`

const render = (rows: Rows, classed: Classed = new Map()): string =>
  NAMES.flatMap(habit =>
    [...rows.get(habit)!]
      .sort(([a], [b]) => inOrder(a, b))
      .map(([file, count]) => `${habit}\t${file}\t${count}${classed.has(rowKey(habit, file)) ? `\t${classed.get(rowKey(habit, file))}` : ''}\n`),
  ).join('')

function tableOf(text: string, ofAnotherReader = false, classed?: Classed): Rows | null {
  const table = rowsOf([])
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^([^\t]+)\t(src\/[^\t]+)\t([1-9][0-9]*)(?:\t([^\t]+))?$/.exec(line)
    const files = m ? table.get(m[1] as Habit) : undefined
    if (m && !files && ofAnotherReader) continue
    if (!m || !files || files.has(m[2]!) || (m[4] !== undefined && !CLASSED.has(m[1] as Habit))) return null
    files.set(m[2]!, Number(m[3]))
    if (m[4] !== undefined) classed?.set(rowKey(m[1] as Habit, m[2]!), m[4])
  }
  return table
}

const CLASS_WORDS = /^([a-z0-9-]+) ([1-9][0-9]*)$/

function unclassed(rows: Rows, classed: Classed): string[] {
  const out: string[] = []
  for (const habit of CLASSED) {
    for (const [file, count] of [...rows.get(habit)!].sort(([a], [b]) => inOrder(a, b))) {
      const words = classed.get(rowKey(habit, file))
      const parts = (words ?? '').split(' · ').map(part => CLASS_WORDS.exec(part))
      const known = words !== undefined && parts.every(part => part !== null && CLASSES.includes(part[1]!))
      const named = parts.reduce((n, part) => n + Number(part?.[2] ?? 0), 0)
      if (!known || named !== count) out.push(`${file} ${habit}: the file holds ${count} and its row says ${words === undefined ? 'no class' : `"${words}"`}`)
    }
  }
  return out
}

const nameOf = (file: string): string => file.slice(file.lastIndexOf('/') + 1)

function carried(rows: Rows, was: Classed): Classed {
  const out: Classed = new Map()
  for (const habit of CLASSED) {
    const files = rows.get(habit)!
    const gone = [...was.keys()].flatMap(key => (key.startsWith(`${habit}\t`) && !files.has(key.slice(habit.length + 1)) ? [key.slice(habit.length + 1)] : []))
    const fresh = [...files.keys()].filter(file => !was.has(rowKey(habit, file)))
    for (const [file, count] of files) {
      const from = gone.filter(old => nameOf(old) === nameOf(file))
      const moved = from.length === 1 && fresh.filter(other => nameOf(other) === nameOf(file)).length === 1 ? from[0] : undefined
      const words = was.get(rowKey(habit, file)) ?? (moved === undefined ? undefined : was.get(rowKey(habit, moved)))
      if (words === undefined) continue
      const parts = words.split(' · ').map(part => CLASS_WORDS.exec(part))
      const left = parts.flatMap(part => (part ? [[part[1]!, Number(part[2])] as [string, number]] : []))
      let over = left.reduce((n, [, held]) => n + held, 0) - count
      if (left.length === 1 && left.length === parts.length) left[0]![1] = count
      else for (const moving of MOVING) for (const entry of left) if (entry[0] === moving && over > 0) {
        const taken = Math.min(over, entry[1])
        entry[1] -= taken
        over -= taken
      }
      out.set(rowKey(habit, file), left.length !== parts.length || (left.length > 1 && over !== 0) ? words : left.filter(([, held]) => held > 0).map(([cls, held]) => `${cls} ${held}`).join(' · '))
    }
  }
  return out
}

function seeded(hits: Hit[], census: string, was: Classed): Classed {
  const of = new Map(census.split('\n').flatMap(line => (line.split('\t').length === 2 ? [line.split('\t') as [string, string]] : [])))
  const tally = new Map<string, Map<string, number>>()
  for (const h of hits) {
    const cls = CLASSED.has(h.habit) ? of.get(`${h.file}:${h.line}`) : undefined
    if (cls === undefined) continue
    const per = tally.get(rowKey(h.habit, h.file)) ?? new Map<string, number>()
    tally.set(rowKey(h.habit, h.file), per.set(cls, (per.get(cls) ?? 0) + 1))
  }
  const out = new Map(was)
  for (const [key, per] of tally) out.set(key, [...per].sort(([a], [b]) => CLASSES.indexOf(a) - CLASSES.indexOf(b)).map(([cls, n]) => `${cls} ${n}`).join(' · '))
  return out
}

const CLASS_WAY = `write the class of each site in the fourth column of its row in ${TABLE}, as "events 1 · clock 1" (the classes: ${CLASSES.join(', ')}); bun ${SELF} --write keeps the column and moves the count of a row of one class with its file, and --write --classes <a census of file:line and class, one site a line> writes it from a census`

function judge(habit: Habit, hits: Hit[], table: Rows): Verdict {
  const allowed = table.get(habit)!
  const lines = new Map<string, Array<{ line: number; note: string }>>()
  for (const h of hits) if (h.habit === habit) lines.set(h.file, [...(lines.get(h.file) ?? []), { line: h.line, note: h.note }])
  const over = [...lines]
    .filter(([file, at]) => at.length > (allowed.get(file) ?? 0))
    .map(([file, at]) => ({ file, row: allowed.get(file) ?? 0, lines: at }))
    .sort((a, b) => inOrder(a.file, b.file))
  const total = [...lines.values()].reduce((n, at) => n + at.length, 0)
  const slack = [...allowed].filter(([file, row]) => (lines.get(file)?.length ?? 0) < row).length
  return { over, total, allowed: sum(allowed), files: lines.size, slack }
}

function refusals(change: Change, only?: Set<string>): Refusal[] {
  const out: Refusal[] = []
  const read = new Map<string, Hit[]>()
  const printsOf = (side: 'before' | 'after', file: string, habit: Habit): Hit[] => {
    const key = `${side}\u0000${file}`
    if (!read.has(key)) {
      const text = change[side](file)
      read.set(key, text === null ? [] : habitsIn(file, text, true))
    }
    return read.get(key)!.filter(h => h.habit === habit)
  }
  for (const habit of NAMES) {
    let left: Map<string, string[]> | null = null
    const leftOver = (): Map<string, string[]> => {
      if (left) return left
      left = new Map()
      for (const file of change.touched) {
        const stay = printsOf('after', file, habit).map(h => h.print)
        for (const h of printsOf('before', file, habit)) {
          const kept = stay.indexOf(h.print)
          if (kept >= 0) stay.splice(kept, 1)
          else left.set(h.print, [...(left.get(h.print) ?? []), `${file}:${h.line}`])
        }
      }
      return left
    }
    for (const file of change.touched) {
      if (change.taken.has(file) || (only && !only.has(file))) continue
      const arrived = printsOf('after', file, habit)
      const stood = printsOf('before', file, habit).map(h => h.print)
      const base = stood.length
      if (arrived.length <= base) continue
      const fresh: number[] = []
      let moved = 0
      for (const h of arrived) {
        const same = stood.indexOf(h.print)
        if (same >= 0) {
          stood.splice(same, 1)
          continue
        }
        const from = leftOver().get(h.print)
        if (from && from.length > 0) {
          from.shift()
          moved++
        } else fresh.push(h.line)
      }
      if (arrived.length > base + moved) out.push({ habit, file, lines: fresh, change: change.name, why: `it holds ${arrived.length}: ${base} stood and ${moved} arrived with ${moved === 1 ? 'its statement' : 'their statements'}` })
    }
  }
  return out
}

function refusedSince(chain: Chain, counts: Rows): Refusal[] {
  const risen = new Set(chain.span.touched.filter(file => NAMES.some(habit => (counts.get(habit)!.get(file) ?? 0) > (chain.was.get(habit)!.get(file) ?? 0))))
  const inOneStep = refusals(chain.span, risen)
  if (inOneStep.length === 0 || chain.links.length === 0) return inOneStep
  return chain.links.flatMap(link => refusals(link, new Set(inOneStep.map(r => r.file))))
}

function handRaised(was: Rows, table: Rows, counts: Rows): string[] {
  const out: string[] = []
  for (const habit of NAMES) {
    for (const [file, row] of table.get(habit)!) {
      const before = was.get(habit)!.get(file) ?? 0
      const held = counts.get(habit)!.get(file) ?? 0
      if (row > Math.max(before, held)) out.push(`${file} ${habit}: its row says ${row}, the last written table says ${before} and the file holds ${held}`)
    }
  }
  return out
}

const MOVE = `A statement that moves whole between files takes its count along, and bun ${SELF} --write in the same change writes the rows. A statement edited while it moves reads as new: move it first and commit that with its table, edit it after`

const told = (habit: Habit, over: Over[]): string =>
  `${over.length} file${over.length === 1 ? '' : 's'} above — instead: ${HABITS[habit]}. ${MOVE}:` +
  over
    .slice(0, 40)
    .map(o => `\n      ${o.file} holds ${o.lines.length} of ${habit} and ${o.row === 0 ? 'has no row' : `its row allows ${o.row}`}${o.file.startsWith(PAYLOADS) ? ` (a payload that runs outside the product goes on the list of payload files in ${SELF} and is then not read)` : ''}:` + o.lines.map(at => `\n        ${o.file}:${at.line} ${habit}${at.note === '' ? '' : ` · ${at.note}`}`).join(''))
    .join('') +
  (over.length > 40 ? `\n      … and ${over.length - 40} more files` : '')

const toldRefusals = (found: Refusal[]): string =>
  `${found.length} file${found.length === 1 ? '' : 's'} — ${MOVE}:` +
  found
    .slice(0, 40)
    .map(r => `\n      in ${r.change}, ${r.file} ${r.habit}: ${r.why} — new, instead: ${HABITS[r.habit]}` + r.lines.map(line => `\n        ${r.file}:${line} ${r.habit} is new: no statement that left another file in that change reads the same`).join(''))
    .join('') +
  (found.length > 40 ? `\n      … and ${found.length - 40} more` : '')

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function blobs(root: string, commit: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (files.length === 0) return out
  const held = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: files.map(file => `${commit}:${file}\n`).join(''), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  let at = 0
  for (const file of files) {
    const end = held.indexOf(10, at)
    if (end < 0) throw new Error(`git cat-file --batch stopped before ${commit}:${file}`)
    const head = held.toString('utf8', at, end).split(' ')
    at = end + 1
    if (head.length !== 3 || head[1] !== 'blob') continue
    const size = Number(head[2])
    out.set(file, held.toString('utf8', at, at + size))
    at += size + 1
  }
  return out
}

function chainSince(root: string, files: string[]): Chain | null {
  const dirty = git(root, 'status', '--porcelain', '--', 'src', TABLE, SELF, CENSUS)
  if (dirty === null) return null
  const lastWrite = (start: string): string => (git(root, 'log', '-1', '--first-parent', '--format=%H', start, '--', TABLE) ?? '').trim()
  let from = lastWrite(dirty.trim() === '' ? 'HEAD^' : 'HEAD')
  let written = from === '' ? null : git(root, 'show', `${from}:${TABLE}`)
  while (from !== '' && written === null) {
    from = lastWrite(`${from}^`)
    written = from === '' ? null : git(root, 'show', `${from}:${TABLE}`)
  }
  if (from === '' || written === null) return null
  const differ = (...between: string[]): string[] => (git(root, 'diff', '--name-only', '--no-renames', ...between, '--', 'src') ?? '').split('\n').filter(file => CODE.test(file) && !PAYLOAD_FILES.has(file))
  const side = (commit: string, touched: string[]): Side => {
    let held: Map<string, string> | null = null
    return file => (held ??= blobs(root, commit, touched)).get(file) ?? null
  }
  const onDisk: Side = file => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null)
  const stood = new Set((git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'src') ?? '').split('\n'))
  const fresh = files.filter(file => !stood.has(file))
  const links: Change[] = []
  for (const line of (git(root, 'rev-list', '--reverse', '--topo-order', '--parents', `${from}..HEAD`) ?? '').split('\n')) {
    const [commit, first, second] = line.split(' ')
    if (!commit || !first) continue
    const touched = differ(first, commit)
    const fork = second ? (git(root, 'merge-base', first, second) ?? '').trim() : ''
    const mine = new Set(fork === '' ? [] : differ(fork, first))
    const theirs = new Set(fork === '' || !second ? [] : differ(second, commit))
    links.push({ name: `commit ${commit.slice(0, 10)}`, touched, taken: new Set(fork === '' ? [] : touched.filter(file => !mine.has(file) && !theirs.has(file))), before: side(first, touched), after: side(commit, touched) })
  }
  if (dirty.trim() !== '') {
    const touched = [...new Set([...differ('HEAD'), ...fresh])].sort()
    links.push({ name: 'the working tree', touched, taken: new Set(), before: side('HEAD', touched), after: onDisk })
  }
  const touched = [...new Set([...differ(from), ...fresh])].sort()
  return { from, was: tableOf(written, true) ?? rowsOf([]), span: { name: `the changes since ${from.slice(0, 10)}`, touched, taken: new Set(), before: side(from, touched), after: onDisk }, links }
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function plantedEstate(): void {
  const doorLines = ['export function flagEnv(name: string): string | undefined {', '  return process.env[name]', '}', 'export const later = setTimeout(() => {}, 1)']
  const failureDoorLines = ['export function passedOver(error: unknown): void { try { sink?.(error) } catch {} }', 'export const home = process.env.HOME', 'export function read(): unknown { try { return work() } catch { return null } }']
  const ambientDoorLines = ['export function hostEnv(): NodeJS.ProcessEnv { return process.env }', 'export const gone = value as never']
  const timerDoorLines = ['export function startTimeout(fn: () => void, ms?: number): ReturnType<typeof setTimeout> { return setTimeout(fn, ms) }', 'export function startInterval(fn: () => void, ms?: number): ReturnType<typeof setInterval> { return setInterval(fn, ms) }', 'export function startImmediate(fn: () => void): unknown { return setImmediate(fn) }', 'export function startMicrotask(fn: () => void): void { queueMicrotask(fn) }', 'export function sleepSync(ms: number): void { Atomics.wait(cells, 0, 0, ms) }', 'export const home = process.env.HOME']
  const effectDoorLines = ["import { useEffect, useLayoutEffect } from 'react'", 'export function useMount(effect: () => void): void { useEffect(effect, []) }', 'export function useMeasure(measure: () => void): void { useLayoutEffect(measure) }', 'export const home = process.env.HOME']
  const deadlineDoorLines = ['export function withDeadline<T>(work: Promise<T>, limit: Promise<never>): Promise<T> { return Promise.race([work, limit]) }', 'export const home = process.env.HOME']
  const planted: Array<{ file: string; lines: string[]; seen: Array<[number, Habit]> }> = [
    {
      file: 'src/planted/screen.ts',
      lines: ["import { useSubscription as hear, useDerivedState, useLayoutDerivedState } from '../screen/effects/effects.js'", "import * as effects from '../screen/effects/effects.js'", 'hear(fn, [])', 'useDerivedState(fn)', 'useLayoutDerivedState(fn)', 'effects.useLayoutSubscription(fn)', "effects['useMeasure'](fn)", 'function local(hear: () => void) { hear() }', 'other.useMeasure(fn)'],
      seen: [[3, 'useSubscription'], [4, 'useDerivedState'], [5, 'useLayoutDerivedState'], [6, 'useLayoutSubscription'], [7, 'useMeasure']],
    },
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
        'const host = globalThis',
        'host.setTimeout(() => {}, 1)',
        'const proc = process',
        'proc.nextTick(() => {})',
        'const arm = setTimeout',
        'arm(() => {}, 2)',
        'const { setImmediate: soon } = globalThis',
        'soon(() => {})',
        "const lazy = require('node:timers')",
        'lazy.setInterval(() => {}, 3)',
        "const { setTimeout: nap } = await import('node:timers/promises')",
        'await nap(4)',
        "import { promises as timersPromises } from 'node:timers'",
        "import { scheduler } from 'node:timers/promises'",
        'await timersPromises.setTimeout(5)',
        'await scheduler.wait(6)',
        'await timers.promises.setImmediate()',
        'Atomics.wait(cells, 0, 0, 7)',
        'void Promise.resolve().then(() => {})',
        'await Promise.resolve()',
        'await null',
        'await new Promise(resolve => setTimeout(resolve, 8))',
        'const napped = new Promise<void>(done => { const held = setTimeout(() => done(), 9); held.unref?.() })',
        'function linger(ms: number): Promise<void> { return new Promise(function (ok) { globalThis.setTimeout(ok, ms).unref() }) }',
        'const bound = new Promise<void>(resolve => { handle = setTimeout(resolve, 10) })',
        "const valued = new Promise<string>(resolve => setTimeout(() => resolve('late'), 11))",
        "const raced = new Promise<void>(resolve => { setTimeout(resolve, 12); socket.once('close', resolve) })",
        'await Bun.sleep(13)',
        'await new Promise<void>(resolve => kick(resolve, 14))',
        'function nudge(done: () => void, ms: number): void { setTimeout(done, ms) }',
        'await new Promise<void>(resolve => nudge(resolve, 15))',
        "import { sleep as doze } from '../platform/async/sleep.js'",
        "const { sleep: snooze } = await import('../platform/async/sleep.js')",
        "export { sleep as rest } from '../platform/async/sleep.js'",
        'await delay(16, undefined, { signal })',
      ],
      seen: [
        [3, 'env-whole'], [4, 'setTimeout'], [5, 'setTimeout'], [6, 'setInterval'], [7, PAUSE], [7, 'setTimeout'], [8, 'setInterval'], [9, 'setImmediate'], [10, 'setImmediate'], [11, 'queueMicrotask'], [12, 'process.nextTick'], [13, 'process.nextTick'], [14, 'setTimeout'], [15, 'setInterval'], [16, 'env-read'], [17, 'setInterval'],
        [20, 'setTimeout'], [22, 'process.nextTick'], [23, 'setTimeout'], [24, 'setTimeout'], [25, 'setImmediate'], [26, 'setImmediate'], [28, 'setInterval'], [29, 'setTimeout'], [30, PAUSE], [30, 'setTimeout'], [33, PAUSE], [33, 'setTimeout'], [34, PAUSE], [34, 'setTimeout'], [35, 'setImmediate'], [36, 'Atomics.wait'], [37, 'queueMicrotask'], [38, 'queueMicrotask'], [39, 'queueMicrotask'],
        [40, PAUSE], [40, 'setTimeout'], [41, PAUSE], [41, 'setTimeout'], [42, PAUSE], [42, 'setTimeout'], [43, 'setTimeout'], [44, 'setTimeout'], [45, 'setTimeout'],
        [46, PAUSE], [47, PAUSE], [48, 'setTimeout'], [49, PAUSE], [50, ALIAS], [51, ALIAS], [52, ALIAS], [53, PAUSE], [53, 'setTimeout'],
      ],
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
        'work().catch(() => fallback()).catch(() => void report())',
        'schema.catch(undefined)',
        'const pattern = /catch \\{\\}|as unknown as|\\/\\/ @ts-ignore/',
        'const typed = (input: any): never[] => []',
        'function settle(env: NodeJS.ProcessEnv): string | undefined { return env.HOME }',
        'function recovered(): unknown { try { return work() } catch (error) { return recover(error) } }',
        'await work()',
        'Promise.resolve(value).then(done)',
        'const store = { wait: () => 0 }; store.wait()',
        'const ticked = new Promise<void>(resolve => clock.setTimeout(resolve, 5))',
        'await clock.sleep(5)',
        'function heard(done: () => void, label: string): void { listeners.set(label, done) }',
        "const closed = new Promise<void>(resolve => heard(resolve, 'closed'))",
        'const woken = new Promise<void>(resolve => waiters.push(resolve))',
        "import { sleep } from '../platform/async/sleep.js'",
        "import { sleep as tick } from './sleep.js'",
        "import { passedOver, passedOverAs } from '../platform/errors/passedOver.js'",
        'try { work() } catch (error) { passedOver(error) }',
        'function answered(): unknown { try { return work() } catch (error) { passedOver(error); return null } }',
        'work().catch(passedOver).then(done, passedOverAs(null))',
        'work().catch(error => { passedOver(error); return fallback() })',
        "const said = 'Promise.race([a, b]) and startInterval(tick, 5)'",
        'const lone = { race: (all: unknown[]) => all[0] }; lone.race([1])',
        'function settleFirst(Promise: { race(all: unknown[]): unknown }): unknown { return Promise.race([1]) }',
        'clock.startInterval(() => {}, 5)',
        "import { startInterval as everyOther } from './timers.js'",
        'everyOther(() => {}, 5)',
        'export const out = [words, told, handle, able, run, mySetTimeout, setTimeoutMs, resetTimeout, wide, narrow, pattern, typed, settle, recovered, store, ticked, said, settleFirst]',
      ],
      seen: [],
    },
    {
      file: 'src/planted/Screen.tsx',
      lines: [
        "import React, { useEffect, useLayoutEffect as useMeasure, useInsertionEffect, useImperativeHandle } from 'react'",
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
        '  useImperativeHandle(ref, () => ({}), [])',
        '  return <Box>{/* eslint-disable-next-line react-hooks/exhaustive-deps */}useEffect(run) // @ts-ignore {process.env.HOME}</Box>',
        '}',
        'export class Panel extends React.Component { componentDidMount(): void {} componentWillUnmount(): void {} render(): React.ReactNode { return null } }',
      ],
      seen: [[4, 'useEffect'], [5, 'useLayoutEffect'], [6, 'useInsertionEffect'], [7, 'useEffect'], [8, 'useLayoutEffect'], [9, 'useEffect'], [10, 'useEffect'], [11, 'useEffect'], [11, 'useEffect'], [12, 'useImperativeHandle'], [13, 'lint-directive'], [13, 'env-read'], [15, 'lifecycle-method'], [15, 'lifecycle-method']],
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
        'const gone = value as never',
        'const loose = value as any',
        'const angled = <any>value',
        'const dead = (value as unknown) as never',
        'function a1(): unknown { try { return work() } catch { return null } }',
        'function a2(): void { try { work() } catch { return } }',
        'for (const item of items) { try { work(item) } catch { continue } }',
        'try { work() } catch (error) { void error }',
        'work().catch(() => null)',
        'work().catch(() => { return false })',
        'work().then(done, () => [])',
        'work().catch(error => { void error })',
        'const cached = process.env',
        'const term = cached.TERM',
        'const path = (options.env ?? process.env).PATH',
        'const { HOME: house, USER: me } = process.env',
        "const seen = 'CI' in process.env",
        'const bun = Bun.env.HOME',
        'const meta = import.meta.env.MODE',
        "import { flagEnvLoose } from '../substrate/registry.ts'",
        "const loosely = flagEnvLoose('MERCURY_PLANTED')",
        "export { setInterval as each } from 'node:timers'",
        "export { env as hostEnv } from 'node:process'",
        'function mine({ env: own } = process): string | undefined { return own.HOME }',
        '({ env: taken } = process)',
        '// @TS-NOCHECK',
        '/* eslint no-console: "off" */',
        '// noinspection JSUnusedGlobalSymbols',
        '/* istanbul ignore next */',
        'export const more = [gone, loose, angled, dead, cached, term, path, house, me, seen, bun, meta, loosely, mine, taken]',
        'let late: NodeJS.ProcessEnv | undefined',
        'late = process.env',
        'const lateHome = late?.HOME',
        "const reflected = [Reflect.get(process, 'env').SHELL, Reflect.get(globalThis, 'setImmediate'), lateHome]",
      ],
      seen: [
        [2, 'lint-directive'], [3, 'as-unknown-as'], [4, 'as-unknown-as'], [5, 'as-unknown-as'], [6, 'ts-ignore'], [8, 'ts-ignore'], [10, 'lint-directive'], [11, 'lint-directive'], [12, 'lint-directive'],
        [13, 'empty-catch'], [14, 'empty-catch'], [16, 'empty-catch'], [17, 'empty-catch-handler'], [18, 'empty-catch-handler'], [18, 'empty-catch-handler'], [19, 'empty-catch-handler'], [21, 'empty-catch-handler'], [22, 'empty-catch-handler'],
        [23, 'env-read'], [24, 'env-read'], [25, 'env-whole'], [26, 'env-whole'], [27, 'env-whole'], [27, 'env-read'], [28, 'env-read'],
        [30, 'as-never'], [31, 'as-any'], [32, 'as-any'], [33, 'as-unknown-as'], [34, 'catch-default'], [35, 'catch-default'], [36, 'catch-default'], [37, 'empty-catch'], [38, 'handler-default'], [39, 'handler-default'], [40, 'handler-default'], [41, 'empty-catch-handler'],
        [42, 'env-whole'], [43, 'env-read'], [44, 'env-whole'], [44, 'env-read'], [45, 'env-read'], [45, 'env-read'], [46, 'env-read'], [47, 'env-read'], [48, 'env-read'], [50, LOOSE], [51, 'setInterval'], [52, 'env-whole'], [53, 'env-whole'], [53, 'env-read'], [54, 'env-whole'], [55, 'ts-ignore'], [56, 'lint-directive'], [57, 'lint-directive'], [58, 'lint-directive'],
        [61, 'env-whole'], [62, 'env-read'], [63, 'env-read'], [63, 'setImmediate'],
      ],
    },
    { file: DOOR_FILE, lines: doorLines, seen: [[4, 'setTimeout']] },
    { file: 'src/planted/door.ts', lines: doorLines, seen: [[2, 'env-read'], [4, 'setTimeout']] },
    { file: FAILURE_DOOR, lines: failureDoorLines, seen: [[2, 'env-read'], [3, 'catch-default']] },
    { file: 'src/planted/passed.ts', lines: failureDoorLines, seen: [[1, 'empty-catch'], [2, 'env-read'], [3, 'catch-default']] },
    { file: AMBIENT_DOOR, lines: ambientDoorLines, seen: [[2, 'as-never']] },
    { file: 'src/planted/ambient.ts', lines: ambientDoorLines, seen: [[1, 'env-whole'], [2, 'as-never']] },
    { file: TIMER_DOOR, lines: timerDoorLines, seen: [[6, 'env-read']] },
    { file: 'src/planted/timersTwin.ts', lines: timerDoorLines, seen: [[1, 'setTimeout'], [2, 'setInterval'], [3, 'setImmediate'], [4, 'queueMicrotask'], [5, 'Atomics.wait'], [6, 'env-read']] },
    { file: EFFECT_DOOR, lines: effectDoorLines, seen: [[4, 'env-read']] },
    { file: 'src/planted/hooks.ts', lines: effectDoorLines, seen: [[2, 'useEffect'], [3, 'useLayoutEffect'], [4, 'env-read']] },
    { file: DEADLINE_DOOR, lines: deadlineDoorLines, seen: [[2, 'env-read']] },
    { file: 'src/planted/deadlineTwin.ts', lines: deadlineDoorLines, seen: [[1, RACE], [2, 'env-read']] },
    {
      file: 'src/planted/waits.ts',
      lines: [
        "import { startInterval } from '../platform/async/timers.js'",
        'const first = await Promise.race([work(), other()])',
        'const beat = startInterval(() => {}, 1000)',
        "const { startInterval: every } = await import('../platform/async/timers.js')",
        'const ticking = every(() => {}, 5)',
        'const both = [await Promise.race([a, b]), await Promise.race([c, d])]',
        'export const out = [first, beat, ticking, both]',
      ],
      seen: [[2, RACE], [3, INTERVAL], [5, INTERVAL], [6, RACE], [6, RACE]],
    },
    { file: 'src/planted/worker.mjs', lines: ["import { setTimeout as pause } from 'timers/promises'", 'await pause(5)', 'setInterval(() => {}, 5)', 'try { run() } catch {}', 'export const home = process.env.HOME'], seen: [[2, PAUSE], [2, 'setTimeout'], [3, 'setInterval'], [4, 'empty-catch'], [5, 'env-read']] },
    {
      file: 'src/planted/beyond.ts',
      lines: [
        "import { useMemo, useState } from 'react'",
        'export function later(run: () => void, ms: number): void { setTimeout(run, ms) }',
        'const raw: unknown = read()',
        'const shaped = raw as Shape',
        'const loose: any = raw',
        'const key = pick()',
        'globalThis[key]()',
        "spawnSync('sleep', ['1'])",
        'while (Date.now() < until) {}',
        'void Promise.allSettled(jobs)',
        'function Panel(): number { const made = useMemo(() => { store.count = 1; return 1 }, []); const [first] = useState(() => { announce(); return 2 }); const kept = useMemo(() => { const list: number[] = []; list.push(1); return list }, []); return made + first + kept.length }',
        'try { work() } catch (error) { report(error) }',
        'work().catch(error => report(error))',
        'export const hostEnv = process.env',
        'export const out = [shaped, loose, Panel]',
        "import { passedOver, passedOverAs } from '../platform/errors/passedOver.js'",
        'try { work() } catch (error) { passedOver(error) }',
        'work().catch(passedOver).then(done, passedOverAs(0))',
      ],
      seen: [[2, 'setTimeout'], [14, 'env-whole']],
    },
  ]
  const far = new Map<string, number>()
  const farHits = planted.flatMap(p => (p.file === 'src/planted/beyond.ts' ? habitsIn(p.file, p.lines.join('\n') + '\n', false, far) : []))
  const farSeen = BEYOND.map(([form]) => `${form} ${beyondCount(form, far, farHits)}`).join(' · ')
  const hits = planted.flatMap(p => habitsIn(p.file, p.lines.join('\n') + '\n'))
  const seen = hits.map(h => `${h.file}:${h.line} ${h.habit}`)
  const want = planted.flatMap(p => p.seen.map(([line, habit]) => `${p.file}:${line} ${habit}`))
  const differs = [...seen.filter(s => !want.includes(s)).map(s => `seen and not wanted ${s}`), ...want.filter(w => !seen.includes(w)).map(w => `wanted and not seen ${w}`), ...(seen.length === want.length ? [] : [`${seen.length} seen, ${want.length} wanted`])].join(' · ')
  const of = (file: string): string => seen.filter(s => s.startsWith(`${file}:`)).join(' ')
  const wanted = (file: string): string => want.filter(w => w.startsWith(`${file}:`)).join(' ')
  const stands = (file: string): boolean => of(file) === wanted(file)
  check(
    'a timer is seen as a call of the global, as a member of globalThis or window, by a bracketed name, under the name an import gives it, as a member of the timers module, of its promises and of its scheduler, loaded by require or by a dynamic import, as a value, through a constant that holds the global or the timer, and through a name taken out of globalThis, each use counted; process.nextTick, Atomics.wait and a microtask queued through a resolved promise or an await of nothing are seen; a pause built by hand is seen where the executor of a new Promise only arms the timer that resolves it (the resolver handed to the timer or called with nothing, with unref on the handle or without), and not where the executor keeps the handle, resolves with a value or does anything more; a call of the timer of timers/promises is seen as a pause under the name an import gives it, as a member, through its scheduler and with a signal, and so are Bun.sleep and a promise whose executor hands its resolver and a delay to a helper; the door imported, taken out of a dynamic import or exported again under another name is seen',
    stands('src/planted/timers.ts'),
    differs,
  )
  check(
    'an effect is seen as a call of the hook, under the name the import gives it, as a member of React under either import and of the React a host hands in, taken out of React with each use of the taken name, and as a value; useImperativeHandle and the lifecycle methods of a class are seen; a lint directive in a JSX comment and an environment read in a JSX expression are seen, and the same words in JSX text are not',
    stands('src/planted/Screen.tsx'),
    differs,
  )
  const doorSpelled = Object.entries(HABITS).filter(([, line]) => /platform\/async\/sleep\.ts/.test(line))
  check(
    `a line that names the door spells it one way, ${SLEEP_DOOR} (${doorSpelled.length} of the ${NAMES.length} lines name it)`,
    doorSpelled.length >= 8 && doorSpelled.every(([, line]) => (line.match(/[\w/]*platform\/async\/sleep\.ts/g) ?? []).every(spelling => spelling === SLEEP_DOOR)),
    doorSpelled.filter(([, line]) => (line.match(/[\w/]*platform\/async\/sleep\.ts/g) ?? []).some(spelling => spelling !== SLEEP_DOOR)).map(([habit]) => habit).join(', '),
  )
  check(
    'a cast through unknown or any is seen in both spellings, and a cast to never and a cast to any alone; @ts-ignore, @ts-expect-error and @TS-NOCHECK are seen; a lint directive is seen for eslint in its three forms, biome, prettier, an editor inspection and a coverage tool; a catch block is seen empty (also with a lone semicolon or a void of the error) and answering with a default (a return, a return of null, a continue); a rejection handler is seen empty and answering with a default',
    stands('src/planted/rest.ts'),
    differs,
  )
  check(
    'a name of the environment is seen read, bracketed, written, taken out by a destructure, tested with in, and read through a constant, a parameter or a fallback that holds the whole environment, and through Bun.env and import.meta.env; the whole environment is seen as a default, a spread, a constant, taken out of process in a declaration, a parameter or an assignment, imported or re-exported from node:process; a re-export from the timers module and a call of the loose door of the registry are seen',
    stands('src/planted/rest.ts') && stands('src/planted/timers.ts'),
    differs,
  )
  check('a plain JavaScript module is read as the TypeScript ones are', stands('src/planted/worker.mjs'), differs)
  check(`a race of promises is seen as a call of ${RACE}, each call counted, and an interval of the timer door as a call of its ${INTERVAL}, under its own name and taken out of a dynamic import`, stands('src/planted/waits.ts'), differs)
  check(`the registry (${DOOR_FILE}, known by its path and its export of ${DOOR}) is the door of the environment: its own reads are not counted and its other habits are; another file that exports a function of that name is counted like any file`, DOOR_FILE !== '' && existsSync(join(ROOT, DOOR_FILE)) && stands(DOOR_FILE) && stands('src/planted/door.ts'), differs)
  check(
    `each door of a habit is known by its path and one export, and what it holds of its own habit is not counted while its other habits are: ${FAILURE_DOOR} (${PASS}: the empty catch round its sink), ${AMBIENT_DOOR} (hostEnv: the environment), ${TIMER_DOOR} (startTimeout: the timers, the microtask and the synchronous wait), ${EFFECT_DOOR} (useMount: the two effects), ${DEADLINE_DOOR} (withDeadline: the race of a work against its limit); the same lines in another file are counted like any file`,
    [FAILURE_DOOR, 'src/planted/passed.ts', AMBIENT_DOOR, 'src/planted/ambient.ts', TIMER_DOOR, 'src/planted/timersTwin.ts', EFFECT_DOOR, 'src/planted/hooks.ts', DEADLINE_DOOR, 'src/planted/deadlineTwin.ts'].every(stands),
    differs,
  )
  check(
    'a look-alike is not seen: the words in a string, a template or a regular expression; a type query and a typeof test; a method of that name on a socket, a clock or a store; a function, a parameter or a constant of the file under that name; a property named env; an environment a caller hands in as a parameter with no default; the any keyword and never in a type; a cast to unknown alone and a cast between two types; a catch block and a handler that do something or answer with a computed value; a catch block and a handler that hand the failure to the door first (passedOver as the first statement or as the handler, passedOverAs for a default); a schema fallback; an await of work and a promise resolved with a value; a promise that waits on the timer of a clock; a sleep that is the method of a clock, a helper whose body arms no timer, a list that keeps the resolver, the door under its own name and a sleep of another module; a race of another object or of a Promise the file declares, and a startInterval of a clock or of another module',
    of('src/planted/lookalikes.ts') === '',
    of('src/planted/lookalikes.ts'),
  )
  check('screen effects from the hook door are counted under their imported or qualified name, but not when shadowed or on a different object', stands('src/planted/screen.ts'), differs)
  check(`every habit of the fence is seen on the planted estate (${NAMES.length})`, NAMES.every(habit => hits.some(h => h.habit === habit)), NAMES.filter(habit => !hits.some(h => h.habit === habit)).join(', '))
  check(
    `each of the ${BEYOND.length} forms that stay out of reach is counted where it is planted: a wrapper, an exported alias, the environment handed on whole, a cast in two statements, the any keyword, a computed member, a child sleep, a loop on the clock, a dropped allSettled, a useMemo callback and a useState initialiser that change what is outside them (one that fills its own list is not counted), a catch and a handler that hold only calls, and a catch and two handlers that hand the failure to the door first`,
    stands('src/planted/beyond.ts') && farSeen === 'wrapper 1 · exported-alias 1 · env-whole 1 · two-step-cast 1 · any-type 1 · computed-member 1 · child-sleep 1 · busy-loop 1 · all-settled 1 · memo-effect 2 · only-calls 2 · passed-over 3',
    `${farSeen} | ${differs}`,
  )
  const rows = rowsOf(hits)
  const text = render(rows)
  const table = tableOf(text)
  check('the table is one row for each habit and file with its count, in the order of the habits and then of the files, and reads back as written', table !== null && render(table) === text && text.startsWith('setTimeout\tsrc/planted/beyond.ts\t1\nsetTimeout\tsrc/planted/door.ts\t1\nsetTimeout\tsrc/planted/timers.ts\t') && text.includes('\nsetInterval\tsrc/planted/rest.ts\t1\n'), text.replaceAll('\n', ' · ').slice(0, 400))
  check('a table with a habit the fence does not hold, a file outside src, a count of 0, a row twice or a class on a habit that takes none does not read, and the table of another reader is read for the habits this one holds', tableOf('sleep\tsrc/a.ts\t1\n') === null && tableOf('setTimeout\tscripts/a.ts\t1\n') === null && tableOf('setTimeout\tsrc/a.ts\t0\n') === null && tableOf('setTimeout\tsrc/a.ts\t1\nsetTimeout\tsrc/a.ts\t1\n') === null && tableOf('setTimeout\tsrc/a.ts\t1\tevents 1\n') === null && tableOf('process.env\tsrc/a.ts\t3\nsetTimeout\tsrc/a.ts\t2\n', true)?.get('setTimeout')?.get('src/a.ts') === 2)
  if (table === null) return
  const waits = 'src/planted/waits.ts'
  const marked: Classed = new Map()
  const markedText = `${RACE}\t${waits}\t3\tdeadline 1 · events 2\n${INTERVAL}\t${waits}\t2\tclock 2\n`
  const markedTable = tableOf(markedText, false, marked)
  const waitRows = rowsOf(hits.filter(h => h.file === waits))
  const fell = rowsOf(hits.filter(h => h.file === waits && h.line !== 2 && h.line !== 5))
  const kept = carried(fell, marked)
  const short = carried(rowsOf(hits.filter(h => h.file === waits && h.line === 2)), marked)
  const census = seeded(hits, `${waits}:2\tdeadline\n${waits}:6\tevents\n${waits}:3\tclock\n${waits}:5\theartbeat\n`, new Map())
  const loose = [unclassed(waitRows, new Map(marked).set(rowKey(INTERVAL, waits), 'clock 1')), unclassed(waitRows, new Map(marked).set(rowKey(RACE, waits), 'deadline 1 · racing 2')), unclassed(waitRows, new Map())]
  check(
    `a row of ${RACE} and of ${INTERVAL} carries the class of each site its file holds, read and written back as it stands; it is named when its classes do not add up to the file's count, hold a word that is not a class, or are missing; --write keeps the classes, moves the count of a row of one class with its file, takes a fall in a row of several classes from the classes that move (${MOVING.join(', ')}) and from no other, and --classes writes them from a census of sites`,
    markedTable !== null && render(markedTable, marked) === markedText && unclassed(waitRows, marked).length === 0 && loose[0]!.join() === `${waits} ${INTERVAL}: the file holds 2 and its row says "clock 1"` && loose[1]!.length === 1 && loose[2]!.length === 2 && kept.get(rowKey(INTERVAL, waits)) === 'clock 1' && kept.get(rowKey(RACE, waits)) === 'events 2' && short.get(rowKey(RACE, waits)) === 'deadline 1 · events 2' && census.get(rowKey(RACE, waits)) === 'deadline 1 · events 2' && census.get(rowKey(INTERVAL, waits)) === 'clock 1 · heartbeat 1',
    JSON.stringify({ loose, kept: [...kept], short: [...short], census: [...census] }),
  )
  const movedTo = 'src/planted/later/waits.ts'
  const movedRows = rowsOf([])
  movedRows.get(RACE)!.set(movedTo, 3)
  movedRows.get(INTERVAL)!.set(movedTo, 1)
  const followed = carried(movedRows, marked)
  const twoRows = rowsOf([])
  twoRows.get(RACE)!.set('src/planted/one/waits.ts', 3).set('src/planted/two/waits.ts', 3)
  const two = carried(twoRows, marked)
  check(
    `a row of ${RACE} and of ${INTERVAL} whose file moved keeps its classes at the new path when the one file of that name left the table and one came to it, and none when two came`,
    followed.get(rowKey(RACE, movedTo)) === 'deadline 1 · events 2' && followed.get(rowKey(INTERVAL, movedTo)) === 'clock 1' && followed.size === 2 && two.size === 0,
    JSON.stringify({ followed: [...followed], two: [...two] }),
  )
  check('on its own table the planted estate stands for every habit', NAMES.every(habit => judge(habit, hits, table).over.length === 0 && judge(habit, hits, table).total === judge(habit, hits, table).allowed))
  const unrowed = tableOf(text.replace('env-read\tsrc/planted/Screen.tsx\t1\n', ''))!
  const lone = judge('env-read', hits, unrowed)
  check('a file with no row that holds a habit is named with its line and what to use instead, and a name of the environment with whether the registry holds its row', lone.over.length === 1 && lone.total === lone.allowed + 1 && told('env-read', lone.over).includes('src/planted/Screen.tsx:13 env-read · HOME has no row') && told('env-read', lone.over).includes('has no row:') && told('env-read', lone.over).includes(DOOR) && named(hits, 'src/planted/rest.ts', 50) === '', told('env-read', lone.over))
  const plantedPauses = hits.filter(h => h.habit === PAUSE && h.file === 'src/planted/timers.ts').length
  const paused = judge(PAUSE, hits, tableOf(text.replace(`${PAUSE}\tsrc/planted/timers.ts\t${plantedPauses}\n`, ''))!)
  const pausedWords = told(PAUSE, paused.over)
  check(
    'a pause in a file with no row is red by its own line, which names the call of sleep that replaces it and the file the call comes from: a promise built over a timer, the timer of timers/promises under a name, as a member, through its scheduler and with a signal, Bun.sleep, and a helper that is handed the resolver',
    plantedPauses === 11 && paused.over.length === 1 && paused.total === paused.allowed + plantedPauses && pausedWords.includes(`call sleep(ms, signal?, opts?) from ${SLEEP_DOOR}`) && [`7 ${PAUSE} · sleep(5)`, `30 ${PAUSE} · sleep(4)`, `33 ${PAUSE} · sleep(5)`, `34 ${PAUSE} · sleep(6)`, `40 ${PAUSE} · sleep(8)`, `41 ${PAUSE} · sleep(9, undefined, { unref: true })`, `42 ${PAUSE} · sleep(ms, undefined, { unref: true })`, `46 ${PAUSE} · sleep(13)`, `47 ${PAUSE} · sleep(14)`, `49 ${PAUSE} · sleep(15)`, `53 ${PAUSE} · sleep(16, signal, { throwOnAbort: true })`].every(line => pausedWords.includes(`src/planted/timers.ts:${line} from ${SLEEP_DOOR}`)),
    pausedWords,
  )
  const aliased = judge(ALIAS, hits, tableOf(text.replace(`${ALIAS}\tsrc/planted/timers.ts\t3\n`, ''))!)
  const aliasedWords = told(ALIAS, aliased.over)
  check(
    'the door under another name in a file with no row is red by its own line, which says to import it as sleep: an import, a name taken out of a dynamic import and a re-export',
    aliased.over.length === 1 && aliased.total === aliased.allowed + 3 && aliasedWords.includes(`import { sleep } from ${SLEEP_DOOR}`) && [`50 ${ALIAS} · import { sleep } from '../platform/async/sleep.js'`, `51 ${ALIAS} · const { sleep } = await import('../platform/async/sleep.js')`, `52 ${ALIAS} · import { sleep } from '../platform/async/sleep.js'`].every(line => aliasedWords.includes(`src/planted/timers.ts:${line}`)),
    aliasedWords,
  )
  const lowered = tableOf(text.replace('empty-catch\tsrc/planted/rest.ts\t4\n', 'empty-catch\tsrc/planted/rest.ts\t3\n'))!
  const raised = judge('empty-catch', hits, lowered)
  check('a file that holds one more than its row allows is named with every line it holds', raised.over.length === 1 && ['13', '14', '16', '37'].every(line => told('empty-catch', raised.over).includes(`src/planted/rest.ts:${line} empty-catch`)) && told('empty-catch', raised.over).includes('its row allows 3'), told('empty-catch', raised.over))
  const fallen = judge('setTimeout', hits.filter(h => h.file !== 'src/planted/worker.mjs'), table)
  check('a count that fell stands, and its row is counted as standing above it', fallen.over.length === 0 && fallen.total === fallen.allowed - 1 && fallen.slack === 1, JSON.stringify(fallen))
  const lines = (files: Record<string, string[]>): Map<string, string> => new Map(Object.entries(files).map(([file, body]) => [file, body.join('\n') + '\n']))
  const changed = (before: Record<string, string[]>, after: Record<string, string[]>, taken: string[] = []): Change => {
    const stood = lines(before)
    const now = lines(after)
    return { name: 'planted', touched: [...new Set([...stood.keys(), ...now.keys()])].filter(file => stood.get(file) !== now.get(file)).sort(), taken: new Set(taken), before: file => stood.get(file) ?? null, after: file => now.get(file) ?? null }
  }
  const said = (found: Refusal[]): string => found.map(r => `${r.file} ${r.habit} ${r.lines.join(',')}`).join(' · ')
  const ruled = (before: Record<string, string[]>, after: Record<string, string[]>, taken: string[] = []): string => said(refusals(changed(before, after, taken)))
  const countsOf = (files: Record<string, string[]>): Rows => rowsOf([...lines(files)].flatMap(([file, body]) => habitsIn(file, body)))
  const A = ['export function arm(): void {', '  setTimeout(() => stop(), 50)', '}', 'export const keep = setTimeout(() => {}, 1)']
  const A_LESS = ['export function arm(): void {', '}', 'export const keep = setTimeout(() => {}, 1)']
  const GONE = ['export const lost = setTimeout(() => {}, 9)']
  const STILL = ['export const one = setTimeout(() => {}, 2)']
  const FRESH = 'export const fresh = setTimeout(() => {}, 3)'
  const estate = { 'src/planted/a.ts': A, 'src/planted/gone.ts': GONE, 'src/planted/still.ts': STILL }
  const moved = { ...estate, 'src/planted/a.ts': A_LESS, 'src/planted/b.ts': ['setTimeout(() => stop(), 50)'] }
  const movedAndEdited = { ...estate, 'src/planted/a.ts': A_LESS, 'src/planted/b.ts': ['setTimeout(() => stop(), 60)'] }
  const grown = { ...estate, 'src/planted/still.ts': [...STILL, FRESH] }
  const split = ruled(estate, moved)
  const renamed = ruled(estate, { 'src/planted/a.ts': A, 'src/planted/there.ts': GONE, 'src/planted/still.ts': STILL })
  const nowExported = ruled({ 'src/planted/a.ts': ['const keep = setTimeout(() => {}, 1)', 'function read(env = process.env): string | undefined { return env.HOME }'] }, { 'src/planted/b.ts': ['export const keep = setTimeout(() => {}, 1)', 'export function read(env = process.env): string | undefined { return env.HOME ?? env.USER }'] })
  check(
    'a file holds more of a habit only with the statement: one that moves whole into a new file is let through, and so is a file that is renamed; a declaration that gains export on the way is the same statement, and a default of a parameter is known by its function and the parameter, so the body may change while the statement that changed in it reads as new',
    split === '' && renamed === '' && nowExported === 'src/planted/b.ts env-read 2,2',
    `${split} | ${renamed} | ${nowExported}`,
  )
  const paidByAFall = ruled(estate, { ...estate, 'src/planted/a.ts': A_LESS, 'src/planted/b.ts': [FRESH] })
  const paidByADeletion = ruled(estate, { 'src/planted/a.ts': A, 'src/planted/still.ts': [...STILL, FRESH] })
  const edited = ruled(estate, movedAndEdited)
  check('a new occurrence is refused with its line when another left a file that stands, when a file was deleted in the same change, and when the statement was edited while it moved', paidByAFall === 'src/planted/b.ts setTimeout 1' && paidByADeletion === 'src/planted/still.ts setTimeout 2' && edited === 'src/planted/b.ts setTimeout 1', `${paidByAFall} | ${paidByADeletion} | ${edited}`)
  const chainOf = (steps: Array<Record<string, string[]>>, table: Record<string, string[]>): Chain => ({ from: 'planted', was: countsOf(table), span: changed(steps[0]!, steps.at(-1)!), links: steps.slice(1).map((step, i) => changed(steps[i]!, step)) })
  const inTwo = said(refusedSince(chainOf([estate, moved, movedAndEdited], estate), countsOf(movedAndEdited)))
  const inOne = said(refusedSince(chainOf([estate, movedAndEdited], estate), countsOf(movedAndEdited)))
  const newThenMoved = said(refusedSince(chainOf([estate, grown, { ...grown, 'src/planted/a.ts': A_LESS, 'src/planted/b.ts': ['setTimeout(() => stop(), 50)'] }], estate), countsOf({ ...grown, 'src/planted/a.ts': A_LESS, 'src/planted/b.ts': ['setTimeout(() => stop(), 50)'] })))
  const underSlack = said(refusedSince(chainOf([estate, grown], grown), countsOf(grown)))
  check(
    'each change since the last written table is read on its own when the whole does not read as a move: moved in one commit and edited in the next stands, the same in one commit does not, and a new occurrence in one commit is refused with a move in the next beside it; a file that is not above the last written table is not read again',
    inTwo === '' && inOne === 'src/planted/b.ts setTimeout 1' && newThenMoved === 'src/planted/still.ts setTimeout 2' && underSlack === '',
    `${inTwo} | ${inOne} | ${newThenMoved} | ${underSlack}`,
  )
  const takenWhole = ruled(estate, grown, ['src/planted/still.ts'])
  check('a file a merge takes whole from the side that alone changed it is left to the commits of that side', takenWhole === '' && ruled(estate, grown) === 'src/planted/still.ts setTimeout 2', takenWhole)
  const lifted = (rowsNow: Rows): string => handRaised(countsOf(estate), rowsNow, countsOf(estate)).join(' · ')
  const byHand = countsOf(estate)
  byHand.get('setTimeout')!.set('src/planted/still.ts', 2)
  const afterAFall = handRaised(countsOf(grown), countsOf(grown), countsOf(estate)).join(' · ')
  const firstCount = handRaised(rowsOf([]), countsOf(estate), countsOf(estate)).join(' · ')
  check(
    'a row raised by hand is named: it stands above the last written table and above what its file holds; a row left above its file by a fall is not, and neither is the first count of a habit the last table did not hold',
    lifted(byHand) === 'src/planted/still.ts setTimeout: its row says 2, the last written table says 1 and the file holds 1' && lifted(countsOf(estate)) === '' && afterAFall === '' && firstCount === '',
    `${lifted(byHand)} | ${afterAFall} | ${firstCount}`,
  )
}

const named = (hits: Hit[], file: string, line: number): string => hits.find(h => h.file === file && h.line === line)?.note ?? '?'
function beyondCount(form: string, tallies: Map<string, number>, hits: Hit[]): number {
  return tallies.get(form) ?? hits.filter(h => h.habit === form).length
}

section('§0 the reader on a planted estate: each habit is seen with its line, each look-alike is not, and a row rises only with its statement')
plantedEstate()

section(`§1 the estate: the habits in the code under src, counted for each file and in all, against ${TABLE}`)
const files = sourceFiles(ROOT)
const beyond = new Map<string, number>()
const hits = files.flatMap(file => habitsIn(file, readFileSync(join(ROOT, file), 'utf8'), false, beyond))
const rows = rowsOf(hits)
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const classed: Classed = new Map()
const table = text === null ? null : tableOf(text, false, classed)
const payloads = [...PAYLOAD_FILES].filter(file => existsSync(join(ROOT, file))).length
console.log(`  ${files.length} code files under src · ${hits.length} occurrences of ${NAMES.length} habits · aside: the ${PAYLOAD_FILES.size} payload files under ${PAYLOADS} (they run outside the product and cannot import its doors) and what each door holds of its own habit (${[...beyond].filter(([form]) => form.startsWith(OWN)).map(([form, count]) => `${form.slice(OWN.length)} ${count}`).join(' · ') || 'none'})`)
check(
  `the code under src is read (${files.length} files), and every payload file of the list stands (${payloads} of ${PAYLOAD_FILES.size})`,
  files.length > 3000 && payloads === PAYLOAD_FILES.size,
  `${files.length} files read, more than 3000 wanted; gone from the tree and still on the list of payload files in ${PAYLOAD_LIST}, to take off it: ${[...PAYLOAD_FILES].filter(file => !existsSync(join(ROOT, file))).join(', ') || 'none'}`,
)
if (process.argv.includes('--list')) {
  const asked = NAMES.filter(habit => process.argv.includes(habit))
  for (const h of hits) if (asked.length === 0 || asked.includes(h.habit)) console.log(`${h.habit}\t${h.file}\t${h.line}\t${h.column}`)
} else if (process.argv.includes('--write')) {
  const chain = chainSince(ROOT, files)
  const refused = chain === null ? [] : refusedSince(chain, rows)
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate')
  else if (refused.length > 0) check(`a file holds more of a habit only with a statement that left another file (the last written table: ${chain!.from.slice(0, 10)})`, false, `nothing written — ${toldRefusals(refused)}`)
  else {
    const census = process.argv[process.argv.indexOf('--classes') + 1]
    const kept = process.argv.includes('--classes') && census !== undefined ? seeded(hits, readFileSync(census, 'utf8'), carried(rows, classed)) : carried(rows, classed)
    writeFileSync(join(ROOT, TABLE), render(rows, kept))
    console.log(`  wrote ${TABLE}: ${NAMES.reduce((n, habit) => n + rows.get(habit)!.size, 0)} rows, ${hits.length} occurrences${chain === null ? ' (no commit holds a table: the first one)' : ` (the last written table: ${chain.from.slice(0, 10)}; ${chain.span.touched.length} files differ from it)`}`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a habit, a file and its count`, false, text === null ? `no table: put the table of the last commit back (git checkout -- ${TABLE}); a tree that never held one writes the first with bun ${SELF} --write` : `a row is not a habit of the fence, a file under src and a count of 1 or more, or a habit and file stand twice; after a change of the reader, bun ${SELF} --write writes the table of the new one`)
} else {
  let slack = 0
  for (const habit of NAMES) {
    const found = judge(habit, hits, table)
    slack += found.slack
    check(`${habit}: no file holds more than its row allows, a file with no row holds none, and the total is at most the table's (${found.total} in ${found.files} files, ${found.allowed} allowed)`, found.over.length === 0 && found.total <= found.allowed, told(habit, found.over))
  }
  const chain = chainSince(ROOT, files)
  if (chain === null) console.log('  no commit to read the last written table from: the rows are held to the table as it stands')
  else {
    const refused = refusedSince(chain, rows)
    check(`no file holds more of a habit than at the last written table but by statements that moved (${chain.from.slice(0, 10)}; ${chain.span.touched.length} files differ from it, in ${chain.links.length} change${chain.links.length === 1 ? '' : 's'})`, refused.length === 0, toldRefusals(refused))
    const lifted = handRaised(chain.was, table, rows)
    check('no row stands above both the last written table and what its file holds: a row is written by --write and never by hand', lifted.length === 0, `${lifted.length} row${lifted.length === 1 ? '' : 's'} — bun ${SELF} --write puts each row at what its file holds:` + lifted.slice(0, 40).map(row => `\n      ${row}`).join(''))
  }
  const loose = unclassed(rows, classed)
  check(`every row of ${RACE} and ${INTERVAL} names the class of each site its file holds (${CLASSED.size} habits, ${[...CLASSED].reduce((n, habit) => n + rows.get(habit)!.size, 0)} rows)`, loose.length === 0, `${loose.length} row${loose.length === 1 ? '' : 's'} — ${CLASS_WAY}:` + loose.slice(0, 40).map(row => `\n      ${row}`).join(''))
  console.log(`  out of reach, counted here and held by no row: ${BEYOND.map(([form, words]) => `${words} (${beyondCount(form, beyond, hits)} today)`).join('; ')}`)
  if (slack > 0) console.log(`  rows above their file's count: ${slack} (bun ${SELF} --write lowers them)`)
}
console.log(failures === 0 ? '\nprove-source-patterns: green' : `\nprove-source-patterns: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
