#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-face-doors.ts — the boot face's OWN Health + Resume
//  entrances (the operator's ruling: the
//  face's rows open face-native sub-views inside the Boot face's containers
//  and style — never a REPL round-trip, never a settleAbsentChat rubber-band).
//
//    §1 THE VOCABULARY — every status is a WORD on the row (glyph + word,
//       the meta's own); a status that asserts something wrong stands out,
//       one that does not reads like a default; legends name only the moves
//       that exist (f exactly on a fixable row); the status line's three
//       states; wrapPlain keeps whole words inside the width.
//    §2 THE TRAIL — the selected check's full evidence trail: evidence
//       always, detail/fix/link exactly when present, the remedy hint
//       exactly when fixable; the ↵ layer's rows are all inert.
//    §3 THE FIX CARD — consent names the remedy class and plan; the
//       DESTRUCTIVE warning appears for destructive remedies alone; the
//       outcome card tells the apply/verify truths in the panel's words.
//    §4 GENERIC SECTIONS — the screen renders whatever sections the
//       certificate carries (a sibling lane's Unity/Blender doctor rows
//       appear with no edit here); POISON: a hardcoded section roster in
//       the screen source.
//    §5 THE COMPOSER — the health frames ride composeBootMenu's own tiers:
//       the 64×12 floor warns and keeps operating (WARN-NEVER-WALL), the
//       wide tier fits 120×40; the additive amber/crimson summary tones
//       paint their own registers and change no absent-tone bytes.
//    §6 THE STILLS — the frames byte-match the written fixtures
//       (scripts/ui/face-door-stills.ts --write regenerates).
//    §7 THE REAL MOUNT — BootHealthScreen under staticRender with an
//       injected certificate renders the verdict, the sections, the check
//       rows and the legend; the module never imports the surface-route
//       bridge (no enterRootRepl/settleAbsentChat/armRootCommand — the
//       route cannot move because this screen exists).
//  cpu-pure: composes through the shared core + one off-screen Ink string
//  render; never a PTY, a daemon, a boot, or a live probe run.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'
import {
  healthDetailLines,
  healthEntryOf,
  healthFixCardLines,
  healthLegendOf,
  healthStatusLine,
  healthTrailEntries,
  healthVerdictLine,
  wrapPlain,
} from '../../src/components/BootHealthScreen.js'
import { HEALTH_STATUS_META, type HealthCheck, type HealthStatus } from '../../src/utils/healthReport.js'
import {
  resumeCrewEntryOf,
  resumeDetailLines,
  resumeElsewhereEntry,
  resumeEmptyDetailLines,
  resumeEntryOf,
  resumeLegendOf,
  resumeStatusLine,
  resumeSummaryRows,
} from '../../src/components/BootResumeScreen.js'
import { FIXED_CERT, RESUME_FIXTURE_LOGS, STILLS, composeHealth, composeResume, readStill, renderStill, resumeModelOf } from './face-door-stills.ts'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const screenSrc = read('src/components/BootHealthScreen.tsx')

const CHECK = (over: Partial<HealthCheck>): HealthCheck => ({
  id: 'x',
  label: 'X check',
  status: 'ok',
  evidence: 'the evidence line',
  ...over,
})

