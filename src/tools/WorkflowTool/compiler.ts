// ============================================================================
// Workflow script compilation.
//
// A workflow script is plain async JavaScript whose first statement is a
// pure-literal `export const meta = {...}` block. This module turns the part
// after the meta block into a reusable vm.Script for a hardened realm, and
// owns everything that must be decided before a realm exists:
//
//   • parseWorkflowScript — meta extraction + validation (pure literal only);
//   • rewriteAwaits / compileWorkflow — the await interception that routes
//     every awaited value through an in-realm settle helper, so Promises and
//     thenables crossing the VM↔host boundary resolve under the sandbox
//     realm's own Promise machinery;
//   • installDeterminismShim — the wall-clock/randomness lockout that keeps a
//     run replayable from its journal;
//   • scriptUsesNonDeterminism — the static detector behind the friendlier
//     pre-launch rejection message;
//   • MAX_SCRIPT_BYTES / SYNC_TIMEOUT_MS — the limits every consumer shares.
//
// Import discipline: node:vm + acorn only. No sibling imports — this module
// stays independently loadable and testable.
// ============================================================================

import vm from 'node:vm'
import { parse as parseSource } from 'acorn'
import * as astWalk from 'acorn-walk'

// ── Shared limits ────────────────────────────────────────────────────────────

/** Maximum accepted workflow-script size (512 KiB). Enforced here against
 *  string length and by the directory loaders against true bytes. */
export const MAX_SCRIPT_BYTES = 524288 // 512 * 1024

/** Synchronous-execution ceiling handed to vm runs: caps a host-blocking
 *  loop in the script's synchronous prologue. */
export const SYNC_TIMEOUT_MS = 30000

// Prefix reserved for the helper bindings the await transform introduces into
// compiled scripts. User identifiers starting with it are refused up front so
// no script can shadow a helper. The spelling is a compatibility constant:
// the refusal message quotes it, and existing scripts were validated against
// exactly this value.
const SETTLE_PREFIX = '__wRg$'

// ── Determinism error texts (user-facing; fixed) ────────────────────────────
const CLOCK_LOCKOUT_MSG =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume).' +
  ' Stamp results after the workflow returns, or pass timestamps via args.'
const RANDOM_LOCKOUT_MSG =
  'Math.random() is unavailable in workflow scripts (breaks resume).' +
  ' For N independent samples, include the index in the agent label or prompt.'

// ── The determinism shim ─────────────────────────────────────────────────────
//
// Evaluated in a freshly created realm, ahead of the intrinsic lockdown. Locks
// out the two replay hazards — Math.random and every clock-reading Date form —
// while the explicit-timestamp forms (new Date(value), Date.parse, Date.UTC)
// stay legal. The non-obvious move: `(new Date(x)).constructor` would still
// reach the native Date, and through it a working .now, unless the prototype's
// constructor is re-pointed at the guard and the native is then frozen so that
// wiring sticks.
export const DETERMINISM_SHIM_SRC = `(() => {
      const CLOCK_MSG = ${JSON.stringify(CLOCK_LOCKOUT_MSG)};
      const RANDOM_MSG = ${JSON.stringify(RANDOM_LOCKOUT_MSG)};
      Math.random = function random() { throw new Error(RANDOM_MSG) };
      const RealDate = Date;
      RealDate.now = function now() { throw new Error(CLOCK_MSG) };
      function GuardedDate(...args) {
        // Bare Date() and zero-argument new Date() both read the clock.
        if (!new.target || args.length === 0) throw new Error(CLOCK_MSG);
        return Reflect.construct(RealDate, args, new.target);
      }
      GuardedDate.now = RealDate.now;
      GuardedDate.parse = RealDate.parse;
      GuardedDate.UTC = RealDate.UTC;
      GuardedDate.prototype = RealDate.prototype;
      RealDate.prototype.constructor = GuardedDate;
      Object.freeze(RealDate);
      globalThis.Date = GuardedDate;
    })()`

/** Install the determinism shim into a realm — the top-level realm AND every
 *  child-workflow realm each get one. */
export function installDeterminismShim(ctx: vm.Context): void {
  vm.runInContext(DETERMINISM_SHIM_SRC, ctx)
}

// ── Loosely-typed AST node view (acorn's nodes are structurally typed) ──────
interface SyntaxNode {
  type: string
  start: number
  end: number
  name?: string
  [k: string]: unknown
}

