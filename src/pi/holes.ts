export type Unbuilt = any

export function notBuilt(id: string): never {
  throw new Error(`not built: ${id}`)
}

export function unbuilt(id: string): Unbuilt {
  const cross = (): never => notBuilt(id)
  return new Proxy(cross, {
    apply: cross,
    construct: cross,
    defineProperty: cross,
    deleteProperty: cross,
    get: cross,
    getOwnPropertyDescriptor: cross,
    getPrototypeOf: cross,
    has: cross,
    isExtensible: cross,
    ownKeys: cross,
    preventExtensions: cross,
    set: cross,
    setPrototypeOf: cross,
  })
}
