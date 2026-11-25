#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createSplashCore, vis } from '../../assets/splash/splash-core.mjs'
import { checker } from '../engine-durability/harness.ts'
import { enableConfigs } from '../../src/platform/config/globalConfig.js'
import { kitEntryOf, kitSummaryRows } from '../../src/screen/boot-face/KitMenuScreen.js'
import { agentFaceDetailLines, agentFaceEntryOf, agentFaceSummaryRows } from '../../src/screen/boot-face/agents/face.js'
import { agentsFaceBase } from '../../src/screen/boot-face/agents/menuModel.js'
import { loginsMenuModelOf } from '../../src/screen/boot-face/logins/menuModel.js'
import { resolveEffectiveAgentRuntime } from '../../src/crew/agents/resolver.js'
import { kitCounts, kitRowView, sectionRows } from '../../src/screen/kit-menu-model/kitTypes.js'
import { buildStudioRows } from '../../src/screen/agents/studio/studioData.js'
import { SAMPLE_CATALOGUE, SAMPLE_STATES } from './kit-menu-stills.ts'
import { mixedFacts } from './face-logins-stills.ts'

enableConfigs()

const t = checker()
const core = createSplashCore({ nocolor: true, truecolor: false }) as {
  composeBootMenu: (cols: number, rows: number, m: unknown) => { lines: string[] }
}

const FIX = 'fix wrapDetailLine and moreHint wrapping in composeBootMenuWide (assets/splash/splash-core.mjs) and moreHint strings in KitMenuScreen.tsx, bootAgents/menuModel.ts, bootLogins/menuModel.ts, bootSaturn/menu.tsx'
const WHOLE_FIX = 'in composeBootMenuWide (assets/splash/splash-core.mjs) cut the detail rows above moreHint between whole lines: a line that wraps and does not fit above the trail line is not begun, and the trail line takes its place'

function detailInnerLines(lines: string[]): string[] {
  const start = lines.findIndex(l => l.includes('SETTING DETAIL'))
  if (start < 0) return []
  const headerRight = lines[start]!.lastIndexOf('│')
  const headerLeft = lines[start]!.lastIndexOf('│', headerRight - 1)
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line[headerLeft] === '╰') break
    if (line[headerLeft] !== '│' || line[headerRight] !== '│') break
    out.push(line.slice(headerLeft + 1, headerRight))
  }
  return out
}

function hasTrailingClip(line: string): boolean {
  return /…\s*$/.test(line)
}

const env = { model: 'Sonnet 5.5', critter: 'Crab', critterHue: '#DD4444', dirBase: 'proj', dirTail: '' }

