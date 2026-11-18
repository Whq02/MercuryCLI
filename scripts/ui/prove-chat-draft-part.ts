#!/usr/bin/env bun
import { settle } from '../lib/settingsPopupHarness.ts'
import { openDraftPart } from './chatScenarios.ts'

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
check('keys typed before the screen stood are the first words of the draft', pending.text() === 'typed before the screen stood', JSON.stringify(pending.text()))
await act(() => part.value().setInputValue('a line for the session'))
check('a value set by the screen is an edit of the draft', pending.text() === 'a line for the session', JSON.stringify(pending.text()))
await act(() => part.value().setInputMode('bash'))
check('a mode set by the screen is the mode of the draft', pending.mode() === 'bash', pending.mode())
await act(() => part.value().setInputMode('prompt'))
const pastes = { 1: { id: 1, type: 'text' as const, content: 'alpha\nbeta' } }
await act(() => part.value().setPastedContents(pastes))
check('pastes set by the screen are the pastes of the draft', JSON.stringify(pending.pastedContents()) === JSON.stringify(pastes), JSON.stringify(pending.pastedContents()))
check('the ref for inserted text is one ref from render to render', part.value().insertTextRef.current === null)
const firstRef = part.value().insertTextRef
await t.plant({})
check('and stays the same object', part.value().insertTextRef === firstRef)

section('§2 the hook alone: what the draft tells the screen while it is typed')
await act(() => pending.edit(''))
check('an empty draft is not active', part.value().isPromptInputActive === false)
const before = t.pins()
await act(() => pending.edit('h'))
check('the first character makes the draft active and is never held back as a suggestion', part.value().isPromptInputActive === true && pending.text() === 'h', `${String(part.value().isPromptInputActive)} · ${pending.text()}`)
check('and pins the transcript to the bottom once', t.pins() === before + 1, `${t.pins() - before} pins`)
await act(() => pending.edit('he'))
check('a later character pins nothing', t.pins() === before + 1, `${t.pins() - before} pins`)
await act(() => pending.edit(''))
check('an emptied draft is not active again', part.value().isPromptInputActive === false)
t.scrolledAt.current = Date.now()
await act(() => pending.edit('x'))
check('a first character within three seconds of a scroll of the user pins nothing', t.pins() === before + 1, `${t.pins() - before} pins`)
await act(() => pending.edit(''))
t.scrolledAt.current = Date.now() - 3100
await act(() => pending.edit('y'))
check('a first character later than that pins again', t.pins() === before + 2, `${t.pins() - before} pins`)
await act(() => pending.edit(''))
await t.plant({ fullscreen: false })
await act(() => pending.edit('z'))
check('outside the fullscreen layout nothing is pinned', t.pins() === before + 2, `${t.pins() - before} pins`)
await t.plant({})

section('§3 the hook alone: words seeded from a card reach the draft')
await act(() => pending.edit('wait'))
const seeded = seed.seedComposerDirect('!')
check('a seed is appended to the draft through its own edit', seeded && pending.text() === 'wait!', JSON.stringify(pending.text()))
const release = seed.armComposerSeed()
const trimmed = seed.trySeedComposer('', { backspace: true } as never)
release()
check('a backspace under the card takes the last character off the draft', trimmed && pending.text() === 'wait', JSON.stringify(pending.text()))

section('§4 the hook alone: the prompt behind a sign-in wall is put back in an empty composer')
await act(() => pending.edit('words the user is typing'))
await t.plant({ messages: t.wallRows('the brief that hit the wall') })
check('a composer that holds words is left alone', pending.text() === 'words the user is typing' && part.value().authWallHold.held()?.text === 'the brief that hit the wall', `${pending.text()} · ${JSON.stringify(part.value().authWallHold.held())}`)
await t.close()
{
  const second = await openDraftPart('chat-draft-part-wall')
  await second.plant({ messages: second.wallRows('the brief that hit the wall') })
  check('an empty composer gets the held words back', second.pending.text() === 'the brief that hit the wall', JSON.stringify(second.pending.text()))

  section("§5 the hook alone: the composer's modes")
  check('the composer starts in insert mode with no history search and no help', second.part.value().vimMode === 'INSERT' && !second.part.value().isSearchingHistory && !second.part.value().helpOpen)
  second.part.value().setVimMode('NORMAL')
  second.part.value().setIsSearchingHistory(true)
  second.part.value().setHelpOpen(true)
  await settle(80)
  check('each mode is set by its own setter', second.part.value().vimMode === 'NORMAL' && second.part.value().isSearchingHistory && second.part.value().helpOpen)
  await second.close()
}

console.log(`\n${failures === 0 ? 'prove-chat-draft-part: ALL PASS' : `prove-chat-draft-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
