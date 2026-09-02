#!/usr/bin/env bun
// ============================================================================
//  repro-activity — reproducer (EXPECT-RED until
//  M4).
//
//  The gap this repro pins: no semantic activity projection exists. Native tool
//  events have rich cards; external (ACP child) events surface as raw tool
//  names; nothing classifies either into the twelve ordered Mercury classes,
//  nothing keys rows by stable source ids for in-place phase updates, and
//  unknown events have no truthful generic row. M4 lands the classifier
//  registry + AgentActivityV1 projection at the path pinned HERE.
// ============================================================================
import { existsSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const CLASSES = [
  'message',
  'file-change',
  'command',
  'check',
  'tool',
  'plan',
  'question',
  'work-item',
  'session-lifecycle',
  'artifact',
  'handoff',
  'unknown',
]

t.section('CS-11 — the classifier registry exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/activity.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/activity.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no activity classifier',
)
t.check(
  'ACTIVITY_CLASSES is exactly the twelve Mercury classes',
  Array.isArray(mod?.ACTIVITY_CLASSES) &&
    JSON.stringify(mod?.ACTIVITY_CLASSES) === JSON.stringify(CLASSES),
  Array.isArray(mod?.ACTIVITY_CLASSES) ? (mod!.ACTIVITY_CLASSES as string[]).join(',') : 'absent',
)
t.check('the ordered classifier exists (classifyActivity)', typeof mod?.classifyActivity === 'function')
t.check(
  'rows key by stable source id (activityIdOf) — never rendered text',
  typeof mod?.activityIdOf === 'function',
)

t.section('CS-11 — adapter event fixtures exist (current shapes + future-unknown)')
{
  const { readFileSync } = await import('node:fs')
  // The adapter fixtures carry `events` arrays (the M3 fixture files own the
  // shapes; the classifier prover replays them) — plus the future-unknown
  // fallback leg lives in prove-activity-classifier §5.
  for (const name of ['codex', 'opencode', 'goose']) {
    let hasEvents = false
    try {
      const fx = JSON.parse(readFileSync(`scripts/session-graph/fixtures/${name}.fixture.json`, 'utf8'))
      hasEvents = Array.isArray(fx.events)
    } catch {
      hasEvents = false
    }
    t.check(`${name} fixture carries replayable events`, hasEvents)
  }
  t.check(
    'the classifier prover exists (table-driven precedence + fixtures)',
    existsSync('scripts/session-graph/prove-activity-classifier.ts'),
  )
}

t.section('CS-12 — the feed UI (journey-final pins, land with the M5 board)')
{
  const { readFileSync } = await import('node:fs')
  // The board's FEED section retired in place with the WORK panel.
  // The feed owner keeps its
  // surviving surface (/crew) and the prompts panel must not re-grow a feed.
  const crewCmd = readFileSync('src/commands/crew/index.ts', 'utf8')
  t.check(
    'the semantic activity feed keeps a production surface (/crew) after the board retired',
    /activityRows|cachedActivityFeed/.test(crewCmd),
    'no feed surface survives the board',
  )
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check(
    'the prompts panel carries no activity feed (a record of prompts and crew traffic only)',
    !/activityRows|cachedActivityFeed|subscribeActivityFeed/.test(panel),
    'the retired feed re-grew on the panel',
  )
}

t.finish('repro-activity')
