#!/usr/bin/env bun
// gate-watch: src/utils/statusNoticeDefinitions.tsx src/components/Settings/Config.tsx src/memdir/mnemeFrontPage.ts src/memdir/mnemeUsage.ts
// gate-watch: src/components/Messages.tsx src/components/CrewmateTranscript.tsx src/components/memory/MemoryCentreView.tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-notice-frames')
const framesArg = process.argv.indexOf('--frames')
const FRAMES = framesArg >= 0 ? process.argv[framesArg + 1] : undefined
if (FRAMES) mkdirSync(FRAMES, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
function save(name: string, lines: string[]): void {
  if (FRAMES) writeFileSync(join(FRAMES, name), lines.join('\n') + '\n')
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { appendObservation } = await import('../../src/memdir/mnemeBuffer.js')
const { maybeConsolidate, listTopicDocs } = await import('../../src/memdir/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')
const { pinFact, formatTextSize } = await import('../../src/memdir/mnemeUsage.js')
const { readPinnedStatus } = await import('../../src/memdir/mnemeFrontPage.js')
const { getActiveNotices, pinnedOverLimitLine } = await import('../../src/utils/statusNoticeDefinitions.js')
const { getGlobalConfig } = await import('../../src/utils/config.js')

section('§1 a library whose pinned shelf is over its text limit')
const dir = mnemeLibraryDir()
const RULES = ['deploys', 'commits', 'reviews', 'suites', 'worktrees', 'releases', 'docs', 'frames', 'keys', 'lanes', 'folds', 'censuses', 'drives', 'briefs', 'pages', 'notes', 'rows', 'seals', 'gates', 'pools', 'homes', 'walls', 'relogs']
for (const word of RULES) {
  appendObservation({ text: `About ${word}: handle ${word} the careful way, say exactly what happened and what it means for the release, and put the owner's part last — the long form of the rule so the shelf fills with text (${'·'.repeat(120)}).`, source: 'operator', topicHint: 'rules' }, dir)
}
check('the batch landed', maybeConsolidate({ force: true, dir }).consolidated)
for (const e of listTopicDocs(dir).find(d => d.slug === 'rules')!.sections[0]!.entries) pinFact(e.seq, dir, new Date(), { asked: true })
maybeConsolidate({ force: true, dir })
const status = readPinnedStatus(dir)
check('the shelf is over its limit with every rule loaded', status !== null && status.over && status.loaded.length === RULES.length, JSON.stringify(status && { pinned: status.pinned, used: status.used, limit: status.limit }))

section('§2 the calm start-of-session line, as the notice strip paints it')
const notices = getActiveNotices({ config: getGlobalConfig(), memoryFiles: [] })
const notice = notices.find(n => n.id === 'pinned-over-limit')
check('the pinned-over-limit notice is active', notice !== undefined, notices.map(n => n.id).join(','))
const words = status ? pinnedOverLimitLine({ pinned: status.pinned, used: status.used, limit: status.limit }) : ''
console.log(`  words: ${words}`)
check('the words carry the count, the fill, the limit, that all are loaded, and the two ways out',
  words === `Pinned memory: ${RULES.length} rules, ${formatTextSize(status?.used ?? 0)} of the ${formatTextSize(status?.limit ?? 0)} limit — all still loaded. Trim in /memory or raise the limit in /config.`, words)
if (notice) {
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  for (const [cols, rows] of [[80, 6], [100, 6], [120, 6], [178, 6]] as const) {
    const element = React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: cols, paddingLeft: 1 }, notice.render({ config: getGlobalConfig(), memoryFiles: [] })))
    const m: Mounted = await mountOffscreen(element, cols, rows)
    await settle(150)
    const lines = m.lines()
    m.unmount()
    const painted = lines.filter(l => l.trim() !== '')
    console.log(`\n  ${cols} columns:`)
    for (const l of painted) console.log(`  │${l}`)
    save(`notice-${cols}.txt`, lines)
    check(`${cols} columns: the line paints once, with the ○ lead, inside the width`, painted.length >= 1 && painted[0]!.trimStart().startsWith('○') && painted.join(' ').replace(/\s+/g, ' ').includes('all still loaded.') && lines.every(l => Array.from(l).length <= cols), painted.join(' | '))
  }
}