t.section('§1 — THE VOCABULARY (words on rows, honest legends, the status line)')
{
  const STATUSES: HealthStatus[] = ['ok', 'warn', 'fail', 'stale', 'unknown', 'off', 'info']
  for (const status of STATUSES) {
    const entry = healthEntryOf(CHECK({ status }), 'RUNTIME')
    t.check(`'${status}' rides the row as its glyph + word`, entry.valueLabel === `${HEALTH_STATUS_META[status].glyph} ${status}`, entry.valueLabel)
  }
  const loud = STATUSES.filter(s => !healthEntryOf(CHECK({ status: s }), 'S').valueIsDefault)
  t.check('exactly the wrong-asserting statuses stand out (fail · warn · stale · unknown)', JSON.stringify(loud.sort()) === JSON.stringify(['fail', 'stale', 'unknown', 'warn']), loud.join(','))
  const entry = healthEntryOf(CHECK({ status: 'warn', evidence: 'the one-line evidence' }), 'PROVIDERS')
  t.check('the classic tier reads the evidence as the summary line; the section title is the group verbatim', entry.summary === 'the one-line evidence' && entry.groupTitle === 'PROVIDERS' && entry.group === 'PROVIDERS')

  t.check('the base legend names ↵ evidence · d deep · r re-run · esc back and NO fix key on an unfixable row', healthLegendOf({ fixable: false, trailOpen: false, fixPhase: null }) === '↑↓ move · ↵ evidence · d deep · r re-run · esc back')
  t.check('the fix key appears exactly on a fixable row', healthLegendOf({ fixable: true, trailOpen: false, fixPhase: null }).includes(' · f fix · '))
  t.check('the trail legend is the way back alone', healthLegendOf({ fixable: true, trailOpen: true, fixPhase: null }) === '↑↓ move · ↵ back · esc back')
  t.check('the consent legend is apply/cancel; running says read-only; done says dismiss', healthLegendOf({ fixable: true, trailOpen: false, fixPhase: 'confirm' }) === '↵ apply · esc cancel' && healthLegendOf({ fixable: true, trailOpen: false, fixPhase: 'running' }).includes('read-only') && healthLegendOf({ fixable: true, trailOpen: false, fixPhase: 'done' }).includes('dismiss'))

  t.check('the running status line carries depth + progress + the current label', healthStatusLine({ kind: 'running', depth: 'deep', done: 3, total: 40, current: 'Daemon reachability' }) === 'examining the harness (deep) · 3/40 · Daemon reachability')
  t.check('the zero-total running line stays honest (no 0/0)', healthStatusLine({ kind: 'running', depth: 'fast', done: 0, total: 0, current: '' }) === 'examining the harness (fast)…')
  t.check('the settled line: verdict · checks · issued · duration · read-only', healthStatusLine({ kind: 'settled', verdict: 'caution', checks: 7, issuedAgo: '2m ago', durationMs: 830 }) === 'verdict caution · 7 checks · issued 2m ago · 830ms · read-only')
  t.check('the failed line names the way back (r re-runs)', healthStatusLine({ kind: 'failed' }).includes('r re-runs'))
  t.check('the verdict sentences are the certificate\'s own three', healthVerdictLine('certified').includes('safe to trust') && healthVerdictLine('caution').includes('trust with care') && healthVerdictLine('fault').includes('do not trust'))

  const wrapped = wrapPlain('one two three four five six seven', 10)
  t.check('wrapPlain keeps whole words inside the width', wrapped.every(l => l.length <= 10) && wrapped.join(' ') === 'one two three four five six seven', JSON.stringify(wrapped))
  t.check('wrapPlain of the empty string is one empty line (the composer never sees a zero-row body)', JSON.stringify(wrapPlain('', 10)) === JSON.stringify(['']))
}

t.section('§2 — THE TRAIL (evidence always; detail/fix/link when present; inert layer)')
{
  const bare = healthDetailLines(CHECK({ status: 'ok' }))
  t.check('a bare check trails status word + evidence and nothing else', bare[0] === '✓ ok' && bare.includes('evidence:') && bare.join('\n').includes('the evidence line') && !bare.join('\n').includes('related surface') && !bare.some(l => l.startsWith('→')))
  const full = healthDetailLines(
    CHECK({ status: 'warn', detail: 'the longer detail body', fix: 'do the thing', link: '/logins', remedy: { class: 'safe', plan: 'p' } }),
  )
  const joined = full.join('\n')
  t.check('a full check trails detail, the → fix, the linked surface and the f hint', joined.includes('the longer detail body') && joined.includes('→ do the thing') && joined.includes('related surface: /logins') && joined.includes('f — apply the safe remedy'))
  const unfixable = healthDetailLines(CHECK({ status: 'ok', remedy: { class: 'safe', plan: 'p' } }))
  t.check('an ok row with a remedy offers NO f hint (isFixable is the one gate)', !unfixable.join('\n').includes('f — apply'))
  const trail = healthTrailEntries(CHECK({ status: 'warn', detail: 'd', fix: 'f' }))
  t.check('the ↵ layer mirrors the trail as inert rows under the check\'s own title', trail.length === healthDetailLines(CHECK({ status: 'warn', detail: 'd', fix: 'f' })).length && trail.every(e => e.inert === true) && trail.every(e => e.groupTitle === 'X check'))
}

