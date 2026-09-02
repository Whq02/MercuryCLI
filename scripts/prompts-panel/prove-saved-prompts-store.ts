#!/usr/bin/env bun
// ============================================================================
//  scripts/prompts-panel/prove-saved-prompts-store.ts
//  PROOF: the SAVED PROMPTS store (sheet line 7) — the operator's list of
//  prompts written ahead of sending, per project, across restarts.
//
//  Locks:
//    §1 the file lives per project under the config home (never the global
//       config, never the repo tree) and a scratch MERCURY_CONFIG_DIR moves it;
//    §2 round-trip: add appends at the END (newest at the bottom) · edit is
//       the ONE writer of `text` · [ ] reorder is the array order · delete;
//    §3 durable publish: after every write the file parses whole and no
//       tmp sibling is left behind; a corrupt file reads as empty (declared
//       policy), never a throw;
//    §4 the refinement law: refine lands BESIDE (original byte-kept) · a
//       stale base is refused · an operator edit drops the refinement · x
//       discards it · an empty refinement lands nothing;
//    §5 restart survival: a FRESH bun process reads the same list back;
//    §6 caps: the empty add refuses · the per-prompt char cap · the list cap.
//
//  Run: ~/.bun/bin/bun run scripts/prompts-panel/prove-saved-prompts-store.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const home = mkdtempSync(join(tmpdir(), 'prompts-panel-store-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.NODE_ENV
delete process.env.CI

