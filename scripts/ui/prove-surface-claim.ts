#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(
  join(root, 'src', 'components', 'FullscreenLayout.tsx'),
  'utf-8',
)

console.log('============================================================')
console.log(' Fullscreen modal SURFACE-CLAIM invariant')
console.log('============================================================')

check(
  'modalClaims is derived from modalPeek === 0 (one claim decision)',
  /const modalClaims = modalPeek === 0;/.test(src),
)
check(
  'recessOn derives from recessTargetFor (the ONE recess policy seam)',
  /const recessOn = modal != null && recessTargetFor\(t\) !== null;/.test(src),
)
check(
  'blankClaims = modalClaims && !recessOn (the closed-gate blank claim)',
  /const blankClaims = modalClaims && !recessOn;/.test(src),
)
check(
  'blank claim carries height={blankClaims ? terminalRows : undefined} (claim, not cap)',
  /height=\{blankClaims \? terminalRows : undefined\} maxHeight=\{terminalRows - modalPeek\}/.test(
    src,
  ),
)
check(
  'flexGrow spacer above the ▔ divider, gated on blankClaims',
  /\{blankClaims && <Box flexGrow=\{1\} \/>\}<Box flexShrink=\{0\}><Text color="info">/.test(
    src,
  ),
)
check(
  'flexGrow spacer BELOW the content too (blank claim centers short surfaces)',
  /\{modal\}<\/Box>\{blankClaims && <Box flexGrow=\{1\} \/>\}/.test(src),
)
check(
  'pane stays opaque={true} in BOTH modes (transparency is structurally banned)',
  /flexDirection="column" overflow="hidden" opaque=\{true\}>/.test(src),
)
check(
  'the pane registers elevated exactly while recessOn',
  /<Box ref=\{recessOn \? elevatedRef : undefined\} position="absolute"/.test(src),
)
check(
  'peek>0 path keeps the designed transcript sliver (height undefined off-claim)',
  /blankClaims \? terminalRows : undefined/.test(src),
)

console.log('-- the compositor half: the recess target is published')
check(
  'the layout owner publishes the recess target for the live tokens',
  /useEffect\(\(\) => \{\s*\n\s*setRecessTarget\(recessTargetFor\(tokens\)\)\s*\n\s*return \(\) => setRecessTarget\(null\)\s*\n\s*\}, \[tokens\]\)/.test(src),
)

console.log('-- the shell right edge: a flush slot, shells stretch')
check(
  'the modal slot wrapper is flush (no padding, no margin)',
  /<Box flexShrink=\{0\} flexDirection="column">\{modal\}<\/Box>/.test(src),
)
check(
  'the modal context advertises the slot width it actually provides',
  /rows: terminalRows - modalPeek - 1,\s*\n\s*columns,\s*\n\s*scrollRef: modalScrollRef \?\? null,/.test(src),
)
const kitSrc = readFileSync(
  join(root, 'src', 'components', 'mercury-ui', 'components.tsx'),
  'utf-8',
)
const standaloneShell = kitSrc.match(
  /<Box ref=\{elevated \? elevatedRef : undefined\} flexDirection="column" borderStyle="round"[^\n]*>/,
)
check(
  'CommandCenter standalone shell asks for no percent width',
  standaloneShell !== null && !/width="100%"/.test(standaloneShell[0]),
)
const embeddedBody = kitSrc.match(/if \(embedded\) \{[\s\S]*?return \(\s*\n\s*<Box flexDirection="column"([^\n]*)>/)
check(
  'CommandCenter embedded body asks for no percent width',
  embeddedBody !== null && !/width="100%"/.test(embeddedBody[1]!),
)
const towerSrc = readFileSync(
  join(root, 'src', 'components', 'CockpitView.tsx'),
  'utf-8',
)
const towerJsx = towerSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')
check(
  'the cockpit tower asks for no percent width',
  !/width="100%"/.test(towerJsx),
)

console.log('-- the tower fits its slot: footer always on screen')
check(
  'the tower reads its budget from the modal slot (useModalOrTerminalSize)',
  /const slot = useModalOrTerminalSize\(\{ rows: termRows, columns: termCols \}\)/.test(towerSrc),
)
check(
  'the tower caps its height at the slot rows inside the modal and clips (spread, never an explicit undefined)',
  /\{\.\.\.\(insideModal \? \{ maxHeight: slot\.rows, overflow: 'hidden' as const \} : \{\}\)\}/.test(towerSrc),
)
check(
  'the body is a ScrollBox inside a shrinkable region (header/tabs/footer never shrink)',
  /<Box ref=\{bodyBoxRef\} marginTop=\{1\} flexDirection="column" flexShrink=\{1\} minHeight=\{0\}>\s*\n\s*\{insideModal \? \(\s*\n\s*<ScrollBox ref=\{bodyRef\}/.test(towerSrc) &&
    /<Box marginTop=\{1\} flexShrink=\{0\}>\s*\n\s*\{TABS\.map/.test(towerSrc),
)
check(
  'the body binds the slot scroll route (PageUp/PageDown, ctrl+home/end, wheel)',
  /modalScrollRef\.current = bodyRef\.current/.test(towerSrc),
)
check(
  'the tower footer packs to the slot inner width (close hint reserved)',
  /packFooter\(/.test(towerSrc) && /'esc close',\s*\n\s*\]\.join\(' · '\),\s*\n\s*Math\.max\(0, slot\.columns - 4\)/.test(towerSrc),
)

console.log('-- the transcript gutter inside the frame')
check(
  'the transcript area pads by the gutter (1 in the cockpit frame, 0 otherwise)',
  /const transcriptGutter = cockpit \? 1 : 0/.test(src) && /paddingX=\{transcriptGutter\}/.test(src),
)
check(
  'the transcript wraps inside the gutter (its own size override)',
  /columns: Math\.max\(1, sizeVal\.columns - 2 \* transcriptGutter\)/.test(src) &&
    /<TerminalSizeContext\.Provider value=\{transcriptSize\}>/.test(src),
)

console.log(
  failures === 0
    ? '✅ surface-claim invariant GREEN'
    : `❌ surface-claim invariant RED (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
