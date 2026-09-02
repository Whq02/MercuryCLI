/** Round a fractional cent amount to a whole number of cents (half-up). */
export function roundCents(amount: number): number {
  return Math.round(amount)
}

/** Render integer cents as a dollar string, e.g. 1250 -> "$12.50". */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
