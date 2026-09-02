#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-side-branch.ts — A4: side-branch
//  parentage end-to-end.
//
//  EXPECT-RED at the pre-fix tree, promoted in the same commit.
//
//    §1 the console STORE records parentage: an ask whose runner echoes
//       originRef settles onto the history entry (the owner's own record).
//    §2 the /console command strips a machine-built --origin flag and
//       threads it to the ask engine (never displayed as question text).
//    §3 toContextItem round-trips a parented result; an empty response
//       never attaches.
//    §4 the surface is bound: the Action Graph names board:side-question.
// ============================================================================
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

// M6 made the ask lifecycle mint conversation records — this
// proof world owns its store home (the ambient-state law; unscratched, these
// asks land in the OPERATOR'S real crew inbox — the wave-B finding).
{
  const home = mkdtempSync(join(tmpdir(), 'side-branch-home-'))
  process.env.MERCURY_CONFIG_DIR = home
}

const t = checker()
const H = await import('../../src/utils/cockpit/helmConsole.ts')
const SQ = await import('../../src/utils/sideQuestion.ts')

t.section('§1 — the console store records parentage')
{
  const ok = H.consoleAsk('what changed?', async () => ({
    response: 'the tail moved',
    originRef: 'at:thread:task-9',
  }))
  t.check('(rig) the ask started', ok === true)
  await new Promise(res => setTimeout(res, 10))
  const e = [...H.getConsoleEntries()].reverse().find(x => x.question === 'what changed?')
  t.check(
    'the settled entry carries the originRef (the owner record of parentage)',
    e !== undefined && e.originRef === 'at:thread:task-9' && e.answer === 'the tail moved',
    e ? `${e.originRef ?? 'absent'}` : 'no entry',
  )
}

t.section('§2 — the /console command threads the flag')
{
  const src = readFileSync('src/commands/console/console.tsx', 'utf8')
  t.check(
    'the command strips a leading --origin=<ref> and passes originRef to the engine',
    src.includes('--origin=') && src.includes('originRef'),
  )
}

t.section('§3 — attachable results')
{
  const item = (SQ as Record<string, (r: unknown, at: number) => unknown>).toContextItem?.(
    { response: 'answer', usage: {} as never, originRef: 'board', question: 'q?' },
    123,
  ) as { kind: string; originRef?: string; atMs: number } | null
  t.check(
    'a parented result becomes a typed context item',
    item !== null && item!.kind === 'side-question' && item!.originRef === 'board' && item!.atMs === 123,
  )
  const empty = (SQ as Record<string, (r: unknown, at: number) => unknown>).toContextItem?.(
    { response: '  ', usage: {} as never },
    1,
  )
  t.check('an empty response never attaches', empty === null)
}

t.section('§4 — the surface is bound')
{
  // The WORK board retired in place,
  // so no board:* node names the side question any more; the
  // typed kind survives at its owner — the attention contract — and the
  // Action Graph carries no retired board node.
  const contracts = readFileSync('src/services/attention/contracts.ts', 'utf8')
  t.check("the attention contract names the 'side-question' kind", /['"]side-question['"]/.test(contracts))
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check("the Action Graph carries no retired 'board:side-question' node", !/['"]board:side-question['"]/.test(ag))
}

t.finish('prove-side-branch')