t.section('§3 — THE FIX CARD (consent · running · outcome; destructive warns)')
{
  const safeCheck = CHECK({ status: 'warn', remedy: { class: 'safe', plan: 'rewrite the file' } })
  const destructiveCheck = CHECK({ status: 'stale', remedy: { class: 'destructive', plan: 'drop the snapshot' } })
  const safe = healthFixCardLines({ phase: 'confirm', check: safeCheck }).join('\n')
  const destructive = healthFixCardLines({ phase: 'confirm', check: destructiveCheck }).join('\n')
  t.check('consent names the class and the plan and ends on ↵ apply · esc cancel', safe.startsWith('fix · safe remedy') && safe.includes('rewrite the file') && safe.includes('↵ apply · esc cancel'))
  t.check('the DESTRUCTIVE warning appears for the destructive class alone', destructive.includes('DESTRUCTIVE') && !safe.includes('DESTRUCTIVE'))
  t.check('running says applying…', healthFixCardLines({ phase: 'running', check: safeCheck }).join('\n').includes('applying…'))
  const done = healthFixCardLines({
    phase: 'done',
    check: safeCheck,
    outcome: { applied: { ok: true, note: 'file rewritten' }, verified: { ok: true, note: 'clean re-probe' } },
  }).join('\n')
  t.check('the outcome tells apply + verify + the re-issue dismissal', done.includes('apply: ok — file rewritten') && done.includes('verify: ok — clean re-probe') && done.includes('re-issue the certificate'))
  const failedApply = healthFixCardLines({
    phase: 'done',
    check: safeCheck,
    outcome: { applied: { ok: false, note: 'EPERM' }, verified: null },
  }).join('\n')
  t.check('a failed apply reads FAILED with verify skipped', failedApply.includes('apply: FAILED — EPERM') && failedApply.includes('verify: skipped (apply failed)'))
}

t.section('§4 — GENERIC SECTIONS (whatever the certificate carries appears)')
{
  const foreign = {
    ...FIXED_CERT,
    sections: [
      {
        id: 'unity',
        title: 'UNITY & BLENDER',
        checks: [CHECK({ id: 'unity-bridge', label: 'Unity bridge', status: 'ok', evidence: 'a section this screen has never heard of' })],
      },
    ],
  }
  const placed = composeHealth(120, 40, { view: 'list', cert: foreign }).join('\n')
  t.check('an unseen section title renders with its rows (nothing here knows the roster)', placed.includes('UNITY & BLENDER') && placed.includes('Unity bridge'))
  // POISON — a hardcoded section roster in the screen: the screen source may
  // not name the shipped sections' ids/titles anywhere (comments included:
  // a roster in prose invites the next hand to code against it).
  const rosterTokens = ['RUNTIME', 'PROVIDERS', "'runtime'", "'providers'", 'agent-definitions', 'env-limits', 'version-locks']
  const hits = rosterTokens.filter(tok => screenSrc.includes(tok))
  t.check('POISON absent: the screen source names no section roster', hits.length === 0, hits.join(','))
}

