#!/usr/bin/env bun
// ============================================================================
//  scripts/prompts-panel/prove-prompt-rows.ts
//  PROOF: the prompts panel's READ-ONLY projection (sheet lines 1, 3, 5, 6,
//  10) — pure rows over the transcript records, and the source-level
//  census that the panel touches no writer.
//
//  Locks:
//    §1 PROMPTS rows: every prompt the operator sent, in order (newest at
//       the bottom); the mode classification (plain · bash · slash, skills
//       spelled /name); the first line + honest length facts; tool results,
//       meta rows, compact summaries, task notifications, bash/local stdout,
//       tick rows and teammate replies are NOT prompts (the rewind
//       surface's own predicate);
//    §2 CREW TRAFFIC rows: the Agent launch brief + every SendMessage call
//       (lead → agent, string and structured bodies) + the
//       <teammate-message> replies (agent → lead), threaded per agent in
//       first-seen order, oldest→newest inside a thread; no traffic ⇒ [];
//    §3 the LIMITS line: nothing sent · since HH:MM from the start · the
//       resumed transcript included · a compaction says so in one line;
//    §4 the reads-only census: the panel, its rows module and the /workbench
//       route import no sender, queue, slash dispatcher, model call or
//       transcript writer — the composer hand-off is onDone's nextInput and
//       never submitNextInput; the retired WORK options' section labels and
//       verbs are absent from the panel source; the route's description
//       speaks the new content.
//
//  Run: ~/.bun/bin/bun run scripts/prompts-panel/prove-prompt-rows.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const rows = await import('../../src/components/prompts-panel/rows.ts')
const xml = await import('../../src/constants/xml.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Raw = Record<string, unknown>
let n = 0
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const user = (content: unknown, extra: Raw = {}, at = `2026-08-26T12:${String(n).padStart(2, '0')}:00.000Z`): Raw => ({
  type: 'user',
  uuid: uuid(),
  timestamp: at,
  message: { role: 'user', content },
  ...extra,
})
const assistant = (content: unknown[], at = `2026-08-26T12:${String(n).padStart(2, '0')}:30.000Z`): Raw => ({
  type: 'assistant',
  uuid: uuid(),
  timestamp: at,
  message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})

console.log('============================================================')
console.log(' PROMPTS PANEL — rows over the records (API-free)')
console.log('============================================================')

section('§1 — PROMPTS rows')
{
  const records = [
    user('audit the retry ladder'),
    assistant([{ type: 'text', text: 'On it.' }]),
    user('refactor the switchboard focus path\n- keep the reap law\n- one pool per boundary'),
    user(`<${xml.BASH_INPUT_TAG}>git status --short</${xml.BASH_INPUT_TAG}>`),
    user(`<${xml.BASH_STDOUT_TAG}> M src/a.ts</${xml.BASH_STDOUT_TAG}>`),
    user(`<${xml.COMMAND_NAME_TAG}>/model</${xml.COMMAND_NAME_TAG}>\n<${xml.COMMAND_MESSAGE_TAG}>model</${xml.COMMAND_MESSAGE_TAG}>\n<${xml.COMMAND_ARGS_TAG}>opus</${xml.COMMAND_ARGS_TAG}>`),
    user(`<${xml.LOCAL_COMMAND_STDOUT_TAG}>Set model to opus</${xml.LOCAL_COMMAND_STDOUT_TAG}>`),
    user(`<${xml.COMMAND_NAME_TAG}>skill:code-review</${xml.COMMAND_NAME_TAG}>\n<${xml.COMMAND_MESSAGE_TAG}>code-review</${xml.COMMAND_MESSAGE_TAG}>\n<${xml.COMMAND_ARGS_TAG}>high</${xml.COMMAND_ARGS_TAG}>`),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }]),
    user('a meta row', { isMeta: true }),
    user('the summary', { isCompactSummary: true }),
    user(`<${xml.TASK_NOTIFICATION_TAG}>done</${xml.TASK_NOTIFICATION_TAG}>`),
    user(`<${xml.TICK_TAG}>1</${xml.TICK_TAG}>`),
    user(`<${xml.TEAMMATE_MESSAGE_TAG} teammate_id="PANEL">landed</${xml.TEAMMATE_MESSAGE_TAG}>`),
    // The REAL slash wire (processSlashCommand): the message tag leads, the
    // name tag follows, the args tag closes — one line.
    user(`<${xml.COMMAND_MESSAGE_TAG}>compact</${xml.COMMAND_MESSAGE_TAG}><${xml.COMMAND_NAME_TAG}>/compact</${xml.COMMAND_NAME_TAG}><${xml.COMMAND_ARGS_TAG}>keep the receipts</${xml.COMMAND_ARGS_TAG}>`),
    // A plain prompt whose own words QUOTE a bash tag mid-sentence.
    user('the doc says <bash-input>rm -rf /tmp/x</bash-input> is the command — do not run it'),
    user([{ type: 'text', text: 'ship it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
  ]
  const out = rows.promptRows(records as never)
  check('exactly the eight sent prompts survive (tool results, meta, summary, stdout, task/tick, teammate rows are not prompts)', out.length === 8, out.map(r => r.text).join(' | '))
  check('order = the order sent, numbered from 1 (newest at the bottom)', out.map(r => r.n).join(',') === '1,2,3,4,5,6,7,8' && out[0]!.text === 'audit the retry ladder' && out[7]!.text === 'ship it')
  check('plain · bash · slash classified', out.map(r => r.mode).join(',') === 'plain,plain,bash,slash,slash,slash,plain,plain', out.map(r => r.mode).join(','))
  check('the REAL slash wire order (message tag first) reads /name args', out[5]!.mode === 'slash' && out[5]!.text === '/compact keep the receipts')
  check('a plain prompt quoting a bash tag mid-sentence stays PLAIN with the operator’s words (never re-labelled bash, never replaced by the quoted command)', out[6]!.mode === 'plain' && /^the doc says/.test(out[6]!.text) && /do not run it$/.test(out[6]!.text) && !/^!/.test(out[6]!.text), `${out[6]!.mode}: ${out[6]!.text}`)
  check('a bash send is only the WHOLE wire shape (a tag with trailing words is not a bash send)', rows.classifyPrompt(`<${xml.BASH_INPUT_TAG}>ls</${xml.BASH_INPUT_TAG}> and then some words`).mode === 'plain')
  check('a bash send reads as the operator typed it (! cmd)', out[2]!.text === '! git status --short' && out[2]!.firstLine === '! git status --short')
  check('a slash send reads /name args', out[3]!.text === '/model opus')
  check('a skill send is spelled /name args', out[4]!.text === '/code-review high')
  check('a multi-line prompt keeps its first line + honest length facts', out[1]!.firstLine === 'refactor the switchboard focus path' && out[1]!.lines === 3 && out[1]!.chars === out[1]!.text.length)
  check('the whole prompt text is kept for the expand', out[1]!.text.includes('one pool per boundary'))
  check('a block-content prompt uses its text block', out[7]!.mode === 'plain' && out[7]!.lines === 1)
  check('row keys are the record uuids (stable across repaints)', out.every(r => r.key.startsWith('prompt:00000000-0000-4000-8000-')))
  check('an empty transcript ⇒ no rows', rows.promptRows([]).length === 0)
  const blank = rows.promptRows([user('   ')] as never)
  check('a blank send is honest, never a fabricated line', blank.length === 0 || blank[0]!.text === '(no prompt text)')
}

section('§2 — CREW TRAFFIC rows')
{
  n = 0
  const records = [
    user('build the panel'),
    assistant([
      { type: 'tool_use', id: 'toolu_a1', name: 'Agent', input: { name: 'PANEL', description: 'Prompts panel implementer lane', prompt: 'You are lane PANEL.\nRead the sheet whole first.' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'launched' }]),
    assistant([
      { type: 'text', text: 'Dispatching.' },
      { type: 'tool_use', id: 'toolu_s1', name: 'SendMessage', input: { to: 'PANEL', summary: 'go', message: 'Build tab one first; report per landed tab.' } },
      { type: 'tool_use', id: 'toolu_s2', name: 'SendMessage', input: { to: 'CLAM', message: { type: 'question', content: 'Is the splash yours?', request_id: 'q1' } } },
    ]),
    user(`<${xml.TEAMMATE_MESSAGE_TAG} teammate_id="PANEL" summary="tab one landed">PROMPTS tab landed on fix/prompts-panel &amp; pushed.</${xml.TEAMMATE_MESSAGE_TAG}>`),
    user(`<${xml.TEAMMATE_MESSAGE_TAG} teammate_id="CLAM">yes — hands off please</${xml.TEAMMATE_MESSAGE_TAG}>`),
    assistant([{ type: 'tool_use', id: 'toolu_s3', name: 'SendMessage', input: { to: 'PANEL', message: 'Good — carry on.' } }]),
    assistant([{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'ls' } }]),
  ]
  const msgs = rows.crewTrafficMessages(records as never)
  check('six traffic messages (1 launch · 3 sends · 2 replies); a Bash call is not traffic', msgs.length === 6, msgs.map(m => `${m.dir}:${m.agent}:${m.via}`).join(' '))
  check('the launch brief is lead → agent, keyed by the agent name', msgs[0]!.via === 'launch' && msgs[0]!.dir === 'to' && msgs[0]!.agent === 'PANEL' && msgs[0]!.firstLine === 'You are lane PANEL.')
  check('a structured SendMessage body reads its type + content', msgs[2]!.agent === 'CLAM' && msgs[2]!.text.includes('[question]') && msgs[2]!.text.includes('Is the splash yours?'))
  check('a reply carries the agent id, the summary attr and the unescaped body', msgs[3]!.dir === 'from' && msgs[3]!.agent === 'PANEL' && msgs[3]!.summary === 'tab one landed' && msgs[3]!.text.includes('& pushed'))
  const threaded = rows.crewTrafficRows(records as never)
  const heads = threaded.filter(r => r.kind === 'crew-thread')
  check('threaded per agent in first-seen order (PANEL, CLAM)', heads.map(h => (h.kind === 'crew-thread' ? h.agent : '')).join(',') === 'PANEL,CLAM')
  check('thread counts are honest (PANEL 4 · CLAM 2)', heads.map(h => (h.kind === 'crew-thread' ? h.count : 0)).join(',') === '4,2')
  const panelThread = threaded.slice(1, 5)
  check('inside a thread: oldest → newest (launch · message · reply · message)', panelThread.map(r => (r.kind === 'crew' ? r.via : 'x')).join(',') === 'launch,message,reply,message')
  check('no agents this session ⇒ [] (the honest empty line is the surface’s)', rows.crewTrafficRows([user('hello'), assistant([{ type: 'text', text: 'hi' }])] as never).length === 0)
}

section('§3 — the limits line')
{
  n = 0
  const clock = (iso: string): string => iso.slice(11, 16)
  check('nothing sent', rows.limitsLine(rows.recordLimits([]), 0, clock) === '0 prompts · nothing sent in this chat yet')
  const fresh = [user('one', {}, '2026-08-26T12:01:00.000Z'), user('two', {}, '2026-08-26T12:05:00.000Z')]
  const l1 = rows.limitsLine(rows.recordLimits(fresh as never, '2026-08-26T12:00:00.000Z'), 2, clock)
  check('from the start of this session (records newer than the process)', l1 === '2 prompts since 12:01 · from the start of this session', l1)
  const l2 = rows.limitsLine(rows.recordLimits(fresh as never, '2026-08-26T13:00:00.000Z'), 2, clock)
  check('a resumed transcript is said out loud', /resumed transcript included/.test(l2), l2)
  const compacted = [...fresh, user('summary', { isCompactSummary: true }, '2026-08-26T12:06:00.000Z')]
  const l3 = rows.limitsLine(rows.recordLimits(compacted as never, '2026-08-26T12:00:00.000Z'), 2, clock)
  check('a compaction says the gap in one line', /a compaction hides the earlier prompts/.test(l3), l3)
  // The fullest line (a three-digit count · resumed · compacted) must fit the
  // panel's header at 100 columns (border + padding leave 96 cells) — the
  // checker's 100x30 capture showed the compaction clause cut mid-word.
  const fullest = rows.limitsLine(rows.recordLimits(compacted as never, '2026-08-26T13:00:00.000Z'), 120, clock)
  check('the fullest limits line fits the 100-column header whole (≤ 96 cells)', fullest.length <= 96, `${fullest.length}: ${fullest}`)
  const boundary = [...fresh, { type: 'system', subtype: 'compact_boundary', content: '', uuid: uuid(), timestamp: '2026-08-26T12:07:00.000Z' }]
  check('a compact_boundary system row counts as a compaction too', rows.recordLimits(boundary as never).compacted)
  check('one prompt reads singular', rows.limitsLine(rows.recordLimits([fresh[0]!] as never, '2026-08-26T12:00:00.000Z'), 1, clock).startsWith('1 prompt since'))
  check('clockOf paints HH:MM and never throws on junk', /^\d\d:\d\d$/.test(rows.clockOf('2026-08-26T12:01:00.000Z')) && rows.clockOf('junk') === '--:--')
}

section('§4 — the reads-only census (sheet lines 5 + 10)')
{
  const panel = readFileSync(join(ROOT, 'src/components/prompts-panel/PromptsPanel.tsx'), 'utf8')
  const rowsSrc = readFileSync(join(ROOT, 'src/components/prompts-panel/rows.ts'), 'utf8')
  const route = readFileSync(join(ROOT, 'src/commands/workbench/workbench.tsx'), 'utf8')
  const cmd = readFileSync(join(ROOT, 'src/commands/workbench/index.ts'), 'utf8')
  const writers = ['sendWords(', 'dispatchSlash(', 'enqueue(', 'queryWithModel', 'submitDispatch', 'dispatchToAgent', 'appendEvents(', 'setTranscript(', 'fetch(', 'submitNextInput']
  for (const src of [
    ['PromptsPanel.tsx', panel],
    ['rows.ts', rowsSrc],
    ['workbench.tsx', route],
  ] as const) {
    const hit = writers.filter(w => src[1].includes(w))
    check(`${src[0]} imports no sender, queue, slash dispatcher, model call or transcript writer`, hit.length === 0, hit.join(', '))
  }
  check('the panel reads the focused chat through the ONE connector slot', panel.includes('useSessionConnector()') && panel.includes('connector.subscribeRecords') && panel.includes('connector.records'))
  // The daemon-carried connector is a CLASS: a bare `connector.records`
  // handed to useSyncExternalStore reads `this.painted` off undefined and
  // crashes the entered view (found by the hop drive). Doors are called bound.
  check(
    'the connector doors are called BOUND (never a bare method reference into useSyncExternalStore)',
    !/useSyncExternalStore\(\s*connector\./.test(panel) && panel.includes('() => connector.records()') && panel.includes('connector.subscribeRecords(cb)'),
  )
  check('the composer hand-off is nextInput (never submitNextInput)', route.includes('nextInput') && !route.includes('submitNextInput'))
  check('the store is the only writer path the panel touches (saved prompts)', panel.includes('savedPromptsStore.js') && !panel.includes('tabulaStore'))
  check('a damaged saved-prompts file is said out loud (the panel reads the store’s problem seam; never a silent "reading…")', panel.includes('getSavedPromptsProblem') && panel.includes('could not be read'))
  // Comments may NAME the retirement; the code must not carry it — strip
  // the comment lines, then look for the retired section labels as string
  // literals and the retired verbs as identifiers.
  const code = panel
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n')
  const retiredLabels = ['WORK', 'LANES', 'REVIEW', 'GRAPH', 'TO-REVIEW', 'FEED', 'CREW']
  const retiredVerbs = ['dispatchOpen', 'crewFilter', 'createWalkthroughArtifact', 'promoteHandoff', 'submitDispatch', 'handOffSideConversation', 'no running work']
  const found = [
    ...retiredLabels.filter(word => new RegExp(`label: ['"\`]${word}['"\`]`).test(code)),
    ...retiredVerbs.filter(word => code.includes(word)),
  ]
  check('the retired WORK options’ section labels and verbs are absent from the panel source', found.length === 0, found.join(', ') || 'none')
  check('the three tabs: PROMPTS · CREW TRAFFIC · SAVED PROMPTS', panel.includes("label: 'PROMPTS'") && panel.includes("label: 'CREW TRAFFIC'") && panel.includes("label: 'SAVED PROMPTS'"))
  check('the honest empty lines are spelled in-panel', panel.includes('no agent traffic this session') && panel.includes('no prompts sent in this chat yet') && panel.includes('no saved prompts yet'))
  check('the route keeps its name (/workbench) and gate, and describes the new content', cmd.includes("name: 'workbench'") && cmd.includes('workbenchEnabled()') && /prompts panel/i.test(cmd))
  check('no model call, no network on open (no fetch/query import in the panel)', !/from '.*providers/.test(panel) && !panel.includes('fetch('))
}


// ── §FC-080: the composer slot declares what the buffer needs, capped ───────
{
  console.log('\n§FC-080 the composer slot height truth')
  const layout = await import('../../src/components/prompts-panel/composerLayout.ts')
  check('an empty buffer needs header + one input row', layout.promptsComposerRows(0) === 2)
  check('a one-line buffer needs 2', layout.promptsComposerRows(60) === 2)
  check('a wrapped buffer grows the declaration', layout.promptsComposerRows(200) === 4)
  check(
    'a ceiling-sized paste is CAPPED — never the whole panel',
    layout.promptsComposerRows(4000) === layout.COMPOSER_SLOT_MAX_ROWS,
    String(layout.promptsComposerRows(4000)),
  )
  const panelSrc = readFileSync(join(ROOT, 'src/components/prompts-panel/PromptsPanel.tsx'), 'utf8')
  check(
    'the slot DECLARES through the one formula (call-shaped)',
    /rows:[\s\S]{0,200}promptsComposerRows\(editor\.buffer\.length\)/.test(panelSrc),
  )
  check(
    'the paint CLIPS to the same cap (tail window: overflow hidden, flex-end)',
    /height=\{promptsComposerRows\(editor\.buffer\.length\) - 1\}/.test(panelSrc) &&
      /overflow="hidden"/.test(panelSrc) &&
      /justifyContent="flex-end"/.test(panelSrc),
  )
  check(
    'the two-row literal no longer hardcodes the editor arm',
    !/rows: editor\?\.kind === 'confirm-clear' \? 1 : 2,/.test(panelSrc),
  )
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-prompt-rows — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
