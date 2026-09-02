#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/prove-minerva-flow.ts
//  PROOF: the MINERVA FLOW (operator-designed, COORDKEYS item 4) — a
//  refinement that lands is USABLE in one gesture.
//
//   §1 the durable feed (minervaRefinedStore): per-project, newest at the
//      bottom, identical-tail dedupe, the cap trims the oldest, remove
//      works, the live snapshot follows writes.
//   §2 the chat leg LANDS the feed: a refine op through
//      applyMinervaChatPlan also lands a MINERVA row (source 'chat',
//      noteRef carried) — fire-and-forget beside the journal truth.
//   §3 every door writes the feed (source pins): the boot pass (source
//      'boot', projectPath threaded from the boot trigger), the room
//      (source 'room'), and both chat-leg callers thread projectPath.
//   §4 the one gesture: the workbench MINERVA section rows answer s (to
//      the composer) and d (remove); the room's s sends the selected
//      refined prompt and closes onto the composer (nextInput through
//      /tabula); the landing wears the estate's attention ink.
//   §5 the legend truth: 'm to box' is dead everywhere; the room's keys
//      say what they do in plain words; the doc spells the gesture.
//
//  Run:  ~/.bun/bin/bun run scripts/tabula/prove-minerva-flow.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'minerva-flow-proof-'))
process.env.MERCURY_TABULA_DIR = mkdtempSync(join(tmpdir(), 'minerva-flow-tabula-'))

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const settle = (ms = 50): Promise<void> => new Promise(r => setTimeout(r, ms))

const FEED = await import('../../src/utils/savedPrompts/minervaRefinedStore.ts')
const PROJECT = '/tmp/minerva-flow-project'

section('§1 the durable feed — order, dedupe, cap, remove, live snapshot')
{
  const a = await FEED.appendMinervaRefined(PROJECT, { original: 'fix the cache thing', refined: 'Investigate the prompt-cache miss: reproduce one, report file:line.', source: 'room' })
  check('a room refinement lands', a.ok === true)
  const b = await FEED.appendMinervaRefined(PROJECT, { original: 'gate note', refined: 'Drive the gate red-first and report the verdict text.', source: 'chat', noteRef: 'n1' })
  check('a chat refinement lands beside it', b.ok === true)
  const list = await FEED.listMinervaRefined(PROJECT)
  check('newest at the BOTTOM (the receipt-roll law)', list.length === 2 && list[1]?.refined.startsWith('Drive the gate'), JSON.stringify(list.map(e => e.source)))
  check('the noteRef provenance rides the chat row', list[1]?.noteRef === 'n1')
  const dup = await FEED.appendMinervaRefined(PROJECT, { original: 'gate note', refined: 'Drive the gate red-first and report the verdict text.', source: 'chat' })
  const afterDup = await FEED.listMinervaRefined(PROJECT)
  check('an identical tail append is a no-op (a re-asked polish never doubles the shelf)', dup.ok === true && afterDup.length === 2)
  const removed = await FEED.removeMinervaRefined(PROJECT, afterDup[0]!.id)
  check('remove takes exactly the named row', removed.ok === true && (await FEED.listMinervaRefined(PROJECT)).length === 1)
  for (let i = 0; i < FEED.MAX_MINERVA_REFINED + 5; i++) {
    await FEED.appendMinervaRefined(PROJECT, { original: `o${i}`, refined: `refined prompt number ${i}`, source: 'boot' })
  }
  const capped = await FEED.listMinervaRefined(PROJECT)
  check(`the cap holds at ${FEED.MAX_MINERVA_REFINED} and trims the OLDEST`, capped.length === FEED.MAX_MINERVA_REFINED && capped[capped.length - 1]?.refined.endsWith(`number ${FEED.MAX_MINERVA_REFINED + 4}`), String(capped.length))
  let pinged = 0
  const stop = FEED.subscribeMinervaRefined(PROJECT, () => {
    pinged++
  })
  await FEED.appendMinervaRefined(PROJECT, { original: 'live', refined: 'the live snapshot follows writes', source: 'room' })
  await settle(150)
  check('the live snapshot follows writes (subscribe fired)', pinged > 0 && (FEED.getMinervaRefinedSnapshot(PROJECT)?.length ?? 0) > 0, String(pinged))
  stop()
}

