#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const impl = (await import('../../src/utils/scribe/implementerAwareness.js')) as typeof import('../../src/utils/scribe/implementerAwareness.js')

console.log('============================================================')
console.log(' Double-message CLASS GUARD — Scribe + Implementer, one surface/turn')
console.log('============================================================')

section('SCRIBE keystone — default-mode Scribe is DENIED Brief (no 2nd surface)')
const brief = src('tools', 'BriefTool', 'BriefTool.ts')
check('BriefTool denies Brief to the default-mode Scribe (mode-gated)', /if \(scribeModeEnabled\(\) && isScribeModeOn\(\) && !scribeChatroomEnabled\(\)\) return false/.test(brief))
check('the deny sits between the Implementer guard and the headless suppression ', /if \(isImplementerRole\(\)\) return false[\s\S]{0,2500}if \(scribeModeEnabled\(\) && isScribeModeOn\(\) && !scribeChatroomEnabled\(\)\) return false[\s\S]{0,2500}getIsNonInteractiveSession/.test(brief))
check('imports scribeModeEnabled + isScribeModeOn (the mode discriminator, not isScribeRole)', /import \{ isImplementerRole, scribeChatroomEnabled, scribeModeEnabled \}/.test(brief) && /import \{ isScribeModeOn \} from '\.\.\/\.\.\/utils\/scribeMode\.js'/.test(brief))
check('keystone no longer gates on the role env isScribeRole() (was inert on the carousel path)', !/if \(isScribeRole\(\) && !scribeChatroomEnabled\(\)\) return false/.test(brief))
check('chatroom KEEPS Brief (the !scribeChatroomEnabled term is present, load-bearing)', /!scribeChatroomEnabled\(\)/.test(brief))

section('SCRIBE doctrine — prose IS the surface (no SendUserMessage mandate, no ack)')
const pack = src('utils', 'scribe', 'scribePack.ts')
const aware = src('utils', 'scribe', 'scribeAwareness.ts')
check('default pack: typed prose IS the operator surface', /typed lines ARE your operator surface/.test(pack))
check('default pack: the old "INVISIBLE to them" doctrine is GONE', !/plain text you merely[\s\S]{0,20}type is INVISIBLE/.test(pack))
check('default pack: no "relay every result ... through SendUserMessage" mandate', !/relay every result, acknowledgement, and question/.test(pack))
check('awareness: the non-chatroom ", then SendUserMessage a one-line ack" clause is GONE', !/then SendUserMessage a one-line ack/.test(aware))
check('chatroom override still says "just speak" (untouched)', /just speak/.test(pack))

