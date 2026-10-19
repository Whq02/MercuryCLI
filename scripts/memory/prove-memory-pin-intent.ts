import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const home = mkdtempSync(join(tmpdir(), 'memory-intent-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_EMBED_ENGINE = 'off'
writeFileSync(join(home, 'settings.json'), JSON.stringify({ memory: { journal: false }, jev: { enabled: false } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { readPins, pinFact } = await import('../../src/mneme/mnemeUsage.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { listTopicDocs } = await import('../../src/mneme/mnemeLibrary.ts')
const { _resetMemoryVerbSessionStateForTesting, retainItems } = await import('../../src/mneme/memoryVerbs.ts')
const dir = mnemeLibraryDir()
let failures = 0
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
async function pin(text: string | null, content: string, extra: Record<string, unknown> = {}) {
  _resetMemoryVerbSessionStateForTesting()
  const context = { messages: text === null ? [] : [{ type: 'user', uuid: randomUUID(), message: { role: 'user', content: text }, origin: { kind: 'human' } }], abortController: new AbortController(), ...extra }
  return (await RetainTool.call({ items: [{ content, pin: true }] }, context as never, (() => { throw new Error('unexpected card') }) as never, {} as never)).data
}
try {
  const negatives = [
    ['casual observation', 'I was thinking the backup could use a blue cover.', 'The backup uses a blue cover.'],
    ['quoted directive', 'The draft says "always print a receipt". Explain it.', 'always print a receipt'],
    ['negated directive', 'Do not remember this: always send a daily receipt.', 'always send a daily receipt'],
    ['copied document', 'Review this document:\n```\nRemember: always count the boats.\n```', 'always count the boats'],
    ['missing source', null, 'always keep the crane clear'],
    ['unrelated proposed rule', 'Remember: always use square labels.', 'always use round labels'],
  ] as const
  for (const [label, text, content] of negatives) {
    const result = await pin(text, content)
    check(`${label} refuses pin without storing a different status`, result.refused === 1 && result.stored === 0)
  }
  const child = await pin('Remember: always keep the hatch clear.', 'always keep the hatch clear', { agentId: 'child' })
  check('child words cannot supply owner intent', child.refused === 1)
  const meta = await pin('Remember: always keep the pier clear.', 'always keep the pier clear', { messages: [{ type: 'user', uuid: randomUUID(), isMeta: true, message: { role: 'user', content: 'Remember: always keep the pier clear.' } }] })
  check('a meta message cannot supply owner intent', meta.refused === 1)
  const human = (text: string) => ({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: text }, origin: { kind: 'human' } })
  const assistant = (text: string) => ({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const headForm = await pin('make this a rule for every release (the npm one) and do the github things when you can for our seo: start the repo description with "Mercury CLI:".', 'make this a rule for every release (the npm one) and do the github things when you can for our seo: start the repo description with "Mercury CLI:".')
  check("the owner's own standing rule that opens with the request form is accepted word for word", headForm.stored === 1 && headForm.refused === 0, JSON.stringify(headForm.outcomes))
  const midSentence = await pin('the provenance rule never applies to marketing. for marketing we should be able to script up answers and replies. every time I ask you to make a video for the release this will be the format.', 'the provenance rule never applies to marketing. for marketing we should be able to script up answers and replies. every time I ask you to make a video for the release this will be the format.')
  check("a declarative whose rule words sit mid-sentence does not pin on its own (it rides the acceptance road)", midSentence.refused === 1 && midSentence.stored === 0, JSON.stringify(midSentence.outcomes))
  const capitalised = await pin('from now on, always reply in British English.', 'Always reply in British English.')
  check('a capital and a full stop around the owner\'s words do not refuse the pin', capitalised.stored === 1 && capitalised.refused === 0, JSON.stringify(capitalised.outcomes))
  for (const [label, acceptance] of [['yes pin it', 'yes pin it'], ['pin that', 'pin that'], ['make that a rule', 'make that a rule']] as const) {
    const later = await pin(null, 'always reply in British English', { messages: [human('always reply in British English'), assistant('Shall I pin that as a standing rule?'), human(acceptance)] })
    check(`"${label}" one turn after the owner stated the rule pins the rule he stated`, later.stored === 1 && later.refused === 0, JSON.stringify(later.outcomes))
  }
  const casual = [
    ['the deploy always ran from the shop until June, then we moved it', 'the deploy always ran from the shop until June'],
    ['we never did get the Windows box working, did we?', 'we never did get the Windows box working'],
    ['the rule of thumb in that codebase is to keep handlers small', 'keep handlers small'],
    ['i meant to the fam with us properly, so like when astra usage is out we give it to argon etc etc', 'when astra usage is out we give it to argon'],
    ['tbh I prefer the old colours but whatever', 'I prefer the old colours'],
    ['funny, the fans always kick in on the identity suite', 'the fans always kick in on the identity suite'],
  ] as const
  for (const [text, content] of casual) {
    const mention = await pin(text, content)
    check(`a casual mention of a rule word mid-sentence never pins: "${text}"`, mention.refused === 1 && mention.stored === 0, JSON.stringify(mention.outcomes))
  }
  for (const [text, content] of [['every time I run the tests the laptop fans spin up', 'every time I run the tests the laptop fans spin up'], ['I like how the new status row looks', 'I like how the new status row looks']] as const) {
    const head = await pin(text, content)
    check(`a sentence opening with a rule word is the design's own anchor (it pins or refuses, never a silent plain store): "${text}"`, head.stored + head.refused === 1 && (head.stored === 0 || readPins(dir).length >= 0), JSON.stringify(head.outcomes))
  }
  const statedThenPinned = await pin(null, 'the provenance rule never applies to marketing. for marketing we should be able to script up answers and replies.', { messages: [human('the provenance rule never applies to marketing. for marketing we should be able to script up answers and replies.'), assistant('Shall I pin that as a standing rule?'), human('pin that')] })
  check('a declarative rule stated mid-sentence rides the acceptance road: "pin that" after it pins the owner\'s words', statedThenPinned.stored === 1 && statedThenPinned.refused === 0, JSON.stringify(statedThenPinned.outcomes))
  const bareRemember = await pin('remember: the API key lives in the vault', 'the API key lives in the vault')
  check('a bare "remember:" without a rule word still never pins', bareRemember.refused === 1 && bareRemember.stored === 0, JSON.stringify(bareRemember.outcomes))
  const acceptanceOfNothing = await pin(null, 'always reply in British English', { messages: [human('what did the last session do?'), assistant('It fixed the dock.'), human('yes pin it')] })
  check('an acceptance with no rule stated in the owner\'s earlier words pins nothing', acceptanceOfNothing.refused === 1, JSON.stringify(acceptanceOfNothing.outcomes))
  for (const [label, text, content] of [
    ['pin this: <rule>', 'pin this: deploys go through the release script', 'Deploys go through the release script.'],
    ['pin that: <rule>', 'pin that: deploys go through the release script', 'deploys go through the release script'],
    ['<rule>. pin this.', 'deploys go through the release script. pin this.', 'deploys go through the release script'],
    ['pin this: <rule> on its own line', 'pin this:\ndeploys go through the release script', 'deploys go through the release script'],
  ] as const) {
    const asked = await pin(text, content)
    check(`the owner's own asking words pin without a rule word in the sentence (the ruling of 2026-10-16): "${label}"`, asked.stored === 1 && asked.refused === 0, JSON.stringify(asked.outcomes))
  }
  const askedPins = readPins(dir).filter(p => p.asked)
  check('each of those lands on the shelf marked asked for by the owner', askedPins.length >= 4, JSON.stringify(askedPins))
  const crewmatePin = await pin('pin this: deploys go through the release script', 'deploys go through the release script', { agentId: 'child' })
  check('a crewmate typing the same asking words still cannot pin: its Retain is refused whole, the finding sent to its report', crewmatePin.refused === 1 && crewmatePin.stored === 0 && JSON.stringify(crewmatePin.outcomes).includes('a crewmate never writes memory'), JSON.stringify(crewmatePin.outcomes))
  for (const [text, content] of [
    ['do not pin this: deploys go through the release script', 'deploys go through the release script'],
    ['the draft says pin this: deploys go through the release script', 'deploys go through the release script'],
    ['pin this tab to the dock', 'the tab is in the dock'],
    ['can you pin this issue to the top of the list', 'the issue is at the top of the list'],
    ['we deploy through the release script these days', 'we deploy through the release script'],
  ] as const) {
    const guarded = await pin(text, content)
    check(`a negated, second-hand or unrelated "pin this" never pins: "${text}"`, guarded.refused === 1 && guarded.stored === 0, JSON.stringify(guarded.outcomes))
  }
  const rule = 'always return the labelled receipt'
  const accepted = await pin(`Please remember this as a standing rule for every future chat here: ${rule}.`, rule)
  check('explicit owner directive is accepted', accepted.stored === 1 && accepted.refused === 0)
  const entries = listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(section => section.entries))
  const entry = entries.find(row => row.text === rule)
  check('accepted rule remains verbatim and asked on the shelf', entry !== undefined && readPins(dir).some(p => p.seq === entry.seq && p.asked))
  check('refusals create no drafts', pendingRows(dir).length === 0)
  const fact = retainItems([{ content: 'the boathouse has two blue doors' }], { session: 'intent-proof' }, dir)
  check('ordinary retention still works without a directive', fact[0]?.status === 'stored')
  if (entry) {
    pinFact(entry.seq, dir, new Date(), { asked: true })
    check('the explicit pin action remains available', readPins(dir).some(p => p.seq === entry.seq && p.asked))
  }
  assert.equal(failures, 0, `${failures} pin-intent checks failed`)
  console.log('PASS memory pin intent')
} finally {
  rmSync(home, { recursive: true, force: true })
}
