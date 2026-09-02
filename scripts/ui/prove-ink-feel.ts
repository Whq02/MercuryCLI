#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-ink-feel.ts — the W9 ink-feel pass's structural locks
// mouse affordances are WIRING, not paint — a render can't
//  click — so this pins the seams that make the surface clickable:
//    · useTypeahead exposes acceptSuggestionAt/hoverSuggestionAt and the
//      accept core honors an explicit index (the mouse-pick path)
//    · the chain threads end-to-end: PromptInput → Footer → rows (both the
//      inline mount AND the fullscreen overlay via promptOverlayContext)
//    · suggestion rows carry onClick + onMouseEnter on ABSOLUTE indices
//    · CommandCenter's footer row is a click target for its own advertised
//      close · the `? for shortcuts` hint dispatches /help (Box sibling —
//      never Box-in-Text) · telemetry rows activate by LABEL
//    · the boot coalesce exists, stamp-gated, with its cancel path
//  Pure greps — always-on in the ui suite.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (label: string, cond: boolean): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

console.log('============================================================')
console.log(' ink-feel structural locks (mouse chain · boot coalesce)')
console.log('============================================================')

const ta = read('src/hooks/useTypeahead.tsx')
check('typeahead accept honors an explicit index', /atIndex \?\? \(selectedSuggestion === -1 \? 0 : selectedSuggestion\)/.test(ta))
check('typeahead exposes acceptSuggestionAt + hoverSuggestionAt', /acceptSuggestionAt,\s*\n\s*hoverSuggestionAt/.test(ta))

const pi = read('src/components/PromptInput/PromptInput.tsx')
check('PromptInput threads onPick/onHover to the footer', /onSuggestionPick=\{typeahead\.acceptSuggestionAt\}\s*onSuggestionHover=\{typeahead\.hoverSuggestionAt\}/.test(pi))

const pf = read('src/components/PromptInput/PromptInputFooter.tsx')
check('footer passes the pair to the inline rows', /onPick=\{onSuggestionPick\}\s*onHover=\{onSuggestionHover\}/.test(pf))
check('footer portals the pair to the fullscreen overlay', /onPick: onSuggestionPick,\s*onHover: onSuggestionHover,/.test(pf))

const fl = read('src/components/FullscreenLayout.tsx')
check('overlay mount consumes data.onPick/data.onHover', /onPick=\{data\.onPick\}\s*onHover=\{data\.onHover\}/.test(fl))

const rows = read('src/components/PromptInput/PromptInputFooterSuggestions.tsx')
check('suggestion rows: onClick + onMouseEnter on ABSOLUTE indices', /onClick: \(\) => onPick\(absolute\)/.test(rows) && /onMouseEnter: \(\) => onHover\(absolute\)/.test(rows))

const cc = read('src/components/mercury-ui/components.tsx')
// the footer rides the ONE kernel — a registered direct control
// (one click closes, geometry never moves), not a bare onClick.
check('CommandCenter footer row clicks close (via InteractiveRow directActivate)', /<InteractiveRow id=\{`center:\$\{view\}:close`\} directActivate onActivate=\{onClose\}/.test(cc))
// Hover-hierarchy: CHROME hovers through INK, never the
// body-row surface2 slab — titles/headings/footer actions take the
// InteractiveRow function-child path (which suppresses the fill) and
// brighten their label ink instead of pretending to be selected rows.
const rp = read('src/components/mercury-ui/RailPanel.tsx')
check('RailPanel header is a function child (no static slab)', /const headerText = \(hover: boolean\)/.test(rp))
check('RailPanel header hover brightens info → infoShimmer', /hover \? 'infoShimmer' : headerHue/.test(rp))
check('CommandCenter footer child keeps the spacer Box and inks on hover', /\{hover => \(\s*\n\s*<Box marginTop=\{1\}>/.test(cc))
const hch = read('src/components/HelmCenterHeader.tsx')
check('SESSION chrome hovers through ink (muted → info; white ink retired from chrome)', /hover \? t\.info : t\.textMuted\}>SESSION/.test(hch))

const ls = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
check('`? for shortcuts` is a Box sibling dispatching /help', /onClick=\{\(\) => \{[\s\S]{0,240}requestCommandDispatch\('\/help'\)/.test(ls))

const tr = read('src/components/HelmTelemetryRail.tsx')
// Slice-3 centralized the per-row calls into the ONE TelemetryRow adapter —
// activation still routes by LABEL: one adapter call + ≥9 label-carrying
// row registrations through the ONE selector (`sel({ kind, …, label })`);
// a label may be a literal or a computed key (the workflow, extension and
// trace rows carry theirs), and every registration counts. (The usage:acct
// toggle row left with the switching machinery — account-slot
// simplification, operator ruling; the beyond-plan allowance row
// left with the retired usage-overflow command.)
check(
  'telemetry rows activate by LABEL (one adapter + ≥9 labeled rows)',
  tr.includes("requestHelmRowActivationByLabel('telemetry', label)") &&
    ((tr.match(/sel\(\{ kind: '[a-z]+',[^}]*\blabel: /g) ?? []).length >= 9),
)

const ink = read('src/ink/ink.tsx')
// The boot coalesce moved into root/render-scheduler.ts (native-core T6
// — clock-injected (clock.now, not Date.now) with the same
// window + trailing flush + cancel triple.
const sched = read('src/ink/root/render-scheduler.ts')
check('boot coalesce: window + trailing flush + cancel (unconditional)', /BOOT_COALESCE_MS = 100/.test(sched) && /clock\.now\(\) \+ BOOT_COALESCE_MS/.test(sched) && /clearTimeout\(this\.bootTimer\)/.test(sched))

console.log(failures === 0 ? '✅ ink-feel GREEN' : `❌ ink-feel RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
