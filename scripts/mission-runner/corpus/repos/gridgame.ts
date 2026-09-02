// ============================================================================
//  corpus repo: gridgame — a small ESM grid/pathfinding/sim library
//  (node --test). grid (tuple coords) · path (A*, 10/14 units, octile
//  heuristic) · rules (initiative/engagement) · sim (round loop, roster-order
//  tie law). Base tree is ALL-GREEN. The path optimality test is
//  SELF-VERIFYING (inline Dijkstra oracle, no magic constants).
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const PACKAGE_JSON = `{
  "name": "gridgame",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`

// ── src/grid.js ─────────────────────────────────────────────────────────────

const GRID_BASE = `// Rectangular grid; coords are [x, y] tuples; blocked cells are a Set of
// 'x,y' keys.
export function key(x, y) {
  return x + ',' + y
}

export function createGrid(width, height, blocked) {
  const cells = (blocked ?? []).map(pair => key(pair[0], pair[1]))
  return { width, height, blocked: new Set(cells) }
}

export function inBounds(grid, x, y) {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height
}

export function isBlocked(grid, x, y) {
  return grid.blocked.has(key(x, y))
}

const DIRS = [
  [1, 0, false],
  [-1, 0, false],
  [0, 1, false],
  [0, -1, false],
  [1, 1, true],
  [1, -1, true],
  [-1, 1, true],
  [-1, -1, true],
]

export function neighbors(grid, x, y) {
  const out = []
  for (const [dx, dy, diagonal] of DIRS) {
    const nx = x + dx
    const ny = y + dy
    if (!inBounds(grid, nx, ny) || isBlocked(grid, nx, ny)) continue
    out.push([nx, ny, diagonal])
  }
  return out
}
`

/** lane defect: inBounds off-by-one on both far edges. */
const GRID_OFF_BY_ONE = GRID_BASE.replace(
  '  return x >= 0 && y >= 0 && x < grid.width && y < grid.height',
  '  return x >= 0 && y >= 0 && x <= grid.width && y <= grid.height',
)

/** reference: opposite-cell geometry joins grid.js. */
const GRID_WITH_OPPOSITE = GRID_BASE + `
// oppositeNeighbor: the cell straight across the defender from the attacker
// (the flanking cell). Pure geometry plus bounds truth: null when the mirror
// cell falls off the grid.
export function oppositeNeighbor(grid, defender, attacker) {
  const ox = 2 * defender[0] - attacker[0]
  const oy = 2 * defender[1] - attacker[1]
  if (!inBounds(grid, ox, oy)) return null
  return [ox, oy]
}
`

/** falsify: no bounds truth — mirror coords leak off-grid. */
const GRID_OPPOSITE_NO_BOUNDS = GRID_BASE + `
export function oppositeNeighbor(grid, defender, attacker) {
  const ox = 2 * defender[0] - attacker[0]
  const oy = 2 * defender[1] - attacker[1]
  return [ox, oy]
}
`

// ── src/path.js ─────────────────────────────────────────────────────────────

const PATH_BASE = `import { key, neighbors } from './grid.js'

// Costs ride 10/14 integer units (orthogonal/diagonal).
export function stepCost(diagonal) {
  return diagonal ? 14 : 10
}

// Octile distance in the same units — admissible for 10/14 grids.
export function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy)
}

// Deterministic A*: array-scan frontier, f then insertion order; a better g
// re-opens a cell (gBest prune, re-push on improvement).
export function findPath(grid, start, goal) {
  const goalKey = key(goal[0], goal[1])
  const startKey = key(start[0], start[1])
  const open = [
    {
      x: start[0],
      y: start[1],
      g: 0,
      f: heuristic(start[0], start[1], goal[0], goal[1]),
      seq: 0,
    },
  ]
  const gBest = new Map([[startKey, 0]])
  const cameFrom = new Map()
  let seq = 1
  while (open.length > 0) {
    let bestAt = 0
    for (let i = 1; i < open.length; i++) {
      const a = open[i]
      const b = open[bestAt]
      if (a.f < b.f || (a.f === b.f && a.seq < b.seq)) bestAt = i
    }
    const current = open.splice(bestAt, 1)[0]
    const currentKey = key(current.x, current.y)
    if (current.g > (gBest.get(currentKey) ?? Infinity)) continue
    if (currentKey === goalKey) {
      const path = [[current.x, current.y]]
      let walk = currentKey
      while (cameFrom.has(walk)) {
        walk = cameFrom.get(walk)
        const parts = walk.split(',')
        path.unshift([Number(parts[0]), Number(parts[1])])
      }
      return { path, cost: current.g }
    }
    for (const [nx, ny, diagonal] of neighbors(grid, current.x, current.y)) {
      const nKey = key(nx, ny)
      const g = current.g + stepCost(diagonal)
      if ((gBest.get(nKey) ?? Infinity) <= g) continue
      gBest.set(nKey, g)
      cameFrom.set(nKey, currentKey)
      open.push({ x: nx, y: ny, g, f: g + heuristic(nx, ny, goal[0], goal[1]), seq })
      seq += 1
    }
  }
  return null
}
`

