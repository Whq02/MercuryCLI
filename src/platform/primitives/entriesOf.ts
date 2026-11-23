export function keysOf<K extends string>(record: { readonly [P in K]?: unknown }): K[] {
  return Object.keys(record) as K[]
}

export function entriesOf<K extends string, V>(record: { readonly [P in K]?: V }): [K, V][] {
  return Object.entries(record) as [K, V][]
}
