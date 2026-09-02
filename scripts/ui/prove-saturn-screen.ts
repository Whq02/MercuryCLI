#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-saturn-screen.ts — the SATURN birth-tier scheduler
// screen (the lane; the operator's banked spec: schedule a
//  fresh session to be born at a time, all seven facts customizable).
//
//    §1 THE SPELLING COMPILER (fork (v)'s form seam) — every teaching
//       example compiles; the landed substrate's own phrases compile to
//       their landed targets (PINNED-SPELLING-WINS: 'every day 09:00' →
//       '0 9 * * *', 'in a minute' → one minute out, cronToHuman's display
//       forms round-trip, raw 5-field cron passes verbatim); the phrase is
//       stored VERBATIM and survives the wire validator byte-equal;
//       refusals are typed sentences that name a working form; the 'at'
//       arithmetic is local-clock (computed here with the same calendar).
//    §2 THE BOARD COMPOSERS — the parity floor's verbs verbatim in the
//       legend; value polarity; the trail's honesty (spelling verbatim ·
//       account WHO-never-a-token · absent preflight 'not computed' ·
//       birth facts · held reasons · the fired-late/missed receipt tail);
//       board order (owners contiguous); the projection wiring.
//    §3 THE TIERS AND THE STILLS — the 64×12 floor warns and keeps the way
//       out; classic and wide carry the rows; stills byte-compare
//       (saturn-screen-stills.ts --write regenerates).
//    §4 THE REAL MOUNT — staticRender over injected facts at a frozen
//       clock; zero surface-route imports; the landed wire verbs alone.
//    §5 THE FORM — the banked seven facts as rows; THE ONE VERDICT's
//       sentences verbatim (expired/signed-out carry the held-birth
//       honesty line); the compiler's errors shown as its own; the L26
//       two-door refusal; presence/opening/contract contracts in words.
//    §6 THE BOX WRITERS — the operator door over the daemon-home file:
//       daemon-shaped stamps, the derived account (typed refusal writes
//       nothing), BOTH presence arms (the ruled widening), pause/resume/
//       remove, the 50-cap; the built row always satisfies the loud-skip
//       read's own validator.
//    §7 THE ROW AND THE DOOR — after Doctor, the menu's fit fact, host-
//       truth ctx, one row owner, both hosts' activations, the face-door
//       deep-link armed once with no boot-surface intent.
//    §8 THE CONCOURSE ROW FACT — saturnSoonestFireMs pure (paused never
//       counts; absent ≠ empty); one reader (the snapshot composer), one
//       paint home (the NOW cell's workflows-tag grammar).
//    §9 THE REACTIVATION WARN — fork (ii)'s paint at the one resume door:
//       THE ONE VERDICT over live facts, typed sentences, display-only,
//       fail-soft.
//    §10 ROUTE SILENCE + THE ESC CHAIN — the real layer mounts on the live
//       store with zero transitions; prompt → picker → form → board close
//       one at a time; the face's lists park behind the layer.
//
//  cpu-pure: pure compiles + the shared core + one off-screen Ink string
//  render; never a PTY, a daemon, a boot, or a live probe run.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { compileWhenSpelling, parseTimeOfDay, WHEN_SPELLING_EXAMPLES } from '../../src/services/saturn/whenSpelling.js'
import { validateSaturnSubmission, SATURN_SPELLING_CAP, describeWhen } from '../../src/daemon/saturn.js'
import { cronToHuman } from '../../src/utils/cron.js'

const t = checker()