t.section('§5 — THE COMPOSER TIERS (floor warns · wide fits · additive tones)')
{
  const floor = composeHealth(64, 12, { view: 'list' })
  t.check('the 64×12 floor frame WARNS and keeps the legend (never a wall)', floor.join('\n').includes('wants at least') && floor.join('\n').includes('esc back'), floor.join('\n').slice(0, 120))
  t.check('the floor frame fits its rows', floor.length <= 12, String(floor.length))
  const wide = composeHealth(120, 40, { view: 'list', sel: 2 })
  t.check('the wide tier composes the three panels + the certificate summary', ['CONTROL PLANE', 'SETTING DETAIL', 'CERTIFICATE', 'ENVIRONMENT'].every(p => wide.join('\n').includes(p)))
  t.check('the wide frame fits 120×40', wide.length <= 40, String(wide.length))
  const microCols = composeHealth(40, 12, { view: 'list' })
  const microRows = composeHealth(80, 8, { view: 'list' })
  t.check('below the micro thresholds the shred still names the way out', microCols.join('\n').includes('esc back') && microRows.join('\n').includes('esc back'))

  // The additive tones: amber/crimson paint their own SGR registers in the
  // colour-bound core; a toneless row keeps the mid ink; the nocolor core
  // (the stills') is byte-identical whatever the tone says.
  const colorCore = createSplashCore({ nocolor: false, truecolor: true, accent: 'crimson' })
  const menuOf = (tone?: string): string =>
    (
      colorCore.composeBootMenu(120, 40, {
        entries: [{ label: 'row', group: 'g', groupTitle: 'G', summary: 's', valueLabel: 'v', valueIsDefault: true, pinnedVal: null, detail: null }],
        selIdx: 0,
        summaryTitle: 'T',
        summaryRows: [{ key: 'K', value: 'value', ...(tone !== undefined ? { tone } : {}) }],
        environment: { model: 'm', critter: 'c', critterHue: '#B07BE0', dirBase: 'd', dirTail: '' },
        statusRight: 'status',
        legend: 'legend',
      }) as { lines: string[] }
    ).lines.join('\n')
  const [plain, amber, crimson, teal] = [menuOf(undefined), menuOf('amber'), menuOf('crimson'), menuOf('teal')]
  t.check('amber and crimson tones paint (bytes move against the toneless row) and differ from teal and each other', amber !== plain && crimson !== plain && amber !== crimson && amber !== teal && crimson !== teal)
  const nocolorCore = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const nocolorOf = (tone?: string): string =>
    (
      nocolorCore.composeBootMenu(120, 40, {
        entries: [{ label: 'row', group: 'g', groupTitle: 'G', summary: 's', valueLabel: 'v', valueIsDefault: true, pinnedVal: null, detail: null }],
        selIdx: 0,
        summaryTitle: 'T',
        summaryRows: [{ key: 'K', value: 'value', ...(tone !== undefined ? { tone } : {}) }],
        environment: { model: 'm', critter: 'c', critterHue: '#B07BE0', dirBase: 'd', dirTail: '' },
        statusRight: 'status',
        legend: 'legend',
      }) as { lines: string[] }
    ).lines.join('\n')
  t.check('the nocolor core is tone-blind (the stills cannot drift on ink)', nocolorOf(undefined) === nocolorOf('amber') && nocolorOf('amber') === nocolorOf('crimson'))
}

t.section('§6 — THE STILLS (byte-compare against the written fixtures)')
{
  for (const still of STILLS) {
    const want = readStill(still.id)
    const got = renderStill(still.compose())
    const ok = want !== null && got === want
    t.check(`still '${still.id}' byte-matches its fixture`, ok, ok ? '' : want === null ? 'fixture missing — run face-door-stills.ts --write' : 'drifted — re-write on purpose or fix the compose')
  }
}

t.section('§7 — THE REAL MOUNT (staticRender with an injected certificate)')
{
  // Env pins BEFORE the dynamic imports; a
  // scratch config home so no live estate is read; no live probes run —
  // the injected certificate is the screen's whole world.
  process.env['MERCURY_CONFIG_DIR'] ??= (await import('node:fs')).mkdtempSync(
    join((await import('node:os')).tmpdir(), 'face-doors-prove-'),
  )
  process.env['FORCE_COLOR'] = '3'
  process.env['MERCURY_CRITTER_GAZE'] = '0'
  process.env['MERCURY_LIVE_GLYPHS'] = '0'
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootHealthScreen } = await import('../../src/components/BootHealthScreen.js')
  // 120×40 — the wide tier, where the CERTIFICATE panel and the status bar
  // carry the verdict (the classic tier keeps only the list + legend).
  const frame = await renderToString(
    React.createElement(BootHealthScreen, { certificate: FIXED_CERT, fullScene: { columns: 120, rows: 40 } } as never),
    120,
  )
  t.check('the mounted screen presents the verdict word', frame.includes('caution'), frame.slice(0, 200))
  t.check('the mounted screen presents the sections and their check rows', frame.includes('RUNTIME') && frame.includes('Keybindings file') && frame.includes('Anthropic credential'))
  t.check('the mounted screen presents the status words on the rows', frame.includes('warn') && frame.includes('stale'))
  t.check('the mounted screen presents the list legend', frame.includes('d deep · r re-run · esc back'))

  // The route CANNOT move because this screen exists: the module has zero
  // surface-route imports (the C4 journey pins assert the running truth;
  // this is the structural half).
  const routeTokens = ['surfaceRoute', 'enterRootRepl', 'settleAbsentChat', 'armRootCommand', 'initialMessage']
  const routeHits = routeTokens.filter(tok => screenSrc.includes(tok))
  t.check('the screen module never touches the surface-route bridge', routeHits.length === 0, routeHits.join(','))
}

