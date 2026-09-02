// scripts/ui/renderOracle.ts — the capture oracle for verify-by-rendering.
// A capture is trustworthy only if (1) the binary actually painted (blank-guard),
// (2) it is NOT a boot-error screen — an error screen paints plenty of cells,
// which is exactly how "No conversation found" passed as a green render when
// MERCURY_CONFIG_DIR diverged from the staging dir — and (3) recognizable Mercury
// chrome landed (prompt caret or a frame glyph): a wall of text is not the TUI.
export type GridCell = { c: string }
export type CapturedGrid = { cols: number; rows: number; grid: GridCell[][] }

// Substrings that never appear in a healthy render of our synthetic scenarios
// but are printed by the binary's exit-with-error paths (main.tsx --resume /
// --continue failures). Extend as new boot-failure modes are discovered.
export const BOOT_ERROR_SIGNATURES = [
  'No conversation found', // --resume/--continue: session file missing (the MERCURY_CONFIG_DIR divergence class)
]

// At least ONE must be painted: ❯ is the prompt caret; the box glyphs are
// MercuryFrame / panel borders (present in both fullscreen and inline chrome).
export const CHROME_MARKERS = ['❯', '╭', '│', '╰']

export function countPainted(g: CapturedGrid): number {
  return g.grid.reduce((n, row) => n + row.filter(c => c.c && c.c !== ' ').length, 0)
}

// `markers` override: a scenario whose legitimate end state is a
// NON-Mercury screen (one that
// paints no ❯/round-corner chrome by design) supplies its own recognizable
// needles instead of failing 3/3 as "no chrome" (the visual-audit false
// negative). Default stays the strict Mercury set — no global loosening.
export function evaluateCapture(
  g: CapturedGrid,
  markers: string[] = CHROME_MARKERS,
): { ok: boolean; reason: string } {
  const painted = countPainted(g)
  if (painted < 40) {
    return { ok: false, reason: `blank/partial capture: ${painted} painted cells (binary did not paint)` }
  }
  const text = g.grid.map(row => row.map(c => c.c ?? '').join('')).join('\n')
  // Boot errors print at the TOP of an otherwise-bare screen — scope the scan
  // to the first rows so a transcript legitimately CONTAINING an error phrase
  // (this repo's own fixtures discuss them) can't fail a good capture (audit U23).
  const topText = g.grid.slice(0, 3).map(row => row.map(c => c.c ?? '').join('')).join('\n')
  const sig = BOOT_ERROR_SIGNATURES.find(s => topText.includes(s))
  if (sig) {
    return { ok: false, reason: `boot-error screen captured: "${sig}" (session/config staging mismatch?)` }
  }
  if (!markers.some(m => text.includes(m))) {
    return { ok: false, reason: `no expected chrome painted (looked for: ${markers.join(' ')})` }
  }
  return { ok: true, reason: `${painted} painted cells, chrome present` }
}
