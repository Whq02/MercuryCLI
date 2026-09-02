const cleanupFunctions = new Set<() => Promise<void>>()

export function registerCleanup(fn: () => Promise<void>): () => void {
  cleanupFunctions.add(fn)
  return () => {
    cleanupFunctions.delete(fn)
  }
}

export async function runCleanupFunctions(): Promise<void> {
  const results = await Promise.allSettled([...cleanupFunctions].map(fn => fn()))
  const firstRejection = results.find(r => r.status === 'rejected')
  if (firstRejection) throw (firstRejection as PromiseRejectedResult).reason
}