t.section('§1 — MORE HINT FITS WHOLE WITHOUT TRAILING ELLIPSIS AT 120×36 AND 110×36')
{
  const bootModel = {
    entries: [
      {
        label: 'Sovereign mode',
        group: 'trust combo',
        summary: 'no permission question is asked',
        valueLabel: 'on',
        valueIsDefault: false,
        pinnedVal: null,
        detail: {
          controls: 'Interactive boots start in sovereign mode with no permission prompts for files, commands, or computer use. Saving this row is standing consent; the launch confirmation dialog and settings deny rules still apply.',
          on: ['interactive boots start in sovereign mode', 'the launch consent dialog still confirms once'],
          off: ['every permission question is asked'],
        },
        detailExtra: ['this session  1 (boot-env)'],
      },
    ],
    selIdx: 0,
    summary: { profile: 'r1 · custom · 1 set', harness: 'helm' },
    environment: env,
    statusRight: '1 choice saved — applies to new sessions',
    legend: '↑↓ move · ↵ change (saved) · ⌫ default · esc back',
  }
  for (const [cols, rows] of [[120, 36], [110, 36], [120, 40]] as const) {
    const inner = detailInnerLines(core.composeBootMenu(cols, rows, bootModel).lines)
    const hintRows = inner.filter(l => l.includes('the trail continues') || l.includes('terminal'))
    const ok = hintRows.length > 0 && hintRows.every(l => !hasTrailingClip(l)) && inner.join(' ').includes('the trail continues') && inner.join(' ').includes('terminal)')
    t.check(`boot menu ${cols}×${rows}: moreHint fits whole without being cut`, ok, ok ? '' : `${FIX} | got=${JSON.stringify(hintRows)}`)
  }

  const kitRows = sectionRows(SAMPLE_CATALOGUE)
  const kitModel = {
    entries: kitRows.map(r => kitEntryOf(r, kitRowView(r, SAMPLE_STATES))),
    selIdx: 4,
    title: 'mcps & skills',
    summaryTitle: 'NEXT SESSION',
    summaryRows: kitSummaryRows(kitCounts(kitRows, SAMPLE_STATES)),
    environment: env,
    statusRight: '4 choices saved',
    legend: '↑↓ move · esc back',
  }
  for (const [cols, rows] of [[120, 36], [120, 40]] as const) {
    const inner = detailInnerLines(core.composeBootMenu(cols, rows, kitModel).lines)
    const hintRows = inner.filter(l => l.includes('the trail continues') || l.includes('terminal'))
    const ok = hintRows.length > 0 && hintRows.every(l => !hasTrailingClip(l)) && inner.join(' ').includes('terminal)')
    t.check(`mcps & skills ${cols}×${rows}: moreHint fits whole without being cut`, ok, ok ? '' : `${FIX} | got=${JSON.stringify(hintRows)}`)
  }

  const customLongHint = {
    ...bootModel,
    moreHint: '… (the trail continues — a taller terminal shows it whole)',
  }
  for (const [cols, rows] of [[110, 36], [120, 36]] as const) {
    const inner = detailInnerLines(core.composeBootMenu(cols, rows, customLongHint).lines)
    const joined = inner.map(l => l.trim()).join(' ')
    const clipped = inner.filter(hasTrailingClip)
    const ok = clipped.length === 0 && joined.includes('the trail continues') && joined.includes('shows it whole)')
    t.check(`custom long moreHint ${cols}×${rows}: wraps onto a second line instead of clipping`, ok, ok ? '' : `${FIX} | clipped=${JSON.stringify(clipped)} inner=${JSON.stringify(inner)}`)
  }

  const loginsM = loginsMenuModelOf(mixedFacts(), { selIdx: 0, environment: env })
  const loginsOverflow = { ...loginsM, detailOverride: Array.from({ length: 18 }, (_, i) => `detail line ${i + 1}`) }
  const loginsInner = detailInnerLines(core.composeBootMenu(120, 36, loginsOverflow).lines)
  const loginsClipped = loginsInner.filter(hasTrailingClip)
  const loginsOk = loginsClipped.length === 0 && loginsInner.map(l => l.trim()).join(' ').includes('the trail continues')
  t.check('logins 120×36: moreHint fits whole without being cut', loginsOk, loginsOk ? '' : `${FIX} | got=${JSON.stringify(loginsInner.slice(-3))}`)
}