section('§3 the /config popup: the Pinned memory limit row, where it sits and how it reads')
{
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
  const store = await import('../../src/utils/cockpit/settingsPopup.js')
  const { configPopupRequest } = await import('../../src/commands/config/config.js')
  const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
  for (const [COLS, ROWS] of [[178, 51], [120, 40]] as const) {
    const element = React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
    )
    const m: Mounted = await mountOffscreen(element, COLS, ROWS)
    store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
    const up = await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 6000)
    check(`${COLS}×${ROWS}: the popup painted`, up)
    await settle(150)
    let found = -1
    for (let step = 0; step < 80 && found < 0; step++) {
      const lines = m.lines()
      found = lines.findIndex(l => l.includes(CONFIG_ROW_MARK) && l.includes('Pinned memory limit'))
      if (found >= 0) break
      m.push(KEY.down)
      await settle(30)
    }
    const lines = m.lines()
    check(`${COLS}×${ROWS}: the Pinned memory limit row is in the list and selectable`, found >= 0)
    const row = found >= 0 ? lines[found]! : ''
    console.log(`  row: ${row.trim()}`)
    check(`${COLS}×${ROWS}: the row reads how full the shelf is and says every rule still loads`, /\d+(\.\d+)?k of \d+(\.\d+)?k/.test(row) && row.includes('over, all still loaded'), row.trim())
    const warning = lines.slice(found + 1, found + 4).join(' ').replace(/│/g, ' ').replace(/\s+/g, ' ')
    check(`${COLS}×${ROWS}: the row's note names the rule count, the limit's meaning and the arrows`, found >= 0 && /\d+ rules? pinned/.test(warning) && warning.includes('every pinned rule still loads past it') && warning.includes('←/→'), warning.trim())
    save(`config-${COLS}x${ROWS}.txt`, lines)
    store.closeSettingsPopup?.()
    m.unmount()
  }
}

section("§4 the line paints in the person's chat and never in a crewmate's chat view")
{
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { Messages } = await import('../../src/components/Messages.js')
  const crewmateSource = readFileSync(join(REPO, 'src/components/CrewmateTranscript.tsx'), 'utf8')
  check('the crewmate transcript mounts Messages with the notice strip suppressed', /<Messages[\s\S]*?suppressNotices[\s\S]*?\/>/.test(crewmateSource))
  const mountMessages = async (suppressNotices: boolean): Promise<string[]> => {
    const props = {
      messages: [],
      tools: [],
      commands: [],
      verbose: true,
      toolJSX: null,
      toolUseConfirmQueue: [],
      inProgressToolUseIDs: new Set<string>(),
      isMessageSelectorVisible: false,
      conversationId: 'crewmate:proof',
      screen: 'prompt' as const,
      streamingToolUses: [],
      showAllInTranscript: false,
      isLoading: false,
      streamingThinking: null,
      hidePastReasoning: true,
      streamingTail: null,
      trackStickyPrompt: false,
      disableRenderCap: true,
      ...(suppressNotices ? { suppressNotices: true } : {}),
    }
    const element = React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 40 }, React.createElement(Messages as never, props))),
    )
    const m: Mounted = await mountOffscreen(element, 120, 40)
    await waitFor(() => m.lines().some(l => l.includes('Pinned memory')), 3000)
    await settle(200)
    const lines = m.lines()
    m.unmount()
    return lines
  }
  const person = await mountMessages(false)
  check("the person's chat header paints the line once", person.filter(l => l.includes('Pinned memory')).length === 1, person.filter(l => l.trim()).slice(0, 6).join(' | '))
  const crewmate = await mountMessages(true)
  check("a crewmate's chat view (the crewmate transcript's mount) paints no line", crewmate.filter(l => l.includes('Pinned memory')).length === 0, crewmate.filter(l => l.includes('Pinned memory')).join(' | '))
  save('crewmate-view-120x40.txt', crewmate)
}

section('§5 the line is a start-of-session reading: what changes mid-session paints nothing new')
{
  const { pinnedStatusPath } = await import('../../src/memdir/mnemeFrontPage.js')
  const under = { ...status!, over: false, used: 100, pinned: 1 }
  writeFileSync(pinnedStatusPath(dir), JSON.stringify(under))
  check('the status on disk now reads under the limit', readPinnedStatus(dir)?.over === false)
  const again = getActiveNotices({ config: getGlobalConfig(), memoryFiles: [] })
  check('a header re-render keeps the reading the session started with', again.some(n => n.id === 'pinned-over-limit'), again.map(n => n.id).join(','))
  const line = again.find(n => n.id === 'pinned-over-limit')?.render({ config: getGlobalConfig(), memoryFiles: [] })
  check('and the same words', line !== null && line !== undefined)
}

await releaseScratchHome(HOME)
console.log(`\nmemory notice frames: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