/** trap defect: inadmissible manhattan heuristic PLUS first-visit-wins
 *  (no re-open) — optimality collapses on detour arenas. */
const PATH_TRAP = PATH_BASE.replace(
  `// Octile distance in the same units — admissible for 10/14 grids.
export function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy)
}`,
  `// Manhattan distance in step units.
export function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return 10 * (dx + dy)
}`,
).replace(
  `      const g = current.g + stepCost(diagonal)
      if ((gBest.get(nKey) ?? Infinity) <= g) continue`,
  `      const g = current.g + stepCost(diagonal)
      if (gBest.has(nKey)) continue`,
)

/** orientation-state defect: diagonal steps cost the same as orthogonal
 *  (no test covers path-length preference — a discovery target). */
const PATH_FLAT_DIAGONAL = PATH_BASE.replace(
  `export function stepCost(diagonal) {
  return diagonal ? 14 : 10
}`,
  `export function stepCost(diagonal) {
  return 10
}`,
)

// ── src/rules.js ────────────────────────────────────────────────────────────

const RULES_BASE = `import { inBounds, isBlocked, key } from './grid.js'

// Engagement rules. Initiative: faster units act first; fatigue slows a unit
// down (tired units act LATER).
export function initiative(unit) {
  return unit.speed * 10 - unit.fatigue
}

export function canEnter(grid, occupied, x, y) {
  if (!inBounds(grid, x, y)) return false
  if (isBlocked(grid, x, y)) return false
  if (occupied.has(key(x, y))) return false
  return true
}

export function attackPower(unit, defender) {
  const advantage = defender.fatigue >= 5 ? 2 : 0
  return unit.power + advantage
}
`

/** tiny defect: fatigue ADDS initiative. */
const RULES_FATIGUE_SIGN = RULES_BASE.replace(
  '  return unit.speed * 10 - unit.fatigue',
  '  return unit.speed * 10 + unit.fatigue',
)

/** lane defect: the occupancy check is absent. */
const RULES_NO_OCCUPANCY = RULES_BASE.replace(
  `  if (!inBounds(grid, x, y)) return false
  if (isBlocked(grid, x, y)) return false
  if (occupied.has(key(x, y))) return false
  return true`,
  `  if (!inBounds(grid, x, y)) return false
  if (isBlocked(grid, x, y)) return false
  return true`,
)

/** reference: flank bonus + best attack cell over the grid geometry. */
const RULES_FLANK = RULES_BASE.replace(
  `import { inBounds, isBlocked, key } from './grid.js'`,
  `import { inBounds, isBlocked, key, oppositeNeighbor } from './grid.js'`,
) + `
// Flanking (FLANK.md): an ally standing on the cell straight across the
// defender from the attacker grants +25% of the attacker's BASE power,
// floored. No opposite cell (edge/corner) means no flank.
export function attackPowerWithFlank(grid, attacker, defender, allies) {
  const base = attackPower(attacker, defender)
  const opposite = oppositeNeighbor(grid, defender.pos, attacker.pos)
  if (!opposite) return base
  const flanked = (allies ?? []).some(
    pos => pos[0] === opposite[0] && pos[1] === opposite[1],
  )
  return flanked ? base + Math.floor(attacker.power / 4) : base
}

// bestAttackCell: among candidate cells, pick the FIRST enterable one that
// maximizes the flank-aware power the attacker would project from it.
export function bestAttackCell(grid, attacker, defender, allies, candidates) {
  let best = null
  let bestPower = -Infinity
  for (const cell of candidates) {
    const occupied = new Set((allies ?? []).map(pos => key(pos[0], pos[1])))
    occupied.add(key(defender.pos[0], defender.pos[1]))
    if (!canEnter(grid, occupied, cell[0], cell[1])) continue
    const projected = attackPowerWithFlank(
      grid,
      { ...attacker, pos: cell },
      defender,
      allies,
    )
    if (projected > bestPower) {
      best = cell
      bestPower = projected
    }
  }
  return best
}
`

// ── src/sim.js ──────────────────────────────────────────────────────────────

const SIM_BASE = `import { key } from './grid.js'
import { initiative } from './rules.js'

// Round loop: each round, the roster acts in initiative order; TIES keep
// ROSTER order (the per-round sort must never mutate the roster itself).
// Moving costs 1 fatigue; resting at the target recovers 1 (floor 0).
export function runSim(grid, roster, rounds) {
  const state = roster.map(u => ({ ...u, pos: [...u.pos] }))
  const log = []
  for (let round = 0; round < rounds; round++) {
    const order = [...state].sort((a, b) => initiative(b) - initiative(a))
    for (const unit of order) {
      const x = unit.pos[0]
      const y = unit.pos[1]
      const dx = Math.sign(unit.target[0] - x)
      const dy = Math.sign(unit.target[1] - y)
      if (dx === 0 && dy === 0) {
        unit.fatigue = Math.max(0, unit.fatigue - 1)
        log.push(unit.id + ' rests at ' + key(x, y))
        continue
      }
      unit.pos = [x + dx, y + dy]
      unit.fatigue += 1
      log.push(unit.id + ' moves to ' + key(unit.pos[0], unit.pos[1]))
    }
  }
  return { state, log }
}
`