section('§2 the chat leg lands the feed (source chat, beside the journal)')
{
  const { appendEvents, readNotes } = await import('../../src/utils/tabula/tabulaStore.ts')
  const { applyMinervaChatPlan } = await import('../../src/utils/tabula/minerva.ts')
  const dir = join(process.env.MERCURY_TABULA_DIR!, 'chat-leg')
  appendEvents(dir, [{ t: new Date().toISOString(), op: 'add', id: 'note-1', text: 'look into the flaky prover' }])
  const live = readNotes(dir)
  check('the seed note stands', live.notes.length === 1)
  const project2 = '/tmp/minerva-flow-project-chat'
  const applied = applyMinervaChatPlan(dir, 'proj', {
    ops: [{ op: 'refine', id: 'note-1', refinedText: 'Reproduce the flaky prover red, bisect the cause, report file:line plus the fix.' }],
    reply: 'refined 1',
  }, project2)
  check('the plan applies (journal truth first)', applied.ok === true && applied.refined === 1, JSON.stringify(applied))
  await settle(250)
  const feed = await FEED.listMinervaRefined(project2)
  check('the refine ALSO landed one MINERVA feed row (fire-and-forget)', feed.length === 1, String(feed.length))
  check("…source 'chat', noteRef carried, original kept verbatim", feed[0]?.source === 'chat' && feed[0]?.noteRef === 'note-1' && feed[0]?.original === 'look into the flaky prover', JSON.stringify(feed[0]))
}

section('§3 every door writes the feed (source pins)')
{
  const minerva = read('src/utils/tabula/minerva.ts')
  check("the boot pass lands rows (source: 'boot')", minerva.includes("source: 'boot'"))
  check('the boot trigger threads the project path', minerva.includes('runMinervaOnce(dir, projectName, { projectPath: cwd })'))
  const room = read('src/utils/tabula/minervaRoom.ts')
  check("the room lands rows (source: 'room') beside refineSavedPrompt", room.includes("source: 'room'"))
  const promptInput = read('src/components/PromptInput/PromptInput.tsx')
  check('the rail REPL caller threads projectPath', promptInput.includes('projectPath: originalCwd'))
  const cmd = read('src/commands/tabula/minerva.ts')
  check('the /minerva command threads projectPath', cmd.includes('projectPath: cwd'))
}

section('§4 the one gesture — the panel and the room')
{
  const panel = read('src/components/prompts-panel/PromptsPanel.tsx')
  check("the workbench has the MINERVA section (label 'MINERVA')", panel.includes("label: 'MINERVA'"))
  check('the s verb covers minerva rows (the descend)', panel.includes("row.kind === 'saved' || row.kind === 'minerva'") && panel.includes('onClose(row.entry.refined)'))
  check('the d verb removes a feed row behind its confirm', panel.includes('removeMinervaRefined(project, row.entry.id)'))
  check('the landing wears the attention ink (sparkBright on the row mark)', panel.includes('GLYPH.sparkBright') && panel.includes('refined prompt — s sends it to the composer'))
  const roomSrc = read('src/components/tabula/MinervaRoom.tsx')
  check("the room's s key sends the refined prompt (closes onto the composer)", roomSrc.includes("_input === 's'") && roomSrc.includes('onClose(d.refinedText)'))
  check('a bare row says what is missing instead of dying silent', roomSrc.includes('no refinement beside this prompt yet'))
  check('the selected refined row advertises the gesture in accent ink', roomSrc.includes('s sends this refined prompt to the composer'))
  const tabulaCmd = read('src/commands/tabula/tabula.tsx')
  check('/tabula forwards nextInput to the composer (never auto-submitted)', tabulaCmd.includes('nextInput') && tabulaCmd.includes("display: 'skip', nextInput"))
  const rail = read('src/components/HelmLanesRail.tsx')
  check('the rail receipt advertises the HOME truthfully (no key the rail lacks)', rail.includes('/workbench MINERVA sends it'))
}

section("§5 the legend truth — plain words, 'm to box' is dead")
{
  const { execSync } = await import('node:child_process')
  let hits = ''
  try {
    hits = execSync("grep -rn 'm to box' src docs 2>/dev/null || true", { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    hits = ''
  }
  check("'m to box' appears NOWHERE in src or docs", hits === '', hits.slice(0, 200))
  const roomSrc = read('src/components/tabula/MinervaRoom.tsx')
  check('the room footer names each key destination in plain words', roomSrc.includes('m edit in message box') && roomSrc.includes('tab message box') && roomSrc.includes('s send refined to composer'))
  check('the box footer speaks plainly too', roomSrc.includes('send to minerva') && roomSrc.includes('tab prompt list'))
  const doc = read('docs/TABULA-NOTES.md')
  check('the doc spells the gesture and the MINERVA tab', doc.includes('MINERVA') && doc.includes('puts the refined text in the main composer'))
}

console.log('')
if (failures > 0) {
  console.log(`prove-minerva-flow: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('prove-minerva-flow: all checks passed')