// ── Detached error surrogate ────────────────────────────────────────────────
//
// A null-prototype plain object standing in for an Error when the throw can
// reach another realm (the dynamic-import rejection below). A live host Error
// would hand the catching realm a walk back to un-frozen host intrinsics.
function severedError(message: string, name = 'Error', stack?: string): object {
  const rendered = `${name}: ${message}`
  const toString = () => rendered
  Object.setPrototypeOf(toString, null)
  return { __proto__: null, name, message, stack: stack ?? rendered, toString }
}

// ── The await transform ──────────────────────────────────────────────────────
//
// Anything that flows through `await` — plus async-arrow expression bodies,
// returns inside async functions, `for await` iterables, and async-generator
// yield/yield*/return — is routed through a settle-helper call. Unwrapped, a
// promise minted host-side reaches the sandbox's await as an opaque foreign
// object; wrapped, the value settles under the sandbox's own Promise
// machinery.

// Parsing happens inside this wrapper so top-level await/return are legal; the
// wrapper lengths drive the final unwrap, hence named constants over hand
// counts. Exactly one newline precedes the body: user line N sits on compiled
// line N+1, a stable offset for stack traces.
const WRAP_HEAD = "(async () => {'use strict';\n"
const WRAP_TAIL = '\n})()'

export function rewriteAwaits(body: string): string {
  const prefix = SETTLE_PREFIX
  const parseText = `${WRAP_HEAD}${body}${WRAP_TAIL}`
  const tree = parseSource(parseText, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
  }) as unknown as SyntaxNode

  // Refusal pass — the whole tree, BEFORE any edit is considered, so a
  // reserved identifier or `with` always outranks the second-pass refusals.
  astWalk.full(tree as never, ((node: SyntaxNode) => {
    if (node.type === 'WithStatement')
      throw new SyntaxError("'with' statements are not supported in workflow scripts.")
    if (node.name?.startsWith(prefix))
      throw new SyntaxError(`Identifier '${node.name}' is reserved.`)
  }) as never)

  // Edits are insert-only {at, text} pairs; user bytes are never rewritten.
  const inserts: Array<{ at: number; text: string }> = []
  const wrapWith = (open: string, target: SyntaxNode | null | undefined) => {
    if (!target) return
    inserts.push({ at: target.start, text: open })
    inserts.push({ at: target.end, text: '))' })
  }
  const settleWrap = (target: SyntaxNode | null | undefined) => wrapWith(` ${prefix}((`, target)
  const adapterWrap = (target: SyntaxNode | null | undefined) => wrapWith(` ${prefix}a((`, target)

  // The nearest enclosing function of the node under visit. The walker's
  // ancestor list ends with the node itself, so the scan starts one above it.
  const enclosingFunction = (ancestors: SyntaxNode[]): SyntaxNode | undefined => {
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const kind = ancestors[i]?.type
      if (
        kind === 'FunctionDeclaration' ||
        kind === 'FunctionExpression' ||
        kind === 'ArrowFunctionExpression'
      ) {
        return ancestors[i]
      }
    }
    return undefined
  }

  astWalk.ancestor(tree as never, {
    VariableDeclaration(node: SyntaxNode) {
      if (node.kind === 'await using')
        throw new SyntaxError("'await using' declarations are not supported in workflow scripts.")
    },
    AwaitExpression(node: SyntaxNode) {
      settleWrap(node.argument as SyntaxNode)
    },
    ArrowFunctionExpression(node: SyntaxNode) {
      // `async () => EXPR` — the expression body is an implicit await target.
      if (node.async && node.expression) settleWrap(node.body as SyntaxNode)
    },
    ForOfStatement(node: SyntaxNode) {
      // `for await (… of EXPR)` — the iterable rides the async-iterator
      // adapter, which settles every protocol step.
      if (node.await) adapterWrap(node.right as SyntaxNode)
    },
    ReturnStatement(node: SyntaxNode, _state: unknown, ancestors: SyntaxNode[]) {
      const fn = enclosingFunction(ancestors)
      if (!fn?.async) return
      if (!fn.generator) {
        settleWrap(node.argument as SyntaxNode)
        return
      }
      // An async generator's `return EXPR` is not implicitly awaited — the
      // settled value needs an explicit await spliced in front.
      if (node.argument) {
        const target = node.argument as SyntaxNode
        inserts.push({ at: target.start, text: ` await ${prefix}((` })
        inserts.push({ at: target.end, text: '))' })
      }
    },
    YieldExpression(node: SyntaxNode, _state: unknown, ancestors: SyntaxNode[]) {
      const fn = enclosingFunction(ancestors)
      if (!(fn?.async && fn.generator)) return
      if (node.delegate) {
        // `yield* EXPR` delegates the whole iteration — adapter, not settle.
        if (node.argument) adapterWrap(node.argument as SyntaxNode)
      } else {
        settleWrap(node.argument as SyntaxNode)
      }
    },
  } as never)

  if (inserts.length === 0) return body
  // Apply from the highest offset down so the lower offsets stay valid. Two
  // inserts share an offset only as a pair of `))`, where order cannot matter.
  inserts.sort((a, b) => b.at - a.at)
  let edited = parseText
  for (const { at, text } of inserts) edited = edited.slice(0, at) + text + edited.slice(at)
  return edited.slice(WRAP_HEAD.length, edited.length - WRAP_TAIL.length)
}

