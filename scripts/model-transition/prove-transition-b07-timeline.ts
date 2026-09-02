#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-b07-timeline.ts —
//  the timeline actions.
//
//    §A — View only · Create branch · Rerun from here are THREE distinct
//       actions on the confirm card, each gated on its REPL callback, each
//       reachable even with checkpointing off (the timeline is not a
//       fileHistory privilege)
//    §B — the View-only path is projection-only: the selector arm and
//       the REPL callback touch ONLY display state (screen mode · show-all ·
//       the frozen-length/scroll capture); enter and exit are symmetric
//    §C — rerun semantics on the REAL branch owner: rewind-branch at the
//       ordinal BEFORE the anchor (the message re-runs live, never replays),
//       fork-branch at the inclusive ordinal — distinct heads from the same
//       anchor, both sources byte-identical after, both identities new
//    §D — the three receipts are distinct (keys + texts pairwise)
//    §E — the rerun guard refuses mid-run; the /rewind alias stays
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-b07-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')
const { readAllTranscriptEntries } = await import('../../src/utils/sessionStorage/materialize.js')
const { createBranchSession } = await import('../../src/services/branches/branchManifest.js')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

const ROOT = join(import.meta.dir, '../..')
const selectorSrc = readFileSync(join(ROOT, 'src/components/MessageSelector.tsx'), 'utf8')
const replSrc = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')

/** The text of a block between two unique anchors (both must exist). */
function between(src: string, from: string, to: string, name: string): string {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  if (a === -1 || b === -1) {
    check(`${name}: anchors present`, false, `from=${a} to=${b}`)
    return ''
  }
  return src.slice(a, b)
}

section('§A B07 — three distinct actions on the confirm card')
{
  check(
    "the option union carries 'view' | 'branch' | 'rerun'",
    selectorSrc.includes("value: 'view'") &&
      selectorSrc.includes("value: 'branch'") &&
      selectorSrc.includes("value: 'rerun'"),
  )
  for (const [value, label] of [
    ['view', 'View history read-only (nothing is mutated)'],
    ['branch', 'Create a branch session from here (this one is untouched)'],
    ['rerun', 'Rerun from here on a new branch (this session is untouched)'],
  ] as const) {
    check(`'${value}' row present with its distinct label`, selectorSrc.includes(label))
  }
  for (const gate of ['if (onViewOnly)', 'if (onBranchCreated)', 'if (onRerun)']) {
    check(`row gated on its callback: ${gate}`, selectorSrc.includes(gate))
  }
  // The timeline is not a fileHistory privilege: the direct-restore shortcut
  // yields to the card whenever any timeline callback is wired.
  check(
    'checkpointing-off still reaches the card when the timeline is wired',
    selectorSrc.includes(
      'onViewOnly !== undefined || onRerun !== undefined || onBranchCreated !== undefined',
    ) && selectorSrc.includes('if (!historyOn && !anyTimelineAction)'),
  )
  // Distinct per-option confirm copy (the description line under the card).
  check(
    'view/branch/rerun each carry distinct confirm copy',
    selectorSrc.includes('Nothing changes — a read-only view of the history.') &&
      selectorSrc.includes('A new branch session is created from this point') &&
      selectorSrc.includes('A new branch reruns this message'),
  )
}

section('§B B04 — the View-only path is projection-only')
{
  const viewArm = between(selectorSrc, "if (value === 'view')", "if (value === 'branch')", 'view arm')
  check('the view arm calls the REPL callback and closes — nothing else', viewArm.includes('onViewOnly?.()') && viewArm.includes('close()'))
  for (const forbidden of ['onPreRestore', 'onRestoreMessage', 'onRestoreCode', 'onSummarize', 'setRestoring(true)']) {
    check(`the view arm never touches ${forbidden}`, !viewArm.includes(forbidden))
  }
  const viewCb = between(replSrc, 'onViewOnly={() =>', 'onRerun={async', 'REPL onViewOnly')
  check(
    'the REPL callback enters the SAME display path ctrl+o rides',
    viewCb.includes('handleEnterTranscript()') &&
      viewCb.includes("setScreen('transcript')") &&
      viewCb.includes('setShowAllInTranscript(true)'),
  )
  for (const forbidden of ['setMessages(', 'setConversationId', 'resetSessionFilePointer', 'removeTranscriptMessage', 'createBranchSession']) {
    check(`the REPL view callback never touches ${forbidden}`, !viewCb.includes(forbidden))
  }
  // Enter/exit symmetry: the frozen display lengths are set on enter and
  // cleared on exit — the view cursor state lives and dies with the view.
  const enterBlock = between(replSrc, 'const handleEnterTranscript', 'const handleExitTranscript', 'enter handler')
  const exitBlock = between(replSrc, 'const handleExitTranscript', 'const globalKeybindingProps', 'exit handler')
  check('enter freezes display lengths only', enterBlock.includes('setFrozenTranscriptState({'))
  check('exit clears the frozen state (projection-only return)', exitBlock.includes('setFrozenTranscriptState(null)'))
  for (const forbidden of ['setMessages(', 'setConversationId']) {
    check(`enter/exit never touch ${forbidden}`, !enterBlock.includes(forbidden) && !exitBlock.includes(forbidden))
  }
}

// ── the synthetic vNext transcript (the WRITER's own encoder) ───────────────
const SID = 'b7b7b7b7-c2c2-d3d3-e4e4-f5f5f5f5f5f5'
const SRC = join(HOME, `${SID}.jsonl`)
const N = 9
{
  let text = ''
  for (let i = 1; i <= N; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant'
    const entry = {
      type: role,
      message:
        role === 'user'
          ? { role, content: `turn ${i}` }
          : { role, content: [{ type: 'text', text: `reply ${i}` }] },
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: new Date(1754000000000 + i * 1000).toISOString(),
      sessionId: SID,
    }
    writeFileSync(SRC, text, { flag: 'w' })
    const enc = encodeTranscriptLine(SRC, entry as never)
    text += enc.line
  }
  writeFileSync(SRC, text)
}

