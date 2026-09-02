#!/usr/bin/env bun
// ============================================================================
//  prove-prompt-input-paste-prune — F1/F3: the orphan-prune data-loss
//  regressions the closing verify wave confirmed (both introduced by the
//  prune generalization, both fixed at root):
//
//    A. PASTE SURVIVAL (PTY, built artifact): a large input folds into a
//       text chip whose paste entry must survive the generalized prune all
//       the way into the durable draft (placeholder AND content). The
//       truncate-path variant of the bug (entry destroyed in the SAME
//       effect flush that created it — the placeholder then submitted
//       literally) is pinned by the structural live-read lock in leg C.
//
//    B. QUEUE POP-BACK (module): popAllEditable collected images ONLY —
//       after the generalized prune deleted live entries at enqueue, a
//       popped-back [Pasted text #N] placeholder had no backing content.
//       ALL paste types must restore under their ORIGINAL ids.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-prune-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// ── B (module, fast): pop-back restores EVERY paste type by original id ─────
{
  const { enqueue, popAllEditable, resetCommandQueue } = await import('../../src/input-core/command-queue.ts')
  resetCommandQueue()
  enqueue({
    value: 'analyze [Pasted text #7 +12 lines] and [Image #3]',
    mode: 'prompt',
    pastedContents: {
      7: { id: 7, type: 'text', content: 'line1\nline2\nthe 500-line log body' },
      3: { id: 3, type: 'image', content: 'aGk=', mediaType: 'image/png' },
    } as never,
  })
  const popped = popAllEditable('', 0)
  t('B: pop-back returns the queued text with placeholders', !!popped && popped.text.includes('[Pasted text #7 +12 lines]'))
  const byId = new Map((popped?.images ?? []).map(p => [p.id, p]))
  t('B: the TEXT paste restores under its original id', byId.get(7)?.type === 'text' && (byId.get(7) as { content?: string })?.content?.includes('500-line log') === true)
  t('B: the image restores too', byId.get(3)?.type === 'image')
  resetCommandQueue()
}

// ── A (PTY, built artifact): paste chip + content survive the prune ────────
const cfg = scenario('resume-2turn', 120, 40)
type Grid = { grid: { c: string }[][] }
const rowsOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

function capture(tag: string, sends: unknown[], total: number): string[] {
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total, cols: 120, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home },
  })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${res.stderr?.slice(-500)}`)
  return rowsOf(JSON.parse(readFileSync(out, 'utf8')) as Grid)
}

try {
  // ~12k of raw newline-free bytes — the owned input layer's burst
  // classifier folds it into a [Pasted text #N] chip (the true truncate
  // path needs per-char typing, PTY-unreachable at sane cost — the
  // live-read lock below pins that fix structurally). The run lasts past
  // the 400ms draft debounce so the durable draft records the outcome:
  // placeholder AND content must both survive the prune.
  const big = 'the quick brown fox jumps over the lazy dog 0123456789 '.repeat(220)
  const rows = capture('trunc', [
    { atTick: 40, data: big, minTick: 30 },
  ], 75)
  const composer = rows.some(r => r.includes('Pasted text') || r.includes('Truncated text'))
  t('A: the paste chip painted', composer)

  const draftsDir = join(home, 'drafts')
  const file = readdirSync(draftsDir).find(f => f.endsWith('.json'))
  t('A: a durable draft persisted', !!file)
  if (file) {
    const parsed = JSON.parse(readFileSync(join(draftsDir, file), 'utf8')) as Record<string, { text?: string; pastedContents?: Record<string, { type?: string; content?: string }> }>
    const entry = Object.values(parsed).find(v => typeof v?.text === 'string' && (v.text.includes('Pasted text') || v.text.includes('Truncated text')))
    t('A: the draft text carries the placeholder', !!entry)
    const paste = entry ? Object.values(entry.pastedContents ?? {})[0] : undefined
    t('A: the paste CONTENT survived the prune into the durable draft',
      paste?.type === 'text' && (paste.content?.includes('quick brown fox') ?? false),
      paste ? `type=${paste.type} len=${paste.content?.length ?? 0}` : 'no paste entry — pruned')
  }

  // ── C (structural lock): the prune reads LIVE module text ────────────────
  // The truncate-path fix: the prune effect must derive referencedIds from
  // pendingInput.text(), never its render-snapshot closure — the snapshot
  // form destroyed the truncation paste in the SAME flush that created it.
  const promptSrc = readFileSync(join(import.meta.dir, '../../src/components/PromptInput/PromptInput.tsx'), 'utf8')
  // The id allocator's taken-set reads the LIVE pending text (never a render
  // snapshot), so a reference that exists only in the live draft is never
  // re-minted and its stored body never pruned under it.
  const pruneIdx = promptSrc.indexOf('for (const ref of parseReferences(pendingInput.text())) taken.add(ref.id)')
  const pruneBody = promptSrc.slice(Math.max(0, pruneIdx - 160), pruneIdx + 120)
  t('C: the prune derives from pendingInput.text(), not the render snapshot',
    pruneIdx >= 0 && pruneBody.includes('Object.keys(pendingInput.pastedContents()).map(Number)'), pruneBody.slice(0, 80))
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ kinetic paste-prune law holds' : '❌ kinetic paste-prune BROKEN')
process.exit(failures)