// ── Compilation ──────────────────────────────────────────────────────────────

export interface CompileResult {
  ok: true
  vmScript: vm.Script
}
export interface CompileError {
  ok: false
  error: string
}

// The async-iterator adapter, parameterized on the settle prefix. Given a
// (possibly cross-realm) iterable it returns an async-iterable whose
// next/return/throw settle EVERY protocol step — the step result and its
// .value both — through the settle helper, with the spec's own protocol
// checks. Dense single-expression source: it concatenates AFTER the script
// body, so its formatting never shifts the body's line numbers.
function adapterSourceFor(prefix: string): string {
  const q = prefix
  return (
    `${q}src => ({[Symbol.asyncIterator](){` +
    `const ${q}fn = ${q}src[Symbol.asyncIterator];` +
    `if (${q}fn != null && typeof ${q}fn !== 'function') throw new TypeError('@@asyncIterator is not a function');` +
    `const ${q}it = ${q}fn != null ? ${q}fn.call(${q}src) : ${q}src[Symbol.iterator]();` +
    `if (${q}it === null || (typeof ${q}it !== 'object' && typeof ${q}it !== 'function')) throw new TypeError('Iterator is not an object');` +
    `const ${q}next = ${q}it.next;` +
    `if (typeof ${q}next !== 'function') throw new TypeError('Iterator.next is not a function');` +
    `const ${q}ret = ${q}it.return;const ${q}thr = ${q}it.throw;` +
    `const ${q}lift = r => ${q}(r).then(r => { if (r === null || (typeof r !== 'object' && typeof r !== 'function')) throw new TypeError('Iterator result is not an object'); const done = r.done; return ${q}(r.value).then(value => ({value, done})) });` +
    `return {` +
    `next:v=>${q}lift(${q}next.call(${q}it,v)),` +
    `return:v=>${q}lift(typeof ${q}ret==='function'?${q}ret.call(${q}it,v):{value:v,done:true}),` +
    `throw:e=>typeof ${q}thr==='function'?${q}lift(${q}thr.call(${q}it,e)):${q}(typeof ${q}ret==='function'?${q}ret.call(${q}it):undefined).then(()=>{throw new TypeError('The iterator does not provide a throw method')})` +
    `}}})`
  )
}

/**
 * Compile a workflow script BODY (everything past the meta export) into a
 * reusable vm.Script. What compiles is one immediately-invoked expression
 * returning the body's Promise; running it in a context yields THAT realm's
 * Promise for the workflow result.
 *
 * The whole interception mechanism: the settle helper is
 * `Promise.resolve.bind(Promise)`, and the bind evaluates INSIDE the compiled
 * source — it captures the executing realm's Promise, so every intercepted
 * await resolves foreign thenables under the sandbox's own machinery.
 */