/** defect: the per-round sort mutates the roster — tie order drifts from
 *  round 2 on (visible only as a diverged battle log). */
const SIM_MUTATING_SORT = SIM_BASE.replace(
  '    const order = [...state].sort((a, b) => initiative(b) - initiative(a))',
  '    const order = state.sort((a, b) => initiative(b) - initiative(a))',
)

// ── base tests ──────────────────────────────────────────────────────────────

const TEST_GRID = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, inBounds, isBlocked, neighbors } from '../src/grid.js'

test('bounds are exclusive at width and height', () => {
  const grid = createGrid(3, 3, [])
  assert.equal(inBounds(grid, 2, 2), true)
  assert.equal(inBounds(grid, 3, 2), false)
  assert.equal(inBounds(grid, 2, 3), false)
  assert.equal(inBounds(grid, -1, 0), false)
})

test('corner neighbors stay on the grid', () => {
  const grid = createGrid(3, 3, [])
  const cells = neighbors(grid, 0, 0).map(n => n[0] + ',' + n[1])
  assert.deepEqual(cells.sort(), ['0,1', '1,0', '1,1'])
})

test('edge neighbors stay on the grid', () => {
  const grid = createGrid(3, 3, [])
  const cells = neighbors(grid, 2, 1).map(n => n[0] + ',' + n[1])
  for (const cell of cells) {
    const x = Number(cell.split(',')[0])
    const y = Number(cell.split(',')[1])
    assert.ok(x >= 0 && x < 3 && y >= 0 && y < 3, 'neighbor off-grid: ' + cell)
  }
  assert.equal(cells.length, 5)
})

test('blocked cells never appear as neighbors', () => {
  const grid = createGrid(3, 3, [[1, 1]])
  assert.equal(isBlocked(grid, 1, 1), true)
  const cells = neighbors(grid, 0, 0).map(n => n[0] + ',' + n[1])
  assert.deepEqual(cells.sort(), ['0,1', '1,0'])
})

test('diagonal neighbors are flagged', () => {
  const grid = createGrid(3, 3, [])
  const diagonal = neighbors(grid, 1, 1).filter(n => n[2])
  assert.equal(diagonal.length, 4)
})
`

const TEST_PATH = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, isBlocked, neighbors } from '../src/grid.js'
import { findPath, stepCost } from '../src/path.js'

// Inline Dijkstra oracle — shares neighbors/stepCost with the implementation,
// so optimality assertions are SELF-VERIFYING (no magic constants).
function dijkstraCost(grid, start, goal) {
  const dist = new Map([[start.join(','), 0]])
  const frontier = [[0, start[0], start[1]]]
  while (frontier.length > 0) {
    let at = 0
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i][0] < frontier[at][0]) at = i
    }
    const [d, x, y] = frontier.splice(at, 1)[0]
    if (x === goal[0] && y === goal[1]) return d
    if (d > (dist.get(x + ',' + y) ?? Infinity)) continue
    for (const [nx, ny, diagonal] of neighbors(grid, x, y)) {
      const nd = d + stepCost(diagonal)
      const nKey = nx + ',' + ny
      if ((dist.get(nKey) ?? Infinity) <= nd) continue
      dist.set(nKey, nd)
      frontier.push([nd, nx, ny])
    }
  }
  return null
}

const ARENA = createGrid(6, 6, [
  [2, 0],
  [2, 1],
  [2, 2],
  [2, 3],
  [2, 4],
])

test('step costs ride the 10/14 units', () => {
  assert.equal(stepCost(false), 10)
  assert.equal(stepCost(true), 14)
})

test('a straight corridor walks straight', () => {
  const grid = createGrid(4, 1, [])
  const found = findPath(grid, [0, 0], [3, 0])
  assert.equal(found.cost, 30)
  assert.equal(found.path.length, 4)
})

test('findPath matches the exhaustive optimum around the wall', () => {
  const found = findPath(ARENA, [0, 0], [5, 0])
  const optimum = dijkstraCost(ARENA, [0, 0], [5, 0])
  assert.ok(found, 'a path exists')
  assert.equal(found.cost, optimum)
})

test('the returned path is contiguous, unblocked and correctly costed', () => {
  const found = findPath(ARENA, [0, 0], [5, 0])
  let walked = 0
  for (let i = 1; i < found.path.length; i++) {
    const [ax, ay] = found.path[i - 1]
    const [bx, by] = found.path[i]
    const dx = Math.abs(ax - bx)
    const dy = Math.abs(ay - by)
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, 'step is a king move')
    assert.ok(!isBlocked(ARENA, bx, by), 'step avoids blocks')
    walked += stepCost(dx === 1 && dy === 1)
  }
  assert.equal(walked, found.cost)
})

test('an unreachable goal returns null', () => {
  const grid = createGrid(3, 1, [[1, 0]])
  assert.equal(findPath(grid, [0, 0], [2, 0]), null)
})
`

