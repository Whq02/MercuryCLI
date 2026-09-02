#!/usr/bin/env bun
// ============================================================================
//  scripts/prompts-panel/prove-minerva-room.ts
//  PROOF: MINERVA'S ROOM (sheet lines 8–9) — sees, never acts uninvited;
//  beside, never over; never sends; no model set ⇒ no spend.
//
//  Legs (the wire is a loopback OpenRouter fixture on 127.0.0.1:36210 —
//  NODE_ENV/CI are cleared so the VCR never arms; every leg asserts the
//  fixture's request COUNT, the honesty invariant):
//    §1 prompt build: saved prompts as numbered data · the sent-prompts
//       digest as data · byte caps + honest elision · the role line binds a
//       refinement to an explicit ask and forbids sending;
//    §2 the output schema (strict, one act) + the validator table: by id ·
//       by number · unknown handle dropped · mostly-unknown refused · cap
//       drops one polish · empty reply refused · duplicate ids collapse;
//    §3 UNSET model: the runner answers the /submodels hint, ZERO requests,
//       the saved prompts byte-identical;
//    §4 the asked-for refinement lands BESIDE prompt 2 only (originals
//       byte-kept, #1/#3 untouched); a chat that asks nothing lands nothing;
//       an unknown-id refinement is dropped; a stale base is refused;
//       exactly ONE request per ↵ (the exchange log's submit path);
//    §5 the never-sends census: the engine and the room import no sender,
//       queue, slash dispatcher or auto-submit; the ONE hand-off is the
//       close road (nextInput — the refined prompt lands as the composer's
//       DRAFT, never submitted; COORDKEYS item 4's s gesture, the
//       workbench's exact contract); the room's model line and the honest unset
//       line are spelled in-source; the notes board is gone.
//
//  Run: ~/.bun/bin/bun run scripts/prompts-panel/prove-minerva-room.ts
// ============================================================================
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_MODEL, startMinervaFixture } from './minerva-fixture-server.ts'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const PORT = 36210
const home = mkdtempSync(join(tmpdir(), 'minerva-room-proof-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_MINERVA_MODEL
delete process.env.MERCURY_CONSOLE_MODEL
delete process.env.MERCURY_TABULA
delete process.env.MERCURY_TABULA_MINERVA
process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${PORT}/api/v1`
process.env.OPENROUTER_API_KEY = 'sk-or-fixture-key'

const room = await import('../../src/utils/tabula/minervaRoom.ts')
const store = await import('../../src/utils/savedPrompts/savedPromptsStore.ts')
// resolveSubModel reads the real config owner (the saved /submodels pick) —
// the scratch home holds none, so the env pin and UNSET are the two answers.
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(" MINERVA'S ROOM — sees, never acts uninvited (loopback wire)")
console.log('============================================================')

const project = '/Users/example/dev/room-project'
const fixture = await startMinervaFixture(PORT)

try {
  section('§1 — prompt build')
  {
    const drafts = [
      { id: 'aa11bb', text: 'audit the retry ladder', createdAt: 't', updatedAt: 't' },
      { id: 'bb22cc', text: 'write the release notes', createdAt: 't', updatedAt: 't', refinedText: 'Write the release notes.' },
    ]
    const built = room.buildMinervaRoomUserPrompt(drafts, 'tighten prompt 2', ['ship it', 'audit the retry ladder and report file:line'])
    check('saved prompts ride as numbered data lines inside <saved_prompts>', built.prompt.includes('<saved_prompts>') && built.prompt.includes('"n":1,"id":"aa11bb"') && built.prompt.includes('"n":2,"id":"bb22cc"'))
    check('an existing refinement rides beside its prompt (the model sees what already landed)', built.prompt.includes('"refinedText":"Write the release notes."'))
    check('the sent prompts ride as data inside <sent_prompts>', built.prompt.includes('<sent_prompts>\nship it\naudit the retry ladder and report file:line\n</sent_prompts>'))
    check('the operator message rides inside <operator_message>', built.prompt.endsWith('<operator_message>\ntighten prompt 2\n</operator_message>'))
    check('no sent prompts ⇒ no <sent_prompts> block', !room.buildMinervaRoomUserPrompt(drafts, 'hi').prompt.includes('<sent_prompts>'))
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}`, text: 'x'.repeat(120), createdAt: 't', updatedAt: 't' }))
    const capped = room.buildMinervaRoomUserPrompt(many, 'hi')
    check('the byte cap elides from the OLDEST end with an honest notice', capped.elidedCount > 0 && capped.shownCount + capped.elidedCount === 400 && capped.prompt.includes(`(${capped.elidedCount} older saved prompt(s) were elided`) && capped.prompt.includes('"id":"id0399"') && !capped.prompt.includes('"id":"id0000"'))
    const longSent = room.buildMinervaRoomUserPrompt(drafts, 'hi', ['y'.repeat(1000)])
    check('a long sent prompt is clipped to one line with an ellipsis', /y{240}…/.test(longSent.prompt))
    const sys = room.minervaRoomSystemPrompt('Engine identity: fixture').join('\n')
    check('the role binds a refinement to an explicit ask', /ONLY when the operator's message asks for that/.test(sys) && /lands no refinement/.test(sys))
    check('the role forbids sending', /never send, submit, queue, or run anything/.test(sys) && /You cannot send, submit, queue, edit, delete, or reorder anything/.test(sys))
    check('the role states beside-never-over', /sits BESIDE the operator's wording/.test(sys))
    check('the identity line is stamped in', sys.includes('Engine identity: fixture'))
  }

  section('§2 — schema + validator table')
  {
    const fmt = room.minervaRoomOutputFormat()
    const schema = fmt.schema as { additionalProperties: boolean; required: string[]; properties: { refinements: { items: { properties: Record<string, unknown>; additionalProperties: boolean } } } }
    check('strict object: refinements + reply required, nothing else', schema.additionalProperties === false && schema.required.join(',') === 'refinements,reply')
    check('one act in the vocabulary: prompt + refinedText (no send, no edit, no delete)', Object.keys(schema.properties.refinements.items.properties).sort().join(',') === 'prompt,refinedText' && schema.properties.refinements.items.additionalProperties === false)
    const live = [{ id: 'aa11bb' }, { id: 'bb22cc' }, { id: 'cc33dd' }]
    const v1 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'bb22cc', refinedText: 'Do the thing.' }], reply: 'refined 2' }, live)
    check('by id passes', v1.ok && v1.plan.refinements.length === 1 && v1.plan.refinements[0]!.id === 'bb22cc')
    const v2 = room.validateMinervaRoomPlan({ refinements: [{ prompt: '2', refinedText: 'Do the thing.' }, { prompt: '#3', refinedText: 'Do that.' }], reply: 'ok' }, live)
    check('by number (2, #3) resolves to the live ids', v2.ok && v2.plan.refinements.map(r => r.id).join(',') === 'bb22cc,cc33dd')
    const v3 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'zz9999', refinedText: 'x' }, { prompt: 'aa11bb', refinedText: 'y' }, { prompt: 'bb22cc', refinedText: 'z' }, { prompt: 'cc33dd', refinedText: 'w' }], reply: 'ok' }, live)
    check('one unknown handle among four is dropped and reported', v3.ok && v3.plan.refinements.length === 3 && v3.dropped.length === 1)
    const v4 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'zz9999', refinedText: 'x' }, { prompt: 'yy8888', refinedText: 'y' }], reply: 'ok' }, live)
    check('a plan mostly of unknown handles is refused whole', !v4.ok && /unknown saved prompts/.test(v4.ok ? '' : v4.reason))
    const v5 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'aa11bb', refinedText: 'x'.repeat(room.MAX_ROOM_REFINED_CHARS + 1) }, { prompt: 'bb22cc', refinedText: 'fine' }], reply: 'ok' }, live)
    check('an overlong polish drops alone (the other lands)', v5.ok && v5.plan.refinements.length === 1 && v5.plan.refinements[0]!.id === 'bb22cc' && v5.dropped.length === 1)
    const v6 = room.validateMinervaRoomPlan({ refinements: [], reply: '   ' }, live)
    check('an empty reply is refused', !v6.ok)
    const v7 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'aa11bb', refinedText: 'one' }, { prompt: '1', refinedText: 'two' }], reply: 'ok' }, live)
    check('a duplicate handle collapses to the first refinement', v7.ok && v7.plan.refinements.length === 1)
    const v8 = room.validateMinervaRoomPlan({ refinements: [], reply: 'just talking' }, live)
    check('a chat with no refinements is a valid, empty plan', v8.ok && v8.plan.refinements.length === 0)
    check('a cap-busting plan is refused', !room.validateMinervaRoomPlan({ refinements: Array.from({ length: 9 }, () => ({ prompt: 'aa11bb', refinedText: 'x' })), reply: 'ok' }, live).ok)
    check('a non-object is refused', !room.validateMinervaRoomPlan('nope', live).ok)
    // The ASK SCOPE — the mechanical half of "refines only when you ask".
    const s0 = room.askedScope('who are you', live)
    check('a message naming nothing asks for nothing', !s0.all && !s0.named)
    const s2 = room.askedScope('tighten prompt 2', live)
    check('"tighten prompt 2" names the second prompt only', !s2.all && [...s2.ids].join(',') === 'bb22cc')
    check('"#3" and "the second one" and "the last" resolve to prompts', [...room.askedScope('polish #3', live).ids].join(',') === 'cc33dd' && [...room.askedScope('sharpen the second one', live).ids].join(',') === 'bb22cc' && [...room.askedScope('rewrite the last', live).ids].join(',') === 'cc33dd')
    check('an id names its prompt', [...room.askedScope('refine aa11bb', live).ids].join(',') === 'aa11bb')
    check('"refine all" / "rewrite them" / "sharpen both" speak of every prompt', room.askedScope('refine all', live).all && room.askedScope('rewrite them', live).all && room.askedScope('sharpen both', live).all)
    const p1 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'aa11bb', refinedText: 'HIJACKED' }], reply: 'I rewrote it anyway' }, live, s0)
    check('POISON: a refinement riding a message that asked for nothing is DROPPED and named in the receipt', p1.ok && p1.plan.refinements.length === 0 && p1.dropped.length === 1 && /did not ask/.test(p1.dropped[0]!), p1.ok ? p1.dropped.join(' | ') : p1.reason)
    const p2 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'bb22cc', refinedText: 'asked for' }, { prompt: 'aa11bb', refinedText: 'HIJACKED extra' }], reply: 'both' }, live, s2)
    check('POISON: an extra prompt beside the asked-for one is DROPPED, the asked-for one lands', p2.ok && p2.plan.refinements.map(r => r.id).join(',') === 'bb22cc' && p2.dropped.length === 1 && /prompt 1 was not asked for/.test(p2.dropped[0]!), p2.ok ? p2.dropped.join(' | ') : p2.reason)
    const p3 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'aa11bb', refinedText: 'a' }, { prompt: 'cc33dd', refinedText: 'c' }], reply: 'all' }, live, room.askedScope('refine all', live))
    check('"all" lets every named refinement land', p3.ok && p3.plan.refinements.length === 2 && p3.dropped.length === 0)
    // WORDS-NAMING (the operator's report: "can you refine my audit codebase
    // prompt" was dropped as unasked) — an ask that names a prompt by its
    // words resolves to it; ambiguity asks; a verb-less mention never widens.
    const wordsLive = [{ id: 'aa11bb', text: 'audit codebase for dead feature flags' }]
    const w1 = room.askedScope('can you refine my audit codebase prompt', wordsLive)
    check('THE OPERATOR SENTENCE resolves by words to the one prompt', !w1.all && w1.named && [...w1.ids].join(',') === 'aa11bb' && w1.ambiguous.size === 0)
    const twoLive = [
      { id: 'aa11bb', text: 'audit the codebase for dead flags' },
      { id: 'bb22cc', text: 'audit the release ladder' },
      { id: 'cc33dd', text: 'write the migration notes' },
    ]
    const w2 = room.askedScope('refine my audit prompt', twoLive)
    check('words fitting TWO prompts resolve to the ambiguity set, never a guess', !w2.named && w2.ids.size === 0 && [...w2.ambiguous].sort().join(',') === 'aa11bb,bb22cc')
    const w3 = room.validateMinervaRoomPlan({ refinements: [{ prompt: 'aa11bb', refinedText: 'Guessed.' }], reply: 'refined the audit one' }, twoLive, w2)
    check('a guessed refinement under ambiguity is WITHHELD without a drop line — askWhich flags the question', w3.ok && w3.plan.refinements.length === 0 && w3.dropped.length === 0 && w3.askWhich === true, w3.ok ? w3.dropped.join(' | ') : w3.reason)
    check('the room\'s question names both candidates by number and words', /^which one — 1 «audit the codebase.*» or 2 «audit the release ladder»\? name it by number$/.test(room.whichOneQuestion(w2.ambiguous, twoLive)), room.whichOneQuestion(w2.ambiguous, twoLive))
    const w4 = room.askedScope('my audit codebase prompt is great', wordsLive)
    check('prompt words WITHOUT an ask verb resolve nothing (the hijack gate holds)', !w4.named && w4.ambiguous.size === 0)
    const w5 = room.askedScope('please refine my prompt', wordsLive)
    check('a bare refine ask against a ONE-prompt store means the one prompt', w5.named && [...w5.ids].join(',') === 'aa11bb')
    const w6 = room.askedScope('tighten prompt 2, the audit one', twoLive)
    check('a classic handle beside prompt words wins outright — words stay a fallback', w6.named && [...w6.ids].join(',') === 'bb22cc' && w6.ambiguous.size === 0)
    // The M-key staging seat (the ruled follow-up): a COPY staged for the
    // room's box — trimmed, capped, one-shot; pure module state, so staging
    // can never touch the wire or the saved prompts.
    room._resetMinervaRoomForProofs()
    room.stageMinervaRoomDraft('  audit the retry ladder  ')
    check('the staged draft takes once, trimmed — the seat is one-shot', room.takeMinervaRoomStagedDraft() === 'audit the retry ladder' && room.takeMinervaRoomStagedDraft() === null)
    room.stageMinervaRoomDraft('x'.repeat(room.MAX_ROOM_MESSAGE_CHARS + 50))
    check('an overlong stage is capped at the message ceiling', (room.takeMinervaRoomStagedDraft() ?? '').length === room.MAX_ROOM_MESSAGE_CHARS)
    // FC-081: the cap is the room's deliberate ceiling — the DROP must be
    // reported, never silent. The count takes once beside the draft, and
    // the room's mount-notice renders it (call-shaped below).
    check('… and the dropped count is taken beside it (one-shot)', room.takeMinervaRoomStagedDraftDroppedChars() === 50 && room.takeMinervaRoomStagedDraftDroppedChars() === 0)
    room.stageMinervaRoomDraft('fits fine')
    void room.takeMinervaRoomStagedDraft()
    check('a fitting stage drops zero', room.takeMinervaRoomStagedDraftDroppedChars() === 0)
    {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const roomSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'tabula', 'MinervaRoom.tsx'), 'utf8')
      check(
        "the room SAYS the drop where the operator lands (call-shaped: the mount-notice renders the count)",
        /takeMinervaRoomStagedDraftDroppedChars\(\)/.test(roomSrc) && /stayed in the saved prompt/.test(roomSrc),
      )
    }
    room.stageMinervaRoomDraft('leftover')
    room._resetMinervaRoomForProofs()
    check('the proof reset clears the seat', room.takeMinervaRoomStagedDraft() === null && room.takeMinervaRoomStagedDraftDroppedChars() === 0)
  }

  section('§3 — UNSET model: the hint, zero requests, prompts byte-identical')
  {
    await store.addSavedPrompt(project, 'audit the retry ladder')
    await store.addSavedPrompt(project, 'write the release notes for 1.5.8')
    await store.addSavedPrompt(project, 'fold the flake into the runner')
    const before = JSON.stringify(await store.listSavedPrompts(project))
    fixture.hits.length = 0
    const res = await room.runMinervaRoomMessage(project, 'tighten prompt 2')
    check('the runner answers the /submodels hint as the reply', res.ran && res.ok && /\/submodels/.test(res.reply) && /sit as written/.test(res.reply))
    check('zero refinements, zero spend', res.ran && res.ok && res.refined === 0 && res.spent === false)
    check('ZERO requests reached the wire', fixture.hits.length === 0, `${fixture.hits.length} hit(s)`)
    check('the saved prompts are byte-identical', JSON.stringify(await store.listSavedPrompts(project)) === before)
    const empty = await room.runMinervaRoomMessage(project, '   ')
    check('an empty message never runs', !empty.ran)
  }

  section('§4 — pinned model: a refinement lands BESIDE prompt 2 only')
  {
    process.env.MERCURY_MINERVA_MODEL = FIXTURE_MODEL
    const drafts = await store.listSavedPrompts(project)
    const original = drafts.map(d => JSON.stringify(d))
    fixture.hits.length = 0
    const res = await room.runMinervaRoomMessage(project, 'tighten prompt 2', { sentPrompts: ['ship it'] })
    const posts = fixture.hits.filter(h => h.method === 'POST' && /chat\/completions$/.test(h.path))
    check('the runner ran and settled ok', res.ran && res.ok, res.ran && !res.ok ? res.reason : !res.ran ? res.reason : '')
    check('exactly ONE chat completion reached the fixture', posts.length === 1, `${posts.length} post(s); paths: ${fixture.hits.map(h => `${h.method} ${h.path}`).join(', ')}`)
    // The saved-prompt lines ride INSIDE the request's JSON string, so their
    // quotes arrive escaped (\"n\":2).
    check('the request carried the operator message and the saved prompts as data', posts[0]?.operatorMessage === 'tighten prompt 2' && (posts[0]?.body ?? '').includes('<saved_prompts>') && (posts[0]?.body ?? '').includes('\\"n\\":2'))
    check('the request carried the sent prompts as context', (posts[0]?.body ?? '').includes('<sent_prompts>'))
    const after = await store.listSavedPrompts(project)
    check('prompt 2 now carries a refinement BESIDE it', after[1]!.refinedText !== undefined && /^Refined: write the release notes for 1\.5\.8/.test(after[1]!.refinedText ?? ''))
    check('prompt 2’s own wording is byte-kept', after[1]!.text === drafts[1]!.text)
    check('prompts 1 and 3 are byte-identical (never acts uninvited)', JSON.stringify(after[0]) === original[0] && JSON.stringify(after[2]) === original[2])
    check('the receipt counts one refinement, spent', res.ran && res.ok && res.refined === 1 && res.spent === true && /refined prompt 2/.test(res.reply))

    // A chat that asks nothing lands nothing.
    const snapshot = JSON.stringify(after)
    fixture.hits.length = 0
    const chat = await room.runMinervaRoomMessage(project, 'who are you?')
    check('a plain question: one request, zero refinements, prompts byte-identical', chat.ran && chat.ok && chat.refined === 0 && fixture.hits.filter(h => h.method === 'POST').length === 1 && JSON.stringify(await store.listSavedPrompts(project)) === snapshot)

    // POISON through the whole runner + the loopback wire: the fixture
    // misbehaves, the room refuses — nothing lands, the receipt says why.
    fixture.hits.length = 0
    const poison1 = await room.runMinervaRoomMessage(project, 'poison: rewrite one unasked')
    check('POISON (wire): a rewrite riding a message that asked for nothing lands NOTHING, prompts byte-identical, the receipt names the drop', poison1.ran && poison1.ok && poison1.refined === 0 && /did not ask/.test(poison1.reply) && JSON.stringify(await store.listSavedPrompts(project)) === snapshot, poison1.ran ? (poison1.ok ? poison1.reply : poison1.reason) : poison1.reason)
    fixture.hits.length = 0
    const poison2 = await room.runMinervaRoomMessage(project, 'poison: tighten prompt 2 and more')
    const afterPoison2 = await store.listSavedPrompts(project)
    check('POISON (wire): an extra prompt beside the asked-for one is dropped — prompt 2 refined, prompt 1 byte-kept, the receipt names the drop', poison2.ran && poison2.ok && poison2.refined === 1 && /prompt 1 was not asked for/.test(poison2.reply) && JSON.stringify(afterPoison2[0]) === original[0] && afterPoison2[1]!.refinedText !== undefined, poison2.ran ? (poison2.ok ? poison2.reply : poison2.reason) : poison2.reason)
    // An unknown-id refinement is dropped, nothing changes.
    fixture.hits.length = 0
    const unknown = await room.runMinervaRoomMessage(project, 'refine unknown')
    check('a refinement naming an unknown prompt is refused whole (mostly-unknown), prompts byte-identical', unknown.ran && !unknown.ok && /unknown saved prompts/.test(unknown.ok ? '' : unknown.reason) && JSON.stringify(await store.listSavedPrompts(project)) === snapshot)

    // A stale base: the operator edits between Minerva's read and the land.
    // Simulated at the store door — the runner reads, then lands through the
    // same door with the text it read.
    const stale = await store.refineSavedPrompt(project, after[0]!.id, 'Refined: audit the retry ladder — stale.', 'some text Minerva read before an edit')
    check('a refinement against edited wording is refused at the store door', !stale.ok && /changed since Minerva read it/.test(stale.ok ? '' : stale.reason))

    // The exchange log's submit path: exactly one request per ↵, one in
    // flight, the log records the reply and the count.
    room._resetMinervaRoomForProofs()
    fixture.hits.length = 0
    const p1 = room.submitMinervaRoomMessage(project, 'refine all', [])
    const p2 = room.submitMinervaRoomMessage(project, 'refine all', [])
    check('a second ↵ while one is in flight is refused (never a silent drop)', (await p2) === false)
    check('the first ↵ settles', (await p1) === true)
    const log = room.getMinervaRoomExchanges()
    check('the exchange log records the reply and the refinement count', log.length === 1 && log[0]!.reply !== undefined && log[0]!.refined === 2 && log[0]!.spent === true)
    check('exactly one request for that ↵', fixture.hits.filter(h => h.method === 'POST').length === 1)
    const both = await store.listSavedPrompts(project)
    check('refine all landed beside prompts 1 and 2, wording byte-kept', both[0]!.refinedText !== undefined && both[1]!.refinedText !== undefined && both[0]!.text === drafts[0]!.text && both[1]!.text === drafts[1]!.text)

    // ── WORDS-NAMING through the whole runner + the loopback wire ──────────
    // THE OPERATOR SENTENCE against a ONE-prompt store: the poison is
    // today's drop ("dropped: you did not ask for a refinement — prompt 1
    // kept as written" while the refinement the operator asked for was
    // discarded). The asked-for refinement must LAND, with no drop line.
    const project2 = '/Users/example/dev/room-audit'
    await store.addSavedPrompt(project2, 'audit codebase for dead feature flags and report file:line')
    fixture.hits.length = 0
    const opAsk = await room.runMinervaRoomMessage(project2, 'can you refine my audit codebase prompt')
    const auditList = await store.listSavedPrompts(project2)
    check(
      'THE OPERATOR SENTENCE: the words-named refinement LANDS beside prompt 1 — no drop line',
      opAsk.ran && opAsk.ok && opAsk.refined === 1 && !/did not ask/.test(opAsk.reply) && !/dropped/.test(opAsk.reply) && auditList[0]!.refinedText !== undefined && auditList[0]!.text === 'audit codebase for dead feature flags and report file:line',
      opAsk.ran ? (opAsk.ok ? opAsk.reply : opAsk.reason) : opAsk.reason,
    )
    // AMBIGUOUS words against TWO audit prompts: the fixture GUESSES one —
    // the room withholds the guess and ASKS which one; nothing lands,
    // nothing is worded as a drop, and the next message can answer by number.
    const project3 = '/Users/example/dev/room-ambiguous'
    await store.addSavedPrompt(project3, 'audit the codebase for dead flags')
    await store.addSavedPrompt(project3, 'audit the release ladder')
    const ambigBefore = JSON.stringify(await store.listSavedPrompts(project3))
    fixture.hits.length = 0
    const ambig = await room.runMinervaRoomMessage(project3, 'refine my audit prompt')
    check(
      'AMBIGUOUS words-ask: the room asks "which one" — zero refinements, prompts byte-identical, no did-not-ask line, ONE call',
      ambig.ran && ambig.ok && ambig.refined === 0 && /which one — 1 «audit the codebase/.test(ambig.reply) && !/did not ask/.test(ambig.reply) && JSON.stringify(await store.listSavedPrompts(project3)) === ambigBefore && fixture.hits.filter(h => h.method === 'POST').length === 1,
      ambig.ran ? (ambig.ok ? ambig.reply : ambig.reason) : ambig.reason,
    )
    // The operator answers the question by number — the conversation closes.
    const answered = await room.runMinervaRoomMessage(project3, 'tighten prompt 2')
    const ambigAfter = await store.listSavedPrompts(project3)
    check(
      'answering the question by number lands that refinement only',
      answered.ran && answered.ok && answered.refined === 1 && ambigAfter[1]!.refinedText !== undefined && ambigAfter[0]!.refinedText === undefined,
      answered.ran ? (answered.ok ? answered.reply : answered.reason) : answered.reason,
    )
    delete process.env.MERCURY_MINERVA_MODEL
  }

  section('§5 — the never-sends census + the surface facts')
  {
    const engine = readFileSync(join(ROOT, 'src/utils/tabula/minervaRoom.ts'), 'utf8')
    const surface = readFileSync(join(ROOT, 'src/components/tabula/MinervaRoom.tsx'), 'utf8')
    const route = readFileSync(join(ROOT, 'src/commands/tabula/tabula.tsx'), 'utf8')
    // The census bans every SEND/DISPATCH road; the close-road hand-off
    // (nextInput — a composer DRAFT, never submitted) is the one lawful
    // door (COORDKEYS item 4: s sends the refined prompt to the composer),
    // and the engine file still reaches none of it.
    const senders = ['sendWords(', 'dispatchSlash(', 'enqueue(', 'submitNextInput', 'setInputValue', 'submitDispatch', 'dispatchToAgent']
    for (const [name, src] of [
      ['minervaRoom.ts', engine],
      ['MinervaRoom.tsx', surface],
      ['tabula.tsx', route],
    ] as const) {
      const hit = senders.filter(s => src.includes(s))
      check(`${name} reaches no sender, queue, slash dispatcher or auto-submit`, hit.length === 0, hit.join(', '))
    }
    check('the ENGINE file still carries no composer hand-off at all', !engine.includes('nextInput'))
    check(
      "the surface's one hand-off is the close road (s → onClose(refined))",
      surface.includes('onClose(d.refinedText)') && !surface.includes('submitNextInput'),
    )
    check('the engine lands refinements through the store’s ONE refine door only', engine.includes('refineSavedPrompt(') && !engine.includes('editSavedPrompt(') && !engine.includes('addSavedPrompt(') && !engine.includes('deleteSavedPrompt('))
    check('the model resolves through the ONE sub-model owner at each call', engine.includes("resolveSubModel('minerva')"))
    check(
      "a pre-wire refusal (no credential · not signed in) is reported as NOT SENT, never as the model 'answering without decodable JSON' (the checker's credential-less drive)",
      engine.includes('result.isApiErrorMessage === true') && engine.includes('not sent — '),
    )
    check('the room says the unset state in one honest line', surface.includes('no Minerva model set — /submodels pins one · your saved prompts sit as written'))
    check(
      'the room calls the connector doors BOUND (the daemon-carried connector is a class)',
      !/useSyncExternalStore\(\s*connector\./.test(surface) && surface.includes('() => connector.records()'),
    )
    check('the room names the pinned model and the law on its status line', surface.includes('refines a saved prompt only when you ask · never sends'))
    check('the room points at the notes file on disk and offers no note-leaving', surface.includes('your earlier notes stay readable in') && !surface.includes('appendEvents') && !surface.includes("'a add"))
    check(
      'the /tabula route hands a refined prompt to the composer ONLY through the close road (nextInput as a draft; never auto-submitted)',
      route.includes("display: 'skip', nextInput") && !route.includes('submitNextInput'),
    )
    check('the notes board is gone from the tree', !existsSync(join(ROOT, 'src/components/tabula/TabulaBoard.tsx')))
    const cmd = readFileSync(join(ROOT, 'src/commands/tabula/index.ts'), 'utf8')
    check("/tabula describes Minerva's room; /note and /minerva point at the notepad file", /Minerva's room/.test(cmd) && /notepad file/.test(cmd))
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-minerva-room — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