export function compileWorkflow(body: string): CompileResult | CompileError {
  const prefix = SETTLE_PREFIX
  try {
    // Cheap syntax gate, run before any vm.Script exists: TypeScript
    // annotations and other parse errors get this engine's message rather
    // than a vm construction failure. The Function is built, never called.
    // eslint-disable-next-line no-new-func
    Function(`async function _syntaxProbe() {'use strict';\n${body}\n}`)

    const transformed = rewriteAwaits(body)

    // Exactly one newline sits before the body (the twin of WRAP_HEAD's), so
    // the user-line → compiled-line +1 mapping holds.
    const compiledSource = `((${prefix} => ((${prefix}a) => async () => {'use strict';\n${transformed}\n})(${adapterSourceFor(prefix)}))(Promise.resolve.bind(Promise)))()`

    return {
      ok: true,
      vmScript: new vm.Script(compiledSource, {
        filename: 'workflow.js',
        // Dynamic import() would smuggle arbitrary module code — and all its
        // non-determinism — past every static check. Refuse with a detached
        // surrogate; a live host Error must never cross into the realm.
        importModuleDynamically: (() => {
          throw severedError('import() is not available in workflow scripts.')
        }) as unknown as undefined,
      }),
    }
  } catch (e) {
    return { ok: false, error: `SyntaxError: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── Static non-determinism detection ────────────────────────────────────────
//
// A courtesy scan for the clock/randomness forms the runtime shim would throw
// on, so validation can reject an inline script with the clearer message
// before launch. Aliased access (`const D = Date`) slips through on purpose —
// the shim is the authority, this layer is the nicety. Parse failures report
// false and leave compilation to produce the real error.
export function scriptUsesNonDeterminism(body: string): boolean {
  let hit = false
  try {
    const tree = parseSource(body, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as SyntaxNode
    astWalk.simple(tree as never, {
      MemberExpression(node: SyntaxNode) {
        if (node.computed) return
        const owner = node.object as SyntaxNode
        const field = node.property as SyntaxNode
        if (owner.type !== 'Identifier' || field.type !== 'Identifier') return
        const reads = (o: string, f: string) => owner.name === o && field.name === f
        if (reads('Date', 'now') || reads('Math', 'random')) hit = true
      },
      NewExpression(node: SyntaxNode) {
        const callee = node.callee as SyntaxNode
        if (callee.type !== 'Identifier' || callee.name !== 'Date') return
        if ((node.arguments as unknown[]).length === 0) hit = true
      },
    } as never)
  } catch {
    return false
  }
  return hit
}

// ============================================================================
// Meta parsing. A script's FIRST statement must be `export const meta = {...}`
// written as a PURE literal — no variables, no calls, no spreads, no template
// interpolation — precisely so it can be read without executing a single
// statement. Each phase entry may carry a per-phase `model` override.
// ============================================================================

export interface WorkflowPhaseMeta {
  title: string
  detail?: string
  model?: string
}
export interface WorkflowMeta {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
}
export interface ParsedWorkflow {
  meta: WorkflowMeta
  scriptBody: string
}

// Key names that would poison the null-proto record or its consumers.
const FORBIDDEN_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Parse + validate a full workflow script. Success carries `{meta, scriptBody}`
 * (and deliberately NO `ok` key); failures are `{ok: false, error}` — callers
 * discriminate on the presence of `ok`.
 */
export function parseWorkflowScript(script: string): ParsedWorkflow | CompileError {
  if (script.length > MAX_SCRIPT_BYTES) {
    return { ok: false, error: `Script exceeds ${MAX_SCRIPT_BYTES} bytes` }
  }

  let tree: SyntaxNode
  try {
    tree = parseSource(script, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as SyntaxNode
  } catch (e) {
    return {
      ok: false,
      error:
        `Script parse error: ${e instanceof Error ? e.message : String(e)}. Workflow scripts ` +
        'must be plain JavaScript — TypeScript syntax (type annotations like `: string[]`, ' +
        'interfaces, generics) fails to parse.',
    }
  }

  const [head] = tree.body as SyntaxNode[]
  if (!head || head.type !== 'ExportNamedDeclaration' || !isMetaDeclaration(head)) {
    return {
      ok: false,
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    }
  }

  const metaNode = ((head.declaration as SyntaxNode).declarations as SyntaxNode[])[0]
    .init as SyntaxNode
  let raw: Record<string, unknown>
  try {
    raw = readRecord(metaNode)
  } catch (e) {
    return {
      ok: false,
      error: `meta must be a pure literal: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const coerced = coerceMeta(raw)
  if ('error' in coerced) return { ok: false, error: coerced.error }

  // Everything past the meta export is the body; one leading blank or
  // semicolon-only line goes too, so the slice offsets leave no debris.
  const scriptBody = script.slice(head.end).replace(/^[;\s]*\n/, '').trimStart()
  return { meta: coerced.meta, scriptBody }
}

/** True exactly for `export const meta = { … }`. */
function isMetaDeclaration(node: SyntaxNode): boolean {
  const decl = node.declaration as SyntaxNode | undefined
  if (!decl || decl.type !== 'VariableDeclaration') return false
  if (decl.kind !== 'const' || (decl.declarations as SyntaxNode[]).length !== 1) return false
  const declarator = (decl.declarations as SyntaxNode[])[0]
  const id = declarator.id as SyntaxNode
  return (
    id.type === 'Identifier' &&
    id.name === 'meta' &&
    (declarator.init as SyntaxNode)?.type === 'ObjectExpression'
  )
}

/** Evaluate one literal node: Literal / Array / Object / uninterpolated
 *  Template / negative number. Anything dynamic throws. */
function readLiteral(node: SyntaxNode): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value
    case 'ArrayExpression': {
      const items = node.elements as (SyntaxNode | null)[]
      return items.map(item => {
        if (item === null) throw new Error('sparse arrays not allowed')
        if (item.type === 'SpreadElement') throw new Error('spread not allowed in meta')
        return readLiteral(item)
      })
    }
    case 'ObjectExpression':
      return readRecord(node)
    case 'TemplateLiteral': {
      if ((node.expressions as unknown[]).length > 0) {
        throw new Error('template interpolation not allowed in meta')
      }
      const quasis = node.quasis as Array<{ value: { cooked?: string } }>
      return quasis.map(q => q.value.cooked ?? '').join('')
    }
    case 'UnaryExpression': {
      const operand = node.argument as SyntaxNode
      if (
        node.operator === '-' &&
        operand.type === 'Literal' &&
        typeof operand.value === 'number'
      ) {
        return -operand.value
      }
      throw new Error('only negative-number unary allowed in meta')
    }
    default:
      throw new Error(`non-literal node type in meta: ${node.type}`)
  }
}

