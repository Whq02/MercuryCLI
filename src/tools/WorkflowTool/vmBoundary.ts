// ============================================================================
// The workflow VM↔host realm boundary.
//
// Workflow scripts run untrusted inside a vm.Context. This module owns the
// three layers that keep that boundary sound:
//
//   • hardenVMIntrinsics — freezes every reachable intrinsic in a fresh
//     context, removes attack-surface globals, and pins stack rendering.
//   • The in-realm marshalling helpers, each COMPILED INSIDE the target
//     realm (makeSettle / makeVMCall / makeHostFnWrapper / makeBoundaryClone)
//     so awaiting, calling, wrapping, and inbound cloning all run under the
//     sandbox's own intrinsics.
//   • The host half: error surrogates and tunnels, the cap-error tag,
//     guarded array reads, and the outbound clone (cloneFromVM).
//
// The standing rules, enforced here and relied on everywhere else:
//   1. nothing that crosses the boundary is a live object of the other realm
//      (deliberately projected functions excepted);
//   2. no cross-realm read may hang the host, recurse without bound, or throw
//      a value that walks back to un-frozen intrinsics;
//   3. every projected host function goes through an error tunnel.
//
// Import discipline: node:vm only. No sibling imports; independently testable.
// The two big inline sources (the lockdown, the in-realm clone) are exact
// security code — change them only with the full threat model in hand.
// ============================================================================

import vm from 'node:vm'

/** Maximum array length honoured across the boundary (denial-of-service guard). */
export const MAX_BOUNDARY_ARRAY = 4096

/**
 * Nesting ceiling for the HOST-side outbound clone. Width and cycles are
 * already covered (the array cap, the WeakMap), yet an acyclic value nested
 * deep enough still exhausts the call stack — a RangeError no catch block
 * reliably sees, and one the engine's JSON fallback would hit again on the
 * very same value. The depth ceiling converts that failure mode into an
 * ordinary, catchable cap error.
 */
export const MAX_BOUNDARY_DEPTH = 256

// Module-private marker for cap errors. Per-slot catch blocks need to
// distinguish "a limit was hit, abort the whole clone" from "this one
// property trapped, degrade it and continue" — the tag is that distinction.
const CAP_TAG = Symbol('boundaryCap')

// ── Intrinsic lockdown ───────────────────────────────────────────────────────
//
// Executed in each workflow context while it is still pristine: after the
// determinism shim (whose replacements this pass then freezes), before any
// script code. Step order is load-bearing — assignment-override accessors
// must be installed BEFORE their prototypes freeze, and prepareStackTrace
// pins before Error does.
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

/** Execute the lockdown pass inside a workflow context. */
export function hardenVMIntrinsics(ctx: vm.Context): void {
  vm.runInContext(LOCKDOWN_SRC, ctx)
}

// ── In-realm marshalling helpers ─────────────────────────────────────────────

/**
 * Compile the settle helper inside the realm: awaits its argument there and
 * hands back a null-proto {v} envelope. What the host then awaits is a
 * sandbox-realm Promise, and what it unwraps is the envelope — so no
 * cross-realm thenable ever meets the host's own Promise machinery directly.
 * The envelope key `v` is a contract.
 */
export function makeSettle(ctx: vm.Context): (v: unknown) => Promise<{ v: unknown }> {
  return vm.runInContext('(async value => ({__proto__: null, v: await value}))', ctx)
}

/** Compile an invoker inside the realm, so the host can apply a VM-realm
 *  function to host-supplied arguments without host call machinery. */
export function makeVMCall(ctx: vm.Context): (fn: any, ...args: any[]) => unknown {
  return vm.runInContext('((fn, ...rest) => fn(...rest))', ctx)
}

/**
 * Compile the projector that turns a host function into a realm-native async
 * function. A host closure handed straight to the sandbox would leak host
 * function identity; the projected form forwards its arguments while owning
 * sandbox-realm identity and sandbox-realm Promises.
 */
export function makeHostFnWrapper(
  ctx: vm.Context,
): (hostFn: (...a: any[]) => any) => (...a: any[]) => Promise<unknown> {
  return vm.runInContext('(hostFn => async (...forwarded) => hostFn(...forwarded))', ctx)
}

/**
 * Compile the INBOUND deep clone inside the realm: host data in, realm-native
 * plain data out. Functions vanish (an array slot degrades to undefined, an
 * object key is dropped), shared references and cycles resolve through a
 * WeakMap, an array's length is read exactly once and width-capped, and only
 * the tagged cap error escapes a nested slot — any other hostile throw merely
 * degrades that slot. Every intrinsic is captured before script code exists.
 */
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

// ── Host-side helpers ────────────────────────────────────────────────────────

/**
 * The null-prototype stand-in for a live Error. Thrown or returned across the
 * boundary so the receiving realm holds plain data with no prototype chain to
 * walk back through; even its toString is null-proto.
 */
export function makeHostError(message: string, name = 'Error', stack?: string): any {
  const rendered = `${name}: ${message}`
  const toString = () => rendered
  Object.setPrototypeOf(toString, null)
  return { __proto__: null, name, message, stack: stack ?? rendered, toString }
}

/** The printable {msg, name, stack} of an arbitrary thrown value. Every field
 *  read is individually defended: a trapping getter yields a placeholder, and
 *  no throw escapes. */
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

/**
 * Wrap a host function so nothing it throws crosses the boundary alive: every
 * failure re-throws as a null-proto surrogate. The wrapper itself is
 * null-proto, so VM code holding it cannot walk to Function.prototype.
 */
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

/** The awaited twin of errorTunnel: settled results pass through, settled
 *  failures become surrogates. */
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

/** Mint a host-side cap error: a real Error wearing the module's cap tag. */
export function makeCapError(msg: string): Error {
  const err = new Error(msg)
  Object.defineProperty(err, CAP_TAG, { value: true })
  return err
}

/** Test for the cap tag without trusting the value — any trap reads as false. */
export function isCapError(e: any): boolean {
  try {
    return typeof e === 'object' && e !== null && e[CAP_TAG] === true
  } catch {
    return false
  }
}

/**
 * One-shot cross-realm length read, applying the same safe-integer and width
 * limits the in-realm clone enforces. `.length` is touched exactly once — a
 * Proxy getter never gets a second run.
 */
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

/**
 * The OUTBOUND deep clone: VM-realm value in, host-owned plain data out.
 * Mirrors the in-realm clone — functions dropped, cycles broken, widths
 * capped, cap errors abort the whole copy — and adds the depth ceiling,
 * converting what would be an uncatchable stack overflow on a hostile deep
 * value into an ordinary cap error. Failure asymmetry, kept deliberately: a
 * trapped ARRAY slot degrades to undefined (positions carry meaning), a
 * trapped OBJECT key is dropped (key sets don't).
 */
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

/**
 * Shallow one-level defensive copy of a VM array, used for the
 * parallel()/pipeline() argument lists. Elements are deliberately NOT cloned:
 * they stay VM-realm values (thunks the hooks later invoke in-realm).
 */
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
