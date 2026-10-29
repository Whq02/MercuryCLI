#!/usr/bin/env bun
// gate-watch: src/tools/MemoryTools/MemoryTools.ts src/tools/MemoryTools/ruleCard.ts src/mneme/memoryVerbs.ts src/tools/MemoryTools/UI.tsx
// gate-watch: src/components/permissions/MemoryRulePermissionRequest/MemoryRulePermissionRequest.tsx src/components/permissions/PermissionRequest.tsx
// gate-watch: scripts/streaming/artifactArena.ts scripts/lib/fixtureApi.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { grabScreens, requireDist, runArtifactArena, sendStamp, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()
const frameDir = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : undefined
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const COLS = 110
const ROWS = 40
const RULE = 'end every reply with the word Fairwinds'
const PROMPT = `remember this as a standing rule, ${RULE}, then drop it again`
const turns: ScriptedTurn[] = [
  { kind: 'tool_use', preText: 'Pinning it.\n', name: 'Retain', input: { items: [{ content: RULE, pin: true }] } },
  { kind: 'tool_use', preText: 'Dropping it.\n', name: 'Correct', input: { op: 'retract', id: 'seq:1', reason: 'the user said it is not a rule' } },
  { kind: 'text', text: 'Done.' },
]

const libraryOf = (home: string): string | null => {
  const walk = (at: string): string | null => {
    if (!existsSync(at)) return null
    for (const name of readdirSync(at)) {
      const p = join(at, name)
      if (name === 'library' && existsSync(join(p, 'pins.json'))) return p
      if (statSync(p).isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(home)
}
const pinsOf = (lib: string): Array<{ seq: number; asked?: boolean }> => (JSON.parse(readFileSync(join(lib, 'pins.json'), 'utf8')) as { pins?: Array<{ seq: number; asked?: boolean }> }).pins ?? []
const toolResults = (run: ArenaRun): string[] =>
  run.fixture.messageRequests().flatMap(request => {
    const messages = ((request.body as { messages?: Array<{ content?: unknown }> }).messages ?? [])
    return messages.flatMap(message =>
      Array.isArray(message.content)
        ? (message.content as Array<{ type?: string; content?: unknown }>).filter(b => b.type === 'tool_result').map(b => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map(x => x.text ?? '').join('\n') : ''))
        : [],
    )
  })
const cardRows = (rows: string[]): string[] => {
  const start = rows.findIndex(r => r.includes('⦿ Memory rule'))
  if (start === -1) return []
  const end = rows.findIndex((r, i) => i > start && /^\s*╰/.test(r))
  return rows.slice(start, end === -1 ? rows.length : end + 1).map(r => r.replace(/\s+$/, ''))
}

for (const scene of [
  { id: 'yes', key: '1', row: 'retract seq 1 →', said: 'The user said yes on the card' },
  { id: 'no', key: '2', row: 'rule kept you kept the rule; nothing changed', said: 'the user kept the rule' },
]) {
  section(`§ the real cockpit: the model pins a rule the user asked for, then asks to drop it — the card paints with the rule's words verbatim and ${scene.id === 'yes' ? 'Yes drops it' : 'No keeps it'}`)
  const run = await runArtifactArena({
    cols: COLS,
    rows: ROWS,
    turns,
    sends: ['after:Type a prompt:300:' + PROMPT, `after:${PROMPT}:400:\\r`, `after:No, keep the rule:1500:${scene.key}`],
    seconds: 30,
    keep: true,
  })
  const answer = run.sendLog.find(s => Buffer.from((s as { b64?: string }).b64 ?? '', 'base64').toString('latin1') === scene.key)
  check(`${scene.id}: the card painted and was answered with ${scene.key}`, answer !== undefined, run.driverOut.slice(-400))
  if (answer !== undefined) {
    const [atCard] = grabScreens(run, COLS, ROWS, [Math.max(0, sendStamp(run, answer) - 80)])
    const card = cardRows(atCard!.rows)
    if (frameDir) writeFileSync(join(frameDir, `rule-card-drive-${scene.id}.txt`), `${atCard!.rows.map(r => r.replace(/\s+$/, '')).join('\n')}\n`)
    const joined = card.join('\n')
    check(`${scene.id}: the card is the memory card, titled Memory rule`, joined.includes('⦿ Memory rule'), atCard!.rows.join('\n').slice(-1800))
    check(`${scene.id}: the card shows the rule's words verbatim`, joined.includes(`seq 1: "${RULE}"`), joined)
    check(`${scene.id}: the card says what will happen and gives Mercury's reason as Mercury's`, joined.includes('It will be unpinned and struck; its wording is kept in history.') && joined.includes("Mercury's reason: the user said it is not a rule"), joined)
    check(`${scene.id}: the card offers exactly Yes and No, keep the rule`, joined.includes('1. Yes') && joined.includes('2. No, keep the rule') && !joined.includes('3.') && !joined.includes("don't ask again"), joined)
  }
  const [final] = grabScreens(run, COLS, ROWS, [-1])
  const rows = final!.rows.map(r => r.replace(/\s+$/, ''))
  if (frameDir) writeFileSync(join(frameDir, `rule-card-drive-${scene.id}-final.txt`), `${rows.join('\n')}\n`)
  check(`${scene.id}: the turn went on to its end (the answer never interrupted it)`, rows.some(r => r.includes('Done.')), rows.slice(-14).join('\n'))
  check(`${scene.id}: the transcript row reads "${scene.row}"`, rows.some(r => r.includes(scene.row)), rows.filter(r => r.includes('retract') || r.includes('kept')).join(' | ') || rows.slice(-14).join('\n'))
  if (scene.id === 'no') check('no: the kept answer is never drawn as an error row', !rows.some(r => r.includes('▲ Error') && r.includes('kept')), rows.filter(r => r.includes('▲')).join(' | '))
  check(`${scene.id}: the model was told: ${scene.said}`, toolResults(run).some(r => r.includes(scene.said)), toolResults(run).join(' | ').slice(0, 900))
  const lib = libraryOf(run.paths.home)
  const pinned = lib === null ? [] : pinsOf(lib)
  if (scene.id === 'yes') check('yes: the rule left the shelf', lib !== null && !pinned.some(p => p.seq === 1), JSON.stringify(pinned))
  else check('no: the rule is still pinned and asked for by the user', lib !== null && pinned.some(p => p.seq === 1 && p.asked === true), JSON.stringify(pinned))
  run.cleanup()
}

console.log(`\nmemory rule card drive: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
