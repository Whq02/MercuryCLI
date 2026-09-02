
import vm from 'node:vm'

export const MAX_BOUNDARY_ARRAY = 4096

export const MAX_BOUNDARY_DEPTH = 256

const CAP_TAG = Symbol('boundaryCap')

const LOCKDOWN_SRC = `(() => {
    // [1] Pin stack rendering before Error itself freezes.
    Object.defineProperty(Error, 'prepareStackTrace', {
      value: (err, sites) => String(err.stack ?? err),
      writable: false, configurable: false,
    });
    // [2] Remove the attack-surface globals outright.
    for (const doomed of ['ShadowRealm', 'WebAssembly', 'FinalizationRegistry',
                          'WeakRef', 'Atomics', 'SharedArrayBuffer',
                          'queueMicrotask',
                          '$vm', 'gc', 'edenGC', 'fullGC', 'print', 'readFile',
                          'Loader']) {
      delete globalThis[doomed];
    }
    // [3] Before anything freezes: keep the data properties scripts
    // legitimately shadow (err.message = ..., obj.toString = ...) assignable.
    // On a frozen prototype those plain writes would throw, so each such slot
    // becomes an accessor that defines an OWN property on the receiver — and
    // silently swallows writes aimed at the prototype itself.
    const armShadowing = (proto, key) => {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || 'get' in desc) return;
      const original = desc.value;
      Object.defineProperty(proto, key, {
        get() { return original },
        set(next) {
          if (this === proto) return;
          Object.defineProperty(this, key, {
            value: next, writable: true, enumerable: true, configurable: true,
          });
        },
        enumerable: desc.enumerable, configurable: true,
      });
    };
    const armAll = (proto, keys) => { for (const key of keys) armShadowing(proto, key); };
    const errorCtors = [Error, EvalError, RangeError, ReferenceError, SyntaxError,
                        TypeError, URIError, AggregateError,
                        globalThis.SuppressedError].filter(Boolean);
    armAll(Object.prototype, Object.getOwnPropertyNames(Object.prototype));
    armAll(Function.prototype, ['toString', 'constructor', 'name', 'length']);
    armAll(Array.prototype, ['toString', 'constructor']);
    armAll(Date.prototype, ['toString', 'toLocaleString', 'valueOf', 'constructor']);
    for (const E of errorCtors) armAll(E.prototype, ['name', 'message', 'toString', 'constructor']);
    // [4] Freeze the primary constructors, prototypes included.
    const freezeDeep = C => {
      Object.freeze(C);
      if (C.prototype !== undefined) Object.freeze(C.prototype);
    };
    for (const C of [Promise, Object, Array, Function, globalThis.Iterator,
                     Map, Set, WeakMap, WeakSet,
                     String, Number, Boolean, Symbol, BigInt,
                     Date, RegExp, ArrayBuffer, DataView,
                     ...errorCtors,
                     typeof URL !== 'undefined' ? URL : undefined,
                    ].filter(Boolean)) {
      freezeDeep(C);
    }
    // [5] The typed-array family, %TypedArray% base included.
    for (const C of [Object.getPrototypeOf(Int8Array),
                     Int8Array, Uint8Array, Uint8ClampedArray,
                     Int16Array, Uint16Array, Int32Array, Uint32Array,
                     globalThis.Float16Array, Float32Array, Float64Array,
                     BigInt64Array, BigUint64Array].filter(Boolean)) {
      freezeDeep(C);
    }
    // [6] The hidden function constructors, reachable only through instances.
    for (const sample of [async () => {}, function* () {}, async function* () {}]) {
      freezeDeep(sample.constructor);
    }
    // [7] Resource-management stacks and the Intl namespace object.
    for (const C of [globalThis.DisposableStack, globalThis.AsyncDisposableStack,
                     globalThis.Intl].filter(Boolean)) {
      freezeDeep(C);
    }
    // [8] The namespace objects.
    for (const ns of [JSON, Math, Reflect, Proxy]) Object.freeze(ns);
    // [9] globalThis itself stays UNFROZEN — the host still defines the hook
    // globals onto it — but .then pins to undefined so the global object can
    // never become a thenable a settle would call into.
    Object.defineProperty(globalThis, 'then', {
      value: undefined, writable: false, configurable: false,
    });
    // [10] Every Intl member constructor.
    if (typeof Intl !== 'undefined') {
      for (const key of Object.getOwnPropertyNames(Intl)) {
        const member = Intl[key];
        if (typeof member === 'function') freezeDeep(member);
      }
    }
    // [11] Iterator prototypes hide behind live instances: mint one specimen
    // of each kind and freeze its entire prototype chain.
    const specimens = [
      [][Symbol.iterator](),
      ''[Symbol.iterator](),
      new Map()[Symbol.iterator](),
      new Set()[Symbol.iterator](),
      'a'.matchAll(/a/g),
      (function* () {})(),
      (async function* () {})(),
    ];
    if (typeof Iterator !== 'undefined' && Iterator.from) {
      specimens.push([].values().map(x => x));
      specimens.push(Iterator.from({ next: () => ({ done: true }) }));
    }
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segments = new Intl.Segmenter().segment('a');
      specimens.push(segments, segments[Symbol.iterator]());
    }
    for (const specimen of specimens) {
      let proto = Object.getPrototypeOf(specimen);
      while (proto) {
        Object.freeze(proto);
        proto = Object.getPrototypeOf(proto);
      }
    }
    })()`