t.section('§2 — OVERLONG DETAIL LINES WRAP WHEN THE PANE HAS ROWS FREE (AGENTS · KIT · LONG PATHS)')
{
  const crew = {
    agentType: 'mercury-crew',
    whenToUse: 'General-purpose worker.',
    getSystemPrompt: () => 'You are mercury-crew.',
    source: 'built-in' as const,
  }
  const scout = {
    agentType: 'mercury-scout',
    whenToUse: 'Read-only explorer.',
    getSystemPrompt: () => 'You are mercury-scout.',
    source: 'built-in' as const,
  }
  const built = buildStudioRows({ activeAgents: [crew, scout], allAgents: [crew, scout] } as never, { tab: 'all', filter: 'all', query: '' })
  const eff = resolveEffectiveAgentRuntime(crew as never, { parentModel: 'claude-sonnet-5-5', sessionEffort: 'high', tools: [] })
  const detailLines = agentFaceDetailLines(built.rows[0]!, built.estate, eff)
  const base = agentsFaceBase({ counts: { active: 2, disabled: 0, issues: 0 }, mainModel: 'claude-sonnet-5-5', wordGlow: null, workspaceDir: '/tmp/proj' })
  const agentsM = {
    ...base,
    entries: built.rows.map(agentFaceEntryOf),
    selIdx: 0,
    statusRight: '2 agents active',
    legend: '↑↓ move · esc back',
    detailOverride: detailLines,
  }

  const inner36 = detailInnerLines(core.composeBootMenu(120, 36, agentsM).lines)
  const clipped36 = inner36.filter(hasTrailingClip)
  t.check('agents 120×36: neither moreHint nor the line above it ends in a trailing ellipsis', clipped36.length === 0 && inner36.map(l => l.trim()).join(' ').includes('the trail continues'), clipped36.length === 0 ? '' : `${FIX} | clipped=${JSON.stringify(clipped36)}`)
  for (const rows of [37, 38] as const) {
    const inner = detailInnerLines(core.composeBootMenu(120, rows, agentsM).lines)
    const clipped = inner.filter(hasTrailingClip)
    const joined = inner.map(l => l.trim()).join(' ')
    t.check(`agents 120×${rows}: no line is clipped with a trailing ellipsis and the trail line stands at the foot`, clipped.length === 0 && joined.includes('the trail continues'), `${FIX} | clipped=${JSON.stringify(clipped)} inner=${JSON.stringify(inner)}`)
  }

  for (const [cols, rows] of [[120, 40], [204, 43]] as const) {
    const inner = detailInnerLines(core.composeBootMenu(cols, rows, agentsM).lines)
    const clipped = inner.filter(hasTrailingClip)
    const joined = inner.map(l => l.trim()).join(' ')
    const ok =
      clipped.length === 0 &&
      joined.includes('claude-sonnet-5-5') &&
      joined.includes("session's model)") &&
      joined.includes('MCP tools join at session') &&
      joined.includes('time)')
    t.check(`agents ${cols}×${rows}: long model and tools lines wrap whole with no ellipsis`, ok, ok ? '' : `${FIX} | clipped=${JSON.stringify(clipped)} inner=${JSON.stringify(inner)}`)
  }

  const kitRows = sectionRows(SAMPLE_CATALOGUE)
  const extSkillIdx = kitRows.findIndex(r => r.kind === 'skill' && r.name === 'orchard-tools:prune')
  const kitTall = {
    entries: kitRows.map(r => kitEntryOf(r, kitRowView(r, SAMPLE_STATES))),
    selIdx: extSkillIdx,
    title: 'mcps & skills',
    summaryTitle: 'NEXT SESSION',
    summaryRows: kitSummaryRows(kitCounts(kitRows, SAMPLE_STATES)),
    environment: env,
    statusRight: '4 choices saved',
    legend: '↑↓ move · esc back',
  }
  const innerKitTall = detailInnerLines(core.composeBootMenu(120, 50, kitTall).lines)
  const clippedKitTall = innerKitTall.filter(hasTrailingClip)
  const joinedKitTall = innerKitTall.map(l => l.trim()).join(' ')
  const kitTallOk = clippedKitTall.length === 0 && joinedKitTall.includes('this skill follows it') && joinedKitTall.includes('/orchard-tools:prune')
  t.check('mcps & skills 120×50: long detailExtra lines wrap whole with no ellipsis', kitTallOk, kitTallOk ? '' : `${FIX} | clipped=${JSON.stringify(clippedKitTall)} inner=${JSON.stringify(innerKitTall)}`)

  const longPathM = {
    ...agentsM,
    detailOverride: ['fixture-scout', '', '/Users/operator/workspace/very-deep-repository-name/.mercury/agents/fixture-scout.md'],
  }
  const innerPath = detailInnerLines(core.composeBootMenu(120, 40, longPathM).lines)
  const clippedPath = innerPath.filter(hasTrailingClip)
  const joinedPath = innerPath.map(l => l.trim()).join('')
  const pathOk = clippedPath.length === 0 && joinedPath.includes('fixture-scout.md')
  t.check('agents 120×40: unbreakable long file path wraps instead of clipping with ellipsis', pathOk, pathOk ? '' : `${FIX} | clipped=${JSON.stringify(clippedPath)} inner=${JSON.stringify(innerPath)}`)

  t.section('§3 — A WRAPPED LINE IS SHOWN WHOLE OR NOT BEGUN: THE TRAIL LINE TAKES ITS PLACE')
  const trail36 = inner36.findIndex(l => l.includes('the trail continues'))
  const above36 = inner36.slice(0, Math.max(0, trail36)).map(l => l.trim()).filter(Boolean)
  const whole36 = trail36 > 0 && above36.at(-1) === 'scope: Built-in agents' && !above36.some(l => l.includes('(your'))
  t.check('agents 120×36: the pane ends on a whole line and the trail line stands where the model line would begin', whole36, whole36 ? '' : `${WHOLE_FIX} | above the trail line=${JSON.stringify(above36.slice(-2))}`)

  const kitAt = (selIdx: number) => ({ ...kitTall, selIdx })
  const halves: string[] = []
  let cuts = 0
  for (let rows = 31; rows <= 50; rows++) {
    const panes: Array<[string, unknown]> = [['agents', agentsM], ...kitTall.entries.map((entry, i): [string, unknown] => [`mcps & skills · ${entry.label}`, kitAt(i)])]
    for (const [name, model] of panes) {
      const shown = detailInnerLines(core.composeBootMenu(120, rows, model).lines)
      const at = shown.findIndex(l => l.includes('the trail continues'))
      if (at <= 0) continue
      cuts++
      const tall = detailInnerLines(core.composeBootMenu(120, 90, model).lines)
      if (/^ {3}\S/.test(tall[at] ?? '') && shown[at - 1] === tall[at - 1]) halves.push(`${name} 120×${rows}: ${JSON.stringify(shown[at - 1]!.trim())} without ${JSON.stringify(tall[at]!.trim())}`)
    }
  }
  t.check(`agents and mcps & skills, 120 columns, 31 to 50 rows: no pane ends on the first half of a wrapped line (${cuts} panes carry the trail line)`, cuts > 0 && halves.length === 0, cuts === 0 ? 'no pane carried the trail line: the sweep proves nothing, widen its rows' : `${WHOLE_FIX} | ${halves.join(' · ')}`)
}

