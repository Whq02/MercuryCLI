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
  { spelling: new RegExp(J('engine\\?\\.reasoning === ', 'true\\b')), was: '/config read an unset thinking key as off while the model thought', now: 'unset reads on, as the wire treats it; only an explicit off reads off' },
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

console.log('prove-screen-words-plain — the retired screen spellings of the .34 words pass stay gone from the product\'s source and assets')
for (const row of RETIRED) {
  const hits: string[] = []
  for (const path of tracked) {
    if (path === SELF) continue
    const text = readFileSync(join(ROOT, path), 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
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