export function hardenVMIntrinsics(ctx: vm.Context): void {
  vm.runInContext(LOCKDOWN_SRC, ctx)
}


export function makeSettle(ctx: vm.Context): (v: unknown) => Promise<{ v: unknown }> {
  return vm.runInContext('(async value => ({__proto__: null, v: await value}))', ctx)
}

export function makeVMCall(ctx: vm.Context): (fn: any, ...args: any[]) => unknown {
  return vm.runInContext('((fn, ...rest) => fn(...rest))', ctx)
}

export function makeHostFnWrapper(
  ctx: vm.Context,
): (hostFn: (...a: any[]) => any) => (...a: any[]) => Promise<unknown> {
  return vm.runInContext('(hostFn => async (...forwarded) => hostFn(...forwarded))', ctx)
}

export function makeBoundaryClone(ctx: vm.Context): (hostVal: unknown) => unknown {
  return vm.runInContext(
    `(() => {
      const RealmWeakMap = WeakMap
      const isArrayFn = Array.isArray
      const ownKeys = Object.keys
      const defineOwn = Object.defineProperty
      const RealmError = Error
      const isSafeInt = Number.isSafeInteger
      const CAP = Symbol('boundaryCap')
      const capError = message => {
        const err = new RealmError(message)
        try { err[CAP] = true } catch {}
        return err
      }
      const isCap = candidate => {
        try {
          return typeof candidate === 'object' && candidate !== null && candidate[CAP] === true
        } catch { return false }
      }
      return hostVal => {
        const built = new RealmWeakMap()
        const copy = source => {
          if (typeof source === 'function') return undefined
          if (source === null || typeof source !== 'object') return source
          const existing = built.get(source)
          if (existing !== undefined) return existing
          if (isArrayFn(source)) {
            const width = source.length
            if (typeof width !== 'number' || !isSafeInt(width)) {
              throw capError('array length is not a safe integer across the workflow VM boundary')
            }
            if (width > ${MAX_BOUNDARY_ARRAY}) {
              throw capError('array length ' + width + ' exceeds the maximum of ${MAX_BOUNDARY_ARRAY} supported across the workflow VM boundary')
            }
            const target = []
            built.set(source, target)
            for (let i = 0; i < width; i++) {
              try {
                target[i] = copy(source[i])
              } catch (thrown) {
                if (isCap(thrown)) throw thrown
                target[i] = undefined
              }
            }
            return target
          }
          const target = {}
          built.set(source, target)
          let names
          try { names = ownKeys(source) } catch { return target }
          for (const key of names) {
            if (key === '__proto__') continue
            try {
              const slot = source[key]
              if (typeof slot === 'function') continue
              defineOwn(target, key, { value: copy(slot), writable: true, enumerable: true, configurable: true })
            } catch (thrown) {
              if (isCap(thrown)) throw thrown
            }
          }
          return target
        }
        return copy(hostVal)
      }
    })()`,
    ctx,
  )
}


