#!/usr/bin/env bun
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
check('CommandCenter footer row clicks close (via InteractiveRow directActivate)', /<InteractiveRow id=\{`center:\$\{view\}:close`\} directActivate onActivate=\{closable \? onClose : undefined\}/.test(cc))
const rp = read('src/components/mercury-ui/RailPanel.tsx')
check('RailPanel header is a function child (no static slab)', /const headerText = \(hover: boolean\)/.test(rp))
check('RailPanel header hover brightens info → infoShimmer', /hover \? 'infoShimmer' : headerHue/.test(rp))
check('CommandCenter footer child keeps the spacer Box and inks on hover', /\{hover => \(\s*\n\s*<Box marginTop=\{1\}>/.test(cc))
const hch = read('src/components/HelmCenterHeader.tsx')
check('SESSION chrome hovers through ink (muted → info; white ink retired from chrome)', /hover \? t\.info : t\.textMuted\}>\{SESSION_LABEL\}/.test(hch) && hch.includes("export const SESSION_LABEL = 'SESSION'"))

const ls = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
check('`? for shortcuts` is a Box sibling dispatching /help', /onClick=\{\(\) => \{[\s\S]{0,240}requestCommandDispatch\('\/help'\)/.test(ls))

const tr = read('src/components/HelmTelemetryRail.tsx')
check(
  'telemetry rows activate by LABEL (one adapter + ≥9 labeled rows)',
  tr.includes("requestHelmRowActivationByLabel('telemetry', label)") &&
    ((tr.match(/sel\(\{ kind: '[a-z]+',[^}]*\blabel: /g) ?? []).length >= 9),
)

const ink = read('src/ink/ink.tsx')
const sched = read('src/ink/root/render-scheduler.ts')
check('boot coalesce: window + trailing flush + cancel (unconditional)', /BOOT_COALESCE_MS = 100/.test(sched) && /clock\.now\(\) \+ BOOT_COALESCE_MS/.test(sched) && /clearTimeout\(this\.bootTimer\)/.test(sched))

console.log(failures === 0 ? '✅ ink-feel GREEN' : `❌ ink-feel RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
