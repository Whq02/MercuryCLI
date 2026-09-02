#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const repl = read('src/screens/REPL.tsx')

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

check(
  'G2 the permission overlay render requires !replSurfaceCovered',
  /focusedInputDialog === 'tool-permission' && toolUseConfirmQueue\[0\] && !replSurfaceCovered/.test(repl),
)

check(
  'G3 the message selector render requires !replSurfaceCovered',
  /focusedInputDialog === 'message-selector' && !replSurfaceCovered/.test(repl),
)

check(
  'G4 the bottom dialogs are null when covered',
  /const focusedBottomDialog: React\.ReactNode = replSurfaceCovered \? null :/.test(repl),
)

{
  const kb = read('src/keybindings/useKeybinding.ts')
  check(
    "G5 the keybinding covered gate keeps the kind !== 'repl' predicate (the same covered truth)",
    /function coveredFor\(scope: SurfaceKind\)[\s\S]{0,200}const current = currentSurfaceRoute\(\)\.kind[\s\S]{0,80}current !== 'repl' && current !== scope/.test(kb),
  )
  check(
    'G5 …and every gate site reads it (no site left on a bare covered check)',
    !/replCovered\(\)/.test(kb) && (kb.match(/coveredFor\(scope\)/g) ?? []).length === 4,
    `coveredFor sites: ${(kb.match(/coveredFor\(scope\)/g) ?? []).length}`,
  )
  const scopeMod = read('src/keybindings/RouteSurfaceScope.ts')
  const router = read('src/components/SurfaceRouter.tsx')
  check("G7 the scope context defaults to 'repl' (the parked tree's scope)", /createContext<SurfaceKind>\('repl'\)/.test(scopeMod))
  check('G7 SurfaceRouter provides route.kind around the surface render', /<RouteSurfaceScopeContext\.Provider value=\{route\.kind\}>[\s\S]{0,400}entry\.render\(route\)/.test(router))
  check('G7 the hooks read the scope', (kb.match(/useContext\(RouteSurfaceScopeContext\)/g) ?? []).length === 2)
  check("G7 the surface gets its own KeybindingSetup (the REPL's provider mounts beneath the router)", /<KeybindingSetup>[\s\S]{0,200}entry\.render\(route\)/.test(router))
  const scopeOnly = "function coveredFor(scope: SurfaceKind) {\n  const current = currentSurfaceRoute().kind\n  return current !== scope\n}"
  check("G7 poison: a scope-only gate (no kind !== 'repl') does NOT satisfy the covered needle", !/current !== 'repl' && current !== scope/.test(scopeOnly))
}

{
  const preFix = "focusedInputDialog === 'tool-permission' && toolUseConfirmQueue[0] ? ("
  check('G6 poison: the pre-fix ungated overlay shape does NOT satisfy the gate needle', !/focusedInputDialog === 'tool-permission' && toolUseConfirmQueue\[0\] && !replSurfaceCovered/.test(preFix))
  const wrong = "const replSurfaceCovered = useSyncExternalStore(subscribeSurfaceRoute, () => currentSurfaceRoute().kind === 'repl'"
  check('G6 poison: an inverted predicate (kind === repl) does NOT satisfy the covered needle', !/currentSurfaceRoute\(\)\.kind !== 'repl'/.test(wrong))
}

console.log(failures === 0 ? '\nprove-seat-covered-dialog-gate: ALL LAWS HOLD' : `\nprove-seat-covered-dialog-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
