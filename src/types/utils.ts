

type ImmutableLeaf =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | symbol
  | Function

export type DeepImmutable<T> = T extends ImmutableLeaf
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepImmutable<V>>
      : T extends readonly unknown[]
        ?
          { readonly [K in keyof T]: DeepImmutable<T[K]> }
        : T extends object
          ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
          : T


export type Permutations<U, Rest = U> = [U] extends [never]
  ? []
  : Rest extends U
    ? [Rest, ...Permutations<Exclude<U, Rest>>]
    : never
