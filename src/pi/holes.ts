export type Unbuilt = any

export function notBuilt(id: string): never {
  throw new Error(`not built: ${id}`)
}

export function unbuilt(id: string): Unbuilt {
  const cross = (): never => notBuilt(id)
  const given = new Map<string | symbol, unknown>()
  return new Proxy(cross, {
    apply: cross,
    construct: cross,
    defineProperty: cross,
    deleteProperty: cross,
    get: (_hole, key) => (given.has(key) ? given.get(key) : cross()),
    getOwnPropertyDescriptor: cross,
    getPrototypeOf: cross,
    has: cross,
    isExtensible: cross,
    ownKeys: cross,
    preventExtensions: cross,
    set: (_hole, key, value) => {
      given.set(key, value)
      return true
    },
    setPrototypeOf: cross,
  })
}
