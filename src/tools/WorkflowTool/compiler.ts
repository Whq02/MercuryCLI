
import vm from 'node:vm'
import { parse as parseSource } from 'acorn'
import * as astWalk from 'acorn-walk'


export const MAX_SCRIPT_BYTES = 524288

export const SYNC_TIMEOUT_MS = 30000

const SETTLE_PREFIX = '__wRg$'

const CLOCK_LOCKOUT_MSG =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume).' +
  ' Stamp results after the workflow returns, or pass timestamps via args.'
const RANDOM_LOCKOUT_MSG =
  'Math.random() is unavailable in workflow scripts (breaks resume).' +
  ' For N independent samples, include the index in the agent label or prompt.'

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

export function installDeterminismShim(ctx: vm.Context): void {
  vm.runInContext(DETERMINISM_SHIM_SRC, ctx)
}

interface SyntaxNode {
  type: string
  start: number
  end: number
  name?: string
  [k: string]: unknown
}

function severedError(message: string, name = 'Error', stack?: string): object {
  const rendered = `${name}: ${message}`
  const toString = () => rendered
  Object.setPrototypeOf(toString, null)
  return { __proto__: null, name, message, stack: stack ?? rendered, toString }
}


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

  astWalk.full(tree as never, ((node: SyntaxNode) => {
    if (node.type === 'WithStatement')
      throw new SyntaxError("'with' statements are not supported in workflow scripts.")
    if (node.name?.startsWith(prefix))
      throw new SyntaxError(`Identifier '${node.name}' is reserved.`)
  }) as never)

  const inserts: Array<{ at: number; text: string }> = []
  const wrapWith = (open: string, target: SyntaxNode | null | undefined) => {
    if (!target) return
    inserts.push({ at: target.start, text: open })
    inserts.push({ at: target.end, text: '))' })
  }
  const settleWrap = (target: SyntaxNode | null | undefined) => wrapWith(` ${prefix}((`, target)
  const adapterWrap = (target: SyntaxNode | null | undefined) => wrapWith(` ${prefix}a((`, target)

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
      if (node.async && node.expression) settleWrap(node.body as SyntaxNode)
    },
    ForOfStatement(node: SyntaxNode) {
      if (node.await) adapterWrap(node.right as SyntaxNode)
    },
    ReturnStatement(node: SyntaxNode, _state: unknown, ancestors: SyntaxNode[]) {
      const fn = enclosingFunction(ancestors)
      if (!fn?.async) return
      if (!fn.generator) {
        settleWrap(node.argument as SyntaxNode)
        return
      }
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
        if (node.argument) adapterWrap(node.argument as SyntaxNode)
      } else {
        settleWrap(node.argument as SyntaxNode)
      }
    },
  } as never)

  if (inserts.length === 0) return body
  inserts.sort((a, b) => b.at - a.at)
  let edited = parseText
  for (const { at, text } of inserts) edited = edited.slice(0, at) + text + edited.slice(at)
  return edited.slice(WRAP_HEAD.length, edited.length - WRAP_TAIL.length)
}


export interface CompileResult {
  ok: true
  vmScript: vm.Script
}
export interface CompileError {
  ok: false
  error: string
}

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

export function compileWorkflow(body: string): CompileResult | CompileError {
  const prefix = SETTLE_PREFIX
  try {
    // eslint-disable-next-line no-new-func
    Function(`async function _syntaxProbe() {'use strict';\n${body}\n}`)

    const transformed = rewriteAwaits(body)

    const compiledSource = `((${prefix} => ((${prefix}a) => async () => {'use strict';\n${transformed}\n})(${adapterSourceFor(prefix)}))(Promise.resolve.bind(Promise)))()`

    return {
      ok: true,
      vmScript: new vm.Script(compiledSource, {
        filename: 'workflow.js',
        importModuleDynamically: (() => {
          throw severedError('import() is not available in workflow scripts.')
        }) as unknown as undefined,
      }),
    }
  } catch (e) {
    return { ok: false, error: `SyntaxError: ${e instanceof Error ? e.message : String(e)}` }
  }
}

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

const FORBIDDEN_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

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

  const scriptBody = script.slice(head.end).replace(/^[;\s]*\n/, '').trimStart()
  return { meta: coerced.meta, scriptBody }
}

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