t.section('§8 — THE RESUME SKIN (one core, the face grammar; the real journey named)')
{
  const { flat, crew, elsewhereCount } = resumeModelOf('all')
  t.check('the fixture store projects through the REAL C2 pipeline (4 sessions · 1 crew)', flat.length === 4 && crew.length === 1 && elsewhereCount === 0, `${flat.length}/${crew.length}/${elsewhereCount}`)
  const entry = resumeEntryOf(flat[0]!)
  t.check('a session row groups under its PROJECT with the seen age as the value', entry.group === entry.groupTitle && entry.group.length > 0 && entry.valueLabel === flat[0]!.row.seen)
  const clearedRow = flat.find(f => f.row.cleared === true)
  t.check("the cleared session wears '· cleared' beside its age and stands out", clearedRow !== undefined && resumeEntryOf(clearedRow!).valueLabel.endsWith(' · cleared') && resumeEntryOf(clearedRow!).valueIsDefault === false)
  const crewEntry = resumeCrewEntryOf(crew[0]!)
  t.check("crew transcripts class apart under 'router crews' and stay selectable", crewEntry.groupTitle === 'router crews' && crewEntry.inert !== true && crewEntry.label.startsWith('party · dps1 — '))
  const elsewhere = resumeElsewhereEntry(3)
  t.check('the other-repos line is inert and names the a reach', elsewhere.inert === true && elsewhere.label === '+3 in other projects — a shows all history')
  t.check('the detail trail names the REAL journey (the chat stop appears; esc opens nothing)', resumeDetailLines(flat[0]!).join('\n').includes('the chat stop appears on the strip') && resumeDetailLines(flat[0]!).join('\n').includes('esc — back to the face, nothing opened'))
  t.check('a cleared row’s trail says resuming reopens it', clearedRow !== undefined && resumeDetailLines(clearedRow!).join('\n').includes('resuming reopens it'))
  t.check('the empty worlds teach n (births here) in both scopes', resumeEmptyDetailLines('all', 0).join('\n').includes('n births a fresh session here') && resumeEmptyDetailLines('project', 3).join('\n').includes('a shows'))
  t.check('the status line counts sessions · crew · scope and names ↵', resumeStatusLine({ loading: false, count: 4, crewCount: 1, scope: 'all', pendingMore: 0 }) === '4 sessions in the full history · 1 crew · ↵ opens the real chat')
  t.check('the loading and empty status lines stay honest', resumeStatusLine({ loading: true, count: 0, crewCount: 0, scope: 'all', pendingMore: 0 }) === 'reading the session store…' && resumeStatusLine({ loading: false, count: 0, crewCount: 0, scope: 'project', pendingMore: 0 }).includes('n births one'))
  t.check('the legend flips the scope key with the scope and drops moves that do not exist', resumeLegendOf('all', true).includes('a this project') && resumeLegendOf('project', true).includes('a all history') && !resumeLegendOf('all', false).includes('↵ open'))
  t.check('the summary panel says what ↵ opens (a real chat, in place)', resumeSummaryRows({ scope: 'all', count: 4, crewCount: 1, elsewhereCount: 0, pendingMore: 0 }).some(r => r.value.includes('a real chat, in place') && r.tone === 'teal'))

  const wide = composeResume(120, 40, { scope: 'all', sel: 1 }).join('\n')
  t.check('the wide frame carries the sessions panel, the projects as section titles and the crew section', ['SESSIONS', 'router crews', 'orchard-src', 'moodle'].every(s => wide.includes(s)))
  const floor = composeResume(64, 12, { scope: 'all', sel: 1 }).join('\n')
  t.check('the 64×12 floor frame WARNS and keeps the way out (never a wall)', floor.includes('wants at least') && floor.includes('esc back'))
  const project = composeResume(120, 40, { scope: 'project', sel: 0 }).join('\n')
  t.check('project scope drops the cleared chat and paints the honest elsewhere line', project.includes('+1 in other project — a shows all history') && !project.includes('· cleared'))
}