const TEST_RULES = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, key } from '../src/grid.js'
import { attackPower, canEnter, initiative } from '../src/rules.js'

test('tired units act later', () => {
  assert.equal(initiative({ speed: 2, fatigue: 3 }), 17)
  const fresh = initiative({ speed: 2, fatigue: 0 })
  const tired = initiative({ speed: 2, fatigue: 5 })
  assert.ok(fresh > tired)
})

test('canEnter refuses bounds, blocks and occupied cells', () => {
  const grid = createGrid(3, 3, [[1, 0]])
  const occupied = new Set([key(1, 1)])
  assert.equal(canEnter(grid, occupied, 3, 0), false)
  assert.equal(canEnter(grid, occupied, 1, 0), false)
  assert.equal(canEnter(grid, occupied, 1, 1), false)
  assert.equal(canEnter(grid, occupied, 0, 1), true)
})

test('attacking a tired defender gains the advantage', () => {
  assert.equal(attackPower({ power: 10 }, { fatigue: 5 }), 12)
  assert.equal(attackPower({ power: 10 }, { fatigue: 0 }), 10)
})
`

const TEST_SIM = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, key } from '../src/grid.js'
import { runSim } from '../src/sim.js'

const GRID = createGrid(8, 8, [])

test('the four-round battle log is deterministic', () => {
  const roster = [
    { id: 'k', speed: 2, fatigue: 2, pos: [5, 5], target: [5, 5] },
    { id: 'm', speed: 2, fatigue: 0, pos: [0, 0], target: [0, 4] },
  ]
  const { log } = runSim(GRID, roster, 4)
  assert.deepEqual(log, [
    'm moves to 0,1',
    'k rests at 5,5',
    'k rests at 5,5',
    'm moves to 0,2',
    'k rests at 5,5',
    'm moves to 0,3',
    'k rests at 5,5',
    'm moves to 0,4',
  ])
})

test('the roster order itself never changes', () => {
  const roster = [
    { id: 'k', speed: 2, fatigue: 2, pos: [5, 5], target: [5, 5] },
    { id: 'm', speed: 2, fatigue: 0, pos: [0, 0], target: [0, 4] },
  ]
  const { state } = runSim(GRID, roster, 4)
  assert.deepEqual(state.map(u => u.id), ['k', 'm'])
})

test('two-round smoke without ties', () => {
  const roster = [
    { id: 'a', speed: 3, fatigue: 0, pos: [0, 0], target: [2, 0] },
    { id: 'b', speed: 1, fatigue: 0, pos: [7, 7], target: [7, 7] },
  ]
  const { log } = runSim(GRID, roster, 2)
  assert.deepEqual(log, [
    'a moves to 1,0',
    'b rests at 7,7',
    'a moves to 2,0',
    'b rests at 7,7',
  ])
})

test('positions never alias the input roster', () => {
  const roster = [{ id: 'a', speed: 1, fatigue: 0, pos: [0, 0], target: [1, 0] }]
  runSim(GRID, roster, 1)
  assert.deepEqual(roster[0].pos, [0, 0])
})
`

/** task/diag-cost overlay: the same path tests WITHOUT the stepCost unit
 *  contract — the flat-diagonal defect must be invisible to the suite (that
 *  is the discovery-task premise). All remaining tests stay green because
 *  the Dijkstra oracle shares stepCost with the implementation. */
const TEST_PATH_NO_UNITS = TEST_PATH.replace(
  `test('step costs ride the 10/14 units', () => {
  assert.equal(stepCost(false), 10)
  assert.equal(stepCost(true), 14)
})

`,
  '',
)

// ── branch tests (object coords — failing until the refactor) ───────────

const TEST_GRID_OBJECT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, inBounds, key, neighbors } from '../src/grid.js'

test('coords are {x, y} records now', () => {
  const grid = createGrid(3, 3, [{ x: 1, y: 1 }])
  assert.equal(inBounds(grid, { x: 2, y: 2 }), true)
  assert.equal(inBounds(grid, { x: 3, y: 2 }), false)
  assert.equal(key({ x: 1, y: 2 }), '1,2')
})

