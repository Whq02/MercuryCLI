#!/usr/bin/env bun
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
  check(
    'checkpointing-off still reaches the card when the timeline is wired',
    selectorSrc.includes(
      'onViewOnly !== undefined || onRerun !== undefined || onBranchCreated !== undefined',
    ) && selectorSrc.includes('if (!historyOn && !anyTimelineAction)'),
  )
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
  check('the view arm calls the Chat callback and closes — nothing else', viewArm.includes('onViewOnly?.()') && viewArm.includes('close()'))
  for (const forbidden of ['onPreRestore', 'onRestoreMessage', 'onRestoreCode', 'onSummarize', 'setRestoring(true)']) {
    check(`the view arm never touches ${forbidden}`, !viewArm.includes(forbidden))
  }
  const { openTranscriptPart } = await import('../ui/chatScenarios.ts')
  const { conversationIdHere } = await import('../../src/services/engine-connector/focusedConnector.js')
  const view = await openTranscriptPart('b07-view-flip', { keepHome: true })
  const rows = view.rowsOf(4)
  const conversation = conversationIdHere()
  await view.setRows(rows.slice(0, 2))
  await view.act(() => view.part.value().handleEnterTranscript())
  await view.setRows(rows)
  const frozen = view.part.value().transcriptMessages
  check('enter freezes display lengths only', frozen.length === 2 && frozen[0] === rows[0] && frozen[1] === rows[1], `${frozen.length} rows shown of ${rows.length}`)
  await view.act(() => view.part.value().handleExitTranscript())
  check('exit clears the frozen state (projection-only return)', view.part.value().transcriptMessages === rows)
  check('enter/exit never touch the rows of the session', rows.length === 4 && view.touched.length === 0, `${rows.length} rows · ${view.touched.join(',')}`)
  check('enter/exit never touch the conversation id', conversationIdHere() === conversation, `${conversation} → ${conversationIdHere()}`)
  await view.close()
}

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

const selectorRun = await (async () => {
  const { openSelectorPart } = await import('../ui/chatScenarios.ts')
  const { conversationIdHere } = await import('../../src/services/engine-connector/focusedConnector.js')
  const { readdirSync } = await import('node:fs')
  const selector = await openSelectorPart('b07-selector', { keepHome: true })
  const sessionRows = [{ type: 'user', uuid: '00000000-0000-4000-8000-000000000005', message: { role: 'user', content: 'turn 5' } }] as never[]
  selector.session.records = sessionRows
  selector.session.transcriptFile = SRC
  const conversation = conversationIdHere()
  const bytes = sha(readFileSync(SRC))
  const beside = readdirSync(HOME, { recursive: true }).length
  selector.selector().onViewOnly()
  const view = {
    calls: selector.calls.splice(0),
    notices: selector.notices.splice(0),
    asked: selector.session.calls.splice(0),
    rowsKept: selector.session.records === sessionRows && sessionRows.length === 1,
    conversationKept: conversationIdHere() === conversation,
    bytesKept: sha(readFileSync(SRC)) === bytes,
    filesAdded: readdirSync(HOME, { recursive: true }).length - beside,
    resumes: selector.resumes.length,
  }
  await selector.plant({ isLoadingRef: { current: true } })
  const midRun = await selector.selector().onRerun(sessionRows[0]!)
  const midRunResumes = selector.resumes.length
  await selector.plant({ isLoadingRef: { current: false } })
  const outcome = await selector.selector().onRerun(sessionRows[0]!)
  const [branchId, branchLog, entrypoint] = (selector.resumes[0] ?? []) as [string | undefined, { fullPath?: string } | undefined, string | undefined]
  const branchEntries = branchLog?.fullPath === undefined ? [] : (decodeTranscriptBuffer(readFileSync(branchLog.fullPath)).entries as Array<{ uuid?: string; subtype?: string }>)
  const rerun = { outcome, branchId, entrypoint, branchEntries, calls: selector.calls.splice(0), notices: selector.notices.splice(0), asked: selector.session.calls.splice(0), sourceKept: sha(readFileSync(SRC)) === bytes }
  selector.selector().onBranchCreated({ branchSessionId: 'abcdef0123456789', forkOrdinal: 6 })
  const branchNotices = selector.notices.splice(0)
  await selector.close()
  return { view, midRun, midRunResumes, rerun, branchNotices }
})()

