export function isOneOf<const T>(members: readonly T[], value: unknown): value is T {
  const widened: readonly unknown[] = members
  return widened.includes(value)
}