/** An ObjectExpression, evaluated into a null-prototype record. */
function readRecord(node: SyntaxNode): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null)
  for (const prop of node.properties as SyntaxNode[]) {
    if (prop.type !== 'Property') throw new Error('only plain properties allowed in meta')
    if (prop.computed) throw new Error('computed keys not allowed in meta')
    if (prop.method || prop.kind !== 'init') {
      throw new Error('methods/accessors not allowed in meta')
    }
    record[keyNameOf(prop)] = readLiteral(prop.value as SyntaxNode)
  }
  return record
}

/** A property's key name; the prototype-poisoning names are refused. */
function keyNameOf(prop: SyntaxNode): string {
  const key = prop.key as SyntaxNode
  let name: string
  if (key.type === 'Identifier') name = key.name as string
  else if (key.type === 'Literal') name = String(key.value)
  else throw new Error(`unsupported key type in meta: ${key.type}`)
  if (FORBIDDEN_META_KEYS.has(name)) {
    throw new Error(`reserved key name not allowed in meta: ${name}`)
  }
  return name
}

/** name/description are required non-empty strings; the rest coerce softly. */
function coerceMeta(raw: Record<string, unknown>): { meta: WorkflowMeta } | { error: string } {
  const { name, description } = raw
  if (typeof name !== 'string' || name.length === 0) {
    return { error: 'meta.name must be a non-empty string' }
  }
  if (typeof description !== 'string' || description.length === 0) {
    return { error: 'meta.description must be a non-empty string' }
  }
  return {
    meta: {
      name,
      description,
      title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : undefined,
      whenToUse: typeof raw.whenToUse === 'string' ? raw.whenToUse : undefined,
      phases: coercePhases(raw.phases),
    },
  }
}

/** Keep only the well-formed phase entries: {title, detail?, model?}. */
function coercePhases(raw: unknown): WorkflowPhaseMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const phases: WorkflowPhaseMeta[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object' || !('title' in candidate)) continue
    const { title, detail, model } = candidate as Record<string, unknown>
    if (typeof title !== 'string') continue
    phases.push({
      title,
      detail: typeof detail === 'string' ? detail : undefined,
      model: typeof model === 'string' ? model : undefined,
    })
  }
  return phases.length > 0 ? phases : undefined
}