t.section('§9 — THE RESUME MOUNT (staticRender with an injected model; the lawful route door)')
{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootResumeScreen } = await import('../../src/components/BootResumeScreen.js')
  const model = { ...resumeModelOf('all'), pendingMore: 0 }
  const frame = await renderToString(
    React.createElement(BootResumeScreen, { model, fullScene: { columns: 120, rows: 40 } } as never),
    120,
  )
  t.check('the mounted screen presents the session rows and their projects', frame.includes('the tool-loop fold') && frame.includes('moodle groundwork') && frame.includes('orchard-src'))
  t.check('the mounted screen presents the crew section and the legend', frame.includes('router crews') && frame.includes('↵ open · n new session'))

  // The ROUTE LAW, structurally: the resume screen's ONE route door is the
  // plain enterRootRepl step AFTER the landing (ruling 2 — picking is a
  // real chat journey); the armed-command road appears nowhere in it, and
  // the C2 core module cannot reach the route at all.
  const resumeSrc = read('src/components/BootResumeScreen.tsx')
  const armedTokens = ['armedRootCommand', 'armRootCommand', 'initialMessage', 'settleAbsentChat']
  const armedHits = armedTokens.filter(tok => resumeSrc.includes(tok))
  t.check('the resume screen never touches the armed-command road', armedHits.length === 0, armedHits.join(','))
  t.check('the resume screen lands through the one resume door (with the boot posture) then the plain chat step', resumeSrc.includes('focusResumedSession(String(sessionId), log.fullPath, {') && resumeSrc.includes('permissionMode: permissionModeRef.current') && resumeSrc.includes('enterRootRepl()') && !resumeSrc.includes('enterRootRepl({'))
  const coreSrcModel = read('src/components/mercury-ui/screens/sessionPickerModel.ts')
  t.check('the picker core module reaches no route verb at all', !coreSrcModel.includes('surfaceRoute') && !coreSrcModel.includes('enterRootRepl'))
}

