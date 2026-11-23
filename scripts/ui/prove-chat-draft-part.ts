#!/usr/bin/env bun
import { settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { closeStage, openDraftPart, openStage } from './chatScenarios.ts'

process.env.MERCURY_FLUX_PROBE = '1'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openDraftPart('chat-draft-part', { earlyInput: 'typed before the screen stood' })
const { part, pending, seed } = t
const act = async (run: () => void): Promise<void> => {
  run()
  await settle(80)
}

section("§1 the hook alone: the composer's draft and its door")
check('keys typed before the screen stood are the first words of the draft', pending.text() === 'typed before the screen stood', JSON.stringify(pending.text()) + ' (early keys must seed the draft; see useChatDraft in src/screen/chat/useChatDraft.ts)')
await act(() => part.value().setInputValue('a line for the session'))
check('a value set by the screen is an edit of the draft', pending.text() === 'a line for the session', JSON.stringify(pending.text()) + ' (setInputValue must edit the pending input; see useChatDraft in src/screen/chat/useChatDraft.ts)')
await act(() => part.value().setInputMode('bash'))
check('a mode set by the screen is the mode of the draft', pending.mode() === 'bash', pending.mode() + ' (setInputMode must set the mode of the pending input; see useChatDraft in src/screen/chat/useChatDraft.ts)')
await act(() => part.value().setInputMode('prompt'))
const pastes = { 1: { id: 1, type: 'text' as const, content: 'alpha\nbeta' } }
await act(() => part.value().setPastedContents(pastes))
check('pastes set by the screen are the pastes of the draft', JSON.stringify(pending.pastedContents()) === JSON.stringify(pastes), JSON.stringify(pending.pastedContents()) + ' (setPastedContents must write the pending input; see useChatDraft in src/screen/chat/useChatDraft.ts)')
check('the ref for inserted text is one ref from render to render', part.value().insertTextRef.current === null, 'insertTextRef must start as a ref holding null; see useChatDraft in src/screen/chat/useChatDraft.ts')
const firstRef = part.value().insertTextRef
await t.plant({})
check('and stays the same object', part.value().insertTextRef === firstRef, 'insertTextRef must be one stable ref across renders; see useChatDraft in src/screen/chat/useChatDraft.ts')

section('§2 the hook alone: what the draft tells the screen while it is typed')
await act(() => pending.edit(''))
check('an empty draft is not active', part.value().isPromptInputActive === false, 'isPromptInputActive must be false for an empty draft; see useChatDraft in src/screen/chat/useChatDraft.ts')
const before = t.pins()
await act(() => pending.edit('h'))
check('the first character makes the draft active and is never held back as a suggestion', part.value().isPromptInputActive === true && pending.text() === 'h', `${String(part.value().isPromptInputActive)} · ${pending.text()}` + ' (the first character must set isPromptInputActive without holding the text back; see useChatDraft in src/screen/chat/useChatDraft.ts)')
check('and pins the transcript to the bottom once', t.pins() === before + 1, `${t.pins() - before} pins` + ' (the pin on the first character goes through repinToBottom in useChatDraft, src/screen/chat/useChatDraft.ts)')
await act(() => pending.edit('he'))
check('a later character pins nothing', t.pins() === before + 1, `${t.pins() - before} pins` + ' (the pin on the first character goes through repinToBottom in useChatDraft, src/screen/chat/useChatDraft.ts)')
await act(() => pending.edit(''))
check('an emptied draft is not active again', part.value().isPromptInputActive === false, 'isPromptInputActive must drop when the draft is emptied; see useChatDraft in src/screen/chat/useChatDraft.ts')
t.scrolledAt.current = Date.now()
await act(() => pending.edit('x'))
check('a first character within three seconds of a scroll of the user pins nothing', t.pins() === before + 1, `${t.pins() - before} pins` + ' (the pin on the first character goes through repinToBottom in useChatDraft, src/screen/chat/useChatDraft.ts)')
await act(() => pending.edit(''))
t.scrolledAt.current = Date.now() - 3100
await act(() => pending.edit('y'))
check('a first character later than that pins again', t.pins() === before + 2, `${t.pins() - before} pins` + ' (the pin on the first character goes through repinToBottom in useChatDraft, src/screen/chat/useChatDraft.ts)')
await act(() => pending.edit(''))
await t.plant({ fullscreen: false })
await act(() => pending.edit('z'))
check('outside the fullscreen layout nothing is pinned', t.pins() === before + 2, `${t.pins() - before} pins` + ' (the pin on the first character goes through repinToBottom in useChatDraft, src/screen/chat/useChatDraft.ts)')
await t.plant({})
await act(() => pending.edit(''))
await act(() => pending.edit('typed'))
const rendersTyped = part.renders()
for (const more of ['typed a', 'typed an', 'typed and', 'typed and m', 'typed and mo', 'typed and mor', 'typed and more']) pending.edit(more)
await settle(80)
check('the flag the part hands on is the store\'s own, and keys typed while it stands render the part not once', part.value().isPromptInputActive === true && pending.active() === true && part.renders() === rendersTyped, `${part.renders() - rendersTyped} renders over seven more keys` + ' (the part must hand on the flag of the pending input store, not keep its own copy; see useChatDraft in src/screen/chat/useChatDraft.ts)')
const restedAt = Date.now()
await waitFor(() => !pending.active(), 4000)
await settle(80)
check('when the words have rested the store drops the flag by its own timer, and the part follows with one render', part.value().isPromptInputActive === false && part.renders() === rendersTyped + 1 && Date.now() - restedAt >= 1000, `${String(part.value().isPromptInputActive)} · ${part.renders() - rendersTyped} renders · ${Date.now() - restedAt} ms` + ' (the store drops the flag by its own timer in src/screen/composer/input-core/pending-input.ts and the part follows with one render in useChatDraft)')
await act(() => pending.edit(''))

section('§3 the hook alone: words seeded from a card reach the draft')
await act(() => pending.edit('wait'))
const seeded = seed.seedComposerDirect('!')
check('a seed is appended to the draft through its own edit', seeded && pending.text() === 'wait!', JSON.stringify(pending.text()) + ' (seedComposerDirect must append through the draft edit; see src/screen/cockpit/composerSeed.ts)')
const release = seed.armComposerSeed()
const trimmed = seed.trySeedComposer('', { backspace: true } as never)
release()
check('a backspace under the card takes the last character off the draft', trimmed && pending.text() === 'wait', JSON.stringify(pending.text()) + ' (trySeedComposer with backspace must remove the last character; see src/screen/cockpit/composerSeed.ts)')

section('§4 the hook alone: the prompt behind a sign-in wall is put back in an empty composer')
await act(() => pending.edit('words the user is typing'))
await t.plant({ messages: t.wallRows('the brief that hit the wall') })
check('a composer that holds words is left alone', pending.text() === 'words the user is typing' && part.value().authWallHold.held()?.text === 'the brief that hit the wall', `${pending.text()} · ${JSON.stringify(part.value().authWallHold.held())}` + ' (authWallHold in useChatDraft, src/screen/chat/useChatDraft.ts, must keep the brief and leave a composer that holds words alone)')
await t.close()
{
  const second = await openDraftPart('chat-draft-part-wall')
  await second.plant({ messages: second.wallRows('the brief that hit the wall') })
  check('an empty composer gets the held words back', second.pending.text() === 'the brief that hit the wall', JSON.stringify(second.pending.text()) + ' (authWallHold in useChatDraft, src/screen/chat/useChatDraft.ts, must put the held words into an empty composer)')

  section("§5 the hook alone: the composer's modes")
  check('the composer starts in insert mode with no history search and no help', second.part.value().vimMode === 'INSERT' && !second.part.value().isSearchingHistory && !second.part.value().helpOpen, 'vimMode, isSearchingHistory and helpOpen must start as INSERT, false, false; see useChatDraft in src/screen/chat/useChatDraft.ts')
  second.part.value().setVimMode('NORMAL')
  second.part.value().setIsSearchingHistory(true)
  second.part.value().setHelpOpen(true)
  await settle(80)
  check('each mode is set by its own setter', second.part.value().vimMode === 'NORMAL' && second.part.value().isSearchingHistory && second.part.value().helpOpen, 'setVimMode, setIsSearchingHistory and setHelpOpen must each set their own value; see useChatDraft in src/screen/chat/useChatDraft.ts')
  await second.close()
}

section('§6 the whole screen under typing: how often Chat renders for twenty typed keys')
{
  const { __fluxProbeResetForTest, fluxProbeDump } = await import('../../src/integrations/media-flux/fluxProbe.ts')
  const KEYS = 'twenty keys typed ok'
  const TYPED_RENDERS = 2
  const CYCLE_RENDERS = 4
  __fluxProbeResetForTest()
  const renders = (): number => fluxProbeDump().allMarks.filter(mark => mark.k === 'render:chat-root').length
  const stage = await openStage('draft-typing')
  await stage.mark('first', frame => frame.includes('Type a prompt'))
  await settle(400)
  const atRest = renders()
  await stage.type(KEYS)
  await waitFor(() => stage.src.pending.text() === KEYS, 4000)
  await settle(150)
  const typed = renders() - atRest
  const stillActive = stage.src.pending.active()
  await waitFor(() => !stage.src.pending.active(), 6000)
  await settle(400)
  const cycle = renders() - atRest
  await closeStage(stage)
  check(`the probe counted the renders of Chat: ${atRest} before the first key`, atRest > 0 && KEYS.length === 20, `${atRest} marks` + ' (no render:chat-root mark was recorded; the flux probe in src/integrations/media-flux/fluxProbe.ts counts them and MERCURY_FLUX_PROBE must stay set at the top of this file)')
  check(`twenty keys typed in the composer render Chat no more than ${TYPED_RENDERS} times while they are typed (the count on a4c7f8922c, where the screen kept its own copy of the flag)`, stillActive && typed > 0 && typed <= TYPED_RENDERS, `${typed} renders · the words still counted as typed when read: ${stillActive}` + ' (Chat must not re-render per key; the active flag must come from the pending input store through useChatDraft, src/screen/chat/useChatDraft.ts)')
  check(`and no more than ${CYCLE_RENDERS} by the time the words have rested`, cycle >= typed && cycle <= CYCLE_RENDERS, `${cycle} renders` + ' (the flag dropping after the words rest may cost only a few Chat renders; look at useChatDraft in src/screen/chat/useChatDraft.ts)')
}

console.log(`\n${failures === 0 ? 'prove-chat-draft-part: ALL PASS' : `prove-chat-draft-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