section('§B B04 — the screen\'s view-only callback, read off its mounted selector part')
{
  const { view } = selectorRun
  check('the Chat callback enters the SAME display path ctrl+o rides', view.calls.slice(0, 3).join(' · ') === 'handleEnterTranscript · setScreen transcript · setShowAllInTranscript true', view.calls.join(' · '))
  check('the Chat view callback never touches the rows of the session (was: never touches setMessages()', view.rowsKept && view.asked.length === 0, `${view.asked.join(',')}`)
  check('the Chat view callback never touches the conversation id (was: never touches setConversationId)', view.conversationKept)
  check('the Chat view callback never touches the transcript file (was: never touches resetSessionFilePointer)', view.bytesKept)
  check('the Chat view callback does nothing but enter the view and close the selector (was: never touches removeTranscriptMessage)', view.calls.slice(3).join(' · ') === 'setShowMessageSelector false · setMessageSelectorPreselect undefined' && view.calls.length === 5, view.calls.join(' · '))
  check('the Chat view callback makes no branch (was: never touches createBranchSession)', view.filesAdded === 0 && view.resumes === 0, `${view.filesAdded} files added · ${view.resumes} resumes`)
}

section('§C B07 — rerun ≠ replay: rewind-branch before the anchor, fork-branch inclusive')
{
  const before = readFileSync(SRC)
  const entries = await readAllTranscriptEntries(SRC)
  const anchorUuid = '00000000-0000-4000-8000-000000000005'
  const idx = entries.findIndex(e => (e as { uuid?: string }).uuid === anchorUuid)
  check('the anchor resolves in the committed ordinal universe', idx >= 1, `idx=${idx}`)

  const rerun = createBranchSession({
    sourceTranscriptPath: SRC,
    forkOrdinal: idx,
    boundaryKind: 'rewind',
    cwd: '/tmp/proj',
    providerOrigin: 'test-model',
  })
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
  const mounted = selectorRun.rerun
  const beforeAnchor = '00000000-0000-4000-8000-000000000004'
  check("Chat rerun branches at forkOrdinal: idx (before the anchor)", mounted.outcome.ok === true && mounted.branchEntries.some(entry => entry.uuid === beforeAnchor) && !mounted.branchEntries.some(entry => entry.uuid === anchorUuid) && mounted.sourceKept, `${JSON.stringify(mounted.outcome)} · ${mounted.branchEntries.length} entries in the branch`)
  check("Chat rerun uses boundaryKind: 'rewind'", mounted.branchEntries.at(-1)?.subtype === 'rewind_boundary', String(mounted.branchEntries.at(-1)?.subtype))
  check("Create-branch covers the anchor: forkOrdinal: ordinal + 1 with boundaryKind: 'fork'", selectorSrc.includes('forkOrdinal: ordinal + 1') && selectorSrc.includes("boundaryKind: 'fork'"))
  check('Chat rerun switches in-process through the ONE resume chokepoint', mounted.entrypoint === 'fork' && typeof mounted.branchId === 'string' && mounted.branchId !== SID, `${String(mounted.branchId)} · ${String(mounted.entrypoint)}`)
  check('Chat rerun stages the resubmit under operator control (no auto-send)', mounted.calls.includes('setInputValue "turn 5"') && mounted.asked.length === 0, `${mounted.calls.join(' · ')} · asked of the session: ${mounted.asked.join(',')}`)
}

section('§D B07 — distinct receipts')
{
  const painted = { 'view-only-history': selectorRun.view.notices, 'branch-created': selectorRun.branchNotices, 'rerun-branch-created': selectorRun.rerun.notices }
  for (const [key, notices] of Object.entries(painted)) check(`receipt key: '${key}'`, notices.length === 1 && notices[0]!.key === key, notices.map(notice => notice.key).join(','))
  check(
    'receipt copy is action-specific',
    (painted['view-only-history'][0]?.text ?? '').includes('nothing changed') &&
      (painted['branch-created'][0]?.text ?? '').startsWith('Branch created:') &&
      (painted['rerun-branch-created'][0]?.text ?? '').startsWith('Branch created:') &&
      (painted['rerun-branch-created'][0]?.text ?? '').includes('prompt staged, Enter reruns'),
    Object.values(painted).map(notices => notices[0]?.text ?? '(none)').join(' | '),
  )
}

section('§E — the rerun guard + the /rewind alias')
{
  check('a mid-run rerun refuses honestly (no switch under a live turn)', selectorRun.midRun.ok === false && selectorRun.midRun.reason === 'a run is in flight — esc to interrupt it first' && selectorRun.midRunResumes === 0, JSON.stringify(selectorRun.midRun))
  const rewindCmd = readFileSync(join(ROOT, 'src/commands/rewind/index.ts'), 'utf8')
  check("the /rewind alias stays", rewindCmd.includes("name: 'rewind'"))
}

console.log(
  failures === 0
    ? '\n ✅ TIMELINE — three distinct actions, projection-only viewing, rerun ≠ replay'
    : `\n ❌ TIMELINE — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