section('DEFENSE-IN-DEPTH — brief dedup re-armed + scans ALL blocks')
const msgs = src('components', 'Messages.tsx')
check('BRIEF_TOOL_NAME resolves unconditionally (a plain import of the owner constant; no fork guard)', /import \{\s*BRIEF_TOOL_NAME,\s*LEGACY_BRIEF_TOOL_NAME,?\s*\} from '\.\.\/tools\/BriefTool\/prompt\.js'/.test(msgs))
check('SEND_USER_FILE_TOOL_NAME resolves unconditionally too (and rides the brief family)', /import \{ SEND_USER_FILE_TOOL_NAME \} from '\.\.\/tools\/SendUserFileTool\/prompt\.js'/.test(msgs) && /\[BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME, SEND_USER_FILE_TOOL_NAME\]/.test(msgs))
const briefFilters = src('utils', 'messages', 'briefFilters.ts')
check('dropTextInBriefTurns scans ALL blocks (some() over content, not content[0])', /blocks\.some\(b => b\.type === 'tool_use' && b\.name && nameSet\.has\(b\.name\)\)/.test(briefFilters))
check('no lingering content[0]-only brief check in the dedup loop', !/const block = msg\.message\?\.content\[0\];\s*\n\s*if \(msg\.type === 'user' && block\?\.type !== 'tool_result'/.test(briefFilters))
check('Messages.tsx wires the leaf filters (the dedup stays on the render path)', /import \{\s*dropTextInBriefTurns,\s*filterForBriefTool,?\s*\} from '\.\.\/utils\/messages\/briefFilters\.js'/.test(msgs))

section('IMPLEMENTER pack — ONE bus envelope per turn (progress XOR escalate)')
const ipack = src('utils', 'scribe', 'implementerPack.ts')
check('implementer-bus: AT MOST ONE bus message per turn', /AT MOST/.test(ipack) && /ONE bus message per turn/.test(ipack) && /never two progress/.test(ipack))
check('implementer-bus: write != receipt (anti-hallucination)', /NOT proof the Scribe received or acted on it/.test(ipack))
check('examples: the old "Send status \\"started\\" ... \\"done\\"" multi-send is GONE', !/Send status "started" when you pick the task up and "done"/.test(ipack))
check('examples: ONE progress per turn (no separate "started")', /do NOT[\s\S]{0,20}also send a separate "started"/.test(ipack))
check('examples: an escalate REPLACES the progress (does not stack)', /this escalate is your ONE bus message this turn/.test(ipack))

section('IMPLEMENTER awareness — the new per-turn runtime layer (LIVE)')
delete process.env.MERCURY_SCRIBE_IMPLEMENTER
process.env.MERCURY_IMPLEMENTER = '1'
const r = impl.buildImplementerAwarenessReminder([])
check('Implementer process ⇒ non-empty reminder', r.length > 0)
check('content: AT MOST ONE bus message', /AT MOST ONE bus message/.test(r))
check('content: no (inbound) operator channel / prose seen by NO ONE', /seen by NO ONE/.test(r) && /NO (inbound )?operator channel/.test(r))
check('content: write != receipt (do not re-send / invent the reply)', /WRITTEN to the bus/.test(r) && /never narrate or invent the Scribe’s reply/.test(r))
check('content: respawn is normal — do not re-send a pre-restart status', /respawn \/ fresh transcript is NORMAL/.test(r) && /do NOT re-narrate or re-send/.test(r))

process.env.MERCURY_SCRIBE_CHATROOM = '1'
const rChat = impl.buildImplementerAwarenessReminder([])
check('C2 chatroom: envelope renders DIRECTLY as a [Mercury-Implement] line', /renders DIRECTLY to the operator as a `\[Mercury-Implement\]` line/.test(rChat))
check('C2 chatroom: floor intact (no inbound channel + seen by NO ONE)', /NO inbound operator channel/.test(rChat) && /seen by NO ONE/.test(rChat))
process.env.MERCURY_SCRIBE_CHATROOM = '0'
const rDefault = impl.buildImplementerAwarenessReminder([])
check('C2 default: envelope reaches the Scribe (who relays to the operator)', /reaches the Scribe \(who relays to the operator\)/.test(rDefault))
check('C2 default: floor intact (NO operator channel + seen by NO ONE)', /NO operator channel/.test(rDefault) && /seen by NO ONE/.test(rDefault))
delete process.env.MERCURY_SCRIBE_CHATROOM

delete process.env.MERCURY_IMPLEMENTER
check('NOT the Implementer process ⇒ "" (byte-identical)', impl.buildImplementerAwarenessReminder([]) === '')
process.env.MERCURY_SCRIBE = '1'
check('the SCRIBE process ⇒ "" (this is the Implementer-only layer)', impl.buildImplementerAwarenessReminder([]) === '')
delete process.env.MERCURY_SCRIBE
process.env.MERCURY_IMPLEMENTER = '1'
process.env.MERCURY_SCRIBE_IMPLEMENTER = '0'
check('MERCURY_SCRIBE_IMPLEMENTER=0 opt-out ⇒ "" (byte-identical)', impl.buildImplementerAwarenessReminder([]) === '')
delete process.env.MERCURY_SCRIBE_IMPLEMENTER
delete process.env.MERCURY_IMPLEMENTER

section('IMPLEMENTER awareness — the 6 wiring points')
const att = src('utils', 'attachments.ts') + readdirSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'attachments')).filter(f => f.endsWith('.ts')).map(f => src('utils', 'attachments', f)).join('\n')
check("attachments: union member type 'implementer_awareness'", /type: 'implementer_awareness'/.test(att))
check('attachments: imports buildImplementerAwarenessReminder', /import \{ buildImplementerAwarenessReminder \}/.test(att))
check("attachments: maybe('implementer_awareness', …)", /maybe\('implementer_awareness',/.test(att))
check('attachments: getImplementerAwarenessAttachment generator', /function getImplementerAwarenessAttachment/.test(att))
const nm = src('utils', 'messages', 'attachmentText.ts')
check("messages: case 'implementer_awareness' in the normalizer", /case 'implementer_awareness':/.test(nm))
const nullr = src('components', 'messages', 'nullRenderingAttachments.ts')
check("nullRenderingAttachments: 'implementer_awareness' is operator-invisible", /'implementer_awareness'/.test(nullr))

section('IMPLEMENTER cross-turn double — the keep-working stop-hook bus-credit')
const sh = src('utils', 'hooks', 'scribeImplementerStopHook.ts')
check('the settlement effect credits a bus-send turn via the per-turn helper (both roles)', /if \(implementerBusSendThisTurn\(messages\)\) return \{ action: 'settle' \}/.test(sh))
check('the old implementer-only role gate on the credit is GONE', !/role === 'implementer' && implementerBusSendThisTurn\(messages\)/.test(sh))
check('the per-turn helper is defined + exported (implementerBusSendThisTurn)', /export function implementerBusSendThisTurn/.test(sh))
check('helper scopes via the `since` window (findLastIndex on the last real user frame)', /findLastIndex\(\(?\s*m\b[^=]*=>\s*m\?\.type === 'user' && !m\.isMeta && !m\.toolUseResult\)/.test(sh))
check('imports briefTurnSatisfiedByScribeBus', /import \{ briefTurnSatisfiedByScribeBus \}/.test(sh))
const awareMod = (await import('../../src/utils/scribe/scribeAwareness.js')) as typeof import('../../src/utils/scribe/scribeAwareness.js')
const progressTurn = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'scribe', message: { type: 'progress', status: 'working', text: 'batch green' } } }] } }
check('a progress envelope ⇒ briefTurnSatisfiedByScribeBus true (the credit fires)', awareMod.briefTurnSatisfiedByScribeBus([progressTurn]) === true)
const shMod = (await import('../../src/utils/hooks/scribeImplementerStopHook.js')) as typeof import('../../src/utils/hooks/scribeImplementerStopHook.js')
const uFrame = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the task' }] } }
const lateTail = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Next I will run the tests.' }] } }
check('#2 [progress, user, tail] ⇒ NOT credited (stale envelope, keep-working stays alive)', shMod.implementerBusSendThisTurn([progressTurn, uFrame, lateTail]) === false)
check('#2 [user, progress, tail] ⇒ credited (reported THIS turn)', shMod.implementerBusSendThisTurn([uFrame, progressTurn, lateTail]) === true)
check('#2 [user, tail] ⇒ NOT credited (nothing reported this turn)', shMod.implementerBusSendThisTurn([uFrame, lateTail]) === false)

