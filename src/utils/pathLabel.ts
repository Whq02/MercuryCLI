export function pathTailLabel(p: string): string {
  const stripped = p.replace(/[/\\]+$/, '')
  const parts = stripped.split(/[/\\]/)
  return parts[parts.length - 1] || p
}