t.section('§4 — BELOW 110 COLUMNS A NOTICE WORD LONGER THAN THE LINE WRAPS; WHERE THE LINES RUN OUT ITS END IS KEPT')
{
  const NOTICE_FIX = 'in composeBootMenuClassic (assets/splash/splash-core.mjs) a notice word wider than the line is split over the notice\'s lines, and when the notice has more lines than its room the word is cut to its end on one line'
  const file = '/Users/operator/workspace/very-deep-repository-name/.local/bin/mercury2'
  const refusalM = {
    entries: [{ label: '1 · Profile 1', group: 'profiles', summary: 'this session runs in it', valueLabel: 'mercury · this one', valueIsDefault: false, pinnedVal: null, detail: null }],
    selIdx: 0,
    title: 'profiles',
    summaryTitle: 'PROFILES',
    summaryRows: [],
    environment: env,
    statusRight: '1 profile',
    legend: '↑↓ move · n new · r rename · esc back',
    detailOverride: [`The file ${file} is already there and is not this profile's command: move it away, then create the profile again.`],
    detailOverrideConfirms: true,
  }
  const squashed = (lines: string[]): string => lines.join('').replace(/\s+/g, '')
  const roomy = core.composeBootMenu(60, 20, refusalM).lines
  t.check('60×20: the file a notice names is whole over its lines and the sentence ends', squashed(roomy).includes(file) && roomy.some(l => l.includes('again.')), `${NOTICE_FIX} | lines=${JSON.stringify(roomy.map(l => l.trim()).filter(Boolean))}`)
  const tight = core.composeBootMenu(60, 12, refusalM).lines
  t.check('60×12: with room for three notice lines the file is cut to its end, the name of the file whole', tight.some(l => l.trim().startsWith('…') && l.trimEnd().endsWith('/.local/bin/mercury2')), `${NOTICE_FIX} | lines=${JSON.stringify(tight.map(l => l.trim()).filter(Boolean))}`)
  const tighter = core.composeBootMenu(60, 11, refusalM).lines.map(l => l.trim())
  t.check('60×11: with room for two notice lines the file cut to its end is the last one, whole to its name and cut once', tighter.some(l => l.startsWith('…') && l.endsWith('/.local/bin/mercury2')) && !tighter.some(l => l.includes('……')), `${NOTICE_FIX}; the last notice line is not cut again when it is the word already cut to its end | lines=${JSON.stringify(tighter.filter(Boolean))}`)
  const wideFile = '/Users/operator/工作空间/非常深的仓库名称/另一个很长的子项目目录名称/.local/bin/mercury2'
  const wideM = { ...refusalM, detailOverride: [`The file ${wideFile} is already there and is not this profile's command: move it away, then create the profile again.`] }
  const wide = core.composeBootMenu(60, 12, wideM).lines.map(l => l.trim())
  t.check('60×12: a file named in wide characters is cut to its end by cells, its name whole and the line inside the window', wide.some(l => l.startsWith('…') && l.endsWith('/.local/bin/mercury2') && vis(l) <= 56), `${NOTICE_FIX}; the cut counts cells with the core's own measure | lines=${JSON.stringify(wide.filter(Boolean))}`)
  const plainM = { ...refusalM, detailOverride: ['a notice of ordinary words that is longer than one line of this window and so wraps between its words as it always did'] }
  const plain = core.composeBootMenu(60, 20, plainM).lines.map(l => l.trim())
  t.check('60×20: a notice of ordinary words wraps between words as before', plain.includes('a notice of ordinary words that is longer than one line') && plain.includes('of this window and so wraps between its words as it')  && plain.includes('always did'), `${NOTICE_FIX} | lines=${JSON.stringify(plain.filter(Boolean))}`)
}

