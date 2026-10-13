#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')

const RETIRED: Array<{ spelling: RegExp; was: string; now: string }> = [
  { spelling: new RegExp(J('DEC 2026 live', ' latch')), was: 'the terminal check named a DEC mode and a latch', now: 'it says whether this window draws frames atomically, as Windows Terminal does' },
  { spelling: new RegExp(J('full-profile Windows', ' host')), was: 'the failing row of the terminal check was labelled with a profile', now: 'the row is labelled "this window" and says what the window is' },
  { spelling: new RegExp(J('the gate — the full', ' profile renders here')), was: 'Windows Terminal was called the gate', now: 'it is "where Mercury looks right — open it and run mercury there"' },
  { spelling: new RegExp(J("does not satisfy Mercury&apos;s full", ' profile')), was: 'the card opened with a profile a stranger has never heard of', now: 'it opens with "This window cannot show Mercury the way it is designed"' },
  { spelling: new RegExp(J('Theme set to \\$\\{', 'setting\\}')), was: 'the appearance receipt printed the stored spelling (mono, true-black, dark)', now: 'it prints the name the picker shows (Black and white, True Black, Oasis dark)' },
  { spelling: new RegExp(J('> ?· ?e', ' cycles<')), was: 'the model picker\'s effort row ended "e cycles"', now: 'it ends "e changes it"' },
  { spelling: new RegExp(J("'  theme", "   '")), was: 'the chat\'s welcome card called the session critter the theme', now: 'the row is labelled critter' },
  { spelling: new RegExp(J("(mk|kv)\\('Th", "eme'")), was: 'the boot face and the ENVIRONMENT panel called the session critter the theme', now: 'the chip and the row are labelled Critter' },
  { spelling: new RegExp(J('reduced — decorative', ' animation off')), was: 'the motion note repeated its own state word ("reduced — reduced — …")', now: 'the state word is printed once' },
  { spelling: new RegExp(J('fixed in every', ' theme')), was: 'the critter picker promised status colours in every theme', now: 'it names the two colour themes and says Black and white paints none' },
  { spelling: new RegExp(J('\\$\\{verdict\\.statement\\.channel\\}/\\$\\{verdict\\.statement', '\\.target\\}')), was: 'the signed receipt line printed the channel name before the target ("private/macos-arm64")', now: 'it prints the version for the target' },
  { spelling: new RegExp(J('/sub', 'agents\\b')), was: 'the spawn switch had a command of its own, /subagents, beside /crewmates', now: 'one word for one thing: /crewmates on|off flips the switch and /crewmates alone opens the crew view; the old command ceased, with no alias and no refusal line (the changelog and the on-disk subagents/ folder are history, not the screen)' },
  { spelling: new RegExp(J('engine\\?\\.reasoning === ', 'true\\b')), was: '/config read an unset thinking key as off while the model thought', now: 'unset reads on, as the wire treats it; only an explicit off reads off' },
  { spelling: new RegExp(J('Initializing ', 'agent')), was: 'the Crewmate tool\'s progress row read "Initializing agent…"', now: 'one type, one word (ruling AM): the row reads "Initializing crewmate…"' },
  { spelling: new RegExp(J('background agents', '\\b')), was: 'the stop receipts and the multi-launch header counted "background agents"', now: 'they count background crewmates ("All background crewmates stopped.", "N background crewmates launched", "N background crewmates relaunched")' },
  { spelling: new RegExp(J('\\d+ (?:[\\w-]+ )?agents', '(?: finished|…)')), was: 'the grouped Crewmate rows\' header read "N agents finished" / "Running N agents…"', now: 'it reads crewmates' },
  { spelling: new RegExp(J('The agent is ', 'working in the background')), was: 'the launch receipt told the model "The agent is working in the background"', now: 'it says the crewmate is' },
  { spelling: new RegExp(J('To continue this ', 'agent\\b')), was: 'the receipt\'s address line read "To continue this agent, use ResumeCrewmate"', now: 'it reads "To continue this crewmate"' },
  { spelling: new RegExp(J('Resumed ', "agent'")), was: 'a resume with no recorded description was labelled "Resumed agent"', now: 'it is "Resumed crewmate"' },
  { spelling: new RegExp(J('A background agent ', '(?:sent a message|completed a task)')), was: 'the notification heads read "A background agent sent a message:" / "A background agent completed a task:"', now: 'they read "A background crewmate …"' },
  { spelling: new RegExp(J('waiting on ', '(?:\\d+ |\\$\\{[^}]*\\} )?(?:sub-)?agents?\\b')), was: 'the status row, the concourse tile and the crew facts read "waiting on N agents" / "waiting on N sub-agents"', now: 'they read "waiting on N crewmates"' },
  { spelling: new RegExp(J('(?:workflow|spawned|dispatched|delegated|in-process|launched|revived|continued|sibling) ', 'agents?\\b')), was: 'the seats, capacity, flag, config and receipt lines said "workflow agents", "a spawned agent", "a dispatched agent", "Delegated agents", "in-process agents", "the launched agent\'s work", "the revived agent"', now: 'each says crewmate(s)' },
  { spelling: new RegExp(J('\\(sub-', 'agents?')), was: 'the crewmates switch and the docs carried the parenthetical alias "(sub-agents)"', now: 'no alias: the retired spelling ceased (the retired-spelling law)' },
  { spelling: new RegExp(J('Ag', 'ent (?:dispatch refused|execution failed|transcripts:|envelopes|type \')')), was: 'the dispatch refusal, the failure trailer, the workflow recovery line, the health row and the MCP-requirement refusal led with the retired noun', now: 'each leads with Crewmate' },
  { spelling: new RegExp(J("'", 'agents? here')), was: 'the focused-work footer counted "N agents here"', now: 'it counts crewmates here (the short form reads C)' },
  { spelling: new RegExp(J('— agent', ' runs')), was: 'the rail\'s NEXT hint read "/workflows — agent runs"', now: 'it reads "/workflows — crewmate runs"' },
  { spelling: new RegExp(J('"stop ', 'agents"')), was: 'the composer footer\'s kill hint read "stop agents"', now: 'it reads "stop crewmates"' },
  { spelling: new RegExp(J('No agent type', ' named')), was: 'a launch naming an unknown type was refused as "No agent type named"', now: 'the type parameter is crewmate_type, so the refusal says "No crewmate type named"' },
]