// ── §1 the spelling compiler ────────────────────────────────────────────────
{
  // A frozen LOCAL afternoon — the 'at' expectations build through the same
  // calendar constructor the compiler uses, so the pins hold in every tz.
  const NOW = new Date(2026, 7, 29, 14, 0, 0, 0).getTime()
  const at = (d: number, h: number, m: number): number => new Date(2026, 7, d, h, m, 0, 0).getTime()

  const compiled = (raw: string): ReturnType<typeof compileWhenSpelling> => compileWhenSpelling(raw, NOW)
  const cronOf = (raw: string): string | null => {
    const c = compiled(raw)
    return c.ok && c.when.kind === 'every' ? c.when.cron : null
  }
  const atOf = (raw: string): number | null => {
    const c = compiled(raw)
    return c.ok && c.when.kind === 'at' ? c.when.atMs : null
  }

  // Every teaching example compiles green (the form's hint line never
  // advertises a phrase the compiler refuses).
  t.check('§1 every WHEN_SPELLING_EXAMPLES entry compiles', WHEN_SPELLING_EXAMPLES.every(e => compileWhenSpelling(e, NOW).ok))

  // PINNED-SPELLING-WINS: the landed substrate's phrases hit their targets.
  t.check("§1 'every day 09:00' compiles to the landed cron", cronOf('every day 09:00') === '0 9 * * *')
  t.check("§1 'every day 08:00' compiles to the landed cron", cronOf('every day 08:00') === '0 8 * * *')
  t.check("§1 'in a minute' is one minute out", atOf('in a minute') === NOW + 60_000)
  t.check('§1 cronToHuman round-trips: Every 5 minutes', cronOf(cronToHuman('*/5 * * * *')) === '*/5 * * * *')
  t.check('§1 cronToHuman round-trips: Every hour at :07', cronOf(cronToHuman('7 * * * *')) === '7 * * * *')
  t.check('§1 cronToHuman round-trips: Every minute', cronOf(cronToHuman('* * * * *')) === '* * * * *')
  t.check('§1 raw 5-field cron passes verbatim', cronOf('0 9 * * 1-5') === '0 9 * * 1-5')

  // The 'at' arithmetic: a bare time still ahead lands today; one already
  // passed lands tomorrow; 'tomorrow <time>' lands tomorrow even when the
  // time would still fit today.
  t.check("§1 '18:30' lands today (still ahead of 14:00)", atOf('18:30') === at(29, 18, 30))
  t.check("§1 '6am' lands tomorrow (already passed)", atOf('6am') === at(30, 6, 0))
  t.check("§1 'at 6:30pm' lands today", atOf('at 6:30pm') === at(29, 18, 30))
  t.check("§1 'tomorrow 07:30' lands tomorrow", atOf('tomorrow 07:30') === at(30, 7, 30))
  t.check("§1 'tomorrow 15:00' lands tomorrow, not today", atOf('tomorrow 15:00') === at(30, 15, 0))
  t.check("§1 'tomorrow morning' is the landed 9am", atOf('tomorrow morning') === at(30, 9, 0))
  t.check("§1 'in 20m' is twenty minutes out", atOf('in 20m') === NOW + 20 * 60_000)
  t.check("§1 'in 2h' is two hours out", atOf('in 2h') === NOW + 2 * 3_600_000)
  t.check("§1 'noon' lands tomorrow (12:00 already passed at 14:00)", atOf('noon') === at(30, 12, 0))

  // The recurring arms.
  t.check("§1 'hourly' and 'every hour' agree", cronOf('hourly') === '0 * * * *' && cronOf('every hour') === '0 * * * *')
  t.check("§1 'every 5 minutes' steps the minute", cronOf('every 5 minutes') === '*/5 * * * *')
  t.check("§1 'every 2 hours' steps the hour", cronOf('every 2 hours') === '0 */2 * * *')
  t.check("§1 'weekdays 9am' is the working week", cronOf('weekdays 9am') === '0 9 * * 1-5')
  t.check("§1 'weekends 10:00' is the other two", cronOf('weekends 10:00') === '0 10 * * 0,6')
  t.check("§1 'every monday 9am' names the day", cronOf('every monday 9am') === '0 9 * * 1')
  t.check("§1 'every mon,fri 17:00' names both, sorted", cronOf('every mon,fri 17:00') === '0 17 * * 1,5')
  t.check("§1 'daily 6pm' reads the 12-hour clock", cronOf('daily 6pm') === '0 18 * * *')

  // Verbatim storage + the wire validator round-trip: the compiled `when`
  // is accepted whole and the spelling survives byte-equal; describeWhen
  // echoes it on every surface.
  const roundTrip = compiled('Every day 09:00')
  t.check('§1 the spelling stores VERBATIM (case and all)', roundTrip.ok && roundTrip.when.spelling === 'Every day 09:00')
  if (roundTrip.ok) {
    const validated = validateSaturnSubmission({ when: roundTrip.when, action: { kind: 'fire', prompt: 'x' } })
    t.check('§1 the validator accepts every compiled when', validated.ok)
    t.check(
      '§1 the spelling survives the validator byte-equal',
      validated.ok && (validated.submission.when as { spelling?: string }).spelling === 'Every day 09:00',
    )
    t.check('§1 describeWhen echoes the spelling verbatim', describeWhen(roundTrip.when) === 'Every day 09:00')
  }

  // Typed refusals name a working form — never a bare no.
  const refusals: Array<[string, RegExp]> = [
    ['', /say when/],
    ['banana', /not a schedule spelling/],
    ['in banana', /not a delay/],
    ['every day', /say the time too/],
    ['weekdays', /say the time too/],
    ['tomorrow 25:99', /not a time/],
    ['every 0 minutes', /zero interval/],
    ['every 90 minutes', /59 is the widest minute step/],
    ['x'.repeat(SATURN_SPELLING_CAP + 1), /stays under/],
    ['6am' + String.fromCharCode(7), /one plain line/],
  ]
  for (const [raw, want] of refusals) {
    const c = compileWhenSpelling(raw, NOW)
    t.check(`§1 refusal is typed: ${JSON.stringify(raw.slice(0, 24))}`, !c.ok && want.test(c.reason))
  }

  // The time-of-day parser's own edges (the 12-hour hinges).
  t.check('§1 12am is midnight', JSON.stringify(parseTimeOfDay('12am')) === JSON.stringify({ hour: 0, minute: 0 }))
  t.check('§1 12pm is noon', JSON.stringify(parseTimeOfDay('12pm')) === JSON.stringify({ hour: 12, minute: 0 }))
  t.check('§1 a bare number is not a time (ambiguous)', parseTimeOfDay('6') === null)
}