t.section('§10 — THE WIRING + THE RETIREMENT (C4: the rows open the layers; the armed road survives for Continue alone)')
{
  const face = read('src/components/BootSplashScreen.tsx')
  // The two rows open their layers IN PLACE.
  const doctorCase = face.slice(face.indexOf("case 'doctor':"), face.indexOf("case 'concourse':"))
  t.check("the Doctor row opens the face's health layer and arms NOTHING", doctorCase.includes('setHealthOpen(true)') && !doctorCase.includes('armRootCommand') && !doctorCase.includes('enterRootRepl'), doctorCase.slice(0, 120))
  // Re-pinned: the Resume row became the merged
  // 'Sessions · Projects' row (key 'sessions') — the law is unchanged:
  // the row opens the face's picker layer and arms NOTHING.
  const resumeCase = face.slice(face.indexOf("case 'sessions':"), face.indexOf('}\n    return null;'))
  t.check("the Sessions · Projects row opens the face's picker layer and arms NOTHING", resumeCase.includes('setResumeOpen(true)') && !resumeCase.includes('armRootCommand') && !resumeCase.includes('enterRootRepl'), resumeCase.slice(0, 120))
  // The layers are the settings/kit siblings: full scene + esc-home wiring
  // (the face component stays mounted, so the opening row's selection is
  // restored by construction — the layer precedent).
  t.check('the health layer mounts with the esc-home wiring', face.includes('<BootHealthScreen') && face.includes('onClose={() => setHealthOpen(false)}'))
  t.check('the resume layer mounts with the esc-home wiring', face.includes('<BootResumeScreen') && face.includes('onClose={() => setResumeOpen(false)}'))
  // AMENDED: the scheduler layer joined the
  // face's layer set — the parked-lists needle re-pins with its gate.
  // AMENDED: the sign-in layer joined the same
  // set. AMENDED AGAIN: the projects VIEW retired with the
  // merge — ONE face list remains, and every layer parks it (the law
  // unchanged).
  // Needle re-pinned: the agents layer joined the gate.
  t.check('the face list parks while a layer owns the screen', face.includes('!settingsOpen && !kitOpen && !healthOpen && !resumeOpen && !saturnOpen && !agentsOpen && !loginsOpen,'))
  // THE RETIREMENT, grep-back (C6 — final): the armed road is GONE from
  // the face and from the route owner entirely; Continue rides the one
  // resume door directly with the boot's resolved posture, its refusal
  // painting on the row.
  t.check('the armed bridge entry is GONE from the face', !face.includes('armedRootCommand'))
  t.check('the arming helper is GONE from the face', !face.includes('armRootCommand') && !face.includes('initialMessage'))
  t.check('Continue rides the one resume door directly, posture aboard, refusal on the row', face.includes('focusResumedSession(sid, target.transcriptPath ?? undefined') && face.includes('permissionMode: permissionModeRef.current') && face.includes('if (!outcome.ok) return outcome.reason;'))
  // The route owner: the armed exception retired whole; the bridge comment
  // tells the final truth (the census anchor re-trued twice, honestly).
  const route = read('src/context/surfaceRoute.ts')
  t.check('the route owner carries NO armed exception (enterRootRepl refuses without a chat, full stop)', !route.includes('armedRootCommand') && route.includes('export function enterRootRepl(): ChatEntry {'))
  // The road sentence wraps across two comment lines; the needle tolerates
  // the comment's own line-lead (`//` plus its indentation) at the wrap.
  t.check(
    'THE BRIDGE names the retirement and the surviving argv-prompt road',
    route.includes('The armed-root-command state RETIRED WHOLE') &&
      /mounts the chat route through the resolver's explicit-journey\n\/\/\s*landing \(initializeSurfaceRoute\), never this verb/.test(route),
  )
}

t.section('§11 — ROUTE SILENCE around the real layers (no transition, no settle, the strip unmoved)')
{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { BootHealthScreen } = await import('../../src/components/BootHealthScreen.js')
  const { BootResumeScreen } = await import('../../src/components/BootResumeScreen.js')
  const routeStore = await import('../../src/context/surfaceRoute.js')
  routeStore._resetSurfaceRouteForTesting()
  const unregister = routeStore.registerRouteSurface('boot-settings', { render: () => null })
  routeStore.initializeSurfaceRoute({ kind: 'boot-settings' })
  const gen0 = routeStore.surfaceGeneration()
  const stops0 = routeStore.presentStripStops().join('·')
  const model = { ...resumeModelOf('all'), pendingMore: 0 }
  await renderToString(React.createElement(BootHealthScreen, { certificate: FIXED_CERT, fullScene: { columns: 100, rows: 30 } } as never), 100)
  await renderToString(React.createElement(BootResumeScreen, { model, fullScene: { columns: 100, rows: 30 } } as never), 100)
  t.check('the route never left boot-settings across both layer mounts', routeStore.currentSurfaceRoute().kind === 'boot-settings')
  t.check('NO transition committed (the generation stands at the seed)', routeStore.surfaceGeneration() === gen0, `${gen0} → ${routeStore.surfaceGeneration()}`)
  t.check('the last transition is still the INIT seed (no PUSH onto repl, no settle)', routeStore.lastSurfaceTransition().verb === 'INIT' && routeStore.lastSurfaceTransition().to === 'boot-settings')
  t.check('the strip’s stops are unmoved while the layers exist', routeStore.presentStripStops().join('·') === stops0, stops0)
  unregister()
  routeStore._resetSurfaceRouteForTesting()
}