const tracked = execFileSync('git', ['ls-files', 'src', 'assets'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(path => /\.(ts|tsx|mjs)$/.test(path))
const SELF = 'scripts/identity/prove-screen-words-plain.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('prove-screen-words-plain — the retired screen spellings of the .34 words pass stay gone from the product\'s source and assets (the changelog is history and is not read)')
for (const row of RETIRED) {
  const hits: string[] = []
  for (const path of tracked) {
    if (path === SELF) continue
    const text = readFileSync(join(ROOT, path), 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (path === 'src/constants/changelog.ts') return
      if (row.spelling.test(line)) hits.push(`${path}:${index + 1}`)
    })
  }
  check(`${row.was} → ${row.now}`, hits.length === 0, hits.slice(0, 5).join(', '))
}

const themeOwner = readFileSync(join(ROOT, 'src/utils/theme.ts'), 'utf8')
check('the one theme-label owner names the three appearances a user reads', themeOwner.includes("dark: 'Oasis dark'") && themeOwner.includes("'true-black': 'True Black'") && themeOwner.includes("mono: 'Black and white'") && themeOwner.includes('export function themeLabel('))
const appearance = readFileSync(join(ROOT, 'src/commands/appearance/appearance.tsx'), 'utf8')
check('the appearance receipt reads the owner', appearance.includes('Theme set to ${themeLabel(setting)}'))
const home = readFileSync(join(ROOT, 'src/components/MercuryHome.tsx'), 'utf8')
check('the welcome card labels the critter row critter and tells a stranger what the model row is', home.includes("'  critter '") && home.includes("'   the model this session runs on · /model changes it'"))
const seats = readFileSync(join(ROOT, 'src/daemon/concourseWorkers.ts'), 'utf8')
check('the seat-ceiling refusal says what to do about it: it names the sessions holding the seats and its moves say what frees one, levers first (headless-process folded over screens-and-words\u2019 sentence)', seats.includes('${seatHoldersWords(live, ceiling)}') && seats.includes("label: 'stop or park a live session on the Session Concourse to free a seat'") && seats.includes("label: 'or raise the ceiling: /seats N in a chat, the Seats row of the Boot Menu or of /config'"))
const cron = readFileSync(join(ROOT, 'src/utils/cron.ts'), 'utf8')
check('a one-shot wake reads as a time on a date, never as a cron string', cron.includes('on ${dom} ${MONTH_NAMES[month - 1]}'))

console.log(failures === 0 ? '\n✅ prove-screen-words-plain — every retired screen spelling stays gone' : `\n❌ prove-screen-words-plain — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