// ── §2 the board's pure composers ───────────────────────────────────────────
t.section('§2 — THE BOARD COMPOSERS (the parity floor survives; state is words)')
{
  const { FIXED_NOW, FIXTURE_FACTS, EMPTY_FACTS, fixtureReceiptsOf } = await import('./saturn-screen-stills.js')
  const {
    fireDeltaWords,
    saturnDetailLines,
    saturnEmptyDetailLines,
    saturnEntryOf,
    saturnLegendOf,
    saturnNextFireWords,
    saturnStatusLine,
    saturnSummaryRows,
  } = await import('../../src/components/BootSaturnScreen.js')

  // The delta words — plain, bounded, never a bare number.
  t.check('§2 delta words: due now / minutes / hours / days / none', fireDeltaWords(FIXED_NOW - 1, FIXED_NOW) === 'due now' && fireDeltaWords(FIXED_NOW + 20 * 60_000, FIXED_NOW) === 'in 20m' && fireDeltaWords(FIXED_NOW + 2 * 3_600_000, FIXED_NOW) === 'in 2h' && fireDeltaWords(FIXED_NOW + 3 * 86_400_000, FIXED_NOW) === 'in 3d' && fireDeltaWords(null, FIXED_NOW) === 'no future fire')

  const byId = new Map(FIXTURE_FACTS.rows.map(r => [r.facts.id, r]))
  const fire = byId.get('aaaa1111')!
  const birth = byId.get('bbbb2222')!
  const paused = byId.get('cccc3333')!
  const held = byId.get('dddd4444')!
  const box = byId.get('eeee5555')!

  t.check("§2 a paused row's words are 'paused' (paused wins over the clock)", saturnNextFireWords(paused.facts, FIXED_NOW) === 'paused')
  t.check('§2 the entry label leads with the id and carries the spelling verbatim', saturnEntryOf(fire, FIXED_NOW).label === 'aaaa1111  in 2h' && saturnEntryOf(paused, FIXED_NOW).label.includes('every day 09:00'))
  t.check('§2 the owning session is the SECTION title; a parked owner says so', saturnEntryOf(fire, FIXED_NOW).groupTitle === 'journey session' && saturnEntryOf(held, FIXED_NOW).groupTitle === 'ops · parked')
  t.check("§2 a box row's section names the tier", saturnEntryOf(box, FIXED_NOW).groupTitle === 'box (machine)')
  t.check('§2 value polarity: a quiet standing row reads default; held/paused/spent rows stand out', saturnEntryOf(fire, FIXED_NOW).valueIsDefault === true && saturnEntryOf(held, FIXED_NOW).valueIsDefault === false && saturnEntryOf(paused, FIXED_NOW).valueIsDefault === false)
  t.check('§2 a held row wears its held count on the value', saturnEntryOf(held, FIXED_NOW).valueLabel.endsWith('· 2 held'))

  // The parity floor's verbs live in the legend (the J6 needles verbatim).
  const legend = saturnLegendOf({ busy: false })
  t.check('§2 the legend carries the parity floor verbatim (x delete · n run-now · r refresh)', legend.includes('x delete') && legend.includes('n run-now') && legend.includes('r refresh'))
  t.check('§2 the legend adds pause/resume and the way out', legend.includes('p pause/resume') && legend.includes('esc back'))
  t.check('§2 the busy legend says the screen settles', saturnLegendOf({ busy: true }).includes('settles'))

  // The detail trail: spelling verbatim, the first-class account (WHO,
  // never a token), the absent-preflight honesty, birth facts, held
  // reasons, and the fired-late/missed receipt tail.
  const fireDetail = saturnDetailLines(fire, FIXED_NOW, []).join('\n')
  t.check('§2 the trail speaks the spelling verbatim', fireDetail.includes('when: in 2h'))
  t.check('§2 the trail names the account family/source and identity (wrapped at the panel width)', fireDetail.includes('account: anthropic/oauth') && fireDetail.includes('op@example.com'))
  t.check('§2 nothing token-shaped in a trail', !/accessToken|refreshToken|apiKey|secret/i.test(fireDetail))
  const noPreflight = { ...fire, schedule: { ...fire.schedule } }
  delete (noPreflight.schedule as { preflightAtWrite?: unknown }).preflightAtWrite
  t.check("§2 an absent preflight reads 'not computed' — never ready", saturnDetailLines(noPreflight, FIXED_NOW, []).join('\n').includes('preflight at write: not computed'))
  const birthDetail = saturnDetailLines(birth, FIXED_NOW, []).join('\n')
  t.check('§2 a birth trail names presence, workspace, preset and the pre-answered contract', birthDetail.includes('birth: screen-present in') && birthDetail.includes("wearing: preset 'review-kit'") && birthDetail.includes('contract: no-contract (pre-answered)') && birthDetail.includes('born-working'))
  const heldDetail = saturnDetailLines(held, FIXED_NOW, fixtureReceiptsOf(held)).join('\n')
  t.check('§2 held fires paint typed reasons', heldDetail.includes('held fires: 2') && heldDetail.includes('sign-in-expired'))
  t.check('§2 the fired-late/missed receipts stay visible in the trail', heldDetail.includes('recent fire decisions:') && heldDetail.includes('missed — ~430m late') && heldDetail.includes('held: sign-in expired'))

  // Summary, status, empty — words, never a bare dead end.
  const summary = saturnSummaryRows(FIXTURE_FACTS, FIXED_NOW)
  t.check('§2 the summary counts schedules and names the soonest fire', summary[0]!.value === '5' && summary[1]!.value === 'in 2h')
  t.check('§2 held>0 wears amber and the /logins release sentence', summary[2]!.tone === 'amber' && summary[2]!.value.includes('/logins releases sign-in holds'))
  t.check('§2 the paused row never counts a next fire', saturnSummaryRows({ ...FIXTURE_FACTS, rows: [paused] }, FIXED_NOW)[1]!.value === '—')
  t.check('§2 the status line counts and stays read-only until a verb', saturnStatusLine(FIXTURE_FACTS).includes('5 schedules · 2 held'))
  t.check('§2 the unreadable-store status says what to do', saturnStatusLine({ rows: [], heldTotal: 0, sessions: 0, daemonReadable: false }).includes('press r'))
  // AMENDED (the operator's sighting): the empty state
  // LEADS with the birth door (press a — keyHintLabel's grammar) and the
  // in-session road speaks second; the old copy read as a read-only screen.
  const emptyDetail = saturnEmptyDetailLines(EMPTY_FACTS).join('\n')
  t.check('§2 the empty detail LEADS with the birth door (press a)', emptyDetail.includes('press a to schedule a session birth'))
  t.check('§2 the empty detail teaches the in-session road second', emptyDetail.includes('a session schedules itself') && emptyDetail.includes('press a') && emptyDetail.indexOf('press a') < emptyDetail.indexOf('a session schedules itself'))

  // Board order: one section header per owner — the groups are contiguous
  // (a global soonest-first sort would interleave owners), groups by their
  // own soonest fire, rows within a group soonest-first.
  {
    const keys = FIXTURE_FACTS.rows.map(r => (r.box === true ? 'box' : r.sessionId))
    const contiguous = keys.every((k, i) => i === 0 || k === keys[i - 1] || !keys.slice(0, i).includes(k))
    t.check('§2 the board keeps each owner contiguous (one header each)', contiguous, keys.join(','))
    t.check('§2 the soonest owner leads the board', FIXTURE_FACTS.rows[0]!.facts.id === 'aaaa1111')
  }

  // The recurring projection wiring (local-clock math pinned relatively —
  // the stills stay TZ-free by construction).
  const { saturnFactsOf } = await import('../../src/daemon/saturn.js')
  const anyNow = Date.parse('2026-08-29T12:07:00Z')
  const projected = saturnFactsOf({ schedules: [{ ...paused.schedule, paused: undefined, when: { kind: 'every', cron: '*/30 * * * *' } } as never] }, anyNow)
  const nf = projected.schedules?.[0]?.nextFireMs ?? null
  t.check('§2 a live recurring row projects a next fire within its own step', nf !== null && nf > anyNow && nf - anyNow <= 30 * 60_000)
}

// ── §3 the composition tiers + the stills ───────────────────────────────────
t.section('§3 — THE TIERS AND THE STILLS (64×12 floor · classic · wide; bytes)')
{
  const { STILLS, composeSaturn, readStill, renderStill } = await import('./saturn-screen-stills.js')
  const wide = composeSaturn(120, 40, { sel: 0 }).join('\n')
  t.check('§3 the wide frame carries the title, the SATURN panel, the sections and the legend', wide.includes('saturn scheduler') && wide.includes('SATURN') && wide.includes('journey session') && wide.includes('box (machine)') && wide.includes('x delete'))
  t.check('§3 the wide frame paints ids and spellings on the rows', wide.includes('aaaa1111') && wide.includes('every day 09:00'))
  const classic = composeSaturn(80, 24, { sel: 0 }).join('\n')
  t.check('§3 the classic tier keeps the rows and the legend', classic.includes('aaaa1111') && classic.includes('x delete'))
  const floor = composeSaturn(64, 12, { sel: 0 }).join('\n')
  t.check('§3 the 64×12 floor WARNS and keeps the way out (never a wall)', floor.includes('wants at least') && floor.includes('esc back'))
  const empty = composeSaturn(120, 40, { facts: (await import('./saturn-screen-stills.js')).EMPTY_FACTS }).join('\n')
  t.check('§3 the empty board teaches instead of blanking', empty.includes('no schedules stand.'))

  for (const still of STILLS) {
    const want = readStill(still.id)
    t.check(`§3 still byte-match: ${still.id}`, want !== null && renderStill(still.compose()) === want, want === null ? 'missing — run saturn-screen-stills.ts --write' : 'drifted — regenerate on purpose')
  }
}

