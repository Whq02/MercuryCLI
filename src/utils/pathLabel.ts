/**
 * the ONE display-label basename owner. Splits on BOTH
 * separators regardless of host platform — a Windows path must label
 * correctly even when rendered by a POSIX build (transcripts and remote
 * sessions cross platforms; node's basename only understands the HOST's
 * separator). Trailing separators are stripped first; a degenerate root
 * falls back to the input. DISPLAY LABELS ONLY — routing and identity keep
 * full stable paths (truth-law 4). Replaces the per-component
 * split-on-'/' pattern that rendered "C:\CDay\deadnight-del" instead of
 * the directory name.
 */
export function pathTailLabel(p: string): string {
  const stripped = p.replace(/[/\\]+$/, '')
  const parts = stripped.split(/[/\\]/)
  return parts[parts.length - 1] || p
}
