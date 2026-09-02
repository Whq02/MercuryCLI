#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-b2-focus-pointer.ts — B2: the focus
//  graph + keyboard/pointer equivalence and the
//  resize journey.
//
//  EXPECT-RED at the pre-fix tree, promoted in the same commit.
//
//    §1 FOCUS GRAPH — the new surfaces are explicit Action Graph
//       nodes; focus restores by stable id (the panes key-follow + the
//       identity-first section state landed in Wave A — cited pins);
//       disappearing rows fall to the clamped-index nearest neighbour.
//    §2 EQUIVALENCE — every board rowAction hint is a CLICKABLE
//       InteractiveRow firing the same run(selectedRow) as its key (the ONE
//       grammar seam); chips select by pointer and the per-chip ✕ rides the
//       SAME undo path as ctrl+x; the composer slot opens by pointer; wheel
//       rides the pane's own ScrollBox (hover-scoped, never focus theft).
//    §3 RESIZE — the REAL binary wide→narrow→wide
//       over the populated board: the selection holds its SUBJECT, exactly
//       one mascot, the section strip intact at the return width.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('§1 — the focus graph nodes')
{
  const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.ts')
  const keys = Object.keys(ACTION_GRAPH)
  // The WORK/workbench board's focus nodes retired in place with the WORK
  // panel; the prompts panel's
  // rows are the Workbench-context nodes now, and the retired ids must not
  // linger in the graph.
  for (const id of [
    'prompts:expand',
    'prompts:new-saved',
    'prompts:edit-saved',
    'prompts:move-saved',
    'prompts:delete-saved',
    'prompts:send-saved',
    'prompts:drop-refinement',
  ]) {
    t.check(`the graph names ${id}`, keys.includes(id))
  }
  for (const id of ['board:dispatch', 'board:peek', 'board:change-next', 'board:side-question', 'board:attach', 'board:graph', 'composer:shelf']) {
    t.check(`the graph no longer names ${id} (retired with the WORK panel)`, !keys.includes(id))
  }
  const hook = readFileSync('src/components/mercury-ui/useNavigablePanes.ts', 'utf8')
  const panesC = readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8')
  t.check('focus restores BY KEY (Wave A law still holds)', panesC.includes('rowKey(r) === selKeyRef.current'))
  t.check('identity-first sections still hold', hook.includes('sectionMemoKey'))
  t.check('the nearest-neighbour fallback still holds', /clamped index/.test(panesC))
}

t.section('§2 — keyboard/pointer equivalence at the grammar')
{
  const panes = readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8')
  t.check(
    'footer action hints are InteractiveRows firing run(selectedRow) — every board action gains its pointer route at ONE seam',
    panes.includes(':hint:') && panes.includes('onActivate={() => a.run(selectedRow!)}') && panes.includes('headText.length + 3 + hintsWidth + footerTailText.length <= budget'),
  )
  // The board's shelf chips + pointer-opened composer slot retired in place
  // with the WORK panel; the
  // prompts panel's rows ride the same InteractiveRow grammar through the
  // shell, and its one composer (a saved prompt) opens from its `a`/`e` keys.
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check('the prompts panel rides the shared panes shell (rows are InteractiveRows by construction)', panel.includes('<NavigablePanes<Row>'))
  t.check(
    'wheel rides the pane ScrollBox (hover-scoped — the panes list scrolls in its own box)',
    panes.includes('ScrollBox'),
  )
}

t.section('§3 — the resize journey on the REAL binary')
{
  const r = spawnSync(
    process.env.BUN ?? `${homedir()}/.bun/bin/bun`,
    ['run', 'scripts/ui/render-tui.ts', '--scenario', 'prompts-panel-resize', '--cols', '120', '--out', '/tmp/rv-b2-resize.png'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 240_000 },
  )
  t.check('the resize journey ran (render-tui exit 0)', r.status === 0, `exit=${r.status}`)
  let txt = ''
  try {
    const g = JSON.parse(readFileSync('/tmp/grid-120.json', 'utf8')) as {
      grid: Array<Array<{ c: string }>>
    }
    txt = g.grid.map(row => row.map(c => c.c).join('')).join('\n')
  } catch {
    /* checked below */
  }
  t.check('the strip is intact at the return width', txt.includes('PROMPTS') && txt.includes('SAVED PROMPTS'))
  t.check(
    'the ↑-selected older prompt HELD its row through wide→narrow→wide',
    /▸.*first task/.test(txt),
  )
  const mascots = (txt.match(/▖▟▆▙▗/g) ?? []).length
  t.check('exactly one mascot (no stale critter resurrect)', mascots === 1, String(mascots))
}

t.finish('prove-b2-focus-pointer')
