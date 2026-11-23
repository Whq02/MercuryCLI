export function jitterRetryDelay(baseMs: number, range: 'positive' | 'symmetric' = 'positive'): number {
  const spread = Math.random() * 0.25
  return baseMs + baseMs * (range === 'symmetric' ? 2 * spread - 0.25 : spread)
}
