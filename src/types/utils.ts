/**
 * Generic type-level utilities.
 *
 * Pure compile-time helpers — this module has no runtime surface (every import
 * site is `import type`, so the bundler elides it). It exists to back the
 * deep-readonly state shapes (`AppState`, `ToolPermissionContext`) and the
 * exhaustive-tuple `satisfies` guard in the message-queue editable-mode set.
 */

// ============================================================================
// DeepImmutable
// ============================================================================

/**
 * Primitive / opaque leaves that {@link DeepImmutable} passes through untouched.
 *
 * Functions are intentionally treated as leaves: a deep-readonly that recursed
 * into a callable would strip its call signature. The state shapes that pass
 * through `DeepImmutable` deliberately exclude function-bearing members and
 * intersect them back in afterwards (see `AppState.tasks`), so a function value
 * only reaches here defensively — and is preserved as-is.
 */
// biome-ignore lint/complexity/noBannedTypes: Function is the correct leaf guard here
type ImmutableLeaf =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | symbol
  | Function

/**
 * Recursively makes every property of `T` `readonly`.
 *
 * Behaviour, grounded in the in-repo consumers:
 *  - Distributes over unions, so a discriminated union (e.g. the SDK
 *    `SDKMessage`, whose `type` field is switched on in `mappers.ts`) keeps each
 *    member — and thus each discriminant — intact.
 *  - Leaves primitives and functions (see {@link ImmutableLeaf}) unchanged.
 *  - `Map<K, V>` becomes `ReadonlyMap<…>` and `Set<V>` becomes `ReadonlySet<…>`
 *    with their parameters deeply frozen (matches the hand-written
 *    `ToolPermissionContext` in `types/permissions.ts`, where
 *    `Map<string, AdditionalWorkingDirectory>` is mirrored as a `ReadonlyMap`).
 *  - Arrays and tuples become their `readonly` form, so a wrapped
 *    `Array<ContentBlockParam>` stays `Array.isArray`-able and is assignable to
 *    `readonly { readonly type: string }[]` (see `getContentText` in
 *    `messages.ts`).
 *  - Every other object has each property made `readonly`, preserving optional
 *    modifiers, and is recursed into.
 *
 * This is the conventional `DeepReadonly`/`DeepImmutable` utility shape (cf. the
 * `TODO (ashwin): see if we can use utility-types DeepReadonly` note in
 * `AppStateStore.ts`).
 */
export type DeepImmutable<T> = T extends ImmutableLeaf
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepImmutable<V>>
      : T extends readonly unknown[]
        ? // Arrays and tuples become their `readonly` form; a tuple keeps its
          // per-element structure (the mapped type preserves a fixed-length
          // tuple), a plain array stays a homogeneous `ReadonlyArray`.
          { readonly [K in keyof T]: DeepImmutable<T[K]> }
        : T extends object
          ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
          : T

// ============================================================================
// Permutations
// ============================================================================

/**
 * Every ordering of the members of union `U`, as a tuple type.
 *
 * The canonical "union → tuple permutation" utility. Used as an
 * exhaustive-coverage guard with `satisfies`: a literal tuple only satisfies
 * `Permutations<U>` when it lists each member of `U` exactly once (in some
 * order), so adding a union member without extending the tuple is a type error.
 *
 * Consumer (`messageQueueManager.ts`):
 * ```ts
 * const NON_EDITABLE_MODES = new Set<PromptInputMode>([
 *   'task-notification',
 * ] satisfies Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>)
 * ```
 *
 * @typeParam U  the union to enumerate.
 * @typeParam Rest  internal recursion accumulator (the remaining members not yet
 *                  placed); defaults to `U` and should not be supplied by callers.
 */
export type Permutations<U, Rest = U> = [U] extends [never]
  ? []
  : Rest extends U
    ? [Rest, ...Permutations<Exclude<U, Rest>>]
    : never
