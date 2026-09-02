#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-seat-covered-dialog-gate.ts — the covered-REPL
//  dialog input gate (the seat's key-leak seam).
//
//  While another route surface owns the frame (the Concourse board, the Boot
//  Settings), the REPL is COVERED — mounted but off-screen. Its input dialogs
//  (the consent card, the message selector, the bottom-column dialogs) must go
//  INACTIVE, or a keystroke typed on the board reaches an off-screen card's
//  CustomSelect and ANSWERS a parked ask ('1' = allow-once, '2' = allow-
//  ALWAYS) — a silent, PERSISTENT allow of a parked destructive command from a
//  different surface, for BOTH the in-process and the daemon-hosted card (they
//  share this one render path). The useKeybinding covered gate (replCovered)
//  already makes the card's nav/accept inert; the card's RAW input path had no
//  such gate. This pins the general fix: every covered-REPL input dialog is
//  gated on the reactive route signal.
//
//   G1  the covered signal derives from the surface-route store (reactive):
//       replSurfaceCovered = subscribeSurfaceRoute + currentSurfaceRoute().kind
//       !== 'repl' (returns live the instant the frame is the REPL's again);
//   G2  the consent card (THE overlay — in-process AND daemon share it) is
//       gated: its render requires !replSurfaceCovered;
//   G3  the message selector is gated: its render requires !replSurfaceCovered;
//   G4  the bottom-column dialogs are gated: their render is null when
//       seated OR replSurfaceCovered;
//   G5  the gate reuses the SAME "not the REPL's route" predicate the
//       keybinding covered gate uses (replCovered = kind !== 'repl') — one
//       covered truth, not a second spelling;
//   G6  POISON: the self-test's own ungated needles trip (a pin that cannot
//       fail proves nothing) — the assertions are shape-exact, not substring-
//       loose.
//  Source-shape pins on the REAL screen file; the behavioral capture (a board
//  digit on a parked card → the card still parked, the NEEDS YOU rail
//  unchanged) rides the seat capture drives.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const repl = read('src/screens/REPL.tsx')

// ── G1: the covered signal is reactive over the route store ──
check(
  'G1 replSurfaceCovered subscribes the surface-route store',
  repl.includes('useSyncExternalStore(') &&
    repl.includes('subscribeSurfaceRoute') &&
    /const replSurfaceCovered = useSyncExternalStore\(\s*subscribeSurfaceRoute/.test(repl),
)
check(
  "G1 …and reads currentSurfaceRoute().kind !== 'repl' (covered = not the REPL's frame)",
  /const replSurfaceCovered = useSyncExternalStore\([\s\S]{0,160}currentSurfaceRoute\(\)\.kind !== 'repl'/.test(repl),
)

// ── G2: the consent card (THE overlay) is gated ──
check(
  'G2 the permission overlay render requires !replSurfaceCovered',
  /focusedInputDialog === 'tool-permission' && toolUseConfirmQueue\[0\] && !replSurfaceCovered/.test(repl),
)

// ── G3: the message selector is gated ──
check(
  'G3 the message selector render requires !replSurfaceCovered',
  /focusedInputDialog === 'message-selector' && !replSurfaceCovered/.test(repl),
)

// ── G4: the bottom-column dialogs are gated ──
check(
  'G4 the bottom dialogs are null when covered',
  /const focusedBottomDialog: React\.ReactNode = replSurfaceCovered \? null :/.test(repl),
)

// ── G5: ONE covered truth — the same predicate the keybinding gate uses ──
{
  const kb = read('src/keybindings/useKeybinding.ts')
  // The gate became SCOPE-AWARE — covered = another
  // surface owns the frame AND the binding is mounted outside it
  // (RouteSurfaceScope). The parked REPL's bindings (scope 'repl') stay
  // inert under the Concourse exactly as before; a binding mounted INSIDE
  // the covering surface (the git-offer consent card's Select) is live.
  check(
    "G5 the keybinding covered gate keeps the kind !== 'repl' predicate (the same covered truth)",
    /function coveredFor\(scope: SurfaceKind\)[\s\S]{0,200}const current = currentSurfaceRoute\(\)\.kind[\s\S]{0,80}current !== 'repl' && current !== scope/.test(kb),
  )
  check(
    'G5 …and every gate site reads it (no site left on a bare covered check)',
    !/replCovered\(\)/.test(kb) && (kb.match(/coveredFor\(scope\)/g) ?? []).length === 4,
    `coveredFor sites: ${(kb.match(/coveredFor\(scope\)/g) ?? []).length}`,
  )
  // G7: the scope contract — SurfaceRouter provides the route kind around
  // each surface's render; the hooks read it; the always-mounted REPL tree
  // sits under the default 'repl'.
  const scopeMod = read('src/keybindings/RouteSurfaceScope.ts')
  const router = read('src/components/SurfaceRouter.tsx')
  check("G7 the scope context defaults to 'repl' (the parked tree's scope)", /createContext<SurfaceKind>\('repl'\)/.test(scopeMod))
  check('G7 SurfaceRouter provides route.kind around the surface render', /<RouteSurfaceScopeContext\.Provider value=\{route\.kind\}>[\s\S]{0,400}entry\.render\(route\)/.test(router))
  check('G7 the hooks read the scope', (kb.match(/useContext\(RouteSurfaceScopeContext\)/g) ?? []).length === 2)
  check("G7 the surface gets its own KeybindingSetup (the REPL's provider mounts beneath the router)", /<KeybindingSetup>[\s\S]{0,200}entry\.render\(route\)/.test(router))
  // G7 poison: a gate that drops the parked-REPL half (scope-only) must NOT satisfy G5.
  const scopeOnly = "function coveredFor(scope: SurfaceKind) {\n  const current = currentSurfaceRoute().kind\n  return current !== scope\n}"
  check("G7 poison: a scope-only gate (no kind !== 'repl') does NOT satisfy the covered needle", !/current !== 'repl' && current !== scope/.test(scopeOnly))
}

// ── G6: the poison control — the needles are shape-exact ──
{
  // an ungated permission overlay (the pre-fix shape) must NOT satisfy the G2 needle
  const preFix = "focusedInputDialog === 'tool-permission' && toolUseConfirmQueue[0] ? ("
  check('G6 poison: the pre-fix ungated overlay shape does NOT satisfy the gate needle', !/focusedInputDialog === 'tool-permission' && toolUseConfirmQueue\[0\] && !replSurfaceCovered/.test(preFix))
  // a fabricated covered signal that reads the WRONG predicate must NOT satisfy G1
  const wrong = "const replSurfaceCovered = useSyncExternalStore(subscribeSurfaceRoute, () => currentSurfaceRoute().kind === 'repl'"
  check('G6 poison: an inverted predicate (kind === repl) does NOT satisfy the covered needle', !/currentSurfaceRoute\(\)\.kind !== 'repl'/.test(wrong))
}

console.log(failures === 0 ? '\nprove-seat-covered-dialog-gate: ALL LAWS HOLD' : `\nprove-seat-covered-dialog-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