section('§C B07 — rerun ≠ replay: rewind-branch before the anchor, fork-branch inclusive')
{
  const before = readFileSync(SRC)
  const entries = await readAllTranscriptEntries(SRC)
  // The anchor: user message 5 (uuid …005). Header occupies index 0, so the
  // entry index IS the message ordinal here.
  const anchorUuid = '00000000-0000-4000-8000-000000000005'
  const idx = entries.findIndex(e => (e as { uuid?: string }).uuid === anchorUuid)
  check('the anchor resolves in the committed ordinal universe', idx >= 1, `idx=${idx}`)

  // Rerun: the REPL wiring branches at forkOrdinal = idx (STRICTLY BEFORE
  // the anchor — the message re-runs live in the branch, it never replays).
  const rerun = createBranchSession({
    sourceTranscriptPath: SRC,
    forkOrdinal: idx,
    boundaryKind: 'rewind',
    cwd: '/tmp/proj',
    providerOrigin: 'test-model',
  })
  // Create branch: forkOrdinal = idx + 1 (INCLUSIVE of the anchor).
  const fork = createBranchSession({
    sourceTranscriptPath: SRC,
    forkOrdinal: idx + 1,
    boundaryKind: 'fork',
    cwd: '/tmp/proj',
    providerOrigin: 'test-model',
  })
  check('both branch creations succeed', rerun.ok && fork.ok)
  if (rerun.ok && fork.ok) {
    check('the source is byte-identical after BOTH', sha(readFileSync(SRC)) === sha(before))
    check(
      'both identities are NEW and distinct',
      rerun.manifest.branchSessionId !== SID &&
        fork.manifest.branchSessionId !== SID &&
        rerun.manifest.branchSessionId !== fork.manifest.branchSessionId,
    )
    const rerunEntries = decodeTranscriptBuffer(readFileSync(rerun.branchTranscriptPath)).entries as Array<{ uuid?: string; subtype?: string }>
    const forkEntries = decodeTranscriptBuffer(readFileSync(fork.branchTranscriptPath)).entries as Array<{ uuid?: string; subtype?: string }>
    check(
      'the rerun branch EXCLUDES the anchor message',
      !rerunEntries.some(e => e.uuid === anchorUuid),
    )
    check(
      'the stamp branch INCLUDES the anchor message',
      forkEntries.some(e => e.uuid === anchorUuid),
    )
    check(
      'distinct heads from the same anchor (fork = rerun + the anchor)',
      forkEntries.length === rerunEntries.length + 1,
      `fork=${forkEntries.length} rerun=${rerunEntries.length}`,
    )
    check(
      'the rerun branch closes on the rewind boundary',
      rerunEntries.at(-1)?.subtype === 'rewind_boundary',
      String(rerunEntries.at(-1)?.subtype),
    )
    check(
      'the stamp branch closes on the fork boundary',
      forkEntries.at(-1)?.subtype === 'fork_boundary',
      String(forkEntries.at(-1)?.subtype),
    )
    check('the manifests carry their distinct boundary kinds', rerun.manifest.boundaryKind === 'rewind' && fork.manifest.boundaryKind === 'fork')
  }
  // The REPL wiring pins exactly these ordinal semantics.
  const rerunCb = between(replSrc, 'onRerun={async', 'onClose={() =>', 'REPL onRerun')
  check("REPL rerun branches at forkOrdinal: idx (before the anchor)", rerunCb.includes('forkOrdinal: idx,'))
  check("REPL rerun uses boundaryKind: 'rewind'", rerunCb.includes("boundaryKind: 'rewind'"))
  check("Create-branch covers the anchor: forkOrdinal: ordinal + 1 with boundaryKind: 'fork'", selectorSrc.includes('forkOrdinal: ordinal + 1') && selectorSrc.includes("boundaryKind: 'fork'"))
  check('REPL rerun switches in-process through the ONE resume chokepoint', rerunCb.includes("await resume(branchId, branchLog, 'fork')"))
  check('REPL rerun stages the resubmit under operator control (no auto-send)', rerunCb.includes('textForResubmit') && rerunCb.includes('setInputValue') && !rerunCb.includes('onSubmit('))
}

section('§D B07 — distinct receipts')
{
  const keys = ["key: 'view-only-history'", "key: 'branch-created'", "key: 'rerun-branch-created'"]
  for (const k of keys) check(`receipt ${k}`, replSrc.includes(k))
  check(
    'receipt copy is action-specific',
    replSrc.includes('nothing changed') &&
      replSrc.includes('Branch created:') &&
      replSrc.includes('prompt staged, Enter reruns'),
  )
}

section('§E — the rerun guard + the /rewind alias')
{
  const rerunCb = between(replSrc, 'onRerun={async', 'onClose={() =>', 'REPL onRerun')
  check('a mid-run rerun refuses honestly (no switch under a live turn)', rerunCb.includes('if (isLoadingRef.current) return { ok: false as const, reason:'))
  const rewindCmd = readFileSync(join(ROOT, 'src/commands/rewind/index.ts'), 'utf8')
  check("the /rewind alias stays", rewindCmd.includes("name: 'rewind'"))
}

console.log(
  failures === 0
    ? '\n ✅ TIMELINE — three distinct actions, projection-only viewing, rerun ≠ replay'
    : `\n ❌ TIMELINE — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
