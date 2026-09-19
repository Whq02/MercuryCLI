#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'paste-crash-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
const ROOT = process.cwd()
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('§A the loss mechanism: the submit clears the paste map, and a bare chip ships without it')
{
  const { expandPastedTextRefs } = await import('../../src/history.ts')
  const bytes = 'PASTE-BODY-' + 'z'.repeat(1200)
  const chip = '[Pasted text #1]'
  const map = { 1: { id: 1, type: 'text' as const, content: bytes } }
  check('the first send, map intact, expands the chip to the pasted bytes', expandPastedTextRefs(`kick off ${chip}`, map).includes(bytes))
  const cleared = expandPastedTextRefs(`kick off ${chip}`, {})
  check('a re-send with the CLEARED map ships a bare chip — the paste lost (the deployed build)', cleared.includes(chip) && !cleared.includes(bytes))
  check('a re-send with the RESTORED map carries the bytes again (what the fix makes true)', expandPastedTextRefs(`kick off ${chip}`, map).includes(bytes))
}

section('§B the fix at the true cause: a refused send restores the pastes with the text')
{
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  const refAt = repl.indexOf("if (receipt.state !== 'refused') return")
  const refBlock = refAt !== -1 ? repl.slice(refAt, refAt + 500) : ''
  check('the refused-send handler exists', refBlock !== '')
  check('it restores the TEXT to the composer', refBlock.includes('setInputValue(input)'))
  check('it restores the PASTES with the text, so the chips resolve on the re-send', refBlock.includes('setPastedContents(seatPastes)'))
  check('both restores sit under the one empty-composer guard', /pendingInput\.text\(\) === ''\)\s*\{[\s\S]*setInputValue\(input\)[\s\S]*setPastedContents\(seatPastes\)[\s\S]*\}/.test(refBlock))
  check('the composer captures the pastes before the submit clears them', repl.includes('const seatPastes = pendingInput.pastedContents()'))
}

section('§C the crash road: the chip carries its hash, the bytes are on disk from the mint, and a rebuilt composer still expands it')
{
  type Slot = { id: number; type: 'text' | 'image'; content: string; contentHash?: string }
  const promptSrc = readFileSync(join(ROOT, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  const mintAt = promptSrc.indexOf('const numLines = getPastedTextRefNumLines(text)')
  const mint = mintAt === -1 ? '' : promptSrc.slice(mintAt, mintAt + 600)
  check('C1 the mint stamps the chip with the hash of its bytes', mint.includes('const contentHash = hashPastedText(text)') && mint.includes('contentHash,'))
  check('C2 …and stores the bytes at the mint, not at the send', mint.includes('void storePastedText(contentHash, text)'))

  const store = await import('../../src/utils/pasteStore.ts')
  const drafts = (await import('../../src/utils/promptDraft.ts')) as unknown as {
    saveDraftDebounced: (sid: string, d: { text: string; cursorOffset: number; mode: string; pastedContents: Record<number, Slot> }) => void
    flushDraftSaves: () => Promise<void>
    readDraftSync: (sid: string) => { text: string; pastedContents: Record<number, Slot>; missingPastes?: string[] } | null
    draftPasteHashes?: () => Set<string>
  }
  const history = (await import('../../src/history.ts')) as unknown as {
    expandPastedTextRefs: (t: string, p: Record<number, Slot>) => string
    pasteUnavailableLine?: (reference: string) => string
    resolvePastedContents?: (t: string, p: Record<number, Slot>) => Promise<{ pastedContents: Record<number, Slot>; missing: string[] }>
  }
  const body = 'CRASH-BODY-' + 'y'.repeat(300_000)
  const hash = store.hashPastedText(body)
  const chip = '[Pasted text #1 +0 lines]'
  const text = `kick off ${chip}`
  await store.storePastedText(hash, body)
  drafts.saveDraftDebounced('crash-session', { text, cursorOffset: 0, mode: 'prompt', pastedContents: { 1: { id: 1, type: 'text', content: body, contentHash: hash } } })
  await drafts.flushDraftSaves()
  const rebuilt = drafts.readDraftSync('crash-session')
  check('C3 the composer rebuilt from the draft keeps the chip in its text', rebuilt?.text.includes(chip) === true, JSON.stringify(rebuilt?.text))
  const slot = rebuilt?.pastedContents[1]
  check('C4 the oversized paste survives the draft bound as a hash-only reference, not shed whole (the deployed build sheds it, map empty)', slot?.type === 'text' && slot.content === '' && slot.contentHash === hash, JSON.stringify(rebuilt?.pastedContents))
  const map = rebuilt?.pastedContents ?? {}
  const sent = history.resolvePastedContents ? await history.resolvePastedContents(text, map) : null
  const expanded = history.expandPastedTextRefs(text, sent?.pastedContents ?? map)
  check('C5 the send resolves the chip from the store by its hash and ships the bytes (the deployed build ships the chip bare)', expanded.includes(body) && !expanded.includes(chip), expanded.slice(0, 60))
  const file = join(process.env.MERCURY_CONFIG_DIR!, 'paste-cache', `${hash}.txt`)
  unlinkSync(file)
  const gone = history.resolvePastedContents ? await history.resolvePastedContents(text, map) : null
  check('C6 a chip whose bytes are gone is refused by name, never shipped bare', gone !== null && gone.missing.includes(chip) && history.expandPastedTextRefs(text, gone.pastedContents).includes(chip), JSON.stringify(gone?.missing))
  await store.storePastedText(hash, body)
  const past = new Date('2020-01-01')
  utimesSync(file, past, past)
  const retained = typeof drafts.draftPasteHashes === 'function' ? drafts.draftPasteHashes() : new Set<string>()
  await store.cleanupOldPastes(new Date(), retained)
  check('C7 the sweep keeps a paste a draft still names, past the cutoff', existsSync(file) && retained.has(hash), `retained=${[...retained].join(',')}`)
  await store.cleanupOldPastes(new Date())
  check('C8 …and with nothing naming it the same sweep removes it', !existsSync(file))
  const connectorSrc = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check('C9 the refusal has one owner of its words: the composer and the send both say the sentence history.ts owns', typeof history.pasteUnavailableLine === 'function' && history.pasteUnavailableLine(chip) === `${chip} is no longer available — remove the reference or paste the content again` && promptSrc.includes('text: pasteUnavailableLine(dangling[0]!.match)') && connectorSrc.includes('detail: pasteUnavailableLine(resolved.missing[0]!)'))
}

console.log(`\n${failures === 0 ? 'prove-paste-survives-refused-send: ALL LAWS HOLD' : `prove-paste-survives-refused-send: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
