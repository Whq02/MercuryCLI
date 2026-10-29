export async function untilAsync(predicate: () => Promise<boolean> | boolean, ceilingMs: number, everyMs = 250): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < ceilingMs) {
    try {
      if (await predicate()) return true
    } catch {
      void 0
    }
    await new Promise<void>(wake => setTimeout(wake, everyMs))
  }
  return false
}