t.section('§5 — AN OPEN CONFIRM IS ON THE SCREEN WHOLE AT EVERY SIZE: IN THE LAYOUT\'S OWN ROOM, OR AS ITS ONE LINE IN PLACE OF THE LEGEND')
{
  const ASK_FIX = 'in assets/splash/splash-core.mjs a layout whose own room cuts the confirm it is handed (the notice of composeBootMenuClassic, the pane of composeBootMenuWide) draws m.asking in place of the legend, as composeBootMenuMicro does; where the confirm is whole nothing moves'
  const card = ['prune transcripts — the one deleting', 'door · nothing is ever deleted', 'automatically', '', "scope: this project's listed chats", 'older than 30 days', '', 'would delete: 2 transcripts · total 1.2 KB', 'age range: 3mo ago → 2mo ago', '', '▸ No — keep everything (default)', '  Yes — delete exactly this set, for good', '', 'deletes exactly the set named above ·', 'asked every time, never remembered']
  const asking = 'delete 2 transcripts? ▸ No · ↑↓ ↵ esc'
  const legend = '↑↓ choose · ↵ commit (No is the default) · esc / n keep everything'
  const bareM = {
    entries: [{ label: 'alpha chat', group: 'sessions', summary: '2 months ago', valueLabel: '2 months ago', valueIsDefault: true, pinnedVal: null, detail: null }],
    selIdx: 0,
    title: 'resume session',
    summaryTitle: 'SESSIONS',
    summaryRows: [],
    environment: env,
    statusRight: '1 session',
    legend,
    detailOverride: card,
    detailOverrideConfirms: true,
  }
  const squashed = (lines: string[]): string => lines.join('').replace(/\s+/g, '')
  const cut: string[] = []
  const moved: string[] = []
  const unasked: string[] = []
  for (const cols of [40, 48, 80, 120]) {
    for (let rows = 2; rows <= 50; rows++) {
      const bare = core.composeBootMenu(cols, rows, bareM).lines
      const asked = core.composeBootMenu(cols, rows, { ...bareM, asking }).lines
      const room = bare.some(l => l.includes('SETTING DETAIL')) ? detailInnerLines(bare) : bare
      if (squashed(room).includes(squashed(card))) {
        if (asked.join('\n') !== bare.join('\n')) moved.push(`${cols}×${rows}`)
        continue
      }
      cut.push(`${cols}×${rows}`)
      if (!asked.some(l => l.includes(asking)) || asked.some(l => l.includes('keep everything') && l.includes('↑↓ choose'))) unasked.push(`${cols}×${rows}`)
    }
  }
  t.check(`40, 48, 80 and 120 columns by 2 to 50 rows: wherever the layout's own room cuts the confirm (${cut.length} sizes) its one line stands whole in place of the legend`, cut.length > 0 && unasked.length === 0, `${ASK_FIX} | the line is missing at ${unasked.slice(0, 12).join(', ')}${unasked.length > 12 ? ` and ${unasked.length - 12} more` : ''}`)
  t.check('…and wherever the confirm is whole, handing the line moves nothing: the frame is byte for byte the frame without it', moved.length === 0, `${ASK_FIX} | the frame differs at ${moved.slice(0, 12).join(', ')}`)
}

t.finish('prove-boot-detail-pane-fits')
