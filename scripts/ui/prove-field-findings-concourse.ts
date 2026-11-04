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

console.log('§1 the coordinator-model latch is gone with its key (no ⌃s branch, no settings layer, no picker mount)')
{
  check(
    'no ⌃s branch arms anything on the board',
    !screen.includes("input === 's' && !reducedStage) {") && !screen.includes("if (key.ctrl && input === 's')"),
  )
  check(
    'no settings layer state or mount remains (the picker left the front end)',
    !screen.includes('setSettingsOpen') && !screen.includes('settingsOpen={') && !screen.includes('CoordinatorModelPicker'),
  )
  check(
    'no ⌃a turn-on branch remains (only the boot switch turns the coordinator on)',
    !screen.includes("key.ctrl && input === 'a'") && !screen.includes('switchCoordinatorMode'),
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
    /if \(rowPeekOpenRef\.current\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*setRowPeekOpen\(false\)\s*\n\s*return\s*\n\s*\}\s*\n\s*if \(filterRef\.current\.text !== ''\) \{/.test(screen) &&
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
  check('the SESSIONS section exists (the region that owns the board verbs: the pane legend first, then the rest)', atlasBody.includes("{ title: 'SESSIONS (list)', keys: [...managerPaneKeysFor(stage), ...withoutManagerPaneKeys(regionKeysFor('list', stage))] }"))
  check('no atlas section reads a raw region table any more', !atlasBody.includes('CONCOURSE_REGION_KEYS.'))
  check('the COORDINATOR section is stage- and switch-gated (taught only while the coordinator is on)', atlasBody.includes("...(reducedStage || !coordinatorOn ? [] : [{ title: 'COORDINATOR (its composer)'"))
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
  check('the coordinator section teaches no ⌃s (the coordinator-model key is gone)', !regionKeysFor('coordinator', { newSession: true }).some(k => k.keys === '⌃s'))
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
  const { CONCOURSE_REGION_KEYS } = await import('../../src/components/concourse/controlManifest.ts')
  const rows = (declared: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> => declared
  check(
    "the manifest leaves the live composer's ↵ to the layout (no ↵ row declared there) while the coordinator's own row says send",
    rows(CONCOURSE_REGION_KEYS.live).every(k => k.keys !== '↵') && rows(CONCOURSE_REGION_KEYS.coordinator).some(k => k.keys === '↵' && k.label === 'send'),
  )
}

process.exit(failures === 0 ? 0 : 1)