t.section('§12 — THE SPLASH ROAD (C5, Way A): the face-door deep-link outranks policy BOTH directions')
{
  const routeStore = await import('../../src/context/surfaceRoute.js')
  const handover = await import('../../src/substrate/splashHandover.js')
  process.env['MERCURY_FULLSCREEN'] = '1'
  routeStore._resetSurfaceRouteForTesting()
  const unregFace = routeStore.registerRouteSurface('boot-settings', { render: () => null })
  const unregConcourse = routeStore.registerRouteSurface('concourse', { render: () => null })
  while (handover.consumeBootSurfaceIntent() !== null) { /* drain */ }
  while (handover.consumeFaceDoorDeepLink() !== null) { /* drain */ }

  // Direction 1: the armed deep-link OUTRANKS policy-always — the boot
  // lands the face; the resolver PEEKS and the one-shot survives for the
  // face's mount to consume.
  handover.armFaceDoorDeepLink('health')
  const armed = await routeStore.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' } })
  t.check('armed door + policy-always ⇒ the Boot face, typed face-door-intent', armed.effective.kind === 'boot-settings' && armed.reason === 'face-door-intent', JSON.stringify({ kind: armed.effective.kind, reason: armed.reason }))
  t.check('the resolver only PEEKED — the face still gets the one-shot, exactly once', handover.consumeFaceDoorDeepLink() === 'health' && handover.consumeFaceDoorDeepLink() === null)

  // Direction 2: NO deep-link + policy-always ⇒ the concourse, exactly
  // today's road (the widening changed nothing ambient).
  const plainAlways = await routeStore.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' } })
  t.check("no door + policy-always ⇒ the concourse with reason 'always' (today's bytes)", plainAlways.effective.kind === 'concourse' && plainAlways.reason === 'always', JSON.stringify({ kind: plainAlways.effective.kind, reason: plainAlways.reason }))

  // The splash 'repl' intent (continue) still outranks everything first.
  handover._setBootSurfaceIntentForTesting('repl')
  handover.armFaceDoorDeepLink('resume')
  const intent = await routeStore.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' } })
  t.check("a continue pick ('repl' intent) still owns the first frame ahead of the face door", intent.effective.kind === 'repl' && intent.reason === 'splash-intent')
  while (handover.consumeFaceDoorDeepLink() !== null) { /* drain the leftover */ }

  // CB-10 degrade: a non-fullscreen boot falls through to today's roads
  // and the one-shot WAITS (the kit precedent — whichever face mounts
  // first consumes it).
  process.env['MERCURY_FULLSCREEN'] = '0'
  handover.armFaceDoorDeepLink('health')
  const inline = await routeStore.resolveInitialSurface({ env: {} })
  t.check('a non-fullscreen boot never lands the face-door arm (today’s degrade)', inline.reason !== 'face-door-intent')
  t.check('the one-shot waits armed for the next face mount', handover.consumeFaceDoorDeepLink() === 'health')
  process.env['MERCURY_FULLSCREEN'] = '1'

  // The face consumes at mount (the CB-09/kit grammar), seeding the layer.
  const face = read('src/components/BootSplashScreen.tsx')
  // AGENTVERIFY A8: the agents door rides the SAME single consume — the
  // needle carries its seed so a second consume road cannot arrive unseen.
  t.check('the face consumes the face door ONCE at mount and seeds the layers from it', face.includes('useState(() => consumeFaceDoorDeepLink())') && face.includes("useState(faceDoor === 'health')") && face.includes("useState(faceDoor === 'resume')") && face.includes("useState(faceDoor === 'agents')"))
  // The wire vocabulary moves ONLY by the protocol's own degradation law
  // (an older runtime reads a new word as 'unknown-action' and boots
  // plain). AMENDED: the ruled `saturn` door
  // joined the closed set — the needle re-pins the widened vocabulary
  // whole so any further word is still adjudicated here by name.
  const handoverSrc = read('src/substrate/splashHandover.ts')
  // AMENDED: `logins` joined the closed set by the
  // operator's ruling — the needle re-pins the widened vocabulary whole so
  // any further word is still adjudicated here by name.
  // Needle re-pinned: 'agents' joined the closed set by the
  // same ruling grammar; the closed-vocabulary law stands.
  t.check('the receipt vocabulary is the adjudicated closed set (saturn · logins · agents joined by ruling)', handoverSrc.includes("const ACTIONS = new Set(['continue', 'doctor', 'project', 'resume', 'concourse', 'kit', 'saturn', 'logins', 'agents', 'cancel'])"))
  unregConcourse()
  unregFace()
  routeStore._resetSurfaceRouteForTesting()
}

t.finish('prove-face-doors')