// ── §4 the real mount + the route-silence structure ─────────────────────────
t.section('§4 — THE REAL MOUNT (staticRender, injected facts) + route silence')
{
  process.env['MERCURY_CONFIG_DIR'] ??= (await import('node:fs')).mkdtempSync(
    join((await import('node:os')).tmpdir(), 'saturn-screen-prove-'),
  )
  process.env['FORCE_COLOR'] = '3'
  process.env['MERCURY_CRITTER_GAZE'] = '0'
  process.env['MERCURY_LIVE_GLYPHS'] = '0'
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootSaturnScreen } = await import('../../src/components/BootSaturnScreen.js')
  const { FIXED_NOW, FIXTURE_FACTS, fixtureReceiptsOf } = await import('./saturn-screen-stills.js')
  const frame = await renderToString(
    React.createElement(BootSaturnScreen, {
      facts: FIXTURE_FACTS,
      nowMs: FIXED_NOW,
      receiptsOf: fixtureReceiptsOf,
      fullScene: { columns: 120, rows: 40 },
    } as never),
    120,
  )
  t.check('§4 the mounted screen paints the rows and their owners', frame.includes('aaaa1111') && frame.includes('journey session') && frame.includes('box (machine)'))
  t.check('§4 the mounted screen paints the parity-floor legend', frame.includes('x delete') && frame.includes('n run-now') && frame.includes('r refresh'))
  t.check('§4 the mounted screen paints the held truth', frame.includes('2 held'))

  // The route CANNOT move because this screen exists: zero surface-route
  // imports (the face-doors structural law; the live-store journey pins
  // ride the face wiring commit).
  const screenSrc = readFileSync(join(process.cwd(), 'src/components/BootSaturnScreen.tsx'), 'utf8')
  const routeTokens = ['surfaceRoute', 'enterRootRepl', 'settleAbsentChat', 'armRootCommand', 'initialMessage']
  const routeHits = routeTokens.filter(tok => screenSrc.includes(tok))
  t.check('§4 the screen module never touches the surface-route bridge', routeHits.length === 0, routeHits.join(','))
  // The wire verbs it drives are the LANDED ones alone — no new op verb.
  t.check("§4 the screen writes through 'set-schedule' and 'sessionDispatch' only", screenSrc.includes("action: 'set-schedule'") && screenSrc.includes("op: 'sessionDispatch'") && !/op: 'saturn/.test(screenSrc))
}