test('neighbors return {x, y, diagonal} records', () => {
  const grid = createGrid(3, 3, [])
  const cells = neighbors(grid, { x: 0, y: 0 })
  assert.deepEqual(
    cells.map(n => key(n)).sort(),
    ['0,1', '1,0', '1,1'],
  )
  const diagonal = cells.filter(n => n.diagonal)
  assert.deepEqual(diagonal.map(n => key(n)), ['1,1'])
})
`

const TEST_PATH_OBJECT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid } from '../src/grid.js'
import { findPath, stepCost } from '../src/path.js'

test('findPath rides {x, y} coords end to end', () => {
  const grid = createGrid(4, 1, [])
  const found = findPath(grid, { x: 0, y: 0 }, { x: 3, y: 0 })
  assert.equal(found.cost, 30)
  assert.deepEqual(found.path[0], { x: 0, y: 0 })
  assert.deepEqual(found.path[3], { x: 3, y: 0 })
})

test('step costs stay 10/14', () => {
  assert.equal(stepCost(false), 10)
  assert.equal(stepCost(true), 14)
})
`

const TEST_SIM_OBJECT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid } from '../src/grid.js'
import { runSim } from '../src/sim.js'

const GRID = createGrid(8, 8, [])

test('units ride {x, y} positions and the log format holds', () => {
  const roster = [
    { id: 'a', speed: 3, fatigue: 0, pos: { x: 0, y: 0 }, target: { x: 2, y: 0 } },
    { id: 'b', speed: 1, fatigue: 0, pos: { x: 7, y: 7 }, target: { x: 7, y: 7 } },
  ]
  const { log, state } = runSim(GRID, roster, 2)
  assert.deepEqual(log, [
    'a moves to 1,0',
    'b rests at 7,7',
    'a moves to 2,0',
    'b rests at 7,7',
  ])
  assert.deepEqual(state[0].pos, { x: 2, y: 0 })
})
`

const TEST_RULES_OBJECT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, key } from '../src/grid.js'
import { attackPower, canEnter, initiative } from '../src/rules.js'

test('tired units act later', () => {
  assert.equal(initiative({ speed: 2, fatigue: 3 }), 17)
})

test('canEnter rides {x, y} coords', () => {
  const grid = createGrid(3, 3, [{ x: 1, y: 0 }])
  const occupied = new Set([key({ x: 1, y: 1 })])
  assert.equal(canEnter(grid, occupied, { x: 3, y: 0 }), false)
  assert.equal(canEnter(grid, occupied, { x: 1, y: 0 }), false)
  assert.equal(canEnter(grid, occupied, { x: 1, y: 1 }), false)
  assert.equal(canEnter(grid, occupied, { x: 0, y: 1 }), true)
})

test('attacking a tired defender gains the advantage', () => {
  assert.equal(attackPower({ power: 10 }, { fatigue: 5 }), 12)
})
`

/** reference: object coords across the four modules. */
const RULES_OBJECT = `import { inBounds, isBlocked, key } from './grid.js'

// Engagement rules. Initiative: faster units act first; fatigue slows a unit
// down (tired units act LATER).
export function initiative(unit) {
  return unit.speed * 10 - unit.fatigue
}

export function canEnter(grid, occupied, pos) {
  if (!inBounds(grid, pos)) return false
  if (isBlocked(grid, pos)) return false
  if (occupied.has(key(pos))) return false
  return true
}

export function attackPower(unit, defender) {
  const advantage = defender.fatigue >= 5 ? 2 : 0
  return unit.power + advantage
}
`

const GRID_OBJECT = `// Rectangular grid; coords are { x, y } records; blocked cells are a Set of
// 'x,y' keys.
export function key(pos) {
  return pos.x + ',' + pos.y
}

export function createGrid(width, height, blocked) {
  const cells = (blocked ?? []).map(pos => key(pos))
  return { width, height, blocked: new Set(cells) }
}

export function inBounds(grid, pos) {
  return pos.x >= 0 && pos.y >= 0 && pos.x < grid.width && pos.y < grid.height
}

export function isBlocked(grid, pos) {
  return grid.blocked.has(key(pos))
}

const DIRS = [
  { dx: 1, dy: 0, diagonal: false },
  { dx: -1, dy: 0, diagonal: false },
  { dx: 0, dy: 1, diagonal: false },
  { dx: 0, dy: -1, diagonal: false },
  { dx: 1, dy: 1, diagonal: true },
  { dx: 1, dy: -1, diagonal: true },
  { dx: -1, dy: 1, diagonal: true },
  { dx: -1, dy: -1, diagonal: true },
]

export function neighbors(grid, pos) {
  const out = []
  for (const dir of DIRS) {
    const next = { x: pos.x + dir.dx, y: pos.y + dir.dy }
    if (!inBounds(grid, next) || isBlocked(grid, next)) continue
    out.push({ x: next.x, y: next.y, diagonal: dir.diagonal })
  }
  return out
}
`

