#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const screenPath = join(ROOT, 'src/components/concourse/ConcourseScreen.tsx')
const screen = readFileSync(screenPath, 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 ⌃s wide-twin latch (settings owner never arms without a home)')
{
  check(
    'the ⌃s branch carries the reduced-stage guard',
    screen.includes("if (key.ctrl && input === 's' && !reducedStage) {"),
  )
  check(
    'the pre-fix unguarded ⌃s branch is gone',
    !screen.includes("if (key.ctrl && input === 's') {"),
    'an unguarded ⌃s arms the owner from the plain live view',
  )
  check(
    'the arm door refuses on the reduced stage (close always allowed)',
    screen.includes('setSettingsOpen(v => (v ? false : !reducedStage))'),
  )
  check(
    'the sideways-strand disarm effect exists',
    screen.includes('if (reducedStage && settingsOpen) setSettingsOpen(false)'),
  )
  check(
    "the wide pane mount stands (settingsOpen && geo.profile === 'wide')",
    screen.includes("settingsOpen={settingsOpen && geo.profile === 'wide'}"),
  )
  check(
    "the sub-wide overlay mount stands (settingsOpen && geo.profile !== 'wide')",
    screen.includes("{settingsOpen && geo.profile !== 'wide' ? ("),
  )
}

console.log('§2 applied-filter esc layer (the zero-match hint is true)')
{
  const layoutPath = join(ROOT, 'src/components/concourse/ConcourseLayout.tsx')
  const layout = readFileSync(layoutPath, 'utf8')
  const ordered = (hay: string, a: string, b: string): boolean => {
    const ia = hay.indexOf(a)
    const ib = hay.indexOf(b)
    return ia !== -1 && ib !== -1 && ia < ib
  }
  check(
    'the ladder carries the applied-filter layer (ref cleared synchronously — the batch law)',
    screen.includes("if (filterRef.current.text !== '') {") &&
      screen.includes("filterRef.current = { text: '', caret: 0 }"),
  )
  check(
    'the layer peels between the row peek and the marks (view layers before staged sets)',
    ordered(screen, '// Line 5: esc closes the row peek first', "if (filterRef.current.text !== '') {") &&
      ordered(screen, "if (filterRef.current.text !== '') {", 'if (markedIdsRef.current.size > 0) {'),
  )
  check(
    'the zero-match board still teaches the key it now honors',
    layout.includes('esc clears the filter'),
  )
  check(
    'filter-edit esc and the ↵/tab apply-commit are unchanged',
    screen.includes('setFiltering(false)\n        setFilter({ text: \'\', caret: 0 })') &&
      /if \(key\.return \|\| key\.tab\) \{\s*\n\s*event\.stopImmediatePropagation\(\)\s*\n\s*setFiltering\(false\)\s*\n\s*return/.test(screen),
  )
}

console.log('§3 the ? atlas reads the resolver, stage- and width-honest')
{
  const atlasBody = screen.slice(screen.indexOf('function ConcourseKeyAtlas'))
  check('the SESSIONS section exists (the region that owns the board verbs)', atlasBody.includes("{ title: 'SESSIONS (list)', keys: regionKeysFor('list', stage) }"))
  check('no atlas section reads a raw region table any more', !atlasBody.includes('CONCOURSE_REGION_KEYS.'))
  check('the COORDINATOR section is stage-gated (the plain world is not taught ⌃s)', atlasBody.includes("...(reducedStage ? [] : [{ title: 'COORDINATOR (its composer)'"))
  check('the SPLIT section rides the split’s own width gate (one gate, one truth)', atlasBody.includes('!reducedStage && splitAvailableAt(cols, rows)'))
  check('the atlas takes the live split fact (splitOn rides splitActive)', screen.includes('splitOn={splitActive}') && atlasBody.includes('splitOn = false'))
  check("split OFF teaches the toggle only ('s split view' — no divider, no way-back)", atlasBody.includes("{ title: 'SPLIT VIEW (s toggles)', keys: [{ keys: 's', label: 'split view' }] }"))
  check('split ON keeps the pane grammar (the way back + divider stay taught there)', atlasBody.includes("? { title: 'SPLIT VIEW (s toggles)', keys: regionKeysFor('chat', { ...stage, chatSession: chat }) }"))
}
{
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const reducedList = regionKeysFor('list', { newSession: false })
  check(
    'the reduced-stage list drops the full-stage doors (n · r · s · space · newline) and single-↵s the enter',
    !reducedList.some(k => ['n', 'r', 's', 'space', '⇧↵/⌃j'].includes(k.keys)) && reducedList.some(k => k.keys === '↵' && k.label === 'enter session'),
  )
  const fullList = regionKeysFor('list', { newSession: true })
  check('the full-stage list keeps the whole grammar incl. marks and split', ['↵↵', 'n', 'r', '→', '/', '⌃x ⌃x', 'm', 'space', 's'].every(keys => fullList.some(k => k.keys === keys)))
  check('the coordinator section still teaches ⌃s where it fires', regionKeysFor('coordinator', { newSession: true }).some(k => k.keys === '⌃s'))
}

console.log('§3b the atlas reads the frame and clamps to it')
{
  const atlasBody = screen.slice(screen.indexOf('function ConcourseKeyAtlas'))
  check('the atlas mounts on the frame width (termCols), never the pane cols', screen.includes('<ConcourseKeyAtlas cols={termCols}'))
  check('the panel height clamps to the frame (a true-height budget exists)', atlasBody.includes('const maxHeight = Math.max(7, rows - 2)'))
  check('shedding is explicit — the counted marker row', atlasBody.includes('— grow the window'))
  check('…and whole trailing sections fold, never silent row loss', atlasBody.includes('shown = shown.slice(0, -1)'))
  const markerAt = atlasBody.indexOf('— grow the window')
  const footerAt = atlasBody.lastIndexOf('esc close')
  check('the footer paints AFTER the marker (esc close survives every height)', markerAt !== -1 && footerAt !== -1 && markerAt < footerAt)
}

console.log('§3c the contract-offer card names what esc does')
{
  const { readFileSync: readFs } = await import('node:fs')
  const offer = readFs(new URL('../../src/components/concourse/ContractOfferCard.tsx', import.meta.url), 'utf8')
  const prompt = readFs(new URL('../../src/components/permissions/PermissionPrompt.tsx', import.meta.url), 'utf8')
  check("the ask face overrides the inherited footer ('esc starts it plain' — esc BIRTHS here, it never cancels)", offer.includes('escapeHint="esc starts it plain"'))
  check("the prompt's default footer stands for every other consumer", prompt.includes("escapeHint = 'esc cancel'") && prompt.includes('${escapeHint}'))
}

console.log('§4 live meta row: enter-grammar on an empty draft, send only with words held')
{
  check(
    'the hint is derived from the draft (empty ⇒ the enter grammar, per stage)',
    screen.includes("liveDraft.text.length === 0") &&
      screen.includes("'↵↵ enter session · tab panes'") &&
      screen.includes("'↵ enter session · tab panes'"),
  )
  check('the live composer mount carries the derived hint', screen.includes('{...(liveKeysHint !== undefined ? { keysHint: liveKeysHint } : {})}'))
  const manifest = readFileSync(join(ROOT, 'src/components/concourse/controlManifest.ts'), 'utf8')
  check('the manifest contract the row now honors still stands', manifest.includes("its own meta row carries '↵ send' while a draft exists") || manifest.includes("meta row says '↵ send' while a draft exists") || manifest.includes("meta row carries '↵ send'") || manifest.includes("'↵ send' while a draft exists"))
}

process.exit(failures === 0 ? 0 : 1)