// ── §5 the birth composer (the form over the seven facts) ───────────────────
t.section('§5 — THE FORM (seven facts · the verdict verbatim · honest preview)')
{
  const { FIXED_NOW, FIXTURE_FORM, READY_PREFLIGHT, EXPIRED_PREFLIGHT, composeSaturnForm } = await import('./saturn-screen-stills.js')
  const {
    freshSaturnForm,
    saturnContractWords,
    saturnFormDetailLines,
    saturnFormEntries,
    saturnFormLegendOf,
    saturnVerdictSentence,
    SATURN_FORM_ROWS,
  } = await import('../../src/components/BootSaturnScreen.js')
  const { compileWhenSpelling } = await import('../../src/services/saturn/whenSpelling.js')
  const { noCredentialRefusal } = await import('../../src/daemon/saturnAccount.js')

  // The fresh form's defaults: the face's own ground and model, headless
  // (the unattended arm), nothing pre-answered, born-waiting.
  const fresh = freshSaturnForm({ modelKey: 'claude-opus-5', workspaceDir: '/w' })
  t.check('§5 fresh defaults: headless · unset contract · born-waiting · no preset', fresh.presence === 'headless' && fresh.contract.kind === 'unset' && fresh.opening === null && fresh.kitPreset === null && fresh.when === '')

  // Every operator fact is a form row — the seven + workspace/title/note.
  t.check('§5 the row set covers the banked facts', JSON.stringify(SATURN_FORM_ROWS) === JSON.stringify(['when', 'model', 'workspace', 'presence', 'kit', 'opening', 'contract', 'title', 'note']))

  // Entry polarity: the REQUIRED empty when stands out; a set when reads quiet.
  const freshEntries = saturnFormEntries(fresh)
  const filledEntries = saturnFormEntries(FIXTURE_FORM)
  t.check('§5 an empty when stands out and teaches', freshEntries[0]!.valueIsDefault === false && freshEntries[0]!.valueLabel.includes('say when'))
  t.check('§5 a set when reads quiet with the phrase verbatim', filledEntries[0]!.valueIsDefault === true && filledEntries[0]!.valueLabel === 'in 2h')
  t.check('§5 presence speaks both arms in words', saturnFormEntries({ ...fresh, presence: 'headless' })[3]!.valueLabel === 'headless — unattended' && saturnFormEntries({ ...fresh, presence: 'screen-present' })[3]!.valueLabel === 'screen-present — Mercury open')
  t.check('§5 the contract words carry all three states', saturnContractWords({ kind: 'unset' }) === 'not pre-answered' && saturnContractWords({ kind: 'none' }) === 'no-contract (pre-answered)' && saturnContractWords({ kind: 'text', text: 'be careful' }).includes('be careful'))
  t.check('§5 an unset opening reads born-waiting', saturnFormEntries(fresh)[5]!.valueLabel === 'born-waiting')

  // THE VERDICT's sentences — the one function's states verbatim; expired/
  // signed-out carry the held-birth honesty line (the banked sentence).
  t.check('§5 ready is plain', saturnVerdictSentence({ state: 'ready' }) === 'preflight: ready')
  t.check('§5 expiring names the expiry and the warn', saturnVerdictSentence({ state: 'expiring', expiresAt: FIXED_NOW, beforeFire: true }).includes('warned at schedule time') && saturnVerdictSentence({ state: 'expiring', expiresAt: FIXED_NOW, beforeFire: true }).includes('lands before this fire'))
  t.check("§5 expired carries the held-birth honesty line", saturnVerdictSentence({ state: 'expired' }).includes("re-login now (/logins) or it's born held"))
  t.check("§5 signed-out names the door and the hold", saturnVerdictSentence({ state: 'signed-out' }).includes('/logins') && saturnVerdictSentence({ state: 'signed-out' }).includes("born held"))
  t.check('§5 rate-limited names the window', saturnVerdictSentence({ state: 'rate-limited' }).includes('until the window ends'))

  // The preview: compiled words, the compiler's error verbatim, the L26
  // derivation refusal, the presence contracts, the banked footer.
  const compiled = compileWhenSpelling('in 2h', FIXED_NOW)
  const ready = saturnFormDetailLines(FIXTURE_FORM, compiled, READY_PREFLIGHT, FIXED_NOW).join(' ')
  t.check('§5 the preview says when it fires with the phrase verbatim', ready.includes('fires in 2h (in 2h)'))
  t.check('§5 the preview names the account and the ready verdict', ready.includes('account: anthropic/oauth') && ready.includes('preflight: ready'))
  t.check('§5 the preview speaks the headless contract', ready.includes('receipts and the transcript are the record'))
  t.check('§5 born-working paints when the opening is set', ready.includes('born-working: the opening mission is its first turn'))
  t.check('§5 the banked landing sentence closes the preview', ready.includes('receipted "born by schedule"'))
  const badWhen = saturnFormDetailLines({ ...FIXTURE_FORM, when: 'banana' }, compileWhenSpelling('banana', FIXED_NOW), READY_PREFLIGHT, FIXED_NOW).join(' ')
  t.check("§5 a refused when shows the compiler's own words", badWhen.includes('not a schedule spelling'))
  const refused = saturnFormDetailLines(FIXTURE_FORM, compiled, { derivation: { ok: false, reason: noCredentialRefusal('openai') }, verdict: null }, FIXED_NOW).join(' ')
  t.check('§5 a credential-less family speaks the L26 two-door sentence verbatim', refused.includes('/logins connects an account') && refused.includes('/router key openai'))
  const expired = saturnFormDetailLines(FIXTURE_FORM, compiled, EXPIRED_PREFLIGHT, FIXED_NOW).join(' ')
  t.check('§5 the expired preview carries the honesty line whole', expired.includes("re-login now (/logins) or it's born held"))
  const present = saturnFormDetailLines({ ...FIXTURE_FORM, presence: 'screen-present', opening: null }, compiled, READY_PREFLIGHT, FIXED_NOW).join(' ')
  t.check('§5 screen-present + born-waiting speak their contracts', present.includes('fires only while Mercury is open') && present.includes('born-waiting: it appears and waits'))

  // OS-2 (operator-ordered): the workspace row PICKS a known
  // project — the rows are THE ONE PROJECT SOURCE's dirs plus the custom
  // road (the old free-text prompt), and the engine fact stays workspaceDir.
  {
    const { saturnWorkspacePickOptions, SATURN_WORKSPACE_CUSTOM_ROW } = await import('../../src/components/BootSaturnScreen.js')
    const opts = saturnWorkspacePickOptions(['/repo/a', '/repo/b', '/repo/a'])
    t.check('§5 OS-2 the workspace picker dedupes the project dirs, order kept', JSON.stringify(opts.slice(0, 2)) === JSON.stringify(['/repo/a', '/repo/b']))
    t.check('§5 OS-2 the custom-path road is always the last row', opts[opts.length - 1] === SATURN_WORKSPACE_CUSTOM_ROW)
    t.check('§5 OS-2 no projects still leaves the custom road', JSON.stringify(saturnWorkspacePickOptions([])) === JSON.stringify([SATURN_WORKSPACE_CUSTOM_ROW]))
    const screenSrc2 = readFileSync(join(process.cwd(), 'src/components/BootSaturnScreen.tsx'), 'utf8')
    t.check('§5 OS-2 the workspace arm opens the PICK (the prompt is the custom road behind it)', screenSrc2.includes("setFormPick({ field: 'workspace', options: saturnWorkspacePickOptions((projectsOf ?? liveProjectDirs)()) })"))
    t.check('§5 OS-2 the live rows read THE ONE PROJECT SOURCE (workedInProjects — never a second enumeration)', screenSrc2.includes('workedInProjects().map(p => p.dir)'))
    t.check("§5 OS-2 the custom row routes to the old free-text prompt", screenSrc2.includes("r === SATURN_WORKSPACE_CUSTOM_ROW") && screenSrc2.includes("setFormPrompt({ field: 'workspace', draft: form?.workspaceDir ?? '' })"))
  }

  // OS-3 (operator-ordered): the opening mission's quick rows
  // — audit · review land their canned SELF-CONTAINED missions whole,
  // custom… is the old free-text road, none = born-waiting (the default).
  {
    const os3 = await import('../../src/components/BootSaturnScreen.js')
    const {
      saturnOpeningPickOptions,
      saturnOpeningFromPick,
      saturnOpeningRowIsCurrent,
      SATURN_OPENING_NONE_ROW,
      SATURN_OPENING_AUDIT_ROW,
      SATURN_OPENING_REVIEW_ROW,
      SATURN_OPENING_CUSTOM_ROW,
      SATURN_AUDIT_MISSION,
      SATURN_REVIEW_MISSION,
    } = os3
    t.check('§5 OS-3 the pick offers exactly none · audit · review · custom', JSON.stringify(saturnOpeningPickOptions()) === JSON.stringify([SATURN_OPENING_NONE_ROW, SATURN_OPENING_AUDIT_ROW, SATURN_OPENING_REVIEW_ROW, SATURN_OPENING_CUSTOM_ROW]))
    t.check('§5 OS-3 audit/review land their canned missions whole; none is born-waiting; custom is the road', saturnOpeningFromPick(SATURN_OPENING_AUDIT_ROW) === SATURN_AUDIT_MISSION && saturnOpeningFromPick(SATURN_OPENING_REVIEW_ROW) === SATURN_REVIEW_MISSION && saturnOpeningFromPick(SATURN_OPENING_NONE_ROW) === null && saturnOpeningFromPick(SATURN_OPENING_CUSTOM_ROW) === 'custom')
    t.check('§5 OS-3 the canned missions are honest prose under the prompt cap (self-contained: task + reporting channel)', SATURN_AUDIT_MISSION.length > 40 && SATURN_AUDIT_MISSION.length <= 20_000 && SATURN_AUDIT_MISSION.includes('transcript') && SATURN_REVIEW_MISSION.length > 40 && SATURN_REVIEW_MISSION.includes('transcript'))
    t.check("§5 OS-3 the 'current' marker follows the form's own state", saturnOpeningRowIsCurrent(SATURN_OPENING_NONE_ROW, null) && saturnOpeningRowIsCurrent(SATURN_OPENING_AUDIT_ROW, SATURN_AUDIT_MISSION) && saturnOpeningRowIsCurrent(SATURN_OPENING_CUSTOM_ROW, 'my own mission') && !saturnOpeningRowIsCurrent(SATURN_OPENING_CUSTOM_ROW, SATURN_AUDIT_MISSION))
    const screenSrc3 = readFileSync(join(process.cwd(), 'src/components/BootSaturnScreen.tsx'), 'utf8')
    t.check('§5 OS-3 the opening arm opens the PICK; custom routes to the old prompt', screenSrc3.includes("setFormPick({ field: 'opening', options: saturnOpeningPickOptions() })") && screenSrc3.includes("setFormPrompt({ field: 'opening', draft: form?.opening ?? '' })"))
    // The compiled missions survive the wire validator (the prompt-cap class).
    const validated = validateSaturnSubmission({ when: { kind: 'at', atMs: Date.now() + 3_600_000 }, action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', presence: 'headless', opening: SATURN_AUDIT_MISSION } } })
    t.check('§5 OS-3 a canned mission survives the wire validator whole', validated.ok)
  }

  // Legends per layer — only the moves that exist.
  t.check('§5 the form legends (the submit verb lives beside its writer)', saturnFormLegendOf({ prompt: false, pick: false }) === '↑↓ move · ↵ edit · ⌫ clear · s schedule it · esc back' && saturnFormLegendOf({ prompt: true, pick: false }) === 'type · ↵ set · esc cancel' && saturnFormLegendOf({ prompt: false, pick: true }) === '↑↓ move · ↵ pick · esc back')
  // The board legend teaches the door.
  const { saturnLegendOf } = await import('../../src/components/BootSaturnScreen.js')
  t.check("§5 the board legend teaches 'a schedule birth…'", saturnLegendOf({ busy: false }).includes('a schedule birth…'))

  // The composed form frame carries the facts, the preview and the legend.
  const frame = composeSaturnForm(120, 40).join('\n')
  t.check('§5 the form frame paints the groups and rows', frame.includes('the birth') && frame.includes('born wearing') && frame.includes('Opening mission'))
  t.check('§5 the form frame paints the preview panel', frame.includes('schedule a birth') && frame.includes('preflight: ready'))
}

// ── §6 the box tier's operator writers (the file is the door) ───────────────
t.section('§6 — THE BOX WRITERS (stamps daemon-shaped · both presences · caps)')
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const DIR = mkdtempSync(join(tmpdir(), 'saturn-screen-box-'))
  const { addBoxSchedule, removeBoxSchedule, setBoxSchedulePaused, readBoxSchedules, boxScheduleProblem } = await import(
    '../../src/daemon/saturnBoxSchedules.js'
  )
  const account = { family: 'anthropic', source: 'oauth' as const, identity: 'op@example.com' }
  const deps = {
    deriveAccount: () => ({ ok: true as const, account }),
    preflight: () => ({ state: 'ready' as const }),
  }
  const birth = (presence: 'headless' | 'screen-present') => ({
    when: { kind: 'at', atMs: Date.now() + 3_600_000, spelling: 'in 1h' },
    action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'claude-opus-5', presence } },
    note: 'from the form',
  })

  // The add stamps daemon-shaped rows the loud-skip read keeps.
  const added = addBoxSchedule(birth('headless'), 'operator:saturn-screen', deps, DIR)
  t.check('§6 a headless add lands with the daemon-shaped stamps', added.ok)
  const stored = readBoxSchedules(DIR).schedules[0]
  t.check('§6 the stored row carries id/account/createdBy/preflight/note', stored !== undefined && /^[0-9a-f]{8}$/.test(stored.id) && stored.account.family === 'anthropic' && stored.createdBy === 'operator:saturn-screen' && stored.preflightAtWrite?.state === 'ready' && stored.note === 'from the form' && stored.when.spelling === 'in 1h')
  t.check('§6 the built row satisfies the read validator (never a plant the read would drop)', stored !== undefined && boxScheduleProblem(stored) === null)

  // BOTH presence arms are lawful at the box now (the ruled widening).
  const present = addBoxSchedule(birth('screen-present'), 'operator:saturn-screen', deps, DIR)
  t.check('§6 a screen-present add is lawful (the widening under the banked sentence)', present.ok && readBoxSchedules(DIR).schedules.length === 2)

  // Refusals: fire kind · derivation failure (typed, no write).
  const fire = addBoxSchedule({ when: { kind: 'at', atMs: Date.now() + 1000 }, action: { kind: 'fire', prompt: 'x' } }, 'operator:test', deps, DIR)
  t.check("§6 a fire submission refuses — the box takes births only", !fire.ok && fire.reason.includes("'birth'"))
  const refusedDeps = { deriveAccount: () => ({ ok: false as const, reason: 'no-credential:openai — /logins connects an account, or /router key openai connects an API key' }) }
  const before = readBoxSchedules(DIR).schedules.length
  const noCred = addBoxSchedule(birth('headless'), 'operator:test', refusedDeps, DIR)
  t.check('§6 a failed derivation refuses typed and writes nothing', !noCred.ok && noCred.reason.includes('no-credential') && readBoxSchedules(DIR).schedules.length === before)

  // Pause/resume + remove (holds leave with their schedule).
  const id = stored!.id
  t.check('§6 pause applies then noops', setBoxSchedulePaused(id, true, DIR) === 'applied' && setBoxSchedulePaused(id, true, DIR) === 'noop' && readBoxSchedules(DIR).schedules.find(s => s.id === id)?.paused === true)
  t.check('§6 resume clears the pause', setBoxSchedulePaused(id, false, DIR) === 'applied' && readBoxSchedules(DIR).schedules.find(s => s.id === id)?.paused === undefined)
  t.check('§6 remove drops the row; a second remove answers missing', removeBoxSchedule(id, DIR) === 'removed' && removeBoxSchedule(id, DIR) === 'missing')

  // The cap refuses the 51st.
  for (let i = readBoxSchedules(DIR).schedules.length; i < 50; i++) {
    const r = addBoxSchedule(birth('headless'), 'operator:test', deps, DIR)
    if (!r.ok) t.check(`§6 cap fill failed early at ${i}`, false, r.reason)
  }
  const overCap = addBoxSchedule(birth('headless'), 'operator:test', deps, DIR)
  t.check('§6 the 51st schedule refuses at the cap', !overCap.ok && overCap.reason.includes('50'))
}

