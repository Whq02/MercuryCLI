// ============================================================================
//  scripts/sessionStorage/forkedFixture.ts — the heavily forked transcript
//  fixture, written as REAL record JSONL through the writer's own encoder
//  (encodeTranscriptLine): a live main chain of user/assistant turns with a
//  dead fork branch hanging off every Fth live node. Dead rows carry FAT
//  tool results so the dead branches own the byte majority — the shape the
//  dead-branch pruner exists for. Deterministic by construction.
// ============================================================================
import { writeFileSync } from 'node:fs'

export interface ForkedFixture {
  path: string
  sessionId: string
  liveUuids: string[]
  deadUuids: string[]
  liveTailText: string
  bytes: number
}

export async function writeForkedFixture(opts: {
  path: string
  turns: number
  forkEvery: number
  deadPerFork: number
  deadFatBytes: number
}): Promise<ForkedFixture> {
  const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
  const sessionId = 'f0f0f0f0-1111-4000-8000-000000000001'
  let n = 0
  const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
  const ts = (): string => new Date(Date.parse('2026-08-26T00:00:00.000Z') + n * 1000).toISOString()

  const liveUuids: string[] = []
  const deadUuids: string[] = []
  const rows: Record<string, unknown>[] = []
  const base = (uuid: string, parentUuid: string | null): Record<string, unknown> => ({
    uuid,
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: '/tmp/forked-fixture',
    sessionId,
    version: '1.0.0-beta.1',
    timestamp: ts(),
  })
  const userRow = (uuid: string, parent: string | null, text: string): Record<string, unknown> => ({
    ...base(uuid, parent),
    type: 'user',
    message: { role: 'user', content: text },
  })
  const asstRow = (uuid: string, parent: string | null, text: string): Record<string, unknown> => ({
    ...base(uuid, parent),
    type: 'assistant',
    message: {
      id: `msg_${uuid.slice(-6)}`,
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })

  let parent: string | null = null
  let liveTailText = ''
  for (let t = 0; t < opts.turns; t++) {
    const u = uid()
    rows.push(userRow(u, parent, `live turn ${t}: ask`))
    liveUuids.push(u)
    const a = uid()
    liveTailText = `live turn ${t}: reply`
    rows.push(asstRow(a, u, liveTailText))
    liveUuids.push(a)
    parent = a
    if (t % opts.forkEvery === opts.forkEvery - 1 && t < opts.turns - 1) {
      // A dead branch off the live assistant: chained fat rows whose tip no
      // later row ever parents — the rewind/fork residue shape. Never on
      // the FINAL turn: a stranded branch always has live continuation
      // appended after it (that is what makes it dead — the file's
      // physical tail is the live thread).
      let deadParent: string = a
      for (let d = 0; d < opts.deadPerFork; d++) {
        const du = uid()
        rows.push({
          ...base(du, deadParent),
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `toolu_dead_${t}_${d}`,
                content: [{ type: 'text', text: `dead branch ${t}/${d}: ` + 'x'.repeat(opts.deadFatBytes) }],
              },
            ],
          },
        })
        deadUuids.push(du)
        deadParent = du
      }
    }
  }
  // Session metadata sprinkled through the file — the fold must keep it
  // whether it sits between dead rows or live ones.
  rows.splice(Math.floor(rows.length / 3), 0, { type: 'custom-title', customTitle: 'forked odyssey', sessionId })
  rows.splice(Math.floor(rows.length / 2), 0, { type: 'tag', tag: 'pruning', sessionId })
  rows.push({ type: 'summary', summary: 'a forked session', leafUuid: liveUuids[liveUuids.length - 1]! })

  const text = rows.map(r => encodeTranscriptLine(opts.path, r).line).join('')
  writeFileSync(opts.path, text)
  return { path: opts.path, sessionId, liveUuids, deadUuids, liveTailText, bytes: Buffer.byteLength(text) }
}