section('SCRIBE carousel/`/model` engage — keystone + awareness FIRE on the MODE (must-fix #1)')
delete process.env.MERCURY_SCRIBE
delete process.env.MERCURY_IMPLEMENTER
const smMod = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')
check('role env MERCURY_SCRIBE is NOT set (the carousel path has no env)', process.env.MERCURY_SCRIBE !== '1')
check('before engage: mode off ⇒ awareness reminder is "" (byte-identical)', !smMod.isScribeModeOn() && awareMod.buildScribeAwarenessReminder([]) === '')
smMod.setScribeMode(true)
check('after engage (mode flip, NO env): isScribeModeOn() ⇒ true', smMod.isScribeModeOn() === true)
check('after engage: awareness reminder FIRES on the carousel path (was DEAD before the fix)', smMod.isScribeModeOn() && awareMod.buildScribeAwarenessReminder([]).length > 0)
smMod.setScribeMode(false)
check('disengage: awareness reminder is "" again (clean toggle)', awareMod.buildScribeAwarenessReminder([]) === '')

section('SCRIBE attention clauses are SURFACE-AWARE (must-fix #3)')
check('source: surface-aware relay verb present', /const relayToOperator = chatroom \? 'via SendUserMessage' : 'in your own prose'/.test(aware))
check('source: the escalate clause uses ${relayToOperator}', /put it to the operator \$\{relayToOperator\}/.test(aware))
check('source: old hard-coded "put it to the operator via SendUserMessage" is GONE', !/put it to the operator via SendUserMessage/.test(aware))
check('source: old hard-coded "via SendUserMessage in your own voice" is GONE', !/via SendUserMessage in your own voice/.test(aware))
const busMod = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')
const escEnv = busMod.buildEscalate('implementer', 'which database?', { needsOperator: true })
const escMsg = { type: 'user', message: { role: 'user', content: JSON.stringify(escEnv) } }
smMod.setScribeMode(true)
process.env.MERCURY_SCRIBE_CHATROOM = '0'
const defR = awareMod.buildScribeAwarenessReminder([escMsg])
check('SINGLE-SURFACE (=0): the escalate clause fires', /just ESCALATED/.test(defR))
check('SINGLE-SURFACE (=0): relay is "in your own prose" (never names a tool the Scribe lacks)', /put it to the operator in your own prose/.test(defR))
check('SINGLE-SURFACE (=0): the escalate clause does NOT say "via SendUserMessage"', !/via SendUserMessage/.test(defR))
process.env.MERCURY_SCRIBE_CHATROOM = '1'
const crR = awareMod.buildScribeAwarenessReminder([escMsg])
check('CHATROOM: relay IS "via SendUserMessage" (Scribe keeps Brief there)', /put it to the operator via SendUserMessage/.test(crR))
delete process.env.MERCURY_SCRIBE_CHATROOM
smMod.setScribeMode(false)

