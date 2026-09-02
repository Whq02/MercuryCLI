#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a07-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-a07-home-'))

const ROOT = join(import.meta.dir, '..', '..')

const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/utils/model/modelTransition.ts'
)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Slice = Parameters<typeof settleModelSelection>[0]
const base = (over: Partial<Slice> = {}): Slice => ({
  mainLoopModel: 'claude-opus-5',
  mainLoopModelForSession: null,
  pendingModelSwitch: null,
  ...over,
})
const apply = (s: Slice, patch: Partial<Slice> | null): Slice => ({ ...s, ...(patch ?? {}) })

section('§A repeat-confirm applies once — the original receipt stands')
{
  let state = base()
  const first = settleModelSelection(state, 'claude-sonnet-5', { turnActive: false })
  check('first confirm applies with a receipt', first.kind === 'applied' && first.receipt !== null)
  state = apply(state, first.patch)
  const second = settleModelSelection(state, 'claude-sonnet-5', { turnActive: false })
  check('second identical confirm is a plain no-op (null patch, no receipt)', second.kind === 'no-op' && second.patch === null && second.receipt === null)
  state = apply(state, second.patch)
  check(
    'the ORIGINAL receipt stands untouched',
    state.lastModelTransition === (first.kind === 'applied' ? first.receipt : null),
  )
  check('the model applied exactly once', state.mainLoopModel === 'claude-sonnet-5')
}

section('§B a queued switch settles exactly once at the boundary')
{
  let state = base()
  const queued = settleModelSelection(state, 'gpt-5.2', { turnActive: true })
  check('mid-turn pick parks (no receipt yet — nothing applied)', queued.kind === 'queued' && queued.receipt === null)
  state = apply(state, queued.patch)
  check('the pending slot holds the choice', state.pendingModelSwitch?.setting === 'gpt-5.2')
  const boundary = settlePendingAtBoundary(state, {})
  check('the boundary applies with ONE turn-boundary receipt', boundary !== null && boundary.receipt.resolution === 'applied' && boundary.receipt.boundary === 'turn-boundary' && boundary.receipt.crossProvider === true)
  state = apply(state, boundary?.patch ?? null)
  check('applied + pending cleared in the same patch', state.mainLoopModel === 'gpt-5.2' && state.pendingModelSwitch === null)
  const again = settlePendingAtBoundary(state, {})
  check('a second boundary pass finds NOTHING to apply', again === null)
}

section('§C crash before the boundary — the pending slot is in-memory only')
{
  const fresh = getDefaultAppState() as unknown as Slice
  check('a fresh boot carries no pending switch', fresh.pendingModelSwitch === null || fresh.pendingModelSwitch === undefined)
  let hits: string[] = []
  try {
    hits = execFileSync(
      'git',
      ['grep', '-l', 'pendingModelSwitch', '--', 'src/utils/sessionStorage/'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    hits = []
  }
  check('the persistence estate never references pendingModelSwitch', hits.length === 0, hits.join(' · '))
}

section('§D crash after apply — the applied patch is one atomic object')
{
  const state = base()
  const applied = settleModelSelection(state, 'claude-sonnet-5', { turnActive: false })
  const patch = applied.kind === 'applied' ? applied.patch : null
  check(
    'model + pending-cleared + receipt move in ONE patch (no strandable half-state)',
    patch !== null &&
      'mainLoopModel' in patch &&
      'pendingModelSwitch' in patch &&
      patch.pendingModelSwitch === null &&
      'lastModelTransition' in patch,
    JSON.stringify(Object.keys(patch ?? {})),
  )
}

section('§E cancelled-pending mints exactly one receipt')
{
  let state = base({ pendingModelSwitch: { setting: 'gpt-5.2' } })
  const cancel = settleModelSelection(state, 'claude-opus-5', { turnActive: false })
  check('re-picking the current model resolves the parked switch with a receipt', cancel.kind === 'cancelled-pending' && cancel.receipt?.resolution === 'cancelled-pending')
  state = apply(state, cancel.patch)
  const repeat = settleModelSelection(state, 'claude-opus-5', { turnActive: false })
  check('repeating is a plain no-op — no second cancellation receipt', repeat.kind === 'no-op' && repeat.receipt === null)
}

console.log(failures === 0 ? '\n ✅ SETTLEMENT IS IDEMPOTENT (repeat · boundary · crash · cancel)' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
