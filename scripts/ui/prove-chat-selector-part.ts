#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settle } from '../lib/settingsPopupHarness.ts'
import { mountPart, openSelectorPart } from './chatScenarios.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openSelectorPart('chat-selector-part')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { decodeTranscriptBuffer } = await import('../../src/sessions/fabric/transcriptDecode.ts')
const { readAllTranscriptEntries } = await import('../../src/sessions/transcripts/materialize.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message
const asked = (text: string, uuid?: string): Message => ({ ...(createUserMessage({ content: text }) as Message), ...(uuid === undefined ? {} : { uuid }) }) as Message
const answered = (text: string): Message => createAssistantMessage({ content: text }) as Message
const said = (): string => t.calls.splice(0).join(' · ')
const told = (): string => t.notices.splice(0).map(notice => `${notice.key}: ${notice.text}`).join(' | ')
const heard = (): string => t.session.calls.splice(0).join(' · ')
const SEL_AT = 'change useChatRewindPickerView in src/screen/chat/useChatSelector.tsx'

section('§1 the selector: when it is drawn and what it is handed')
const rows = [asked('the first question'), answered('the first answer')]
await t.plant({ messages: rows, focusedEffectiveModel: 'claude-opus-4-5' })
check('with the message selector in focus the part hands back its element, with the rows, the model as the provider of a branch and the cancel of the screen', t.selector().messages === rows && t.selector().providerOrigin.length > 0 && t.selector().preselectedMessage === undefined, `${SEL_AT}; providerOrigin: ${t.selector().providerOrigin}`)
t.selector().onPreRestore()
check('before a restore the selector calls the cancel it was handed', said() === 'onCancel', `${SEL_AT} so onPreRestore calls the cancel it was handed`)
const chosen = asked('a preselected question')
await t.plant({ rewindPickerPreselect: chosen as never })
check('a preselected message is handed on', t.selector().preselectedMessage === chosen, `${SEL_AT} so the preselected message is handed to the selector`)
await t.plant({ chatSurfaceCovered: true })
check('while another surface covers the chat the selector is not drawn', t.part.value().rewindPicker === null, `${SEL_AT} so no selector is drawn while another surface covers the chat`)
await t.plant({ chatSurfaceCovered: false, focusedInputDialog: undefined })
check('nor while it does not have the focus', t.part.value().rewindPicker === null, `${SEL_AT} so no selector is drawn without the focus`)
await t.plant({ focusedInputDialog: 'message-selector', rewindPickerPreselect: undefined })
t.selector().onClose()
check('closing it takes the selector down and forgets the preselected message', said() === 'setShowMessageSelector false · setMessageSelectorPreselect undefined', `${SEL_AT} so onClose hides the selector and clears the preselect`)

section('§2 restore: the rewind of the session, and the words given back')
const anchor = asked('the question to wind back to')
const landed = await t.selector().onRestore(anchor, 'both')
check('a restore asks the session to rewind to the message, in the mode chosen', heard() === `rewind ${JSON.stringify({ userMessageId: anchor.uuid, mode: 'both' })}` && landed.outcome === 'applied', `${SEL_AT} so onRestore asks the session to rewind in the chosen mode; ${JSON.stringify(landed)}`)
check('a conversation that was wound back gives the words of the message to the composer, as restored words', t.draft().text === 'the question to wind back to' && said() === 'setInputMode prompt', `${SEL_AT} so a wound back conversation stages the message words in the composer; ${JSON.stringify(t.draft())} · ${t.calls.join()}`)
check('and the receipt is painted', told() === 'rewind-receipt: rewound: conversation wound back — 2 messages left the model\'s view (the transcript keeps them)', `${SEL_AT} so a conversation rewind paints its receipt`)
const { edit, text: draftText } = await import('../../src/screen/composer/input-core/pending-input.ts')
edit('')
t.session.rewind = request => ({ outcome: 'applied', mode: String(request.mode), code: { filesChanged: ['a.ts', 'b.ts'], insertions: 3, deletions: 1 } })
await t.selector().onRestore(anchor, 'code')
check('a restore of the files alone leaves the composer as it is and paints its own receipt', draftText() === '' && said() === '' && told() === 'rewind-receipt: rewound: 2 files restored (+3 -1)', `${SEL_AT} so a files-only restore leaves the composer alone and paints its receipt; ${JSON.stringify(draftText())} · ${t.calls.join()}`)
heard()
t.session.rewind = request => ({ outcome: 'noop', mode: String(request.mode) })
await t.selector().onRestore(anchor, 'both')
check('a rewind that found nothing to restore says so', told() === 'rewind-receipt: nothing to restore — the files already match this point' && draftText() === '', `${SEL_AT} so a noop rewind paints the nothing-to-restore receipt`)
heard()
t.session.rewind = request => ({ outcome: 'refused', mode: String(request.mode), refusal: 'not-found', detail: 'no such point' })
const refused = await t.selector().onRestore(anchor, 'both')
check('a refused rewind paints nothing and gives no words back: the card shows the refusal', refused.outcome === 'refused' && told() === '' && draftText() === '' && said() === '', `${SEL_AT} so a refused rewind paints nothing and stages no words`)
heard()
const nothing = await t.selector().onRestore(undefined, 'both')
check('with no message and no file point chosen the session is not asked at all', nothing.outcome === 'refused' && nothing.detail === 'no restore point was selected' && heard() === '', `${SEL_AT} so onRestore without a point is refused before it asks the session`)
t.session.rewind = request => ({ outcome: 'applied', mode: String(request.mode), code: { filesChanged: [], insertions: 0, deletions: 0 } })
await t.selector().onRestore(undefined, 'both', { filePath: 'src/a.ts', undo: true, userMessageId: 'point-7' })
check('a file point is restored as code, by its own id', heard() === `rewind ${JSON.stringify({ userMessageId: 'point-7', mode: 'code', filePath: 'src/a.ts', undo: true })}` && told() === 'rewind-receipt: rewound: files already matched', `${SEL_AT} so a file point restores as code by its own id`)
t.session.turnActive = true
t.session.onInterrupt = () => void setTimeout(() => (t.session.turnActive = false), 250)
t.session.rewind = request => ({ outcome: 'applied', mode: String(request.mode), conversation: { removed: 1 } })
const startedAt = Date.now()
await t.selector().onRestore(anchor, 'conversation')
const waited = Date.now() - startedAt
check('a turn that runs is interrupted first and waited for, then the session is asked', heard() === `interrupt · rewind ${JSON.stringify({ userMessageId: anchor.uuid, mode: 'conversation' })}` && waited >= 200 && waited < 4000, `${SEL_AT} so onRestore interrupts a running turn, waits for it, then rewinds; waited ${waited} ms`)
told()
said()
edit('')

section('§3 summarise, view only and a branch made by the selector')
await t.selector().onSummarize()
check('summarising a stretch closes the selector and refuses the rewrite of the session in words', said() === 'setShowMessageSelector false · setMessageSelectorPreselect undefined' && told().startsWith('session-rewrite: summarising a stretch of the conversation acts on the session\'s own conversation') && heard() === '', `${SEL_AT} so onSummarize closes the selector and refuses the session rewrite in words`)
t.selector().onViewOnly()
check('view only enters the transcript by the way ctrl+o takes, shows all of it and closes the selector', said() === 'handleEnterTranscript · setScreen transcript · setShowAllInTranscript true · setShowMessageSelector false · setMessageSelectorPreselect undefined', `${SEL_AT} so onViewOnly enters the transcript the way ctrl+o does`)
check('and says that nothing changed, and asks the session nothing', /^view-only-history: read-only view — .+ returns; nothing changed$/.test(told()) && heard() === '' && t.resumes.length === 0, `${SEL_AT} so view only says nothing changed and asks the session nothing`)
t.selector().onBranchCreated({ branchSessionId: 'abcdef0123456789', forkOrdinal: 4 })
check('a branch the selector made is told with its id and how to open it', told() === 'branch-created: Branch created: abcdef01 (fork 4) — mercury --resume abcdef0123456789; this session is untouched', `${SEL_AT} so onBranchCreated tells the branch id and how to resume it`)

section('§4 rerun: a branch before the message, entered through the one resume')
t.session.transcriptFile = null
const noFile = await t.selector().onRerun(anchor)
check('with no transcript file the rerun is refused in words', noFile.ok === false && noFile.reason === 'no transcript file to branch from — the chat owns no session yet', `${SEL_AT} so onRerun refuses without a transcript file; ${JSON.stringify(noFile)}`)
await t.plant({ isLoadingRef: { current: true } })
const midRun = await t.selector().onRerun(anchor)
check('while a turn runs the rerun is refused and nothing is branched', midRun.ok === false && midRun.reason === 'a run is in flight — esc to interrupt it first' && t.resumes.length === 0, `${SEL_AT} so onRerun refuses while a turn runs; ${JSON.stringify(midRun)}`)
await t.plant({ isLoadingRef: { current: false } })
const project = join(process.env.MERCURY_CONFIG_DIR ?? '', 'selector-project')
mkdirSync(project, { recursive: true })
const source = join(project, 'source-session.jsonl')
const uuidOf = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
{
  let text = ''
  for (let i = 1; i <= 8; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant'
    const entry = { type: role, parentUuid: i === 1 ? null : uuidOf(i - 1), isSidechain: false, userType: 'external', cwd: project, version: '1.0.0', message: role === 'user' ? { role, content: `turn ${i}` } : { role, content: [{ type: 'text', text: `reply ${i}` }] }, uuid: uuidOf(i), timestamp: new Date(1754000000000 + i * 1000).toISOString(), sessionId: 'source-session' }
    writeFileSync(source, text, { flag: 'w' })
    text += encodeTranscriptLine(source, entry as never).line
  }
  writeFileSync(source, text)
}
t.session.transcriptFile = source
const stranger = await t.selector().onRerun(asked('a message of another session', uuidOf(99)))
check('a message that is not in the transcript is refused', stranger.ok === false && stranger.reason === 'that message is not in the committed transcript', `${SEL_AT} so onRerun refuses a message missing from the transcript; ${JSON.stringify(stranger)}`)
const sourceBefore = readFileSync(source, 'utf8')
const ordinal = (await readAllTranscriptEntries(source)).findIndex(entry => (entry as { uuid?: string }).uuid === uuidOf(5))
said()
const rerun = await t.selector().onRerun(asked('turn 5', uuidOf(5)))
const receipt = t.notices.find(notice => notice.key === 'rerun-branch-created')
const [branchId, branchLog, entrypoint] = (t.resumes[0] ?? []) as [string, { fullPath?: string; messages?: unknown[] }, string]
check('a rerun enters the branch through the one resume, as a fork', rerun.ok === true && t.resumes.length === 1 && entrypoint === 'fork' && typeof branchId === 'string' && branchId !== 'source-session' && typeof branchLog.fullPath === 'string', `${SEL_AT} so onRerun resumes the branch once as a fork; ${JSON.stringify(rerun)}`)
const branchEntries = branchLog?.fullPath === undefined ? [] : (decodeTranscriptBuffer(readFileSync(branchLog.fullPath)).entries as Array<{ uuid?: string; subtype?: string }>)
check('the branch is cut before the message and closes on the rewind boundary', branchEntries.some(entry => entry.uuid === uuidOf(4)) && !branchEntries.some(entry => entry.uuid === uuidOf(5)) && branchEntries.at(-1)?.subtype === 'rewind_boundary', `${SEL_AT} so the branch is cut before the message and ends on the rewind boundary; entries: ` + branchEntries.map(entry => entry.subtype ?? entry.uuid?.slice(-2)).join(','))
check('the source transcript is untouched and the session is sent nothing', readFileSync(source, 'utf8') === sourceBefore && heard() === '', `${SEL_AT} so onRerun leaves the source transcript and the session untouched`)
check('the words of the message are staged in the composer for the operator to send, and the selector is closed', said() === 'setShowMessageSelector false · setMessageSelectorPreselect undefined · setInputValue "turn 5" · setInputMode prompt', `${SEL_AT} so onRerun stages the message words and closes the selector`)
check('and the receipt names the branch, the place of the cut and that the prompt is staged', receipt !== undefined && ordinal >= 1 && receipt.text === `Branch created: ${branchId.slice(0, 8)} (fork ${ordinal}) — prompt staged, Enter reruns; the source session is untouched`, `${SEL_AT} so the rerun receipt names the branch, the fork place and the staged prompt; got: ${receipt?.text}`)
t.notices.length = 0

section('§5 the message cursor: the active flag, copy and edit')
const rendersBefore = t.part.renders()
check('with no cursor the part says so, and the actions are never disabled', t.part.value().messageCursorActive === false && t.part.value().messageActionsDisabled === false, `${SEL_AT} so the cursor flag is off and the actions enabled with no cursor`)
t.cursor.setMessageCursor({ uuid: 'u1', type: 'assistant', expanded: false })
await settle(80)
const rendersActive = t.part.renders()
check('a cursor on a message renders the part once and flips the flag', t.part.value().messageCursorActive === true && rendersActive === rendersBefore + 1, `${SEL_AT} so the part renders once when the cursor appears; ${rendersActive - rendersBefore} renders`)
for (const uuid of ['u2', 'u3', 'u4', 'u5']) t.cursor.setMessageCursor({ uuid, type: 'assistant', expanded: false })
await settle(80)
check('the cursor moving from message to message renders the part not once: it reads the flag alone', t.part.renders() === rendersActive, `${SEL_AT} so cursor moves between messages do not render the part; ${t.part.renders() - rendersActive} renders`)
t.clipboard.confirmation = 'copied (the planted route)'
const reply = answered('the words of the answer')
await t.press('c', reply)
check('c copies the text of the message under the cursor and paints the confirmation of the clipboard itself', t.clipboard.copied.join() === 'the words of the answer' && told() === 'message-copy: copied (the planted route)' && t.cursor.getMessageCursor() === null, `${SEL_AT} so c copies the message text, paints the clipboard confirmation and clears the cursor; ${t.clipboard.copied.join()} · ${t.notices.map(notice => notice.text).join()}`)
const sent = asked('a question that was sent', '11111111-2222-4333-8444-555555555555')
t.session.records = [sent, reply]
said()
await t.press('enter', sent)
check('enter on a sent message stages its words in the composer and refuses the rewrite of the session in words', said() === 'setInputValue "a question that was sent" · setInputMode prompt' && told().startsWith('session-rewrite: editing a sent message acts on the session\'s own conversation'), `${SEL_AT} so enter on a sent message stages its words and refuses the session rewrite; ${t.calls.join()} · ${t.notices.map(notice => notice.text).join()}`)
await t.close()

section('§6 the states the arbitration reads')
{
  const { useChatRewindPicker } = t.module
  const states = await mountPart(() => useChatRewindPicker())
  const first = states.value()
  check('the selector starts down, with no preselected message', first.showRewindPicker === false && first.rewindPickerPreselect === undefined, 'change useChatSelector in src/screen/chat/useChatSelector.tsx so the selector starts down with no preselect')
  first.openRewindPicker()
  await settle(80)
  check('opening it shows it, and the opener is the same from one render to the next', states.value().showRewindPicker === true && states.value().openRewindPicker === first.openRewindPicker, 'change useChatSelector in src/screen/chat/useChatSelector.tsx so openMessageSelector shows it and stays the same function across renders')
  states.value().setShowRewindPicker(false)
  states.value().setRewindPickerPreselect(chosen as never)
  await settle(80)
  check('it is closed and a message preselected through the setters the part hands on', states.value().showRewindPicker === false && states.value().rewindPickerPreselect === chosen, 'change useChatSelector in src/screen/chat/useChatSelector.tsx so its setters close the selector and preselect a message')
  states.unmount()
}

console.log(`\n${failures === 0 ? 'prove-chat-selector-part: ALL PASS' : `prove-chat-selector-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