const PATH_OBJECT = `import { key, neighbors } from './grid.js'

// Costs ride 10/14 integer units (orthogonal/diagonal).
export function stepCost(diagonal) {
  return diagonal ? 14 : 10
}

// Octile distance in the same units — admissible for 10/14 grids.
export function heuristic(a, b) {
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy)
}

// Deterministic A*: array-scan frontier, f then insertion order; a better g
// re-opens a cell (gBest prune, re-push on improvement).
export function findPath(grid, start, goal) {
  const goalKey = key(goal)
  const startKey = key(start)
  const open = [{ pos: { x: start.x, y: start.y }, g: 0, f: heuristic(start, goal), seq: 0 }]
  const gBest = new Map([[startKey, 0]])
  const cameFrom = new Map()
  let seq = 1
  while (open.length > 0) {
    let bestAt = 0
    for (let i = 1; i < open.length; i++) {
      const a = open[i]
      const b = open[bestAt]
      if (a.f < b.f || (a.f === b.f && a.seq < b.seq)) bestAt = i
    }
    const current = open.splice(bestAt, 1)[0]
    const currentKey = key(current.pos)
    if (current.g > (gBest.get(currentKey) ?? Infinity)) continue
    if (currentKey === goalKey) {
      const path = [{ x: current.pos.x, y: current.pos.y }]
      let walk = currentKey
      while (cameFrom.has(walk)) {
        walk = cameFrom.get(walk)
        const parts = walk.split(',')
        path.unshift({ x: Number(parts[0]), y: Number(parts[1]) })
      }
      return { path, cost: current.g }
    }
    for (const step of neighbors(grid, current.pos)) {
      const nKey = key(step)
      const g = current.g + stepCost(step.diagonal)
      if ((gBest.get(nKey) ?? Infinity) <= g) continue
      gBest.set(nKey, g)
      cameFrom.set(nKey, currentKey)
      open.push({
        pos: { x: step.x, y: step.y },
        g,
        f: g + heuristic(step, goal),
        seq,
      })
      seq += 1
    }
  }
  return null
}
`

const SIM_OBJECT = `import { key } from './grid.js'
import { initiative } from './rules.js'

// Round loop: each round, the roster acts in initiative order; TIES keep
// ROSTER order (the per-round sort must never mutate the roster itself).
// Moving costs 1 fatigue; resting at the target recovers 1 (floor 0).
export function runSim(grid, roster, rounds) {
  const state = roster.map(u => ({ ...u, pos: { x: u.pos.x, y: u.pos.y } }))
  const log = []
  for (let round = 0; round < rounds; round++) {
    const order = [...state].sort((a, b) => initiative(b) - initiative(a))
    for (const unit of order) {
      const dx = Math.sign(unit.target.x - unit.pos.x)
      const dy = Math.sign(unit.target.y - unit.pos.y)
      if (dx === 0 && dy === 0) {
        unit.fatigue = Math.max(0, unit.fatigue - 1)
        log.push(unit.id + ' rests at ' + key(unit.pos))
        continue
      }
      unit.pos = { x: unit.pos.x + dx, y: unit.pos.y + dy }
      unit.fatigue += 1
      log.push(unit.id + ' moves to ' + key(unit.pos))
    }
  }
  return { state, log }
}
`

// ── branch tests (flanking — failing until implemented) ─────────────────

const FLANK_SPEC = `# FLANK.md — the flanking rule (exact contract)

Two additions, spanning the geometry owner and the rules owner:

1. \`oppositeNeighbor(grid, defender, attacker)\` in \`src/grid.js\`: the cell
   straight across the defender from the attacker — the mirror of the
   attacker's cell through the defender's cell. Diagonal attacks mirror
   diagonally. Returns \`null\` when the mirror cell is off the grid (edges
   and corners flank nothing).
2. \`attackPowerWithFlank(grid, attacker, defender, allies)\` in
   \`src/rules.js\`: the plain \`attackPower\` plus — when an ally stands on
   the opposite cell — a bonus of 25% of the attacker's BASE power, floored
   (power 10 -> +2). \`allies\` is a list of ally positions.
3. \`bestAttackCell(grid, attacker, defender, allies, candidates)\` in
   \`src/rules.js\`: among the candidate cells, the FIRST enterable cell
   (bounds, blocks, defender and allies occupy their cells) that maximizes
   the flank-aware projected power. Returns \`null\` when nothing is
   enterable.

Tests in \`test/flank.test.mjs\` are the acceptance oracle. Do not modify
tests.
`

const TEST_FLANK = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, oppositeNeighbor } from '../src/grid.js'
import { attackPowerWithFlank, bestAttackCell } from '../src/rules.js'

const GRID = createGrid(5, 5, [[3, 1]])

test('opposite cell mirrors through the defender', () => {
  assert.deepEqual(oppositeNeighbor(GRID, [2, 2], [1, 2]), [3, 2])
  assert.deepEqual(oppositeNeighbor(GRID, [2, 2], [1, 1]), [3, 3])
})

test('edges and corners flank nothing', () => {
  assert.equal(oppositeNeighbor(GRID, [0, 2], [1, 2]), null)
  assert.equal(oppositeNeighbor(GRID, [0, 0], [1, 1]), null)
})

