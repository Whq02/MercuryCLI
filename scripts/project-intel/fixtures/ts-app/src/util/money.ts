export function roundCents(amount: number): number {
  return Math.round(amount)
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