// ── §7 the boot-menu row + the deep-link road (both hosts, one owner) ──────
t.section('§7 — THE ROW AND THE DOOR (after Doctor · the fit fact · the face-door grammar)')
{
  const { assembleCardRows } = await import('../../assets/splash/splash-core.mjs')
  type Row = { key: string; icon: string; label: string; ctx: string }
  const FACTS = {
    cwdBase: 'proj',
    continueTarget: null,
    menuAvailable: true,
    concourse: { ctx: 'the live board' },
    projects: [],
  }
  const rows = assembleCardRows(FACTS) as Row[]
  const keys = rows.map(r => r.key)

  t.check('§7 the saturn row sits directly after Doctor (the control-plane glance pair)', keys.indexOf('saturn') === keys.indexOf('doctor') + 1)
  const sat = rows.find(r => r.key === 'saturn')
  t.check("§7 the row's bytes: ◷ · 'Saturn Scheduler' · the standing ctx", sat?.icon === '◷' && sat?.label === 'Saturn Scheduler' && sat?.ctx === 'sessions born on the clock', JSON.stringify(sat))
  t.check('§7 the row rides the SAME fit law as the menu/kit doors (no menu floor ⇒ no scheduler)', !(assembleCardRows({ ...FACTS, menuAvailable: false }) as Row[]).some(r => r.key === 'saturn'))
  t.check('§7 the ctx is the HOST-TRUTH channel (the wake-glance words when passed)', (assembleCardRows({ ...FACTS, saturnCtx: '3 schedules · next in 2h' }) as Row[]).find(r => r.key === 'saturn')?.ctx === '3 schedules · next in 2h')
  t.check('§7 a --chat world carries the same row (no world check)', (assembleCardRows({ ...FACTS, concourse: null }) as Row[]).some(r => r.key === 'saturn'))
  // Re-pinned: the Resume row became the merged
  // 'Sessions · Projects' door — the LAST slot's stability law stands.
  t.check('§7 the merged door stays LAST (proof-leg stability)', keys[keys.length - 1] === 'sessions')

  // ONE owner: the row is composed in the core alone; both hosts activate it.
  const coreSrc = readFileSync(join(process.cwd(), 'assets/splash/splash-core.mjs'), 'utf8')
  const faceSrc = readFileSync(join(process.cwd(), 'src/components/BootSplashScreen.tsx'), 'utf8')
  const driverSrc = readFileSync(join(process.cwd(), 'assets/splash/mercury-splash.mjs'), 'utf8')
  t.check('§7 one row owner (no second saturn row on either host)', (coreSrc.match(/key: 'saturn'/g) ?? []).length === 1 && !faceSrc.includes("key: 'saturn'") && !driverSrc.includes("key: 'saturn'"), 'owner census')
  t.check("§7 the runtime face activates the row (runRow case 'saturn' opens the layer)", faceSrc.includes("case 'saturn':") && faceSrc.includes('setSaturnOpen(true)'))
  t.check("§7 the launcher activates the row with the `saturn` receipt action", driverSrc.includes("else if (r2.key === 'saturn') writeSplashAction('saturn')"))
  t.check('§7 the face mounts the layer with the persistent-scene contract', faceSrc.includes('<BootSaturnScreen') && faceSrc.includes('onClose={() => setSaturnOpen(false)}'))
  t.check('§7 the face consumes the saturn face-door at mount (the one-shot grammar)', faceSrc.includes("useState(faceDoor === 'saturn')"))

  // The deep-link road: decideSplashReceipt arms the saturn face door once,
  // with nothing to chdir/splice and no boot-surface intent.
  const { decideSplashReceipt, consumeFaceDoorDeepLink, consumeBootSurfaceIntent } = await import('../../src/substrate/splashHandover.js')
  const NOW = 1_700_000_000_000
  const receipt = JSON.stringify({ version: 1, ts: NOW, action: 'saturn' })
  const decided = decideSplashReceipt(receipt, NOW, () => true)
  t.check('§7 saturn ⇒ applied, nothing to chdir or splice', decided.reason === 'applied' && decided.apply === null)
  t.check('§7 saturn arms the face door once and NO boot-surface intent', consumeBootSurfaceIntent() === null && consumeFaceDoorDeepLink() === 'saturn' && consumeFaceDoorDeepLink() === null)
}