test('a flanking ally raises projected power by a quarter, floored', () => {
  const attacker = { power: 10, pos: [1, 2] }
  const defender = { fatigue: 0, pos: [2, 2] }
  assert.equal(attackPowerWithFlank(GRID, attacker, defender, [[3, 2]]), 12)
  assert.equal(attackPowerWithFlank(GRID, attacker, defender, [[3, 3]]), 10)
  const odd = { power: 11, pos: [1, 2] }
  assert.equal(attackPowerWithFlank(GRID, odd, defender, [[3, 2]]), 13)
})

test('no opposite cell means no flank even with adjacent allies', () => {
  const attacker = { power: 10, pos: [1, 1] }
  const defender = { fatigue: 0, pos: [0, 0] }
  assert.equal(attackPowerWithFlank(GRID, attacker, defender, [[0, 1]]), 10)
})

test('bestAttackCell picks the flank-making cell', () => {
  const attacker = { power: 10, pos: [0, 2] }
  const defender = { fatigue: 0, pos: [2, 2] }
  const allies = [[3, 2]]
  const best = bestAttackCell(GRID, attacker, defender, allies, [
    [1, 1],
    [1, 2],
    [1, 3],
  ])
  assert.deepEqual(best, [1, 2])
})

test('a blocked flank cell falls back to the best enterable candidate', () => {
  const attacker = { power: 10, pos: [4, 0] }
  const defender = { fatigue: 0, pos: [2, 1] }
  const allies = [[1, 1]]
  const best = bestAttackCell(GRID, attacker, defender, allies, [
    [3, 1],
    [3, 2],
    [2, 0],
  ])
  assert.deepEqual(best, [3, 2])
})

test('occupied candidates are never chosen', () => {
  const attacker = { power: 10, pos: [0, 2] }
  const defender = { fatigue: 0, pos: [2, 2] }
  const allies = [[1, 2]]
  const best = bestAttackCell(GRID, attacker, defender, allies, [
    [1, 2],
    [1, 3],
  ])
  assert.deepEqual(best, [1, 3])
})
`

// ── comparison-partition overlays (task/cmp-*) ────────────────────

/** defect: resting RAISES fatigue — initiative order silently flips in
 *  later rounds; the only symptom is a diverged battle log. */
const SIM_REST_RAISES_FATIGUE = SIM_BASE.replace(
  '        unit.fatigue = Math.max(0, unit.fatigue - 1)',
  '        unit.fatigue = unit.fatigue + 1',
)

/** falsify: the decoy wrong-site fix (initiative sign in rules.js). */
const RULES_INITIATIVE_DECOY = RULES_BASE.replace(
  '  return unit.speed * 10 - unit.fatigue',
  '  return unit.speed * 10 + unit.fatigue',
)

/** defect: diagonal steps turned CHEAPER than orthogonal ones. */
const PATH_DIAG_CHEAP = PATH_BASE.replace(
  `export function stepCost(diagonal) {
  return diagonal ? 14 : 10
}`,
  `export function stepCost(diagonal) {
  return diagonal ? 9 : 10
}`,
)

/** defect: the fatigue-advantage threshold turns strict. */
const RULES_ADVANTAGE_STRICT = RULES_BASE.replace(
  '  const advantage = defender.fatigue >= 5 ? 2 : 0',
  '  const advantage = defender.fatigue > 5 ? 2 : 0',
)

/** reference: the threat-map module over the existing geometry owners. */
const THREAT_MODULE = `import { key, neighbors } from './grid.js'

// threatMap: every unit projects its power onto each cell it could attack —
// the in-bounds, unblocked neighbor cells of its position. Contributions SUM
// where units overlap. Occupancy is battlefield state, not threat.
export function threatMap(grid, units) {
  const map = new Map()
  for (const unit of units) {
    for (const [nx, ny] of neighbors(grid, unit.pos[0], unit.pos[1])) {
      const cell = key(nx, ny)
      map.set(cell, (map.get(cell) ?? 0) + unit.power)
    }
  }
  return map
}

// safestCell: the candidate with the LOWEST summed threat (untracked cells
// are threat 0); ties keep candidate order.
export function safestCell(grid, units, candidates) {
  const map = threatMap(grid, units)
  let best = null
  let bestThreat = Infinity
  for (const cell of candidates) {
    const threat = map.get(key(cell[0], cell[1])) ?? 0
    if (threat < bestThreat) {
      best = cell
      bestThreat = threat
    }
  }
  return best
}
`

/** falsify: overwrites instead of summing where units overlap. */
const THREAT_MODULE_OVERWRITE = THREAT_MODULE.replace(
  '      map.set(cell, (map.get(cell) ?? 0) + unit.power)',
  '      map.set(cell, unit.power)',
)

const THREAT_SPEC = `# THREAT.md — the threat map (exact contract)

Create \`src/threat.js\` with two exports, built ON the existing geometry
owners (\`grid.js\` neighbors/bounds/blocks — do not reimplement them):

1. \`threatMap(grid, units)\` — a Map from cell key ('x,y') to the SUMMED
   power of every unit that could attack that cell. A unit attacks the
   in-bounds, unblocked neighbor cells of its position (all eight
   directions). Overlapping units ADD their power. Occupied cells are still
   threatened — occupancy is battlefield state, not threat.
2. \`safestCell(grid, units, candidates)\` — the candidate cell with the
   lowest summed threat; a cell absent from the map counts as threat 0;
   ties keep candidate order; no candidates means \`null\`.

Tests in \`test/threat.test.mjs\` are the acceptance oracle. Do not modify
tests or any existing module.
`

