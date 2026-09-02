#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-reflect-grounding.ts
//  PROOF (spec 06 C3): reflect is DISTINCT from recall and its synthesis is
//  grounded or refused — enforced in code, against a scripted loopback
//  model (every base pinned; nothing reaches a live host):
//    · a synthesis citing real records passes, with the cited ids reported;
//    · a synthesis that cites NOTHING is refused → raw recall returned;
//    · a synthesis citing an INVENTED id is refused → raw recall returned;
//    · no reachable model degrades TYPED to recall-with-notice;
//    · an empty recall short-circuits (no model call, elidable).
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-reflect-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_MNEME = '1'

let failures = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (150s) — treat as failure')
  process.exit(1)
}, 150_000)
watchdog.unref?.()
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── the scripted model fixture ─────────────────────────────────────────────
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const scripted: string[] = []
let modelCalls = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    modelCalls++
    const text = scripted.shift() ?? 'unscripted fixture reply'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      [
        `event: message_start\n${sse({ type: 'message_start', message: { id: 'fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } } })}`,
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}`,
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
      ].join(''),
    )
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { retainItems } = await import('../../src/memdir/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')
const { ReflectTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')

const context = {
  options: { mainLoopModel: 'claude-sonnet-5', tools: [], mcpClients: [], isNonInteractiveSession: true },
  abortController: new AbortController(),
} as never

// Seed three related consolidated facts (the acceptance shape).
retainItems(
  [
    { content: 'the release train departs fridays', topic: 'release' },
    { content: 'release tags are signed by the ops key', topic: 'release' },
    { content: 'release hotfixes may skip the train with sign-off', topic: 'release' },
  ],
  { session: 'reflect' },
)
maybeConsolidate({ dir: mnemeLibraryDir(), force: true })
// Derive the citable ids from the ACTUAL recall — the script must cite what
// the tool really put on the sheet.
const { recallQuery } = await import('../../src/memdir/memoryVerbs.js')
const citableSeqs = recallQuery('release', { limit: 12 })
  .hits.map(h => /^seq:(\d+)$/.exec(h.id)?.[1])
  .filter((v): v is string => Boolean(v))
if (citableSeqs.length < 2) {
  console.log('FATAL: seeding produced fewer than 2 citable seqs', JSON.stringify(citableSeqs))
  process.exit(1)
}

section('a citing synthesis passes with its ids reported')
scripted.push(`The train departs fridays [seq ${citableSeqs[0]}], with signed tags [seq ${citableSeqs[1]}].`)
const good = await ReflectTool.call({ query: 'release' } as never, context)
check('mode synthesis', good.data.mode === 'synthesis', `${good.data.mode} :: ${good.data.degradedReason ?? ''}`)
check('answer carried through', (good.data.answer ?? '').includes('signed tags'))
check('cited ids reported', JSON.stringify(good.data.citedIds).includes(`seq ${citableSeqs[0]}`), JSON.stringify(good.data.citedIds))

section('an uncited synthesis is REFUSED → raw recall')
scripted.push('Releases happen weekly and everything is signed, trust me.')
const uncited = await ReflectTool.call({ query: 'release' } as never, context)
check('refused to recall-only', uncited.data.mode === 'recall-only', uncited.data.mode)
check('the refusal names the grounding law', (uncited.data.degradedReason ?? '').includes('cited nothing'), uncited.data.degradedReason)
check('the raw recall rides along', uncited.data.recall.hits.length >= 3, String(uncited.data.recall.hits.length))

section('an INVENTED citation is REFUSED → raw recall')
scripted.push(`The train departs fridays [seq ${citableSeqs[0]}] under the moon protocol [seq 777].`)
const invented = await ReflectTool.call({ query: 'release' } as never, context)
check('refused to recall-only', invented.data.mode === 'recall-only', invented.data.mode)
check('the invented id is named', (invented.data.degradedReason ?? '').includes('seq 777'), invented.data.degradedReason)

section('a doc frontmatter/heading line is NOT citable grounding → refused')
// The topic-slug query surfaces doc:<slug>:<line> frontmatter (id/summary)
// beside the real seq facts. Those lines are structure, not claim-bearing
// records — they never reach the synthesis sheet, and a synthesis that tries
// to ground ONLY in them cites nothing citable and is refused.
scripted.push('Everything about releases is in the summary [doc:release:3].')
const docOnly = await ReflectTool.call({ query: 'release' } as never, context)
check('a doc-only citation is refused to recall-only', docOnly.data.mode === 'recall-only', docOnly.data.mode)
check('the refusal names the grounding law', (docOnly.data.degradedReason ?? '').includes('cited nothing'), docOnly.data.degradedReason)
check('the raw recall (incl. doc lines) still rides along', docOnly.data.recall.hits.some(h => h.id.startsWith('doc:')), JSON.stringify(docOnly.data.recall.hits.map(h => h.id)))

section('no usable seat for the model → TYPED degradation to recall-with-notice')
// A glm id with NO Z.AI credential: the router's account-absent honesty
// refuses FAST (no cross-provider fallback, no network retry loop).
delete process.env.ZAI_API_KEY
const glmContext = {
  options: { mainLoopModel: 'glm-5.2', tools: [], mcpClients: [], isNonInteractiveSession: true },
  abortController: new AbortController(),
} as never
const degraded = await ReflectTool.call({ query: 'release' } as never, glmContext)
check('degraded typed to recall-only', degraded.data.mode === 'recall-only', degraded.data.mode)
check('the notice names the failure', (degraded.data.degradedReason ?? '').startsWith('no synthesis:'), degraded.data.degradedReason)
check('recall still answers', degraded.data.recall.hits.length >= 3)

section('empty recall short-circuits without a model call')
const callsBefore = modelCalls
const empty = await ReflectTool.call({ query: 'zebra-nonsense-query-xyz' } as never, context)
check('recall-only with the empty reason', empty.data.mode === 'recall-only' && (empty.data.degradedReason ?? '').includes('nothing recalled'), empty.data.degradedReason)
check('NO model call was made', modelCalls === callsBefore, String(modelCalls - callsBefore))
check('flagged elidable', empty.data.recall.elidable === true)

server.close()
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL REFLECT-GROUNDING PROOFS PASS' : `❌ ${failures} REFLECT-GROUNDING PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