// ── §8 the concourse surfacing (the banked "next fire" row fact) ────────────
t.section('§8 — THE CONCOURSE ROW FACT (smallest honest read from the projection)')
{
  const { saturnSoonestFireMs } = await import('../../src/daemon/saturn.js')
  const NOW = Date.parse('2026-08-29T12:00:00Z')
  const sched = (id: string, atMs: number, paused?: true): Record<string, unknown> => ({
    schema: 1,
    id,
    when: { kind: 'at', atMs },
    action: { kind: 'fire', prompt: 'x' },
    account: { family: 'anthropic', source: 'oauth' },
    modelKey: 'm',
    createdAt: NOW - 1000,
    createdBy: 'operator:test',
    ...(paused === true ? { paused: true } : {}),
  })
  t.check('§8 the soonest standing fire wins', saturnSoonestFireMs({ schedules: [sched('aaaa0001', NOW + 7200_000), sched('bbbb0002', NOW + 3600_000)] as never }, NOW) === NOW + 3600_000)
  t.check('§8 a paused row never counts', saturnSoonestFireMs({ schedules: [sched('aaaa0001', NOW + 3600_000, true)] as never }, NOW) === null)
  t.check('§8 no schedules ⇒ null (absent ≠ empty holds)', saturnSoonestFireMs({}, NOW) === null && saturnSoonestFireMs({ schedules: [] as never }, NOW) === null)
  t.check('§8 a spent one-shot answers null', saturnSoonestFireMs({ schedules: [sched('aaaa0001', NOW - 60_000)] as never }, NOW) === null)

  // The wiring needles: the contract's field, the composer's read, the
  // cell's paint — one fact, one reader, one paint home.
  const contracts = readFileSync(join(process.cwd(), 'src/components/concourse/contracts.ts'), 'utf8')
  t.check('§8 the contract carries scheduleNextFireMs under the SATURN docblock', contracts.includes('scheduleNextFireMs?: number') && contracts.includes('saturnSoonestFireMs'))
  const composer = readFileSync(join(process.cwd(), 'src/services/concourse/concourseSnapshot.ts'), 'utf8')
  t.check('§8 the snapshot composer reads THROUGH the projection helper', composer.includes('saturnSoonestFireMs(rec, nowMs)') && composer.includes('scheduleNextFireMs: next'))
  const cell = readFileSync(join(process.cwd(), 'src/components/concourse/LiveNowCell.tsx'), 'utf8')
  t.check("§8 the NOW cell paints the tag in the workflows tag's grammar", cell.includes('next fire {fireDeltaWords(row.scheduleNextFireMs') && cell.includes("row.scheduleNextFireMs !== undefined"))
}