section('DEFENSE-IN-DEPTH — chatroom KEEPS the Scribe text (dropText guard, should-fix c)')
check(
  'Messages.tsx text-drop carve-out requires ENGAGED scribe mode (mode-gated, not flag-only)',
  /const chatroomEngaged = scribeModeEnabled\(\) && isScribeModeOn\(\) && scribeChatroomEnabled\(\)/.test(msgs),
)
check(
  'the flag-only gate (dead dedup on the main thread) is GONE',
  !/const dropTextToolNames = scribeChatroomEnabled\(\) \? \[\] :/.test(msgs),
)

section('MAIN THREAD — one operator-facing surface per turn (brief + voice doctrine)')
const briefPromptMod = (await import('../../src/tools/BriefTool/prompt.js')) as typeof import('../../src/tools/BriefTool/prompt.js')
check(
  'BRIEF_PROACTIVE_SECTION: the one-surface rule is present',
  /exactly one channel per turn/.test(briefPromptMod.BRIEF_PROACTIVE_SECTION),
)
check(
  'BRIEF_PROACTIVE_SECTION: forbids the trailing plain-text recap after the call',
  /no summary line after the tool call/.test(briefPromptMod.BRIEF_PROACTIVE_SECTION),
)
check(
  'BRIEF_PROACTIVE_SECTION: never restate a worklog lead in a closing line',
  /no sign-off that re-announces a heading the worklog already gave/.test(briefPromptMod.BRIEF_PROACTIVE_SECTION),
)
check(
  'ASSISTANT_BRIEF enforce text: ONE surface + no trailing plain text',
  /travels on a single channel/.test(briefPromptMod.ASSISTANT_BRIEF) &&
    /no plain text comes after the call/.test(briefPromptMod.ASSISTANT_BRIEF),
)
const promptsSrc = src('constants', 'prompts.ts')
check(
  'prompts.ts: BRIEF_PROACTIVE_SECTION resolves unconditionally',
  /import \{ BRIEF_PROACTIVE_SECTION \} from '\.\.\/tools\/BriefTool\/prompt\.js'/.test(promptsSrc),
)
check(
  'prompts.ts: briefToolModule resolves unconditionally',
  /return BRIEF_PROACTIVE_SECTION/.test(promptsSrc),
)
check(
  "prompts.ts: the dynamicSections 'brief' splice is unconditional",
  /systemPromptSection\('brief', \(\) => buildBriefSection\(toolNames\)\)/.test(promptsSrc),
)
check(
  'prompts.ts: getBriefSection still gates per-session (null floors intact)',
  /if \(!toolNames\.has\('SendUserMessage'\)\) return null/.test(promptsSrc),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DOUBLE-FIX CLASS-GUARD PROOFS PASS')
else console.log(`❌ ${failures} DOUBLE-FIX PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