/** branch: the threat-map acceptance oracle (failing until built). */
const TEST_THREAT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, key } from '../src/grid.js'
import { safestCell, threatMap } from '../src/threat.js'

const GRID = createGrid(4, 4, [[2, 1]])

test('a unit threatens its unblocked in-bounds neighbors', () => {
  const map = threatMap(GRID, [{ pos: [1, 1], power: 10 }])
  assert.equal(map.get(key(0, 0)), 10)
  assert.equal(map.get(key(1, 0)), 10)
  assert.equal(map.get(key(2, 1)), undefined)
  assert.equal(map.get(key(1, 1)), undefined)
})

test('overlapping units SUM their power', () => {
  const map = threatMap(GRID, [
    { pos: [0, 0], power: 10 },
    { pos: [2, 0], power: 7 },
  ])
  assert.equal(map.get(key(1, 0)), 17)
  assert.equal(map.get(key(1, 1)), 17)
})

test('corner units threaten only their three neighbors', () => {
  const map = threatMap(GRID, [{ pos: [0, 0], power: 5 }])
  assert.equal([...map.keys()].length, 3)
})

test('occupied cells are still threatened', () => {
  const map = threatMap(GRID, [
    { pos: [0, 1], power: 4 },
    { pos: [1, 1], power: 9 },
  ])
  assert.equal(map.get(key(1, 1)), 4)
})

test('safestCell picks the lowest summed threat, ties keep order', () => {
  const units = [{ pos: [1, 1], power: 10 }]
  assert.deepEqual(safestCell(GRID, units, [[0, 0], [3, 3]]), [3, 3])
  assert.deepEqual(safestCell(GRID, units, [[3, 3], [3, 2]]), [3, 3])
  assert.equal(safestCell(GRID, units, []), null)
})
`

const BASE_FILES: FileMap = {
  'package.json': PACKAGE_JSON,
  'src/grid.js': GRID_BASE,
  'src/path.js': PATH_BASE,
  'src/rules.js': RULES_BASE,
  'src/sim.js': SIM_BASE,
  'test/grid.test.mjs': TEST_GRID,
  'test/path.test.mjs': TEST_PATH,
  'test/rules.test.mjs': TEST_RULES,
  'test/sim.test.mjs': TEST_SIM,
}

const BRANCHES: Record<string, BranchOverlay> = {
  'task/diag-cost': {
    'src/path.js': PATH_FLAT_DIAGONAL,
    'test/path.test.mjs': TEST_PATH_NO_UNITS,
  },
  'task/refactor-coords': {
    'test/grid.test.mjs': TEST_GRID_OBJECT,
    'test/path.test.mjs': TEST_PATH_OBJECT,
    'test/rules.test.mjs': TEST_RULES_OBJECT,
    'test/sim.test.mjs': TEST_SIM_OBJECT,
  },
  'task/sim-order': { 'src/sim.js': SIM_MUTATING_SORT },
  'task/two-lanes': {
    'src/grid.js': GRID_OFF_BY_ONE,
    'src/rules.js': RULES_NO_OCCUPANCY,
  },
  'task/coupled-rules': {
    'FLANK.md': FLANK_SPEC,
    'test/flank.test.mjs': TEST_FLANK,
  },
  'task/trap': { 'src/path.js': PATH_TRAP },
  'task/tiny': { 'src/rules.js': RULES_FATIGUE_SIGN },
  'task/cmp-sim-rest': { 'src/sim.js': SIM_REST_RAISES_FATIGUE },
  'task/cmp-threat': {
    'THREAT.md': THREAT_SPEC,
    'test/threat.test.mjs': TEST_THREAT,
  },
  'task/cmp-diag': { 'src/path.js': PATH_DIAG_CHEAP },
  'task/cmp-switch-b': { 'src/rules.js': RULES_ADVANTAGE_STRICT },
}

export const GRIDGAME_REPO: HelixRepoSpec = {
  id: 'gridgame',
  seed: 'inline',
  files: BASE_FILES,
  branches: BRANCHES,
}

export const GRIDGAME_CONTENT = {
  GRID_BASE,
  PATH_BASE,
  RULES_BASE,
  SIM_BASE,
  GRID_WITH_OPPOSITE,
  GRID_OPPOSITE_NO_BOUNDS,
  RULES_FLANK,
  GRID_OBJECT,
  PATH_OBJECT,
  SIM_OBJECT,
  RULES_OBJECT,
  TEST_PATH,
  TEST_SIM,
  RULES_INITIATIVE_DECOY,
  THREAT_MODULE,
  THREAT_MODULE_OVERWRITE,
} as const