// ── §9 the reactivation preflight-warn row (fork ii's paint) ────────────────
t.section('§9 — THE REACTIVATION WARN (retained schedules say when they would hold)')
{
  const src = readFileSync(join(process.cwd(), 'src/services/switchboard/hopIntoSession.ts'), 'utf8')
  t.check('§9 the warn rides the one resume door beside the recap (both courtesy roads)', src.includes('void paintResumeRecap(sessionId)') && src.includes('void paintReactivationScheduleWarn(sessionId)'))
  const fn = src.slice(src.indexOf('async function paintReactivationScheduleWarn'), src.indexOf('async function paintResumeRecap'))
  t.check('§9 the warn speaks THE ONE VERDICT over live facts (never a re-derived judgment)', fn.includes('scheduleAccountVerdict({') && fn.includes('readLiveAccountFacts(s.account)') && !fn.includes('isAnthropicOAuthSignInExpired'))
  t.check('§9 paused rows never warn; a ready world paints nothing', fn.includes("if (s.paused === true) continue") && fn.includes('if (worst === null) return'))
  t.check('§9 the row is display-only, warning-leveled, fail-soft', fn.includes('addDisplayRow') && fn.includes("'warning'") && fn.includes('never blocks the hop'))
  t.check('§9 every non-ready state has its typed sentence (the /logins doors named; the keyless arm its own server road)', fn.includes('signed out — /logins connects an account') && fn.includes('sign-in expired — re-login now (/logins)') && fn.includes('rate-limited — due fires hold') && fn.includes("known expiry lands before the next fire") && fn.includes('no local server answering'))
  // RE-PINNED: the account-less arm's 'unreachable'
  // joined the verdict union — its severity is signed-out's twin (the thing
  // the fire needs is gone), so the walk carries both at rank 4.
  t.check('§9 the severity walk is the verdict order', fn.includes("{ 'signed-out': 4, unreachable: 4, expired: 3, 'rate-limited': 2, expiring: 1, ready: 0 }"))
}

// ── §10 route silence + the never-stranded esc chain ────────────────────────
t.section('§10 — ROUTE SILENCE around the real layer (no transition, no settle) + esc topology')
{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootSaturnScreen } = await import('../../src/components/BootSaturnScreen.js')
  const { FIXED_NOW, FIXTURE_FACTS, fixtureReceiptsOf } = await import('./saturn-screen-stills.js')
  const routeStore = await import('../../src/context/surfaceRoute.js')
  routeStore._resetSurfaceRouteForTesting()
  const unregister = routeStore.registerRouteSurface('boot-settings', { render: () => null })
  routeStore.initializeSurfaceRoute({ kind: 'boot-settings' })
  const gen0 = routeStore.surfaceGeneration()
  const stops0 = routeStore.presentStripStops().join('·')
  await renderToString(
    React.createElement(BootSaturnScreen, {
      facts: FIXTURE_FACTS,
      nowMs: FIXED_NOW,
      receiptsOf: fixtureReceiptsOf,
      fullScene: { columns: 100, rows: 30 },
    } as never),
    100,
  )
  t.check('§10 the route never left boot-settings across the layer mount', routeStore.currentSurfaceRoute().kind === 'boot-settings')
  t.check('§10 NO transition committed (the generation stands at the seed)', routeStore.surfaceGeneration() === gen0, `${gen0} → ${routeStore.surfaceGeneration()}`)
  t.check('§10 the last transition is still the INIT seed (no PUSH, no settle)', routeStore.lastSurfaceTransition().verb === 'INIT' && routeStore.lastSurfaceTransition().to === 'boot-settings')
  t.check('§10 the strip’s stops are unmoved while the layer exists', routeStore.presentStripStops().join('·') === stops0, stops0)
  unregister()
  routeStore._resetSurfaceRouteForTesting()

  // THE ESC CHAIN, never stranded (one layer at a time, structurally): the
  // prompt closes to the form; the picker closes to the form; the form
  // closes to the board; the board closes through onClose — and each layer
  // parks the lists beneath it while open.
  const screenSrc = readFileSync(join(process.cwd(), 'src/components/BootSaturnScreen.tsx'), 'utf8')
  t.check('§10 the prompt owns input while open and esc closes IT (not the screen)', screenSrc.includes('{ isActive: formPrompt !== null }') && screenSrc.includes('setFormPrompt(null)'))
  t.check('§10 the picker closes to the form', screenSrc.includes("active: formPick !== null") && screenSrc.includes('onClose: () => setFormPick(null)'))
  t.check('§10 the form closes to the board (and clears its note)', screenSrc.includes('active: form !== null && formPrompt === null && formPick === null') && screenSrc.includes('setForm(null)'))
  t.check('§10 the board closes through the mount contract alone', screenSrc.includes('active: form === null') && screenSrc.includes('onClose: () => onClose?.()'))
  // The face parks its lists while the saturn layer owns the screen (the
  // face-doors parked-lists law, extended at S5).
  // Re-pinned: the sign-in layer joined the
  // gate. Re-pinned AGAIN: the projects VIEW retired with
  // the merge — ONE face list remains and saturn still parks it.
  const faceSrc = readFileSync(join(process.cwd(), 'src/components/BootSplashScreen.tsx'), 'utf8')
  // Needle re-pinned: the agents layer joined the face's
  // gate between saturn and logins — the parking law itself is unchanged.
  t.check('§10 the face list parks behind the saturn layer', faceSrc.includes('!saturnOpen && !agentsOpen && !loginsOpen,'))
}

t.finish('prove-saturn-screen')