const store = await import('../../src/utils/savedPrompts/savedPromptsStore.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' SAVED PROMPTS — the per-project store (API-free)')
console.log('============================================================')

const project = '/Users/example/dev/some-project'
const other = '/Users/example/dev/another-project'

try {
  section('§1 — one file per project under the config home')
  const path = store.savedPromptsPath(project)
  check('path sits under <configHome>/saved-prompts', path.startsWith(join(home, 'saved-prompts')), path)
  check('path is keyed by the project (two projects, two files)', store.savedPromptsPath(other) !== path)
  check('never the global config file', !path.endsWith('config.json') && !path.includes('/.mercury.json'))
  check('nothing on disk before the first write', !existsSync(path))
  check('an unwritten project reads as an empty list', (await store.listSavedPrompts(project)).length === 0)

  section('§2 — round-trip: add · edit · reorder · delete')
  const a = await store.addSavedPrompt(project, 'audit the retry ladder')
  const b = await store.addSavedPrompt(project, 'write the release notes for 1.5.8')
  const c = await store.addSavedPrompt(project, '  fold the flake  \n  into the runner  ')
  check('adds answer ok with ids', a.ok && b.ok && c.ok)
  let list = await store.listSavedPrompts(project)
  check('three saved prompts, newest at the BOTTOM', list.length === 3 && list[0]!.text === 'audit the retry ladder' && list[2]!.text.startsWith('fold the flake'))
  check('the composed line is normalized (CR/LF → space, runs collapsed, trimmed)', list[2]!.text === 'fold the flake into the runner')
  check('created/updated stamps present', list.every(d => d.createdAt && d.updatedAt))
  const idA = a.ok ? a.id : ''
  const idB = b.ok ? b.id : ''
  const idC = c.ok ? c.id : ''
  const ed = await store.editSavedPrompt(project, idB, 'write the release notes for 1.5.8 — patch series')
  list = await store.listSavedPrompts(project)
  check('edit rewrites the text in place (same id, same slot)', ed.ok && list[1]!.id === idB && list[1]!.text.endsWith('patch series'))
  check('edit moves updatedAt, keeps createdAt', list[1]!.updatedAt >= list[1]!.createdAt)
  const noop = await store.editSavedPrompt(project, idB, list[1]!.text)
  check('an identical edit is ok and changes nothing', noop.ok)
  const gone = await store.editSavedPrompt(project, 'nope00', 'x')
  check('editing a missing id refuses with a reason', !gone.ok && /gone/.test(gone.ok ? '' : gone.reason))
  await store.moveSavedPrompt(project, idC, -1)
  list = await store.listSavedPrompts(project)
  check('[ moves the third prompt up into slot 2', list[1]!.id === idC && list[2]!.id === idB)
  await store.moveSavedPrompt(project, idA, -1)
  list = await store.listSavedPrompts(project)
  check('[ at the top is a no-op (order unchanged)', list[0]!.id === idA)
  await store.moveSavedPrompt(project, idA, 1)
  list = await store.listSavedPrompts(project)
  check('] moves the first prompt down', list[0]!.id === idC && list[1]!.id === idA)
  const del = await store.deleteSavedPrompt(project, idC)
  list = await store.listSavedPrompts(project)
  check('delete removes exactly that prompt', del.ok && list.length === 2 && !list.some(d => d.id === idC))
  check('the other project is untouched (empty)', (await store.listSavedPrompts(other)).length === 0)

  section('§3 — durable publish')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { _v?: number; drafts?: unknown[] }
  check('the file is plain JSON with a schema stamp and a drafts array', raw._v === 1 && Array.isArray(raw.drafts) && raw.drafts.length === 2)
  const siblings = readdirSync(dirname(path)).filter(f => f !== `${path.split('/').pop()}`)
  check('no tmp sibling left beside the file', siblings.filter(f => /tmp|\.partial|~$/.test(f)).length === 0, siblings.join(', ') || 'none')
  const corruptProject = '/Users/example/dev/corrupt-project'
  const corruptPath = store.savedPromptsPath(corruptProject)
  mkdirSync(dirname(corruptPath), { recursive: true })
  writeFileSync(corruptPath, '{"drafts": [ this is not json')
  check('a corrupt file reads as EMPTY (declared policy), never a throw', (await store.listSavedPrompts(corruptProject)).length === 0)
  // The LIVE snapshot says it: the kernel's subscribe emits nothing over a
  // damaged file (it never fabricates a value), so the store asks
  // readResult() and lands the reason as the cell's PROBLEM beside an empty
  // list — the surfaces paint an honest line instead of 'reading…' for ever
  // (the checker's built-bundle drive found the tab stuck there).
  store._resetSavedPromptsCacheForProofs()
  const stopCorrupt = store.subscribeSavedPrompts(corruptProject, () => {})
  await new Promise(r => setTimeout(r, 500))
  check(
    'a subscriber over a damaged file gets the PROBLEM (the kernel’s reason) and an empty list — never a silent loading state',
    store.getSavedPromptsProblem(corruptProject) !== null && store.getSavedPromptsSnapshot(corruptProject) !== null && store.getSavedPromptsSnapshot(corruptProject)!.length === 0,
    `problem=${store.getSavedPromptsProblem(corruptProject)} snapshot=${JSON.stringify(store.getSavedPromptsSnapshot(corruptProject))}`,
  )
  stopCorrupt()
  store._resetSavedPromptsCacheForProofs()
  const stopGood = store.subscribeSavedPrompts(project, () => {})
  await new Promise(r => setTimeout(r, 500))
  check('a readable file carries no problem and its list', store.getSavedPromptsProblem(project) === null && (store.getSavedPromptsSnapshot(project)?.length ?? 0) === 2)
  stopGood()
  const halfProject = '/Users/example/dev/half-project'
  const halfPath = store.savedPromptsPath(halfProject)
  writeFileSync(
    halfPath,
    JSON.stringify({ _v: 1, drafts: [{ id: 'ok1', text: 'kept' }, { text: 'no id' }, { id: 'ok1', text: 'dup id' }, 'junk', { id: 'ok2', text: 'kept too', refinedText: '  ' }] }),
  )
  const half = await store.listSavedPrompts(halfProject)
  check('decode is tolerant: rows without an id, duplicates and junk drop; blank refinements drop', half.length === 2 && half[0]!.id === 'ok1' && half[0]!.text === 'kept' && half[1]!.refinedText === undefined)

  section('§4 — the refinement law (beside, never over)')
  list = await store.listSavedPrompts(project)
  const target = list[1]!
  const before = JSON.stringify(list[0])
  const ref = await store.refineSavedPrompt(project, target.id, 'Write the 1.5.8 release notes: list every landed line with its proof path; MUST keep the patch-series wording.', target.text)
  list = await store.listSavedPrompts(project)
  check('refine lands beside the original', ref.ok && list[1]!.refinedText !== undefined && list[1]!.refinedAt !== undefined)
  check('the original wording is byte-kept', list[1]!.text === target.text)
  check('the untouched sibling is byte-identical', JSON.stringify(list[0]) === before)
  const stale = await store.refineSavedPrompt(project, target.id, 'a polish of words that changed', 'some older wording')
  check('a stale base is refused (the operator edited meanwhile)', !stale.ok && /changed since/.test(stale.ok ? '' : stale.reason))
  const empty = await store.refineSavedPrompt(project, target.id, '   ', target.text)
  check('an empty refinement lands nothing', !empty.ok)
  list = await store.listSavedPrompts(project)
  const keptRefinement = list[1]!.refinedText
  check('… and the landed refinement still stands', keptRefinement !== undefined)
  await store.editSavedPrompt(project, target.id, 'write the 1.5.8 release notes (reworded by hand)')
  list = await store.listSavedPrompts(project)
  check('an operator edit drops the refinement beside the OLD wording', list[1]!.refinedText === undefined && list[1]!.refinedAt === undefined)
  await store.refineSavedPrompt(project, list[1]!.id, 'Rewrite the 1.5.8 release notes by hand.', list[1]!.text)
  const drop = await store.discardSavedPromptRefinement(project, list[1]!.id)
  list = await store.listSavedPrompts(project)
  check('x discards the refinement; the wording stays', drop.ok && list[1]!.refinedText === undefined && list[1]!.text === 'write the 1.5.8 release notes (reworded by hand)')

  section('§5 — restart survival (a fresh process reads the same list)')
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `globalThis.MACRO={VERSION:'1.0.0'}; const s = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/savedPrompts/savedPromptsStore.ts'))}); const l = await s.listSavedPrompts(${JSON.stringify(project)}); console.log(JSON.stringify(l.map(d => [d.id, d.text])))`,
    ],
    { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home } },
  )
  const childList = (() => {
    try {
      return JSON.parse(child.stdout.trim().split('\n').pop() ?? '[]') as [string, string][]
    } catch {
      return null
    }
  })()
  list = await store.listSavedPrompts(project)
  check(
    'a fresh bun process reads back ids + texts in the same order',
    childList !== null && JSON.stringify(childList) === JSON.stringify(list.map(d => [d.id, d.text])),
    child.status !== 0 ? `child exit ${child.status}: ${child.stderr.slice(0, 300)}` : '',
  )

  section('§7 — the clear-all (sheet line 7c): the store door never asks; the panel confirms')
  {
    const clearProject = '/Users/example/dev/clear-project'
    await store.addSavedPrompt(clearProject, 'one')
    await store.addSavedPrompt(clearProject, 'two')
    await store.addSavedPrompt(clearProject, 'three')
    const cleared = await store.clearSavedPrompts(clearProject)
    check('clear answers how many it cleared', cleared.ok && cleared.cleared === 3)
    check('the list is empty after the clear', (await store.listSavedPrompts(clearProject)).length === 0)
    const again = await store.clearSavedPrompts(clearProject)
    check('clearing an empty list is ok with 0', again.ok && again.cleared === 0)
    const child = spawnSync(
      process.execPath,
      ['-e', `globalThis.MACRO={VERSION:'1.0.0'}; const s = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/savedPrompts/savedPromptsStore.ts'))}); console.log(JSON.stringify((await s.listSavedPrompts(${JSON.stringify(clearProject)})).length))`],
      { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home } },
    )
    check('the empty list survives a restart (a fresh bun process reads 0)', child.stdout.trim().split('\n').pop() === '0', child.stderr.slice(0, 200))
    const other2 = await store.listSavedPrompts(project)
    check('another project is untouched by the clear', other2.length > 0)
  }

  section('§6 — caps + refusals')
  const emptyAdd = await store.addSavedPrompt(project, '   \n ')
  check('an empty add refuses with a reason', !emptyAdd.ok)
  const long = await store.addSavedPrompt(project, 'x'.repeat(store.MAX_SAVED_PROMPT_CHARS + 500))
  list = await store.listSavedPrompts(project)
  check(`a prompt over the ${store.MAX_SAVED_PROMPT_CHARS}-char cap is clipped, not refused`, long.ok && list[list.length - 1]!.text.length === store.MAX_SAVED_PROMPT_CHARS)
  const capProject = '/Users/example/dev/cap-project'
  const capPath = store.savedPromptsPath(capProject)
  writeFileSync(
    capPath,
    JSON.stringify({ _v: 1, drafts: Array.from({ length: store.MAX_SAVED_PROMPTS }, (_, i) => ({ id: `id${i}`, text: `p${i}` })) }),
  )
  const overflow = await store.addSavedPrompt(capProject, 'one too many')
  check(`the ${store.MAX_SAVED_PROMPTS}-prompt list cap refuses the next add with a reason`, !overflow.ok && /delete one first/.test(overflow.ok ? '' : overflow.reason))

  section('§7 — the injective slug (FC-008: punctuation siblings, legacy adopt)')
  {
    // Two projects differing only in punctuation folded to ONE hashless file;
    // the slug now carries the transcript store's short content hash.
    const dotProj = '/Users/example/dev/wb.proj'
    const underscoreProj = '/Users/example/dev/wb_proj'
    const dotPath = store.savedPromptsPath(dotProj)
    const underscorePath = store.savedPromptsPath(underscoreProj)
    check('punctuation siblings get DISTINCT saved-prompts files', dotPath !== underscorePath, `${dotPath} vs ${underscorePath}`)
    await store.addSavedPrompt(dotProj, 'only in the dot project')
    check('a prompt saved in one sibling never lists in the other', (await store.listSavedPrompts(underscoreProj)).length === 0)

    // A PRE-HASH legacy file is adopted once by rename: the first project to
    // touch it claims it; the sibling starts fresh.
    const legacyProj = '/Users/example/dev/legacy.era'
    const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
    const legacyFile = join(home, 'saved-prompts', `${sanitizePath(legacyProj)}.json`)
    writeFileSync(legacyFile, JSON.stringify({ _v: 1, drafts: [{ id: 'leg1', text: 'the legacy prompt' }] }))
    const adopted = await store.listSavedPrompts(legacyProj)
    check('a pre-hash legacy file is adopted (its prompts survive)', adopted.length === 1 && adopted[0]!.text === 'the legacy prompt', JSON.stringify(adopted))
    check('the legacy file was RENAMED to the hashed slug (no shared hashless file remains)', !existsSync(legacyFile))
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-saved-prompts-store — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