export function makeHostError(message: string, name = 'Error', stack?: string): any {
  const rendered = `${name}: ${message}`
  const toString = () => rendered
  Object.setPrototypeOf(toString, null)
  return { __proto__: null, name, message, stack: stack ?? rendered, toString }
}

export function describeThrown(e: any): { msg: string; name: string; stack?: string } {
  let msg = '<unprintable thrown value>'
  try {
    const raw = e?.message
    if (typeof raw === 'string') msg = raw
    else if (typeof e === 'string') msg = e
    else msg = '<non-string error>'
  } catch {}
  let name = 'Error'
  try {
    const raw = e?.name
    if (typeof raw === 'string') name = raw
  } catch {}
  let stack: string | undefined
  try {
    const raw = e?.stack
    if (typeof raw === 'string') stack = raw
  } catch {}
  return { msg, name, stack }
}

export function errorTunnel<F extends (...a: any[]) => any>(fn: F): F {
  const tunnelled = ((...args: any[]) => {
    try {
      return fn(...args)
    } catch (thrown) {
      const shape = describeThrown(thrown)
      throw makeHostError(shape.msg, shape.name, shape.stack)
    }
  }) as F
  Object.setPrototypeOf(tunnelled, null)
  return tunnelled
}

export function errorTunnelAsync<F extends (...a: any[]) => Promise<any>>(fn: F): F {
  const tunnelled = (async (...args: any[]) => {
    try {
      return await fn(...args)
    } catch (thrown) {
      const shape = describeThrown(thrown)
      throw makeHostError(shape.msg, shape.name, shape.stack)
    }
  }) as F
  Object.setPrototypeOf(tunnelled, null)
  return tunnelled
}

export function makeCapError(msg: string): Error {
  const err = new Error(msg)
  Object.defineProperty(err, CAP_TAG, { value: true })
  return err
}

export function isCapError(e: any): boolean {
  try {
    return typeof e === 'object' && e !== null && e[CAP_TAG] === true
  } catch {
    return false
  }
}

export function safeBoundaryLength(arr: any): number {
  let width: number
  try {
    width = arr.length
  } catch {
    throw new Error('unable to read array length across the workflow VM boundary')
  }
  if (typeof width !== 'number' || !Number.isSafeInteger(width)) {
    throw makeCapError('array length is not a safe integer across the workflow VM boundary')
  }
  if (width > MAX_BOUNDARY_ARRAY) {
    throw makeCapError(
      `array length ${width} exceeds the maximum of ${MAX_BOUNDARY_ARRAY} supported across the workflow VM boundary`,
    )
  }
  return width
}

export function cloneFromVM(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
  depth = 0,
): unknown {
  if (typeof value === 'function') return undefined
  if (value === null || typeof value !== 'object') return value
  const already = seen.get(value as object)
  if (already !== undefined) return already
  if (depth >= MAX_BOUNDARY_DEPTH) {
    throw makeCapError(
      `nesting depth exceeds the maximum of ${MAX_BOUNDARY_DEPTH} supported across the workflow VM boundary`,
    )
  }
  if (Array.isArray(value)) {
    const target: unknown[] = []
    seen.set(value, target)
    const width = safeBoundaryLength(value)
    for (let i = 0; i < width; i++) {
      try {
        target[i] = cloneFromVM((value as any)[i], seen, depth + 1)
      } catch (thrown) {
        if (isCapError(thrown)) throw thrown
        target[i] = undefined
      }
    }
    return target
  }
  const target: Record<string, unknown> = {}
  seen.set(value as object, target)
  let names: string[]
  try {
    names = Object.keys(value as object)
  } catch {
    return target
  }
  for (const key of names) {
    if (key === '__proto__') continue
    try {
      const slot = (value as any)[key]
      if (typeof slot === 'function') continue
      target[key] = cloneFromVM(slot, seen, depth + 1)
    } catch (thrown) {
      if (isCapError(thrown)) throw thrown
    }
  }
  return target
}

export function readBoundaryArray(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return []
  const width = safeBoundaryLength(value)
  const target: unknown[] = []
  for (let i = 0; i < width; i++) {
    try {
      target[i] = (value as any)[i]
    } catch {
      target[i] = undefined
    }
  }
  return target
}
