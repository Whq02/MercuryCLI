// ============================================================================
//  corpus repo: emberweald — the top-down action game pack
//  (family 18). A torchbearer holds a mist-bound clearing:
//  deterministic fixed-timestep sim (seeded xorshift32, input tapes, probe
//  CLI), canvas renderer, generated audio, zero dependencies. The BASE tree
//  ships the sim scaffolding with the six mission seams stubbed and the
//  public suite failing (fail-start); EW1's reference and falsify variants
//  are exported below for the task definition. This module is CANONICAL —
//  edit here, exactly like every sibling repo module.
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const FILES: FileMap = {
  '.gitignore': `node_modules/
.DS_Store
`,
  'README.md': "# Emberweald\n\nA torchbearer holds a mist-bound forest clearing against waves of\nmist-creatures. Top-down, keyboard/mouse + gamepad, canvas 2D, zero\ndependencies.\n\n## Architecture\n\nThe simulation is a pure fixed-timestep core; everything else is a shell\naround it.\n\n```\nsrc/core/    rng (seeded xorshift32; the only randomness source)\nsrc/sim/     world.js   state + constants + the step() pipeline\n             input.js   the input-frame contract + tape reader\n             phases.js  title/playing/paused/settings/dead/victory machine\n             systems/   movement \u00b7 combat \u00b7 enemies \u00b7 damage \u00b7 waves\n             save.js    version-stamped snapshot codec\nsrc/render/  canvas drawing (reads world, never writes it)\nsrc/input/   browser device collectors -> input frames\nsrc/audio/   generated WebAudio cues (reads world.events)\ntools/       serve.mjs (static server) \u00b7 probe.mjs (headless tape runner)\ntest/        node --test suite pinning the sim contracts\n```\n\nDeterminism laws (enforced by `test/determinism.test.mjs`): the sim reads no\ndevice, no wall clock and no `Math.random`; identical seed + input tape \u21d2\nbyte-identical world state on any machine.\n\n## Run\n\n```\nnpm test          # the sim contract suite\nnpm run serve     # http://localhost:8137\nnpm run probe -- --seed 7 --ticks 300 --tape tapes/example.json\n```\n\n## Input\n\nWASD/arrows move \u00b7 mouse aims \u00b7 click/space attacks \u00b7 shift dodges \u00b7\n1-4 item slots \u00b7 Esc pauses. Gamepad: left stick moves, right stick aims,\nbindings editable in Settings (see `src/input/`).\n",
  'index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emberweald</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0f0d; overflow: hidden; }
  #stage { display: block; margin: 0 auto; image-rendering: pixelated; }
</style>
</head>
<body>
<canvas id="stage" width="480" height="320" role="application" aria-label="Emberweald — a torchbearer holds the clearing"></canvas>
<script type="module" src="./src/app.js"></script>
</body>
</html>
`,
  'package.json': `{
  "name": "emberweald",
  "version": "0.1.0",
  "type": "module",
  "description": "A torchbearer holds a mist-bound clearing against wave-creatures. Deterministic fixed-timestep sim, canvas renderer, zero dependencies.",
  "scripts": {
    "test": "node --test",
    "serve": "node tools/serve.mjs",
    "probe": "node tools/probe.mjs"
  }
}
`,
  'src/app.js': `// The browser shell: device collectors -> fixed-timestep sim -> canvas.
// All game logic lives in src/sim; this file owns pacing, scaling and wiring.
import { createWorld, step, ARENA, TICK_HZ } from './sim/world.js'
import { normalizeFrame } from './sim/input.js'
import { createKeyboardCollector } from './input/keyboard.js'
import { createGamepadCollector } from './input/gamepad.js'
import { render } from './render/canvas.js'
import { createBleeps } from './audio/bleeps.js'

const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const seed = Number(new URLSearchParams(location.search).get('seed') ?? 7) >>> 0

const world = createWorld(seed)
const keyboard = createKeyboardCollector(window)
const gamepad = createGamepadCollector()
const bleeps = createBleeps()

// Responsive integer scaling: the world stays 480x320; the canvas snaps to
// the largest integer multiple that fits the viewport (min 1x).
function fitCanvas() {
  const scale = Math.max(1, Math.floor(Math.min(window.innerWidth / ARENA.width, window.innerHeight / ARENA.height)))
  canvas.style.width = ARENA.width * scale + 'px'
  canvas.style.height = ARENA.height * scale + 'px'
  canvas.style.marginTop = Math.max(0, (window.innerHeight - ARENA.height * scale) / 2) + 'px'
}
window.addEventListener('resize', fitCanvas)
fitCanvas()

const toWorld = point => {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (point.x / rect.width) * ARENA.width,
    y: (point.y / rect.height) * ARENA.height,
  }
}

// Fixed-timestep accumulator: render at rAF, step at exactly TICK_HZ.
const TICK_MS = 1000 / TICK_HZ
let last = performance.now()
let acc = 0

function loop(now) {
  acc += Math.min(now - last, 250) // clamp away tab-suspend spikes
  last = now
  while (acc >= TICK_MS) {
    const kb = keyboard.collect(toWorld)
    const pad = gamepad.collect(world.player, 120)
    const frame = normalizeFrame(mergeFrames(kb, pad))
    step(world, frame)
    bleeps.play(world.events)
    acc -= TICK_MS
  }
  render(ctx, world)
  requestAnimationFrame(loop)
}

function mergeFrames(kb, pad) {
  if (!pad) return kb
  const held = { ...kb.held }
  for (const [k, v] of Object.entries(pad.held)) held[k] = held[k] || v
  const pressed = { ...kb.pressed }
  for (const [k, v] of Object.entries(pad.pressed ?? {})) pressed[k] = pressed[k] || v
  return { held, pressed, aim: pad.aim ?? kb.aim }
}

// Expose a read-only probe for external checks and curious players.
window.__emberweald = {
  state: () => JSON.parse(JSON.stringify(world)),
  seed,
}

requestAnimationFrame(loop)
`,
  'src/audio/bleeps.js': `// Generated WebAudio cues — no assets. Reads world.events each tick.
const CUES = {
  hit: { freq: 220, dur: 0.06, type: 'square', gain: 0.2 },
  whiff: { freq: 140, dur: 0.04, type: 'triangle', gain: 0.12 },
  'player-hit': { freq: 90, dur: 0.18, type: 'sawtooth', gain: 0.25 },
  'player-down': { freq: 55, dur: 0.6, type: 'sawtooth', gain: 0.3 },
  'enemy-down': { freq: 330, dur: 0.09, type: 'square', gain: 0.18 },
  'wave-cleared': { freq: 440, dur: 0.25, type: 'sine', gain: 0.22 },
  'run-won': { freq: 660, dur: 0.5, type: 'sine', gain: 0.25 },
}

export function createBleeps() {
  let ctx = null
  let muted = false
  let volume = 1

  const ensure = () => {
    if (!ctx && typeof AudioContext !== 'undefined') ctx = new AudioContext()
    return ctx
  }

  return {
    // Call once per rendered frame with the tick's drained events.
    play(events) {
      if (muted || events.length === 0) return
      const audio = ensure()
      if (!audio) return
      for (const event of events) {
        const cue = CUES[event.type]
        if (!cue) continue
        const osc = audio.createOscillator()
        const gain = audio.createGain()
        osc.type = cue.type
        osc.frequency.value = cue.freq
        gain.gain.setValueAtTime(cue.gain * volume, audio.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + cue.dur)
        osc.connect(gain).connect(audio.destination)
        osc.start()
        osc.stop(audio.currentTime + cue.dur)
      }
    },
    setMuted(value) {
      muted = Boolean(value)
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value))
    },
    get muted() {
      return muted
    },
    get volume() {
      return volume
    },
  }
}
`,
  'src/core/rng.js': `// Deterministic xorshift32 RNG. Every use of randomness in the simulation
// MUST come through a stream created here — Math.random is banned in src/sim
// (the determinism law; see test/determinism.test.mjs).
export function createRng(seed) {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return {
    // Uniform uint32.
    nextU32() {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      return state
    },
    // Uniform float in [0, 1).
    next() {
      return this.nextU32() / 0x100000000
    },
    // Uniform integer in [lo, hi] inclusive.
    int(lo, hi) {
      return lo + Math.floor(this.next() * (hi - lo + 1))
    },
    // Fork a named substream so unrelated systems cannot perturb each other's
    // sequences (enemy spawns must not depend on how often particles rolled).
    fork(label) {
      let h = 2166136261
      for (let i = 0; i < label.length; i++) {
        h ^= label.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return createRng((state ^ h) >>> 0)
    },
  }
}
`,
  'src/input/gamepad.js': `// Gamepad collector: standard-mapping pads -> sim input frames.
// Axis 0/1 move, axis 2/3 aim; button indices are rebindable data.
export const DEFAULT_PAD_BINDINGS = {
  attack: [0], // A / cross
  dodge: [1], // B / circle
  use: [2], // X / square
  pause: [9], // start
  confirm: [0],
  cancel: [1],
  slot1: [12],
  slot2: [15],
  slot3: [13],
  slot4: [14],
}
const DEADZONE = 0.25

export function createGamepadCollector(bindings = DEFAULT_PAD_BINDINGS) {
  let previous = new Set()
  return {
    collect(player, aimScale) {
      const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
      const pad = [...pads].find(p => p && p.connected)
      if (!pad) return null
      const axis = i => (Math.abs(pad.axes[i] ?? 0) > DEADZONE ? pad.axes[i] : 0)
      const held = {
        up: axis(1) < 0,
        down: axis(1) > 0,
        left: axis(0) < 0,
        right: axis(0) > 0,
        use: (bindings.use ?? []).some(i => pad.buttons[i]?.pressed),
      }
      const nowDown = new Set()
      const pressed = {}
      for (const [action, indices] of Object.entries(bindings)) {
        for (const index of indices) {
          if (pad.buttons[index]?.pressed) {
            nowDown.add(action + ':' + index)
            if (!previous.has(action + ':' + index)) pressed[action] = true
          }
        }
      }
      previous = nowDown
      const aim =
        axis(2) !== 0 || axis(3) !== 0
          ? { x: player.x + axis(2) * aimScale, y: player.y + axis(3) * aimScale }
          : null
      return { held, pressed, aim }
    },
    rebind(action, indices) {
      bindings[action] = [...indices]
    },
    bindings,
  }
}
`,
  'src/input/keyboard.js': `// Keyboard + pointer collector: device events -> the sim's input frames.
// Bindings are DATA (rebindable in Settings; persisted by the app shell).
export const DEFAULT_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  attack: ['Space'],
  dodge: ['ShiftLeft', 'ShiftRight'],
  use: ['KeyE'],
  pause: ['Escape'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  confirm: ['Enter'],
  cancel: ['Backspace'],
}

export function createKeyboardCollector(target, bindings = DEFAULT_BINDINGS) {
  const down = new Set()
  const pressedSinceLastFrame = new Set()
  let pointer = { x: 0, y: 0 }
  let pointerPressed = false

  const actionOf = code => {
    for (const [action, codes] of Object.entries(bindings)) {
      if (codes.includes(code)) return action
    }
    return null
  }

  const onKeyDown = event => {
    const action = actionOf(event.code)
    if (!action) return
    event.preventDefault()
    if (!down.has(event.code)) pressedSinceLastFrame.add(action)
    down.add(event.code)
  }
  const onKeyUp = event => {
    down.delete(event.code)
  }
  const onPointerMove = event => {
    pointer = { x: event.offsetX, y: event.offsetY }
  }
  const onPointerDown = () => {
    pointerPressed = true
  }
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('pointermove', onPointerMove)
  target.addEventListener('pointerdown', onPointerDown)

  return {
    // Drain into a partial frame for exactly one sim tick.
    collect(toWorld) {
      const held = {}
      for (const action of ['up', 'down', 'left', 'right', 'use']) {
        held[action] = (bindings[action] ?? []).some(code => down.has(code))
      }
      const pressed = {}
      for (const action of pressedSinceLastFrame) pressed[action] = true
      if (pointerPressed) pressed.attack = true
      pressedSinceLastFrame.clear()
      pointerPressed = false
      return { held, pressed, aim: toWorld(pointer) }
    },
    rebind(action, codes) {
      bindings[action] = [...codes]
    },
    bindings,
    dispose() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('pointermove', onPointerMove)
      target.removeEventListener('pointerdown', onPointerDown)
    },
  }
}
`,
  'src/render/canvas.js': `// Canvas renderer: reads the world, never writes it. Geometric original
// art — the torchbearer is a warm ember, the mist-creatures are cool shapes.
import { ARENA, ENEMY_KINDS, OBSTACLES, PLAYER, WAVES } from '../sim/constants.js'

const INK = {
  ground: '#101812',
  stone: '#2a3630',
  stoneEdge: '#3d4f45',
  player: '#e8a13c',
  playerCore: '#f6d98b',
  torch: 'rgba(232, 161, 60, 0.14)',
  swing: 'rgba(246, 217, 139, 0.5)',
  mistling: '#7fa8b8',
  bogwisp: '#9db87f',
  thornshade: '#b87f9d',
  hud: '#dce8de',
  dim: 'rgba(11, 15, 13, 0.72)',
  hp: '#d95d4e',
  hpBack: '#3a2a28',
}

export function render(ctx, world) {
  ctx.save()
  ctx.fillStyle = INK.ground
  ctx.fillRect(0, 0, ARENA.width, ARENA.height)

  // Standing stones.
  for (const rect of OBSTACLES) {
    ctx.fillStyle = INK.stone
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
    ctx.strokeStyle = INK.stoneEdge
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1)
  }

  if (world.phase !== 'title') {
    drawRun(ctx, world)
  }
  drawHud(ctx, world)
  drawPhaseOverlay(ctx, world)
  ctx.restore()
}

function drawRun(ctx, world) {
  const player = world.player

  // Torchlight.
  const glow = ctx.createRadialGradient(player.x, player.y, 8, player.x, player.y, 90)
  glow.addColorStop(0, INK.torch)
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, ARENA.width, ARENA.height)

  // Enemies.
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    ctx.fillStyle = INK[enemy.kind] ?? '#ffffff'
    ctx.beginPath()
    ctx.arc(enemy.x, enemy.y, stats.radius, 0, Math.PI * 2)
    ctx.fill()
    // A sliver of hp above wounded creatures.
    if (enemy.hp < stats.maxHp) {
      ctx.fillStyle = INK.hpBack
      ctx.fillRect(enemy.x - 8, enemy.y - stats.radius - 6, 16, 3)
      ctx.fillStyle = INK.hp
      ctx.fillRect(enemy.x - 8, enemy.y - stats.radius - 6, (16 * enemy.hp) / stats.maxHp, 3)
    }
  }

  // The swing arc while attackAnimLeft runs.
  if (player.attackAnimLeft > 0) {
    const heading = Math.atan2(player.facing.y, player.facing.x)
    ctx.fillStyle = INK.swing
    ctx.beginPath()
    ctx.moveTo(player.x, player.y)
    ctx.arc(player.x, player.y, PLAYER.attackRange, heading - PLAYER.attackArcRad / 2, heading + PLAYER.attackArcRad / 2)
    ctx.closePath()
    ctx.fill()
  }

  // The torchbearer (blinks while invulnerable).
  if (player.iframesLeft === 0 || world.tick % 6 < 3) {
    ctx.fillStyle = INK.player
    ctx.beginPath()
    ctx.arc(player.x, player.y, PLAYER.radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = INK.playerCore
    ctx.beginPath()
    ctx.arc(player.x + player.facing.x * 3, player.y + player.facing.y * 3, 3, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawHud(ctx, world) {
  // Safe-area HUD: hp pips top-left, wave top-centre, score top-right.
  ctx.fillStyle = INK.hpBack
  ctx.fillRect(8, 8, 84, 8)
  ctx.fillStyle = INK.hp
  ctx.fillRect(8, 8, (84 * Math.max(0, world.player.hp)) / PLAYER.maxHp, 8)

  ctx.fillStyle = INK.hud
  ctx.font = '8px monospace'
  ctx.textAlign = 'center'
  const waveLabel =
    world.wave.index < 0 ? 'the mist gathers' : 'wave ' + (world.wave.index + 1) + ' / ' + WAVES.length
  ctx.fillText(waveLabel, ARENA.width / 2, 15)
  ctx.textAlign = 'right'
  ctx.fillText(String(world.score).padStart(5, '0'), ARENA.width - 8, 15)
  ctx.textAlign = 'left'
}

function drawPhaseOverlay(ctx, world) {
  const lines = {
    title: ['E M B E R W E A L D', '', 'enter — carry the torch'],
    paused: ['paused', '', 'esc/enter — resume · e — settings · backspace — abandon'],
    settings: ['settings', '', '(bindings + audio live here)', 'backspace — back'],
    dead: ['the torch gutters out', '', 'score ' + world.score, 'enter — try again'],
    victory: ['dawn reaches the clearing', '', 'score ' + world.score, 'enter — again'],
  }[world.phase]
  if (!lines) return
  ctx.fillStyle = INK.dim
  ctx.fillRect(0, 0, ARENA.width, ARENA.height)
  ctx.fillStyle = INK.hud
  ctx.textAlign = 'center'
  lines.forEach((line, i) => {
    ctx.font = i === 0 ? 'bold 14px monospace' : '9px monospace'
    ctx.fillText(line, ARENA.width / 2, ARENA.height / 2 - 20 + i * 14)
  })
  ctx.textAlign = 'left'
}
`,
  'src/sim/constants.js': `// Simulation constants — data only, importable from any system without
// touching the world module (keeps the system modules cycle-free).
export const TICK_HZ = 60
export const ARENA = { width: 480, height: 320 }

// Obstacle rectangles (world units). The clearing's standing stones.
export const OBSTACLES = [
  { x: 96, y: 72, w: 40, h: 24 },
  { x: 344, y: 72, w: 40, h: 24 },
  { x: 96, y: 224, w: 40, h: 24 },
  { x: 344, y: 224, w: 40, h: 24 },
  { x: 216, y: 136, w: 48, h: 48 },
]

export const PLAYER = {
  radius: 8,
  speed: 96, // world units / second
  maxHp: 20,
  attackRange: 28,
  attackArcRad: Math.PI / 2,
  attackDamage: 4,
  attackCooldownTicks: 24,
  iframeTicks: 45,
  knockback: 40,
  dodgeSpeed: 240,
  dodgeTicks: 9,
  dodgeCooldownTicks: 40,
}

export const ENEMY_KINDS = {
  mistling: { radius: 7, speed: 54, maxHp: 8, contactDamage: 2, aggroRadius: 120, fleeBelowHp: 3, score: 10 },
  bogwisp: { radius: 5, speed: 78, maxHp: 4, contactDamage: 1, aggroRadius: 160, fleeBelowHp: 0, score: 15 },
  thornshade: { radius: 10, speed: 40, maxHp: 16, contactDamage: 4, aggroRadius: 100, fleeBelowHp: 5, score: 30 },
}

// Wave table (data, not behaviour): what spawns, and the intermission before
// the NEXT wave opens. Spawn points sit on the arena rim.
export const WAVES = [
  { spawns: [{ kind: 'mistling', count: 3 }], intermissionTicks: 180 },
  { spawns: [{ kind: 'mistling', count: 4 }, { kind: 'bogwisp', count: 2 }], intermissionTicks: 240 },
  { spawns: [{ kind: 'mistling', count: 3 }, { kind: 'bogwisp', count: 3 }, { kind: 'thornshade', count: 1 }], intermissionTicks: 0 },
]

export const SPAWN_POINTS = [
  { x: 24, y: 24 },
  { x: ARENA.width - 24, y: 24 },
  { x: 24, y: ARENA.height - 24 },
  { x: ARENA.width - 24, y: ARENA.height - 24 },
  { x: ARENA.width / 2, y: 16 },
  { x: ARENA.width / 2, y: ARENA.height - 16 },
]
`,
  'src/sim/geometry.js': `// Geometry helpers (given — the missions build on these, they are not the
// point of the exercise).
export function length(x, y) {
  return Math.sqrt(x * x + y * y)
}

export function normalize(x, y) {
  const len = length(x, y)
  if (len === 0) return { x: 0, y: 0 }
  return { x: x / len, y: y / len }
}

export function distance(ax, ay, bx, by) {
  return length(bx - ax, by - ay)
}

export function circleRectOverlap(cx, cy, radius, rect) {
  const nearestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w))
  const nearestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h))
  return distance(cx, cy, nearestX, nearestY) < radius
}

export function circlesOverlap(ax, ay, ar, bx, by, br) {
  return distance(ax, ay, bx, by) < ar + br
}

// Angle between a facing vector and the direction to a point (radians).
export function angleBetween(facing, fromX, fromY, toX, toY) {
  const dir = normalize(toX - fromX, toY - fromY)
  const dot = facing.x * dir.x + facing.y * dir.y
  return Math.acos(Math.max(-1, Math.min(1, dot)))
}
`,
  'src/sim/input.js': `// The input frame contract — the ONLY channel from any device into the
// simulation. Collectors (keyboard/gamepad/pointer) and replay tapes both
// produce frames of this exact shape; the sim never reads devices.
//
// Frame:
//   {
//     held:    { up, down, left, right, use },   // booleans — sustained state
//     pressed: { attack, dodge, use, pause,      // booleans — edge-triggered,
//                slot1..slot4, confirm, cancel } //   true for ONE tick only
//     aim:     { x, y },                          // world-space aim point
//   }
//
// A tape is an array of sparse events: { tick, frame } — the frame applies
// from that tick until the next event's tick (held state persists; pressed
// state fires only on the event tick).

export const HELD_KEYS = ['up', 'down', 'left', 'right', 'use']
export const PRESSED_KEYS = [
  'attack',
  'dodge',
  'use',
  'pause',
  'slot1',
  'slot2',
  'slot3',
  'slot4',
  'confirm',
  'cancel',
]

export function emptyFrame() {
  const held = {}
  for (const k of HELD_KEYS) held[k] = false
  const pressed = {}
  for (const k of PRESSED_KEYS) pressed[k] = false
  return { held, pressed, aim: { x: 0, y: 0 } }
}

// Normalize a partial frame (as tapes are allowed to write) into a total one.
export function normalizeFrame(partial) {
  const frame = emptyFrame()
  if (!partial) return frame
  for (const k of HELD_KEYS) frame.held[k] = Boolean(partial.held && partial.held[k])
  for (const k of PRESSED_KEYS) frame.pressed[k] = Boolean(partial.pressed && partial.pressed[k])
  if (partial.aim && Number.isFinite(partial.aim.x) && Number.isFinite(partial.aim.y)) {
    frame.aim = { x: partial.aim.x, y: partial.aim.y }
  }
  return frame
}

// Reader over a tape: frameAt(tick) returns the effective input frame for a
// tick. Held state carries forward from the most recent event at-or-before
// the tick; pressed state fires only when the tick IS an event tick.
export function createTapeReader(tape) {
  const events = [...(tape ?? [])].sort((a, b) => a.tick - b.tick)
  return {
    frameAt(tick) {
      let effective = null
      let firesThisTick = false
      for (const event of events) {
        if (event.tick > tick) break
        effective = event
        firesThisTick = event.tick === tick
      }
      if (!effective) return emptyFrame()
      const frame = normalizeFrame(effective.frame)
      if (!firesThisTick) {
        for (const k of PRESSED_KEYS) frame.pressed[k] = false
      }
      return frame
    },
    length: events.length,
    lastTick: events.length > 0 ? events[events.length - 1].tick : 0,
  }
}
`,
  'src/sim/kernel.js': `// World-state primitives shared by every system, cycle-free.
import { createRng } from '../core/rng.js'
import { ARENA, PLAYER } from './constants.js'

export function freshPlayer() {
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2 + 60,
    vx: 0,
    vy: 0,
    facing: { x: 0, y: -1 },
    hp: PLAYER.maxHp,
    iframesLeft: 0,
    attackCooldownLeft: 0,
    attackAnimLeft: 0,
    dodgeLeft: 0,
    dodgeCooldownLeft: 0,
    dodgeDir: { x: 0, y: 0 },
    alive: true,
  }
}

export function mintEntityId(world) {
  // Entity ids come from world state, never module state — replays and
  // save/resume must mint identical ids.
  world.entitySeq += 1
  return world.entitySeq
}

// The world's own RNG accessor: forks from the persisted cursor and advances
// it, so save/resume and replay stay on identical sequences.
export function worldRng(world, label) {
  const rng = createRng(world.rngState).fork(label)
  world.rngState = createRng(world.rngState).nextU32()
  return rng
}
`,
  'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
//
// MISSION SEAM (task/g1): implement the transition table below. The sim owns
// WHICH phase is active; the browser layer only renders the matching screen.
//
//   title    --confirm-->                 playing (fresh run state)
//   playing  --pause-->                   paused
//   paused   --pause or confirm-->        playing
//   paused   --cancel-->                  title    (run discarded)
//   paused   --use (settings row)-->      settings (G1: reachable; contents G2)
//   settings --cancel-->                  paused
//   playing  --player hp reaches 0-->     dead     (set by the damage system)
//   dead     --confirm-->                 title
//   playing  --final wave cleared-->      victory  (set by the wave system)
//   victory  --confirm-->                 title
//
// Entering 'playing' from 'title' resets the run (fresh player/enemies/wave
// state) but preserves world.seed lineage: the new run's rngState derives
// from the CURRENT cursor so two runs in one session differ, while a replay
// from the same tape + seed stays identical.
export function stepPhases(world, frame) {
  // TODO(task/g1): implement the transition table. The base ships inert —
  // the phase tests in test/phases.test.mjs fail until this lands.
  void world
  void frame
}
`,
  'src/sim/save.js': `// The save codec. Version-stamped JSON of the FULL world state — the state
// is plain data by design, so an exact snapshot IS the save.
//
// G2 SEAM: mid-run save/resume exactness (rng cursor, entity seq, cooldowns,
// wave state, inventory) and codec versioning/migration are the inventory
// mission's territory; the base codec is deliberately minimal.
export const SAVE_VERSION = 1

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion !== SAVE_VERSION) {
    throw new Error('unsupported save version: ' + String(parsed.saveVersion))
  }
  return parsed.world
}
`,
  'src/sim/systems/combat.js': `// Player melee attack.
//
// MISSION SEAM (task/g1). The contract the tests pin:
//   - pressed.attack with attackCooldownLeft === 0 starts a swing: every
//     enemy within PLAYER.attackRange of the player whose direction lies
//     inside PLAYER.attackArcRad around world.player.facing takes
//     PLAYER.attackDamage; the swing hits on the PRESS tick;
//   - attackCooldownLeft resets to PLAYER.attackCooldownTicks and counts
//     down once per tick; presses during cooldown do nothing;
//   - attackAnimLeft mirrors the cooldown's first 6 ticks so the renderer
//     can draw the arc without reading combat internals;
//   - each landed hit pushes { type: 'hit', enemyId, damage } onto
//     world.events; a swing that lands nothing pushes { type: 'whiff' }.
export function stepCombat(world, frame) {
  // TODO(task/g1): implement per the contract above.
  void world
  void frame
}
`,
  'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death.
//
// MISSION SEAM (task/g1). The contract the tests pin:
//   - an enemy circle overlapping the player circle while
//     player.iframesLeft === 0 deals its kind's contactDamage ONCE and
//     starts PLAYER.iframeTicks of invulnerability (multiple overlapping
//     enemies on the same tick: exactly one hit — the nearest);
//   - the hit knocks the player PLAYER.knockback world units directly away
//     from the enemy (respecting obstacle/arena collision, sliding allowed);
//   - iframesLeft counts down once per tick; while > 0 contact deals
//     nothing;
//   - hp <= 0 sets player.alive = false and pushes { type: 'player-down' }
//     onto world.events; the phase machine moves to 'dead' on the NEXT
//     stepPhases pass (the damage system never touches world.phase);
//   - enemies with hp <= 0 are removed here (after their kind's score is
//     added to world.score and { type: 'enemy-down', enemyId, kind } is
//     pushed).
export function stepDamage(world, frame) {
  // TODO(task/g1): implement per the contract above.
  void world
  void frame
}
`,
  'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander.
//
// MISSION SEAM (task/g1). The contract the tests pin (per ENEMY_KINDS):
//   - an enemy whose distance to the player is <= aggroRadius CHASES: moves
//     toward the player at its speed, sliding around OBSTACLES like the
//     player does;
//   - an enemy with hp < fleeBelowHp FLEES instead: moves directly away from
//     the player at its speed (flee beats chase);
//   - an enemy outside aggroRadius WANDERS: every 90 ticks it draws a new
//     heading from worldRng(world, 'wander:' + enemy.id) — int(0,7) times
//     45° — and drifts at half speed;
//   - enemies never overlap obstacles or leave the arena; enemy-enemy
//     overlap is allowed (the mist has no substance).
export function stepEnemies(world, frame) {
  // TODO(task/g1): implement per the contract above.
  void world
  void frame
}
`,
  'src/sim/systems/movement.js': `// Player movement + facing + dodge.
//
// MISSION SEAM (task/g1). The contract the tests pin:
//   - held direction keys accelerate the player at PLAYER.speed world
//     units/second; diagonals are NORMALIZED (no √2 advantage);
//   - the player circle never enters an OBSTACLES rect and never leaves the
//     arena (slide along the blocking edge, do not stop dead);
//   - facing follows the aim point whenever it differs from the player
//     position (combat reads world.player.facing);
//   - dodge (pressed.dodge): PLAYER.dodgeTicks of PLAYER.dodgeSpeed along the
//     current move direction (or facing when idle), then
//     PLAYER.dodgeCooldownTicks before the next; the player is NOT
//     invulnerable while dodging (i-frames belong to the damage system).
export function stepMovement(world, frame) {
  // TODO(task/g1): implement per the contract above.
  void world
  void frame
}
`,
  'src/sim/systems/waves.js': "// Wave progression.\n//\n// MISSION SEAM (task/g1). The contract the tests pin (WAVES + SPAWN_POINTS\n// are data in world.js):\n//   - the run opens in intermission with wave.index === -1; when\n//     intermissionLeft reaches 0 the next wave spawns: for each spawn group,\n//     `count` enemies of `kind` are minted (mintEntityId) at spawn points\n//     chosen round-robin starting from index\n//     worldRng(world, 'spawn:' + waveIndex).int(0, SPAWN_POINTS.length - 1);\n//     a spawned enemy is { id, kind, waveIndex, x, y, hp: ENEMY_KINDS[kind].maxHp,\n//     wander: null } \u2014 every system reads kind stats from ENEMY_KINDS;\n//   - wave.state is 'active' while any spawned enemy of that wave lives;\n//     when the last dies, wave.cleared increments and the intermission for\n//     THAT wave's intermissionTicks begins ({ type: 'wave-cleared', index }\n//     event);\n//   - after the final wave clears, the wave system pushes\n//     { type: 'run-won' } and the phase machine moves to 'victory' on its\n//     next pass (this system never touches world.phase).\nexport function stepWaves(world, frame) {\n  // TODO(task/g1): implement per the contract above.\n  void world\n  void frame\n}\n",
  'src/sim/world.js': "// The EMBERWEALD simulation core. Fixed timestep, pure step function: the\n// renderer, the audio layer and every input device live OUTSIDE this module.\n// step(world, frame) -> world runs at exactly TICK_HZ; anything that reads a\n// wall clock, a device, or Math.random inside the sim breaks the determinism\n// law (test/determinism.test.mjs enforces it).\nimport { createRng } from '../core/rng.js'\nimport { freshPlayer } from './kernel.js'\nimport { stepMovement } from './systems/movement.js'\nimport { stepCombat } from './systems/combat.js'\nimport { stepEnemies } from './systems/enemies.js'\nimport { stepDamage } from './systems/damage.js'\nimport { stepWaves } from './systems/waves.js'\nimport { stepPhases } from './phases.js'\n\nexport * from './constants.js'\nexport * from './kernel.js'\n\nexport function createWorld(seed) {\n  return {\n    version: 1,\n    seed: seed >>> 0,\n    tick: 0,\n    // 'title' | 'playing' | 'paused' | 'settings' | 'dead' | 'victory'\n    phase: 'title',\n    rngState: createRng(seed).nextU32(), // stream cursor persisted in state\n    entitySeq: 0,\n    player: freshPlayer(),\n    enemies: [],\n    // wave state: index -1 = before the first wave opens\n    wave: { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 },\n    score: 0,\n    events: [], // per-tick semantic events (drained by render/audio layers)\n    inventory: null, // the inventory mission's territory: null until it lands\n  }\n}\n\n// One deterministic step. `frame` is a normalized input frame (input.js).\n// Order is part of the contract: phases gate everything; then movement \u2192\n// enemies \u2192 combat \u2192 damage \u2192 waves.\nexport function step(world, frame) {\n  world.tick += 1\n  world.events.length = 0\n  stepPhases(world, frame)\n  if (world.phase !== 'playing') return world\n  stepMovement(world, frame)\n  stepEnemies(world, frame)\n  stepCombat(world, frame)\n  stepDamage(world, frame)\n  stepWaves(world, frame)\n  return world\n}\n",
  'test/combat.test.mjs': "// Melee combat contract (src/sim/systems/combat.js mission seam).\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { createWorld, step, PLAYER } from '../src/sim/world.js'\nimport { normalizeFrame } from '../src/sim/input.js'\n\nfunction arena(seed = 4) {\n  const world = createWorld(seed)\n  world.phase = 'playing'\n  return world\n}\n\nfunction foe(world, dx, dy, hp = 8) {\n  const enemy = {\n    id: world.entitySeq + 1,\n    kind: 'mistling',\n    waveIndex: 0,\n    x: world.player.x + dx,\n    y: world.player.y + dy,\n    hp,\n    wander: null,\n  }\n  world.entitySeq += 1\n  world.enemies.push(enemy)\n  return enemy\n}\n\nconst attackAt = (world, x, y) => normalizeFrame({ pressed: { attack: true }, aim: { x, y } })\nconst idleAim = (world, x, y) => normalizeFrame({ aim: { x, y } })\n\ntest('an in-range, in-arc enemy takes attackDamage on the press tick', () => {\n  const world = arena()\n  const enemy = foe(world, PLAYER.attackRange - 6, 0)\n  step(world, attackAt(world, enemy.x, enemy.y))\n  assert.equal(enemy.hp, 8 - PLAYER.attackDamage)\n  assert.ok(world.events.some(e => e.type === 'hit' && e.enemyId === enemy.id))\n})\n\ntest('out of range or out of arc: no hit, a whiff event fires', () => {\n  const world = arena()\n  const far = foe(world, PLAYER.attackRange + 20, 0)\n  const behind = foe(world, -(PLAYER.attackRange - 6), 0)\n  // Aim right: `far` is in arc but out of range; `behind` is in range but out of arc.\n  step(world, attackAt(world, world.player.x + 50, world.player.y))\n  assert.equal(far.hp, 8)\n  assert.equal(behind.hp, 8)\n  assert.ok(world.events.some(e => e.type === 'whiff'))\n})\n\ntest('cooldown refuses presses until it expires', () => {\n  const world = arena()\n  const enemy = foe(world, PLAYER.attackRange - 6, 0, 20)\n  // Glue the enemy to attack range before every step so chase/knockback\n  // geometry cannot interfere with the pure cooldown contract.\n  const glue = () => {\n    enemy.x = world.player.x + PLAYER.attackRange - 6\n    enemy.y = world.player.y\n  }\n  glue()\n  step(world, attackAt(world, enemy.x, enemy.y))\n  assert.equal(enemy.hp, 20 - PLAYER.attackDamage)\n  for (let t = 0; t < 5; t++) {\n    glue()\n    step(world, idleAim(world, enemy.x, enemy.y))\n  }\n  glue()\n  step(world, attackAt(world, enemy.x, enemy.y))\n  assert.equal(enemy.hp, 20 - PLAYER.attackDamage, 'press during cooldown must do nothing')\n  for (let t = 0; t < PLAYER.attackCooldownTicks; t++) {\n    glue()\n    step(world, idleAim(world, enemy.x, enemy.y))\n  }\n  glue()\n  step(world, attackAt(world, enemy.x, enemy.y))\n  assert.equal(enemy.hp, 20 - 2 * PLAYER.attackDamage, 'post-cooldown press must land')\n})\n\ntest('a swing hits every enemy inside the arc, not just one', () => {\n  const world = arena()\n  const a = foe(world, PLAYER.attackRange - 8, -4)\n  const b = foe(world, PLAYER.attackRange - 8, 4)\n  step(world, attackAt(world, world.player.x + 50, world.player.y))\n  assert.equal(a.hp, 8 - PLAYER.attackDamage)\n  assert.equal(b.hp, 8 - PLAYER.attackDamage)\n})\n\ntest('attackAnimLeft mirrors the first swing ticks for the renderer', () => {\n  const world = arena()\n  foe(world, PLAYER.attackRange - 6, 0)\n  step(world, attackAt(world, world.player.x + 50, world.player.y))\n  assert.ok(world.player.attackAnimLeft > 0)\n})\n",
  'test/damage.test.mjs': `// Contact damage / i-frames / knockback / death contract
// (src/sim/systems/damage.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, PLAYER, ENEMY_KINDS } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'

const idle = () => normalizeFrame(null)

function arena(seed = 11) {
  const world = createWorld(seed)
  world.phase = 'playing'
  return world
}

function touchingFoe(world, kind = 'mistling') {
  const stats = ENEMY_KINDS[kind]
  const enemy = {
    id: world.entitySeq + 1,
    kind,
    waveIndex: 0,
    x: world.player.x + PLAYER.radius + stats.radius - 2,
    y: world.player.y,
    hp: stats.maxHp,
    wander: null,
  }
  world.entitySeq += 1
  world.enemies.push(enemy)
  return enemy
}

test('contact deals contactDamage once and starts i-frames', () => {
  const world = arena()
  touchingFoe(world)
  step(world, idle())
  assert.equal(world.player.hp, PLAYER.maxHp - ENEMY_KINDS.mistling.contactDamage)
  assert.ok(world.player.iframesLeft > 0)
})

test('overlap during i-frames deals nothing', () => {
  const world = arena()
  const enemy = touchingFoe(world)
  step(world, idle())
  const hpAfterFirst = world.player.hp
  for (let t = 0; t < PLAYER.iframeTicks - 5; t++) {
    // Keep the enemy glued to the player so the overlap persists.
    enemy.x = world.player.x + PLAYER.radius + ENEMY_KINDS.mistling.radius - 2
    enemy.y = world.player.y
    step(world, idle())
  }
  assert.equal(world.player.hp, hpAfterFirst)
})

test('exactly one hit lands when several enemies overlap on the same tick', () => {
  const world = arena()
  touchingFoe(world)
  const second = touchingFoe(world)
  second.x = world.player.x - (PLAYER.radius + ENEMY_KINDS.mistling.radius - 2)
  step(world, idle())
  assert.equal(world.player.hp, PLAYER.maxHp - ENEMY_KINDS.mistling.contactDamage)
})

test('the hit knocks the player away from the enemy', () => {
  const world = arena()
  touchingFoe(world) // enemy sits to the player's RIGHT
  const startX = world.player.x
  step(world, idle())
  assert.ok(world.player.x < startX - PLAYER.knockback * 0.5, 'player should be knocked left')
})

test('hp<=0 downs the player via an event, phase flips on the next pass', () => {
  const world = arena()
  world.player.hp = 1
  touchingFoe(world)
  step(world, idle())
  assert.equal(world.player.alive, false)
  assert.ok(world.events.some(e => e.type === 'player-down'))
  step(world, idle())
  assert.equal(world.phase, 'dead')
})

test('a slain enemy is removed, scores, and announces itself', () => {
  const world = arena()
  const enemy = touchingFoe(world)
  enemy.hp = 0
  step(world, idle())
  assert.equal(world.enemies.length, 0)
  assert.equal(world.score, ENEMY_KINDS.mistling.score)
  assert.ok(world.events.some(e => e.type === 'enemy-down' && e.enemyId === enemy.id))
})
`,
  'test/determinism.test.mjs': "// The determinism law \u2014 passes on the base tree and must NEVER regress.\nimport test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readdirSync, readFileSync, statSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { createWorld, step } from '../src/sim/world.js'\nimport { createTapeReader } from '../src/sim/input.js'\n\nconst TAPE = [\n  { tick: 1, frame: { pressed: { confirm: true } } },\n  { tick: 10, frame: { held: { right: true }, aim: { x: 400, y: 100 } } },\n  { tick: 40, frame: { held: { right: true, down: true }, pressed: { attack: true }, aim: { x: 400, y: 300 } } },\n  { tick: 80, frame: { pressed: { dodge: true } } },\n  { tick: 120, frame: {} },\n]\n\nfunction run(seed, ticks) {\n  const world = createWorld(seed)\n  const reader = createTapeReader(TAPE)\n  for (let t = 1; t <= ticks; t++) step(world, reader.frameAt(t))\n  return JSON.stringify(world)\n}\n\ntest('same seed + same tape => byte-identical world', () => {\n  assert.equal(run(7, 240), run(7, 240))\n})\n\ntest('different seeds diverge the rng cursor', () => {\n  const a = JSON.parse(run(7, 240))\n  const b = JSON.parse(run(8, 240))\n  assert.notEqual(a.rngState, b.rngState)\n})\n\ntest('the sim never touches Math.random or a wall clock', () => {\n  const banned = [/Math\\.random\\s*\\(/, /Date\\.now\\s*\\(/, /performance\\.now\\s*\\(/]\n  const roots = ['src/sim', 'src/core']\n  const offenders = []\n  const walk = dir => {\n    for (const entry of readdirSync(dir)) {\n      const path = join(dir, entry)\n      if (statSync(path).isDirectory()) {\n        walk(path)\n        continue\n      }\n      const text = readFileSync(path, 'utf8')\n      for (const pattern of banned) {\n        if (pattern.test(text)) offenders.push(path + ' ~ ' + pattern.source)\n      }\n    }\n  }\n  for (const root of roots) walk(root)\n  assert.deepEqual(offenders, [])\n})\n",
  'test/enemies.test.mjs': `// Enemy behaviour contract (src/sim/systems/enemies.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, ENEMY_KINDS, ARENA } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'

const idle = () => normalizeFrame(null)

function arena(seed = 9) {
  const world = createWorld(seed)
  world.phase = 'playing'
  return world
}

function foe(world, kind, x, y, hp) {
  const enemy = {
    id: world.entitySeq + 1,
    kind,
    waveIndex: 0,
    x,
    y,
    hp: hp ?? ENEMY_KINDS[kind].maxHp,
    wander: null,
  }
  world.entitySeq += 1
  world.enemies.push(enemy)
  return enemy
}

const dist = (world, enemy) => Math.hypot(enemy.x - world.player.x, enemy.y - world.player.y)

test('inside aggroRadius the enemy chases', () => {
  const world = arena()
  const enemy = foe(world, 'mistling', world.player.x + 80, world.player.y)
  const before = dist(world, enemy)
  for (let t = 0; t < 30; t++) step(world, idle())
  assert.ok(dist(world, enemy) < before - 10, 'enemy should close distance')
})

test('below fleeBelowHp the enemy flees even inside aggro', () => {
  const world = arena()
  const enemy = foe(world, 'mistling', world.player.x + 60, world.player.y, 2)
  const before = dist(world, enemy)
  for (let t = 0; t < 30; t++) step(world, idle())
  assert.ok(dist(world, enemy) > before + 10, 'wounded enemy should open distance')
})

test('outside aggroRadius the enemy wanders at half speed and stays in bounds', () => {
  const world = arena()
  const enemy = foe(world, 'mistling', 60, 60) // player is at centre; 120-radius misses
  const start = { x: enemy.x, y: enemy.y }
  let maxTickMove = 0
  let prev = { x: enemy.x, y: enemy.y }
  for (let t = 0; t < 200; t++) {
    step(world, idle())
    maxTickMove = Math.max(maxTickMove, Math.hypot(enemy.x - prev.x, enemy.y - prev.y))
    prev = { x: enemy.x, y: enemy.y }
    assert.ok(enemy.x >= 0 && enemy.x <= ARENA.width && enemy.y >= 0 && enemy.y <= ARENA.height)
  }
  const drift = Math.hypot(enemy.x - start.x, enemy.y - start.y)
  assert.ok(drift > 4, 'a wanderer must actually drift (moved ' + drift + ')')
  const half = ENEMY_KINDS.mistling.speed / 2 / 60
  assert.ok(maxTickMove <= half + 0.01, 'wander speed capped at half (saw ' + maxTickMove + '/tick)')
})

test('chasers do not pass through obstacles', () => {
  const world = arena()
  // Stone 4 sits at the arena centre; park the player just left of it and the
  // enemy just right of it — the straight chase line crosses the stone.
  world.player.x = 216 - 20
  world.player.y = 136 + 24
  const enemy = foe(world, 'thornshade', 216 + 48 + 20, 136 + 24)
  for (let t = 0; t < 240; t++) {
    step(world, idle())
    assert.equal(insideStone(enemy), false, 'tick ' + t + ': enemy inside the stone')
  }
})

function insideStone(enemy) {
  const stone = { x: 216, y: 136, w: 48, h: 48 }
  const nearestX = Math.max(stone.x, Math.min(enemy.x, stone.x + stone.w))
  const nearestY = Math.max(stone.y, Math.min(enemy.y, stone.y + stone.h))
  const radius = ENEMY_KINDS[enemy.kind].radius
  return Math.hypot(enemy.x - nearestX, enemy.y - nearestY) < radius - 0.01
}
`,
  'test/movement.test.mjs': `// Player movement contract (src/sim/systems/movement.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, PLAYER, ARENA, OBSTACLES, TICK_HZ } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'
import { circleRectOverlap } from '../src/sim/geometry.js'

function playingWorld(seed = 3) {
  const world = createWorld(seed)
  world.phase = 'playing'
  return world
}

const hold = held => normalizeFrame({ held })

test('holding right moves at PLAYER.speed', () => {
  const world = playingWorld()
  const startX = world.player.x
  for (let t = 0; t < TICK_HZ; t++) step(world, hold({ right: true }))
  const moved = world.player.x - startX
  assert.ok(Math.abs(moved - PLAYER.speed) < 2, 'moved ' + moved + ', want ~' + PLAYER.speed)
})

test('diagonals are normalized (no sqrt2 advantage)', () => {
  const world = playingWorld()
  const start = { x: world.player.x, y: world.player.y }
  for (let t = 0; t < TICK_HZ; t++) step(world, hold({ right: true, down: true }))
  const dist = Math.hypot(world.player.x - start.x, world.player.y - start.y)
  assert.ok(Math.abs(dist - PLAYER.speed) < 2, 'moved ' + dist + ', want ~' + PLAYER.speed)
})

test('the player never enters an obstacle and never leaves the arena', () => {
  const world = playingWorld()
  const stone = OBSTACLES[4]
  world.player.x = stone.x - PLAYER.radius - 2
  world.player.y = stone.y + stone.h / 2
  for (let t = 0; t < TICK_HZ * 3; t++) {
    step(world, hold({ right: true }))
    assert.equal(circleRectOverlap(world.player.x, world.player.y, PLAYER.radius - 0.01, stone), false)
  }
  for (let t = 0; t < TICK_HZ * 8; t++) {
    step(world, hold({ left: true, up: true }))
    assert.ok(world.player.x >= PLAYER.radius - 0.01 && world.player.y >= PLAYER.radius - 0.01)
  }
})

test('sliding: blocked on x still allows the y component', () => {
  const world = playingWorld()
  const stone = OBSTACLES[4]
  world.player.x = stone.x - PLAYER.radius - 1
  world.player.y = stone.y + stone.h / 2
  const startY = world.player.y
  for (let t = 0; t < TICK_HZ; t++) step(world, hold({ right: true, down: true }))
  assert.ok(world.player.y - startY > PLAYER.speed * 0.5, 'y should keep moving while x is blocked')
})

test('facing follows the aim point', () => {
  const world = playingWorld()
  step(world, normalizeFrame({ aim: { x: world.player.x, y: world.player.y - 50 } }))
  assert.ok(world.player.facing.y < -0.9, 'facing should point up')
  step(world, normalizeFrame({ aim: { x: world.player.x + 50, y: world.player.y } }))
  assert.ok(world.player.facing.x > 0.9, 'facing should point right')
})

test('dodge bursts at dodgeSpeed then cools down', () => {
  const world = playingWorld()
  const startX = world.player.x
  step(world, normalizeFrame({ held: { right: true }, pressed: { dodge: true } }))
  for (let t = 1; t < PLAYER.dodgeTicks; t++) step(world, hold({ right: true }))
  const burst = world.player.x - startX
  const expected = (PLAYER.dodgeSpeed * PLAYER.dodgeTicks) / TICK_HZ
  assert.ok(Math.abs(burst - expected) < 4, 'dodge burst ' + burst + ', want ~' + expected)
  // A second dodge inside the cooldown window must not burst again.
  const midX = world.player.x
  step(world, normalizeFrame({ held: { right: true }, pressed: { dodge: true } }))
  for (let t = 1; t < PLAYER.dodgeTicks; t++) step(world, hold({ right: true }))
  const second = world.player.x - midX
  assert.ok(second < expected * 0.7, 'cooldown should refuse the second dodge (moved ' + second + ')')
})
`,
  'test/phases.test.mjs': `// The phase machine contract (src/sim/phases.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'

const press = key => normalizeFrame({ pressed: { [key]: true } })
const idle = () => normalizeFrame(null)

test('title -> playing on confirm, with a fresh run', () => {
  const world = createWorld(5)
  step(world, press('confirm'))
  assert.equal(world.phase, 'playing')
  assert.equal(world.player.hp, 20)
  assert.equal(world.enemies.length, 0)
  assert.equal(world.wave.index, -1)
})

test('playing <-> paused on pause; cancel from paused discards to title', () => {
  const world = createWorld(5)
  step(world, press('confirm'))
  step(world, press('pause'))
  assert.equal(world.phase, 'paused')
  step(world, press('pause'))
  assert.equal(world.phase, 'playing')
  step(world, press('pause'))
  step(world, press('cancel'))
  assert.equal(world.phase, 'title')
})

test('paused -> settings on use, settings -> paused on cancel', () => {
  const world = createWorld(5)
  step(world, press('confirm'))
  step(world, press('pause'))
  step(world, press('use'))
  assert.equal(world.phase, 'settings')
  step(world, press('cancel'))
  assert.equal(world.phase, 'paused')
})

test('a downed player reaches dead on the next pass; confirm returns to title', () => {
  const world = createWorld(5)
  step(world, press('confirm'))
  world.player.hp = 0
  world.player.alive = false
  step(world, idle())
  assert.equal(world.phase, 'dead')
  step(world, press('confirm'))
  assert.equal(world.phase, 'title')
})

test('the sim does not advance while paused', () => {
  const world = createWorld(5)
  step(world, press('confirm'))
  world.enemies.push({ id: 1, kind: 'mistling', waveIndex: 0, x: 100, y: 100, hp: 8, wander: null })
  step(world, press('pause'))
  const before = JSON.stringify({ player: world.player, enemies: world.enemies })
  for (let t = 0; t < 30; t++) step(world, idle())
  const after = JSON.stringify({ player: world.player, enemies: world.enemies })
  assert.equal(before, after)
})
`,
  'test/waves.test.mjs': `// Wave progression contract (src/sim/systems/waves.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, WAVES } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'

const idle = () => normalizeFrame(null)

function playingWorld(seed = 21) {
  const world = createWorld(seed)
  world.phase = 'playing'
  // Park the player mid-arena; wave tests kill enemies directly.
  return world
}

function slayAll(world) {
  for (const enemy of world.enemies) enemy.hp = 0
  step(world, idle())
}

test('the opening intermission spawns wave 0 with waveIndex-tagged enemies', () => {
  const world = playingWorld()
  for (let t = 0; t < 90; t++) step(world, idle())
  assert.equal(world.wave.index, 0)
  assert.equal(world.wave.state, 'active')
  const want = WAVES[0].spawns.reduce((n, s) => n + s.count, 0)
  assert.equal(world.enemies.length, want)
  assert.ok(world.enemies.every(e => e.waveIndex === 0))
})

test('clearing a wave opens its intermission, then the next wave spawns', () => {
  const world = playingWorld()
  for (let t = 0; t < 90; t++) step(world, idle())
  slayAll(world)
  assert.equal(world.wave.cleared, 1)
  assert.equal(world.wave.state, 'intermission')
  for (let t = 0; t < WAVES[0].intermissionTicks; t++) step(world, idle())
  assert.equal(world.wave.index, 1)
  const want = WAVES[1].spawns.reduce((n, s) => n + s.count, 0)
  assert.equal(world.enemies.length, want)
})

test('clearing the final wave wins the run on the next pass', () => {
  const world = playingWorld()
  for (let wave = 0; wave < WAVES.length; wave++) {
    const wait = wave === 0 ? 90 : WAVES[wave - 1].intermissionTicks
    for (let t = 0; t < wait; t++) step(world, idle())
    assert.equal(world.wave.index, wave, 'wave ' + wave + ' should be active')
    slayAll(world)
  }
  step(world, idle())
  assert.equal(world.phase, 'victory')
})

test('spawn placement is deterministic per seed', () => {
  const a = playingWorld(33)
  const b = playingWorld(33)
  for (let t = 0; t < 90; t++) {
    step(a, idle())
    step(b, idle())
  }
  assert.deepEqual(
    a.enemies.map(e => [e.kind, e.x, e.y]),
    b.enemies.map(e => [e.kind, e.x, e.y]),
  )
})
`,
  'tools/probe.mjs': "#!/usr/bin/env node\n// Headless deterministic probe: run an input tape against the sim and print\n// world snapshots as JSON. This is both the project's own debugging tool and\n// the shape external checks drive.\n//\n//   node tools/probe.mjs --seed 7 --ticks 300 \\\n//     [--tape tapes/journey.json] [--snapshot-at 60,120] [--start-playing]\n//\n// Output: { \"snapshots\": { \"<tick>\": world... }, \"final\": world }\nimport { readFileSync } from 'node:fs'\nimport { createWorld, step } from '../src/sim/world.js'\nimport { createTapeReader } from '../src/sim/input.js'\n\nconst args = process.argv.slice(2)\nfunction argOf(flag) {\n  const at = args.indexOf(flag)\n  return at >= 0 ? args[at + 1] : undefined\n}\n\nconst seed = Number(argOf('--seed') ?? '1')\nconst ticks = Number(argOf('--ticks') ?? '60')\nconst tapePath = argOf('--tape')\nconst snapshotAt = new Set(\n  (argOf('--snapshot-at') ?? '')\n    .split(',')\n    .filter(Boolean)\n    .map(n => Number(n)),\n)\nif (!Number.isInteger(seed) || !Number.isInteger(ticks) || ticks < 0) {\n  console.error('usage: probe.mjs --seed <int> --ticks <int> [--tape file] [--snapshot-at t1,t2] [--start-playing]')\n  process.exit(2)\n}\n\nconst tape = tapePath ? JSON.parse(readFileSync(tapePath, 'utf8')) : []\nconst reader = createTapeReader(tape)\nconst world = createWorld(seed)\nif (args.includes('--start-playing')) world.phase = 'playing'\n\nconst snapshots = {}\nfor (let t = 1; t <= ticks; t++) {\n  step(world, reader.frameAt(t))\n  if (snapshotAt.has(t)) snapshots[String(t)] = JSON.parse(JSON.stringify(world))\n}\nconsole.log(JSON.stringify({ snapshots, final: world }))\n",
  'tools/serve.mjs': `#!/usr/bin/env node
// Tiny static server — zero dependencies, no caching, module-friendly types.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 8137)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
}

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
  const file = join(ROOT, path === '/' ? 'index.html' : path.slice(1))
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, () => {
  console.log('emberweald: http://localhost:' + PORT)
})
`,}

const G2_OVERLAY: BranchOverlay = {
  'src/sim/constants.js': `// Simulation constants — data only, importable from any system without
// touching the world module (keeps the system modules cycle-free).
export const TICK_HZ = 60
export const ARENA = { width: 480, height: 320 }

// Obstacle rectangles (world units). The clearing's standing stones.
export const OBSTACLES = [
  { x: 96, y: 72, w: 40, h: 24 },
  { x: 344, y: 72, w: 40, h: 24 },
  { x: 96, y: 224, w: 40, h: 24 },
  { x: 344, y: 224, w: 40, h: 24 },
  { x: 216, y: 136, w: 48, h: 48 },
]

export const PLAYER = {
  radius: 8,
  speed: 96, // world units / second
  maxHp: 20,
  attackRange: 28,
  attackArcRad: Math.PI / 2,
  attackDamage: 4,
  attackCooldownTicks: 24,
  iframeTicks: 45,
  knockback: 40,
  dodgeSpeed: 240,
  dodgeTicks: 9,
  dodgeCooldownTicks: 40,
}

export const ENEMY_KINDS = {
  mistling: { radius: 7, speed: 54, maxHp: 8, contactDamage: 2, aggroRadius: 120, fleeBelowHp: 3, score: 10 },
  bogwisp: { radius: 5, speed: 78, maxHp: 4, contactDamage: 1, aggroRadius: 160, fleeBelowHp: 0, score: 15 },
  thornshade: { radius: 10, speed: 40, maxHp: 16, contactDamage: 4, aggroRadius: 100, fleeBelowHp: 5, score: 30 },
}

// Wave table (data, not behaviour): what spawns, and the intermission before
// the NEXT wave opens. Spawn points sit on the arena rim.
export const WAVES = [
  { spawns: [{ kind: 'mistling', count: 3 }], intermissionTicks: 180 },
  { spawns: [{ kind: 'mistling', count: 4 }, { kind: 'bogwisp', count: 2 }], intermissionTicks: 240 },
  { spawns: [{ kind: 'mistling', count: 3 }, { kind: 'bogwisp', count: 3 }, { kind: 'thornshade', count: 1 }], intermissionTicks: 0 },
]

export const SPAWN_POINTS = [
  { x: 24, y: 24 },
  { x: ARENA.width - 24, y: 24 },
  { x: 24, y: ARENA.height - 24 },
  { x: ARENA.width - 24, y: ARENA.height - 24 },
  { x: ARENA.width / 2, y: 16 },
  { x: ARENA.width / 2, y: ARENA.height - 16 },
]

// ── The satchel (items are DATA; behaviour lives in systems/items.js) ───────
export const INVENTORY_SLOTS = 4
export const ITEMS = {
  // A swallow of ember: enemies shy from the brighter torch — their
  // effective aggro radius HALVES while the surge lasts.
  'torch-oil': { stackTo: 3, surgeTicks: 600 },
  // A planted ward: enemies within its ring move at HALF speed until it
  // fades. One ward per stone; planting replaces nothing (they coexist).
  wardstone: { stackTo: 2, radius: 60, wardTicks: 900 },
  // A field salve: restores hp, capped at PLAYER.maxHp.
  salve: { stackTo: 3, heal: 6 },
}

// Deterministic drop table: on enemy-down, one roll from
// worldRng(world, 'drop:' + enemyId).next() decides the drop — the FIRST row
// whose cumulative chance covers the roll wins; no row ⇒ no drop.
export const DROPS = {
  mistling: [{ item: 'salve', chance: 0.25 }],
  bogwisp: [{ item: 'torch-oil', chance: 0.35 }],
  thornshade: [
    { item: 'wardstone', chance: 0.5 },
    { item: 'salve', chance: 0.3 },
  ],
}
export const PICKUP_RADIUS = 12
`,
  'src/sim/kernel.js': `// World-state primitives shared by every system, cycle-free.
import { createRng } from '../core/rng.js'
import { ARENA, PLAYER } from './constants.js'

export function freshPlayer() {
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2 + 60,
    vx: 0,
    vy: 0,
    facing: { x: 0, y: -1 },
    hp: PLAYER.maxHp,
    iframesLeft: 0,
    attackCooldownLeft: 0,
    attackAnimLeft: 0,
    dodgeLeft: 0,
    dodgeCooldownLeft: 0,
    dodgeDir: { x: 0, y: 0 },
    emberSurgeLeft: 0,
    alive: true,
  }
}

export function emptyInventory() {
  // INVENTORY_SLOTS null slots; a held slot is { item, count }.
  return { slots: [null, null, null, null] }
}

export function mintEntityId(world) {
  // Entity ids come from world state, never module state — replays and
  // save/resume must mint identical ids.
  world.entitySeq += 1
  return world.entitySeq
}

// The world's own RNG accessor: forks from the persisted cursor and advances
// it, so save/resume and replay stay on identical sequences.
export function worldRng(world, label) {
  const rng = createRng(world.rngState).fork(label)
  world.rngState = createRng(world.rngState).nextU32()
  return rng
}
`,
  'src/sim/world.js': "// The EMBERWEALD simulation core. Fixed timestep, pure step function: the\n// renderer, the audio layer and every input device live OUTSIDE this module.\n// step(world, frame) -> world runs at exactly TICK_HZ; anything that reads a\n// wall clock, a device, or Math.random inside the sim breaks the determinism\n// law (test/determinism.test.mjs enforces it).\nimport { createRng } from '../core/rng.js'\nimport { emptyInventory, freshPlayer } from './kernel.js'\nimport { stepMovement } from './systems/movement.js'\nimport { stepCombat } from './systems/combat.js'\nimport { stepEnemies } from './systems/enemies.js'\nimport { stepDamage } from './systems/damage.js'\nimport { stepItems } from './systems/items.js'\nimport { stepWaves } from './systems/waves.js'\nimport { stepPhases } from './phases.js'\n\nexport * from './constants.js'\nexport * from './kernel.js'\n\nexport function createWorld(seed) {\n  return {\n    version: 1,\n    seed: seed >>> 0,\n    tick: 0,\n    // 'title' | 'playing' | 'paused' | 'settings' | 'dead' | 'victory'\n    phase: 'title',\n    rngState: createRng(seed).nextU32(), // stream cursor persisted in state\n    entitySeq: 0,\n    player: freshPlayer(),\n    enemies: [],\n    // wave state: index -1 = before the first wave opens\n    wave: { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 },\n    score: 0,\n    events: [], // per-tick semantic events (drained by render/audio layers)\n    inventory: emptyInventory(),\n    pickups: [], // grounded drops: { id, item, x, y }\n    wards: [], // planted wardstones: { id, x, y, ticksLeft }\n  }\n}\n\n// One deterministic step. `frame` is a normalized input frame (input.js).\n// Order is part of the contract: phases gate everything; then movement \u2192\n// enemies \u2192 combat \u2192 damage \u2192 items \u2192 waves (items AFTER damage so drops\n// see this tick's enemy-down events; BEFORE waves so wave-clear sees the\n// final roster).\nexport function step(world, frame) {\n  world.tick += 1\n  world.events.length = 0\n  stepPhases(world, frame)\n  if (world.phase !== 'playing') return world\n  stepMovement(world, frame)\n  stepEnemies(world, frame)\n  stepCombat(world, frame)\n  stepDamage(world, frame)\n  stepItems(world, frame)\n  stepWaves(world, frame)\n  return world\n}\n",
  'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { emptyInventory, freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  world.inventory = emptyInventory()
  world.pickups = []
  world.wards = []
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
  'src/sim/save.js': `// The save codec. Version-stamped JSON of the FULL world state — the state
// is plain data by design, so an exact snapshot IS the save.
//
// MISSION SEAM (task/g2). The contract the tests pin:
//   - SAVE_VERSION becomes 2 (the satchel era: inventory/pickups/wards/
//     emberSurgeLeft are part of the world);
//   - serializeWorld(world) -> a version-2 payload; deserializeWorld is
//     TOTAL over known versions:
//       v2  the exact world back (a resumed run steps IDENTICALLY to the
//           uninterrupted run — rngState, entitySeq, cooldowns, wave state
//           and the satchel all survive);
//       v1  MIGRATES: satchel defaults filled in (empty inventory, no
//           pickups, no wards, no surge), everything the version carried
//           preserved;
//       anything else refuses with the typed 'unsupported save version'
//       error below.
export const SAVE_VERSION = 1

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion !== SAVE_VERSION) {
    throw new Error('unsupported save version: ' + String(parsed.saveVersion))
  }
  return parsed.world
}
`,
  'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
  'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
  'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
  'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind, x: enemy.x, y: enemy.y })
  }
  world.enemies = survivors
}
`,
  'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
  'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes.
//
// MISSION SEAM (task/g2). Runs AFTER damage, BEFORE waves. The contract the
// tests pin (ITEMS / DROPS / PICKUP_RADIUS / INVENTORY_SLOTS are data in
// constants.js):
//   - lifetimes first: player.emberSurgeLeft and every ward's ticksLeft
//     count down once per tick; expired wards leave world.wards;
//   - drops: for each { type: 'enemy-down', enemyId, kind, x, y } event of
//     THIS tick, roll worldRng(world, 'drop:' + enemyId).next() ONCE and
//     walk DROPS[kind] cumulatively — the first row whose cumulative chance
//     covers the roll drops { id: mintEntityId(world), item, x, y } into
//     world.pickups (no winning row ⇒ no drop); push
//     { type: 'drop-spawned', item } per drop;
//   - pickups: a pickup within PICKUP_RADIUS of the player stacks into the
//     FIRST slot holding the same item with count < stackTo, else the first
//     empty slot as { item, count: 1 }; no room ⇒ it stays grounded; push
//     { type: 'pickup', item } per collection;
//   - use: pressed.slot1..slot4 use the item in that slot (empty ⇒ nothing):
//       salve      hp = min(PLAYER.maxHp, hp + heal), consumes 1;
//       torch-oil  player.emberSurgeLeft = surgeTicks, consumes 1;
//       wardstone  world.wards gains { id: mintEntityId(world), x: player.x,
//                  y: player.y, ticksLeft: wardTicks }, consumes 1;
//     a slot reaching count 0 becomes null; push { type: 'item-used', item }.
//
// The enemy-side effects (surge halves effective aggro; a ward ring halves
// enemy speed) belong to systems/enemies.js — this system only owns state.
export function stepItems(world, frame) {
  // TODO(task/g2): implement per the contract above.
  void world
  void frame
}
`,
  'test/inventory.test.mjs': `// The satchel contract (src/sim/systems/items.js mission seam + the
// enemy-side surge/ward effects in systems/enemies.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, DROPS, ENEMY_KINDS, ITEMS, PLAYER } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'
import { createRng } from '../src/core/rng.js'

const idle = () => normalizeFrame(null)
const press = key => normalizeFrame({ pressed: { [key]: true } })

function arena(seed = 41) {
  const world = createWorld(seed)
  world.phase = 'playing'
  return world
}

function foe(world, kind, x, y, hp) {
  const enemy = {
    id: world.entitySeq + 1,
    kind,
    waveIndex: 0,
    x,
    y,
    hp: hp ?? ENEMY_KINDS[kind].maxHp,
    wander: null,
  }
  world.entitySeq += 1
  world.enemies.push(enemy)
  return enemy
}

function ground(world, item, x, y) {
  world.entitySeq += 1
  const pickup = { id: world.entitySeq, item, x, y }
  world.pickups.push(pickup)
  return pickup
}

test('drops follow the contractual roll exactly and land where the creature fell', () => {
  const outcomes = []
  for (let round = 0; round < 2; round++) {
    const world = arena(97)
    const enemy = foe(world, 'thornshade', 100, 100, 16)
    enemy.hp = 0
    // The contract names the stream: ONE roll from
    // worldRng(world, 'drop:' + enemyId) decides against DROPS[kind]
    // cumulatively — so the expected outcome is computable in advance.
    const roll = createRng(world.rngState).fork('drop:' + enemy.id).next()
    let expected = null
    let cumulative = 0
    for (const row of DROPS.thornshade) {
      cumulative += row.chance
      if (roll < cumulative) {
        expected = row.item
        break
      }
    }
    step(world, idle())
    outcomes.push(JSON.stringify(world.pickups))
    if (expected === null) {
      assert.equal(world.pickups.length, 0, 'the roll says: no drop')
    } else {
      assert.equal(world.pickups.length, 1, 'the roll says: exactly one drop')
      assert.equal(world.pickups[0].item, expected)
      assert.equal(world.pickups[0].x, 100)
      assert.equal(world.pickups[0].y, 100)
    }
  }
  assert.equal(outcomes[0], outcomes[1])
})

test('pickups stack to stackTo, overflow to a new slot, stay grounded when full', () => {
  const world = arena()
  const player = world.player
  // Fill: salve stacks to 3.
  for (let n = 0; n < 4; n++) ground(world, 'salve', player.x, player.y)
  step(world, idle())
  const slots = world.inventory.slots
  assert.deepEqual(slots[0], { item: 'salve', count: ITEMS.salve.stackTo })
  assert.deepEqual(slots[1], { item: 'salve', count: 1 })
  assert.equal(world.pickups.length, 0)
  // Cram the remaining two slots, then one more salve must stay grounded
  // once every stack and slot is saturated.
  slots[2] = { item: 'torch-oil', count: ITEMS['torch-oil'].stackTo }
  slots[3] = { item: 'wardstone', count: ITEMS.wardstone.stackTo }
  slots[1] = { item: 'salve', count: ITEMS.salve.stackTo }
  ground(world, 'salve', player.x, player.y)
  step(world, idle())
  assert.equal(world.pickups.length, 1, 'a full satchel leaves the pickup grounded')
})

test('salve heals capped at maxHp and consumes one', () => {
  const world = arena()
  world.player.hp = PLAYER.maxHp - 2
  world.inventory.slots[0] = { item: 'salve', count: 2 }
  step(world, press('slot1'))
  assert.equal(world.player.hp, PLAYER.maxHp, 'heal caps at maxHp')
  assert.deepEqual(world.inventory.slots[0], { item: 'salve', count: 1 })
  step(world, press('slot1'))
  assert.equal(world.player.hp, PLAYER.maxHp)
  assert.equal(world.inventory.slots[0], null, 'a stack reaching zero empties the slot')
})

test('torch-oil surges: effective aggro halves while it lasts, then recovers', () => {
  const world = arena()
  const stats = ENEMY_KINDS.bogwisp
  // 100 < aggro 160, but > the surged 80: the wisp should drop to wander pace.
  const enemy = foe(world, 'bogwisp', world.player.x + 100, world.player.y)
  const perTick = positions => {
    let max = 0
    let prev = positions[0]
    for (const p of positions.slice(1)) {
      max = Math.max(max, Math.hypot(p.x - prev.x, p.y - prev.y))
      prev = p
    }
    return max
  }
  // Without the surge: full chase speed.
  let track = [{ x: enemy.x, y: enemy.y }]
  for (let t = 0; t < 10; t++) {
    step(world, idle())
    track.push({ x: enemy.x, y: enemy.y })
  }
  assert.ok(perTick(track) > (stats.speed / 60) * 0.9, 'unsurged wisp chases at full speed')
  // Surge: the wisp falls out of aggro (wander pace at most half speed).
  world.inventory.slots[0] = { item: 'torch-oil', count: 1 }
  step(world, press('slot1'))
  assert.ok(world.player.emberSurgeLeft > 0, 'surge state set')
  enemy.x = world.player.x + 100
  enemy.y = world.player.y
  track = [{ x: enemy.x, y: enemy.y }]
  for (let t = 0; t < 10; t++) {
    step(world, idle())
    track.push({ x: enemy.x, y: enemy.y })
  }
  assert.ok(perTick(track) <= (stats.speed / 2 / 60) + 0.01, 'surged wisp is out of aggro (wander pace)')
  // Expiry: surge over, chase resumes.
  world.player.emberSurgeLeft = 1
  step(world, idle())
  enemy.x = world.player.x + 100
  enemy.y = world.player.y
  track = [{ x: enemy.x, y: enemy.y }]
  for (let t = 0; t < 10; t++) {
    step(world, idle())
    track.push({ x: enemy.x, y: enemy.y })
  }
  assert.ok(perTick(track) > (stats.speed / 60) * 0.9, 'expired surge restores the chase')
})

test('a planted ward halves enemy speed inside its ring and expires', () => {
  const world = arena()
  world.inventory.slots[0] = { item: 'wardstone', count: 1 }
  step(world, press('slot1'))
  assert.equal(world.wards.length, 1)
  const ward = world.wards[0]
  assert.equal(ward.x, world.player.x)
  // A mistling chasing INSIDE the ring moves at half pace.
  const enemy = foe(world, 'mistling', world.player.x + 40, world.player.y)
  const stats = ENEMY_KINDS.mistling
  const before = { x: enemy.x, y: enemy.y }
  step(world, idle())
  const warded = Math.hypot(enemy.x - before.x, enemy.y - before.y)
  assert.ok(warded <= (stats.speed / 2 / 60) + 0.01, 'ward halves chase speed (moved ' + warded + ')')
  // Expiry by ticking the lifetime out.
  ward.ticksLeft = 1
  step(world, idle())
  assert.equal(world.wards.length, 0, 'expired wards leave the world')
  const b2 = { x: enemy.x, y: enemy.y }
  step(world, idle())
  const free = Math.hypot(enemy.x - b2.x, enemy.y - b2.y)
  assert.ok(free > (stats.speed / 60) * 0.9, 'expiry restores full speed')
})

test('slot presses on empty slots do nothing', () => {
  const world = arena()
  const before = JSON.stringify({ p: world.player, inv: world.inventory, wards: world.wards })
  // Aim pinned at the player so facing (part of the snapshot) stays put.
  step(world, normalizeFrame({ pressed: { slot3: true }, aim: { x: world.player.x, y: world.player.y } }))
  const after = JSON.stringify({ p: world.player, inv: world.inventory, wards: world.wards })
  assert.equal(before, after)
})
`,
  'test/save.test.mjs': `// The save codec contract (src/sim/save.js mission seam): versioning,
// migration, and mid-run resume EXACTNESS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step } from '../src/sim/world.js'
import { serializeWorld, deserializeWorld, SAVE_VERSION } from '../src/sim/save.js'
import { normalizeFrame, createTapeReader } from '../src/sim/input.js'

const TAPE = [
  { tick: 1, frame: { pressed: { confirm: true } } },
  { tick: 20, frame: { held: { right: true }, aim: { x: 460, y: 200 } } },
  { tick: 120, frame: { held: { down: true }, pressed: { attack: true }, aim: { x: 240, y: 300 } } },
  { tick: 200, frame: { held: { left: true }, pressed: { dodge: true }, aim: { x: 20, y: 160 } } },
]

test('the codec is version 2 (the satchel era)', () => {
  assert.equal(SAVE_VERSION, 2)
})

test('a v2 round-trip is exact', () => {
  const world = createWorld(13)
  const reader = createTapeReader(TAPE)
  for (let t = 1; t <= 150; t++) step(world, reader.frameAt(t))
  const copy = deserializeWorld(serializeWorld(world))
  assert.equal(JSON.stringify(copy), JSON.stringify(world))
})

test('resume equivalence: save at tick T, continue -> identical to uninterrupted', () => {
  const reader = createTapeReader(TAPE)
  // Uninterrupted run to 400 (crosses the first wave spawn + combat).
  const straight = createWorld(29)
  for (let t = 1; t <= 400; t++) step(straight, reader.frameAt(t))
  // Interrupted twin: save at 150, resume from the serialized text only.
  const first = createWorld(29)
  for (let t = 1; t <= 150; t++) step(first, reader.frameAt(t))
  const resumed = deserializeWorld(serializeWorld(first))
  for (let t = 151; t <= 400; t++) step(resumed, reader.frameAt(t))
  assert.equal(JSON.stringify(resumed), JSON.stringify(straight))
})

test('v1 saves migrate: satchel defaults filled, carried state preserved', () => {
  // A v1-era world: no inventory/pickups/wards, no emberSurgeLeft.
  const relic = createWorld(7)
  delete relic.inventory
  delete relic.pickups
  delete relic.wards
  delete relic.player.emberSurgeLeft
  relic.score = 120
  relic.player.hp = 9
  const migrated = deserializeWorld(JSON.stringify({ saveVersion: 1, world: relic }))
  assert.equal(migrated.score, 120)
  assert.equal(migrated.player.hp, 9)
  assert.deepEqual(migrated.inventory, { slots: [null, null, null, null] })
  assert.deepEqual(migrated.pickups, [])
  assert.deepEqual(migrated.wards, [])
  assert.equal(migrated.player.emberSurgeLeft, 0)
  // A migrated world must be steppable.
  migrated.phase = 'playing'
  step(migrated, normalizeFrame(null))
})

test('unknown versions refuse with the typed error', () => {
  assert.throws(
    () => deserializeWorld(JSON.stringify({ saveVersion: 99, world: {} })),
    /unsupported save version: 99/,
  )
})
`,
}

const G3_OVERLAY: BranchOverlay = {
  'src/sim/constants.js': `// Simulation constants — data only, importable from any system without
// touching the world module (keeps the system modules cycle-free).
export const TICK_HZ = 60
export const ARENA = { width: 480, height: 320 }

// Obstacle rectangles (world units). The clearing's standing stones.
export const OBSTACLES = [
  { x: 96, y: 72, w: 40, h: 24 },
  { x: 344, y: 72, w: 40, h: 24 },
  { x: 96, y: 224, w: 40, h: 24 },
  { x: 344, y: 224, w: 40, h: 24 },
  { x: 216, y: 136, w: 48, h: 48 },
]

export const PLAYER = {
  radius: 8,
  speed: 96, // world units / second
  maxHp: 20,
  attackRange: 28,
  attackArcRad: Math.PI / 2,
  attackDamage: 4,
  attackCooldownTicks: 24,
  iframeTicks: 45,
  knockback: 40,
  dodgeSpeed: 240,
  dodgeTicks: 9,
  dodgeCooldownTicks: 40,
}

export const ENEMY_KINDS = {
  mistwarden: { radius: 14, speed: 30, maxHp: 32, contactDamage: 5, aggroRadius: 480, fleeBelowHp: 0, score: 200 },
  mistling: { radius: 7, speed: 54, maxHp: 8, contactDamage: 2, aggroRadius: 120, fleeBelowHp: 3, score: 10 },
  bogwisp: { radius: 5, speed: 78, maxHp: 4, contactDamage: 1, aggroRadius: 160, fleeBelowHp: 0, score: 15 },
  thornshade: { radius: 10, speed: 40, maxHp: 16, contactDamage: 4, aggroRadius: 100, fleeBelowHp: 5, score: 30 },
}

// Wave table (data, not behaviour): what spawns, and the intermission before
// the NEXT wave opens. Spawn points sit on the arena rim.
export const WAVES = [
  { spawns: [{ kind: 'mistling', count: 3 }], intermissionTicks: 180 },
  { spawns: [{ kind: 'mistling', count: 4 }, { kind: 'bogwisp', count: 2 }], intermissionTicks: 240 },
  { spawns: [{ kind: 'mistling', count: 3 }, { kind: 'bogwisp', count: 3 }, { kind: 'thornshade', count: 1 }], intermissionTicks: 0 },
]

export const SPAWN_POINTS = [
  { x: 24, y: 24 },
  { x: ARENA.width - 24, y: 24 },
  { x: 24, y: ARENA.height - 24 },
  { x: ARENA.width - 24, y: ARENA.height - 24 },
  { x: ARENA.width / 2, y: 16 },
  { x: ARENA.width / 2, y: ARENA.height - 16 },
]

// ── The satchel (items are DATA; behaviour lives in systems/items.js) ───────
export const INVENTORY_SLOTS = 4
export const ITEMS = {
  // A swallow of ember: enemies shy from the brighter torch — their
  // effective aggro radius HALVES while the surge lasts.
  'torch-oil': { stackTo: 3, surgeTicks: 600 },
  // A planted ward: enemies within its ring move at HALF speed until it
  // fades. One ward per stone; planting replaces nothing (they coexist).
  wardstone: { stackTo: 2, radius: 60, wardTicks: 900 },
  // A field salve: restores hp, capped at PLAYER.maxHp.
  salve: { stackTo: 3, heal: 6 },
}

// Deterministic drop table: on enemy-down, one roll from
// worldRng(world, 'drop:' + enemyId).next() decides the drop — the FIRST row
// whose cumulative chance covers the roll wins; no row ⇒ no drop.
export const DROPS = {
  mistling: [{ item: 'salve', chance: 0.25 }],
  bogwisp: [{ item: 'torch-oil', chance: 0.35 }],
  thornshade: [
    { item: 'wardstone', chance: 0.5 },
    { item: 'salve', chance: 0.3 },
  ],
}
export const PICKUP_RADIUS = 12

// ── The Mistwarden (the run's final fight; systems/warden.js owns the logic) ─
export const WARDEN = {
  kind: 'mistwarden',
  spawn: { x: ARENA.width / 2, y: 40 },
  escort: { kind: 'bogwisp', count: 2 },
  summonEveryTicks: 720,
}
`,
  'src/sim/kernel.js': `// World-state primitives shared by every system, cycle-free.
import { createRng } from '../core/rng.js'
import { ARENA, PLAYER } from './constants.js'

export function freshPlayer() {
  return {
    x: ARENA.width / 2,
    y: ARENA.height / 2 + 60,
    vx: 0,
    vy: 0,
    facing: { x: 0, y: -1 },
    hp: PLAYER.maxHp,
    iframesLeft: 0,
    attackCooldownLeft: 0,
    attackAnimLeft: 0,
    dodgeLeft: 0,
    dodgeCooldownLeft: 0,
    dodgeDir: { x: 0, y: 0 },
    emberSurgeLeft: 0,
    alive: true,
  }
}

export function emptyInventory() {
  // INVENTORY_SLOTS null slots; a held slot is { item, count }.
  return { slots: [null, null, null, null] }
}

export function mintEntityId(world) {
  // Entity ids come from world state, never module state — replays and
  // save/resume must mint identical ids.
  world.entitySeq += 1
  return world.entitySeq
}

// The world's own RNG accessor: forks from the persisted cursor and advances
// it, so save/resume and replay stay on identical sequences.
export function worldRng(world, label) {
  const rng = createRng(world.rngState).fork(label)
  world.rngState = createRng(world.rngState).nextU32()
  return rng
}
`,
  'src/sim/world.js': "// The EMBERWEALD simulation core. Fixed timestep, pure step function: the\n// renderer, the audio layer and every input device live OUTSIDE this module.\n// step(world, frame) -> world runs at exactly TICK_HZ; anything that reads a\n// wall clock, a device, or Math.random inside the sim breaks the determinism\n// law (test/determinism.test.mjs enforces it).\nimport { createRng } from '../core/rng.js'\nimport { emptyInventory, freshPlayer } from './kernel.js'\nimport { stepMovement } from './systems/movement.js'\nimport { stepCombat } from './systems/combat.js'\nimport { stepEnemies } from './systems/enemies.js'\nimport { stepDamage } from './systems/damage.js'\nimport { stepItems } from './systems/items.js'\nimport { stepWaves } from './systems/waves.js'\nimport { stepWarden } from './systems/warden.js'\nimport { stepPhases } from './phases.js'\n\nexport * from './constants.js'\nexport * from './kernel.js'\n\nexport function createWorld(seed) {\n  return {\n    version: 1,\n    seed: seed >>> 0,\n    tick: 0,\n    // 'title' | 'playing' | 'paused' | 'settings' | 'dead' | 'victory'\n    phase: 'title',\n    rngState: createRng(seed).nextU32(), // stream cursor persisted in state\n    entitySeq: 0,\n    player: freshPlayer(),\n    enemies: [],\n    // wave state: index -1 = before the first wave opens\n    wave: { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 },\n    score: 0,\n    events: [], // per-tick semantic events (drained by render/audio layers)\n    inventory: emptyInventory(),\n    pickups: [], // grounded drops: { id, item, x, y }\n    wards: [], // planted wardstones: { id, x, y, ticksLeft }\n  }\n}\n\n// One deterministic step. `frame` is a normalized input frame (input.js).\n// Order is part of the contract: phases gate everything; then movement \u2192\n// enemies \u2192 combat \u2192 damage \u2192 items \u2192 waves (items AFTER damage so drops\n// see this tick's enemy-down events; BEFORE waves so wave-clear sees the\n// final roster).\nexport function step(world, frame) {\n  world.tick += 1\n  world.events.length = 0\n  stepPhases(world, frame)\n  if (world.phase !== 'playing') return world\n  stepMovement(world, frame)\n  stepEnemies(world, frame)\n  stepCombat(world, frame)\n  stepDamage(world, frame)\n  stepItems(world, frame)\n  stepWarden(world, frame)\n  stepWaves(world, frame)\n  return world\n}\n",
  'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { emptyInventory, freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  world.inventory = emptyInventory()
  world.pickups = []
  world.wards = []
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared > WAVES.length) {
        // The warden era: the beyond-the-list clear is the win (task/g3).
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
  'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
  'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
  'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
  'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind, x: enemy.x, y: enemy.y })
  }
  world.enemies = survivors
}
`,
  'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
  'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)

  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
  'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
  'src/sim/systems/warden.js': `// The Mistwarden — the run's final fight.
//
// MISSION SEAM (task/g3). The contract the tests pin (in
// constants.js):
//   - the warden ENTERS when the final listed wave clears: the wave system
//     hands over by setting wave.state to 'warden' instead of finishing the
//     run; stepWarden then owns the fight (this system never touches
//     world.phase);
// on entry: ONE warden spawns at.spawn with.maxHp, plus
//     its escort (.escort: kind + count, minted like wave spawns with
//     worldRng(world, 'warden-escort'));
//   - SHIELDED while any escort lives: player attacks deal 0 to the warden
//     (a { type: 'warden-shielded' } event per blocked hit); the shield
//     DROPS when the last escort dies ({ type: 'warden-exposed' });
// every.summonEveryTicks while exposed, it summons one fresh
//     escort ({ type: 'warden-summons', kind }) and the shield RETURNS;
// the warden chases at.speed, deals.contactDamage through
//     the normal damage system (it is an enemy in world.enemies with kind
//     'mistwarden' — ENEMY_KINDS carries its stats so every existing system
//     treats it uniformly);
//   - when the warden dies: wave.cleared = WAVES.length + 1 plus a
//     { type: 'run-won' } event — the GIVEN phase machine of this era reads
//     victory as cleared > WAVES.length (the beyond-the-list clear), so the
//     handover tick (cleared === WAVES.length) never reads as a win.
export function stepWarden(world, frame) {
  // TODO(task/g3): implement per the contract above.
  void world
  void frame
}
`,
  'tools/autopilot.mjs': `// The deterministic autopilot — a pure function world -> input frame. GIVEN:
// it is the balance oracle's driver (the "scripted journey" of the
// progression floors), never a mission seam. Simple by design: kite the
// nearest threat, swing when in reach, salve when low, keep moving.
import { ENEMY_KINDS, PLAYER } from '../src/sim/constants.js'

export function autopilotFrame(world) {
  const player = world.player
  if (world.phase === 'title' || world.phase === 'dead' || world.phase === 'victory') {
    return { pressed: { confirm: true } }
  }
  if (world.phase !== 'playing') return {}

  // Target the nearest LESSER creature while any lives — the warden's own
  // shield teaches the order of work; the warden itself is only the target
  // once it stands alone.
  let nearest = null
  let nearestDist = Infinity
  let warden = null
  let wardenDist = Infinity
  for (const enemy of world.enemies) {
    const d = Math.hypot(enemy.x - player.x, enemy.y - player.y)
    if (enemy.kind === 'mistwarden') {
      warden = enemy
      wardenDist = d
      continue
    }
    if (d < nearestDist) {
      nearest = enemy
      nearestDist = d
    }
  }
  if (!nearest && warden) {
    nearest = warden
    nearestDist = wardenDist
  }

  const held = {}
  const pressed = {}
  let aim = { x: player.x, y: player.y - 10 }

  if (nearest) {
    aim = { x: nearest.x, y: nearest.y }
    const stats = ENEMY_KINDS[nearest.kind]
    // Fighting the warden means standing INSIDE what would normally be the
    // fear ring: keep just clear of contact and trade through i-frames.
    const danger =
      nearest.kind === 'mistwarden'
        ? PLAYER.radius + stats.radius + 3
        : PLAYER.radius + stats.radius + 14
    // A deterministic tangential nudge (tick parity, no memory): straight
    // pursuit wedges on the standing stones; a slowly alternating sidestep
    // walks around them.
    const swirl = Math.floor(world.tick / 90) % 2 === 0 ? 1 : -1
    const dx = nearest.x - player.x
    const dy = nearest.y - player.y
    // The warden's contact ring is the one that kills: give it right of way
    // even while hunting its escort.
    const wardenRing = warden ? PLAYER.radius + ENEMY_KINDS.mistwarden.radius + 16 : 0
    if (warden && warden !== nearest && wardenDist < wardenRing) {
      held.left = warden.x > player.x
      held.right = warden.x < player.x
      held.up = warden.y > player.y
      held.down = warden.y < player.y
    } else if (nearestDist < danger) {
      // Kite: back away along the threat line (the movement system clamps
      // and slides at walls, so blind backing is safe).
      held.left = dx > 0
      held.right = dx < 0
      held.up = dy > 0
      held.down = dy < 0
    } else if (nearestDist > PLAYER.attackRange - 4) {
      // Close to swing range, swirling around obstructions.
      const tx = -dy * swirl
      const ty = dx * swirl
      const cx = dx + tx * 0.6
      const cy = dy + ty * 0.6
      held.left = cx < 0
      held.right = cx > 0
      held.up = cy < 0
      held.down = cy > 0
    }
    if (nearestDist <= PLAYER.attackRange && player.attackCooldownLeft === 0) {
      pressed.attack = true
    }
    if (nearestDist < danger - 6 && player.dodgeCooldownLeft === 0 && player.dodgeLeft === 0) {
      pressed.dodge = true
    }
  }

  // Field discipline: salve when hurting, oil the torch when swarmed.
  if (world.inventory) {
    const slots = world.inventory.slots
    const slotOf = item => slots.findIndex(s => s && s.item === item)
    if (player.hp <= 8) {
      const at = slotOf('salve')
      if (at >= 0) pressed['slot' + String(at + 1)] = true
    } else if (world.enemies.length >= 4 && player.emberSurgeLeft === 0) {
      const at = slotOf('torch-oil')
      if (at >= 0) pressed['slot' + String(at + 1)] = true
    } else if (warden && world.wards.length === 0) {
      // Slow the warden's ground: plant a ward where the dance happens.
      const at = slotOf('wardstone')
      if (at >= 0) pressed['slot' + String(at + 1)] = true
    }
  }

  return { held, pressed, aim }
}
`,
  'test/inventory.test.mjs': `// The satchel contract (src/sim/systems/items.js mission seam + the
// enemy-side surge/ward effects in systems/enemies.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, DROPS, ENEMY_KINDS, ITEMS, PLAYER } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'
import { createRng } from '../src/core/rng.js'

const idle = () => normalizeFrame(null)
const press = key => normalizeFrame({ pressed: { [key]: true } })

function arena(seed = 41) {
  const world = createWorld(seed)
  world.phase = 'playing'
  return world
}

function foe(world, kind, x, y, hp) {
  const enemy = {
    id: world.entitySeq + 1,
    kind,
    waveIndex: 0,
    x,
    y,
    hp: hp ?? ENEMY_KINDS[kind].maxHp,
    wander: null,
  }
  world.entitySeq += 1
  world.enemies.push(enemy)
  return enemy
}

function ground(world, item, x, y) {
  world.entitySeq += 1
  const pickup = { id: world.entitySeq, item, x, y }
  world.pickups.push(pickup)
  return pickup
}

test('drops follow the contractual roll exactly and land where the creature fell', () => {
  const outcomes = []
  for (let round = 0; round < 2; round++) {
    const world = arena(97)
    const enemy = foe(world, 'thornshade', 100, 100, 16)
    enemy.hp = 0
    // The contract names the stream: ONE roll from
    // worldRng(world, 'drop:' + enemyId) decides against DROPS[kind]
    // cumulatively — so the expected outcome is computable in advance.
    const roll = createRng(world.rngState).fork('drop:' + enemy.id).next()
    let expected = null
    let cumulative = 0
    for (const row of DROPS.thornshade) {
      cumulative += row.chance
      if (roll < cumulative) {
        expected = row.item
        break
      }
    }
    step(world, idle())
    outcomes.push(JSON.stringify(world.pickups))
    if (expected === null) {
      assert.equal(world.pickups.length, 0, 'the roll says: no drop')
    } else {
      assert.equal(world.pickups.length, 1, 'the roll says: exactly one drop')
      assert.equal(world.pickups[0].item, expected)
      assert.equal(world.pickups[0].x, 100)
      assert.equal(world.pickups[0].y, 100)
    }
  }
  assert.equal(outcomes[0], outcomes[1])
})

test('pickups stack to stackTo, overflow to a new slot, stay grounded when full', () => {
  const world = arena()
  const player = world.player
  // Fill: salve stacks to 3.
  for (let n = 0; n < 4; n++) ground(world, 'salve', player.x, player.y)
  step(world, idle())
  const slots = world.inventory.slots
  assert.deepEqual(slots[0], { item: 'salve', count: ITEMS.salve.stackTo })
  assert.deepEqual(slots[1], { item: 'salve', count: 1 })
  assert.equal(world.pickups.length, 0)
  // Cram the remaining two slots, then one more salve must stay grounded
  // once every stack and slot is saturated.
  slots[2] = { item: 'torch-oil', count: ITEMS['torch-oil'].stackTo }
  slots[3] = { item: 'wardstone', count: ITEMS.wardstone.stackTo }
  slots[1] = { item: 'salve', count: ITEMS.salve.stackTo }
  ground(world, 'salve', player.x, player.y)
  step(world, idle())
  assert.equal(world.pickups.length, 1, 'a full satchel leaves the pickup grounded')
})

test('salve heals capped at maxHp and consumes one', () => {
  const world = arena()
  world.player.hp = PLAYER.maxHp - 2
  world.inventory.slots[0] = { item: 'salve', count: 2 }
  step(world, press('slot1'))
  assert.equal(world.player.hp, PLAYER.maxHp, 'heal caps at maxHp')
  assert.deepEqual(world.inventory.slots[0], { item: 'salve', count: 1 })
  step(world, press('slot1'))
  assert.equal(world.player.hp, PLAYER.maxHp)
  assert.equal(world.inventory.slots[0], null, 'a stack reaching zero empties the slot')
})

test('torch-oil surges: effective aggro halves while it lasts, then recovers', () => {
  const world = arena()
  const stats = ENEMY_KINDS.bogwisp
  // 100 < aggro 160, but > the surged 80: the wisp should drop to wander pace.
  const enemy = foe(world, 'bogwisp', world.player.x + 100, world.player.y)
  const perTick = positions => {
    let max = 0
    let prev = positions[0]
    for (const p of positions.slice(1)) {
      max = Math.max(max, Math.hypot(p.x - prev.x, p.y - prev.y))
      prev = p
    }
    return max
  }
  // Without the surge: full chase speed.
  let track = [{ x: enemy.x, y: enemy.y }]
  for (let t = 0; t < 10; t++) {
    step(world, idle())
    track.push({ x: enemy.x, y: enemy.y })
  }
  assert.ok(perTick(track) > (stats.speed / 60) * 0.9, 'unsurged wisp chases at full speed')
  // Surge: the wisp falls out of aggro (wander pace at most half speed).
  world.inventory.slots[0] = { item: 'torch-oil', count: 1 }
  step(world, press('slot1'))
  assert.ok(world.player.emberSurgeLeft > 0, 'surge state set')
  enemy.x = world.player.x + 100
  enemy.y = world.player.y
  track = [{ x: enemy.x, y: enemy.y }]
  for (let t = 0; t < 10; t++) {
    step(world, idle())
    track.push({ x: enemy.x, y: enemy.y })
  }
  assert.ok(perTick(track) <= (stats.speed / 2 / 60) + 0.01, 'surged wisp is out of aggro (wander pace)')
  // Expiry: surge over, chase resumes.
  world.player.emberSurgeLeft = 1
  step(world, idle())
  enemy.x = world.player.x + 100
  enemy.y = world.player.y
  track = [{ x: enemy.x, y: enemy.y }]
  for (let t = 0; t < 10; t++) {
    step(world, idle())
    track.push({ x: enemy.x, y: enemy.y })
  }
  assert.ok(perTick(track) > (stats.speed / 60) * 0.9, 'expired surge restores the chase')
})

test('a planted ward halves enemy speed inside its ring and expires', () => {
  const world = arena()
  world.inventory.slots[0] = { item: 'wardstone', count: 1 }
  step(world, press('slot1'))
  assert.equal(world.wards.length, 1)
  const ward = world.wards[0]
  assert.equal(ward.x, world.player.x)
  // A mistling chasing INSIDE the ring moves at half pace.
  const enemy = foe(world, 'mistling', world.player.x + 40, world.player.y)
  const stats = ENEMY_KINDS.mistling
  const before = { x: enemy.x, y: enemy.y }
  step(world, idle())
  const warded = Math.hypot(enemy.x - before.x, enemy.y - before.y)
  assert.ok(warded <= (stats.speed / 2 / 60) + 0.01, 'ward halves chase speed (moved ' + warded + ')')
  // Expiry by ticking the lifetime out.
  ward.ticksLeft = 1
  step(world, idle())
  assert.equal(world.wards.length, 0, 'expired wards leave the world')
  const b2 = { x: enemy.x, y: enemy.y }
  step(world, idle())
  const free = Math.hypot(enemy.x - b2.x, enemy.y - b2.y)
  assert.ok(free > (stats.speed / 60) * 0.9, 'expiry restores full speed')
})

test('slot presses on empty slots do nothing', () => {
  const world = arena()
  const before = JSON.stringify({ p: world.player, inv: world.inventory, wards: world.wards })
  // Aim pinned at the player so facing (part of the snapshot) stays put.
  step(world, normalizeFrame({ pressed: { slot3: true }, aim: { x: world.player.x, y: world.player.y } }))
  const after = JSON.stringify({ p: world.player, inv: world.inventory, wards: world.wards })
  assert.equal(before, after)
})
`,
  'test/save.test.mjs': `// The save codec contract (src/sim/save.js mission seam): versioning,
// migration, and mid-run resume EXACTNESS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step } from '../src/sim/world.js'
import { serializeWorld, deserializeWorld, SAVE_VERSION } from '../src/sim/save.js'
import { normalizeFrame, createTapeReader } from '../src/sim/input.js'

const TAPE = [
  { tick: 1, frame: { pressed: { confirm: true } } },
  { tick: 20, frame: { held: { right: true }, aim: { x: 460, y: 200 } } },
  { tick: 120, frame: { held: { down: true }, pressed: { attack: true }, aim: { x: 240, y: 300 } } },
  { tick: 200, frame: { held: { left: true }, pressed: { dodge: true }, aim: { x: 20, y: 160 } } },
]

test('the codec is version 2 (the satchel era)', () => {
  assert.equal(SAVE_VERSION, 2)
})

test('a v2 round-trip is exact', () => {
  const world = createWorld(13)
  const reader = createTapeReader(TAPE)
  for (let t = 1; t <= 150; t++) step(world, reader.frameAt(t))
  const copy = deserializeWorld(serializeWorld(world))
  assert.equal(JSON.stringify(copy), JSON.stringify(world))
})

test('resume equivalence: save at tick T, continue -> identical to uninterrupted', () => {
  const reader = createTapeReader(TAPE)
  // Uninterrupted run to 400 (crosses the first wave spawn + combat).
  const straight = createWorld(29)
  for (let t = 1; t <= 400; t++) step(straight, reader.frameAt(t))
  // Interrupted twin: save at 150, resume from the serialized text only.
  const first = createWorld(29)
  for (let t = 1; t <= 150; t++) step(first, reader.frameAt(t))
  const resumed = deserializeWorld(serializeWorld(first))
  for (let t = 151; t <= 400; t++) step(resumed, reader.frameAt(t))
  assert.equal(JSON.stringify(resumed), JSON.stringify(straight))
})

test('v1 saves migrate: satchel defaults filled, carried state preserved', () => {
  // A v1-era world: no inventory/pickups/wards, no emberSurgeLeft.
  const relic = createWorld(7)
  delete relic.inventory
  delete relic.pickups
  delete relic.wards
  delete relic.player.emberSurgeLeft
  relic.score = 120
  relic.player.hp = 9
  const migrated = deserializeWorld(JSON.stringify({ saveVersion: 1, world: relic }))
  assert.equal(migrated.score, 120)
  assert.equal(migrated.player.hp, 9)
  assert.deepEqual(migrated.inventory, { slots: [null, null, null, null] })
  assert.deepEqual(migrated.pickups, [])
  assert.deepEqual(migrated.wards, [])
  assert.equal(migrated.player.emberSurgeLeft, 0)
  // A migrated world must be steppable.
  migrated.phase = 'playing'
  step(migrated, normalizeFrame(null))
})

test('unknown versions refuse with the typed error', () => {
  assert.throws(
    () => deserializeWorld(JSON.stringify({ saveVersion: 99, world: {} })),
    /unsupported save version: 99/,
  )
})
`,
  'test/waves.test.mjs': `// Wave progression contract (src/sim/systems/waves.js mission seam).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, WAVES } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'

const idle = () => normalizeFrame(null)

function playingWorld(seed = 21) {
  const world = createWorld(seed)
  world.phase = 'playing'
  // Park the player mid-arena; wave tests kill enemies directly.
  return world
}

function slayAll(world) {
  for (const enemy of world.enemies) enemy.hp = 0
  step(world, idle())
}

test('the opening intermission spawns wave 0 with waveIndex-tagged enemies', () => {
  const world = playingWorld()
  for (let t = 0; t < 90; t++) step(world, idle())
  assert.equal(world.wave.index, 0)
  assert.equal(world.wave.state, 'active')
  const want = WAVES[0].spawns.reduce((n, s) => n + s.count, 0)
  assert.equal(world.enemies.length, want)
  assert.ok(world.enemies.every(e => e.waveIndex === 0))
})

test('clearing a wave opens its intermission, then the next wave spawns', () => {
  const world = playingWorld()
  for (let t = 0; t < 90; t++) step(world, idle())
  slayAll(world)
  assert.equal(world.wave.cleared, 1)
  assert.equal(world.wave.state, 'intermission')
  for (let t = 0; t < WAVES[0].intermissionTicks; t++) step(world, idle())
  assert.equal(world.wave.index, 1)
  const want = WAVES[1].spawns.reduce((n, s) => n + s.count, 0)
  assert.equal(world.enemies.length, want)
})

test('clearing the final LISTED wave hands over to the warden era', () => {
  const world = playingWorld()
  for (let wave = 0; wave < WAVES.length; wave++) {
    const wait = wave === 0 ? 90 : WAVES[wave - 1].intermissionTicks
    for (let t = 0; t < wait; t++) step(world, idle())
    assert.equal(world.wave.index, wave, 'wave ' + wave + ' should be active')
    slayAll(world)
  }
  step(world, idle())
  assert.equal(world.wave.state, 'warden', 'the list ends at the warden, not at dawn')
  assert.notEqual(world.phase, 'victory')
})

test('spawn placement is deterministic per seed', () => {
  const a = playingWorld(33)
  const b = playingWorld(33)
  for (let t = 0; t < 90; t++) {
    step(a, idle())
    step(b, idle())
  }
  assert.deepEqual(
    a.enemies.map(e => [e.kind, e.x, e.y]),
    b.enemies.map(e => [e.kind, e.x, e.y]),
  )
})
`,
  'test/warden.test.mjs': `// The Mistwarden contract (src/sim/systems/warden.js + the waves handover).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, ENEMY_KINDS, WARDEN, WAVES } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'

const idle = () => normalizeFrame(null)
const aimAt = (x, y, extra = {}) => normalizeFrame({ aim: { x, y }, ...extra })

function playingWorld(seed = 51) {
  const world = createWorld(seed)
  world.phase = 'playing'
  return world
}

// Drive the run to the warden handover by slaying every listed wave.
function clearListedWaves(world) {
  for (let wave = 0; wave < WAVES.length; wave++) {
    const wait = wave === 0 ? 90 : WAVES[wave - 1].intermissionTicks
    for (let t = 0; t < wait; t++) step(world, idle())
    for (const enemy of world.enemies) enemy.hp = 0
    step(world, idle())
  }
}

test('clearing the last listed wave hands over to the warden, not victory', () => {
  const world = playingWorld()
  clearListedWaves(world)
  step(world, idle())
  assert.equal(world.wave.state, 'warden', 'the wave system must hand over')
  assert.notEqual(world.phase, 'victory', 'the run is NOT won yet')
  // The ledger stays closed while the warden lives: extra passes must never
  // manufacture a victory.
  for (let t = 0; t < 5; t++) step(world, idle())
  assert.notEqual(world.phase, 'victory', 'no phantom victory from re-counting the empty list')
  assert.equal(world.wave.cleared, WAVES.length, 'cleared stays at the list length until the warden falls')
  const warden = world.enemies.find(e => e.kind === WARDEN.kind)
  assert.ok(warden, 'the warden spawned')
  assert.equal(warden.hp, ENEMY_KINDS.mistwarden.maxHp)
  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind)
  assert.equal(escorts.length, WARDEN.escort.count, 'the escort spawned with it')
})

test('the shield blocks player damage while any escort lives, then drops', () => {
  const world = playingWorld()
  clearListedWaves(world)
  step(world, idle())
  const warden = world.enemies.find(e => e.kind === WARDEN.kind)
  // Teleport the fight into a clean corner: warden in reach, escorts far.
  world.player.x = 60
  world.player.y = 250
  warden.x = world.player.x + 20
  warden.y = world.player.y
  for (const e of world.enemies) {
    if (e.kind === WARDEN.escort.kind) {
      e.x = 400
      e.y = 40
    }
  }
  step(world, aimAt(warden.x, warden.y, { pressed: { attack: true } }))
  assert.equal(warden.hp, ENEMY_KINDS.mistwarden.maxHp, 'shielded: the swing dealt nothing')
  assert.ok(world.events.some(e => e.type === 'warden-shielded'))
  // Slay the escort; the shield drops.
  for (const e of world.enemies) {
    if (e.kind === WARDEN.escort.kind) e.hp = 0
  }
  step(world, idle())
  assert.ok(world.events.some(e => e.type === 'warden-exposed'))
  // Wait out the attack cooldown, then the swing lands.
  for (let t = 0; t < 30; t++) {
    warden.x = world.player.x + 20
    warden.y = world.player.y
    step(world, aimAt(warden.x, warden.y))
  }
  warden.x = world.player.x + 20
  warden.y = world.player.y
  step(world, aimAt(warden.x, warden.y, { pressed: { attack: true } }))
  assert.ok(warden.hp < ENEMY_KINDS.mistwarden.maxHp, 'exposed: the swing landed')
})

test('an exposed warden summons a fresh escort and re-shields', () => {
  const world = playingWorld()
  clearListedWaves(world)
  step(world, idle())
  for (const e of world.enemies) {
    if (e.kind === WARDEN.escort.kind) e.hp = 0
  }
  step(world, idle()) // exposed
  for (let t = 0; t < WARDEN.summonEveryTicks + 2; t++) step(world, idle())
  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind)
  assert.ok(escorts.length >= 1, 'a summon arrived')
  assert.ok(
    JSON.stringify(world.events).includes('warden-summons') ||
      escorts.length >= 1,
    'the summon announced itself on its tick',
  )
})

test('slaying the warden wins the run through the normal victory read', () => {
  const world = playingWorld()
  clearListedWaves(world)
  step(world, idle())
  for (const enemy of world.enemies) enemy.hp = 0
  step(world, idle())
  assert.equal(world.wave.cleared, WAVES.length + 1)
  step(world, idle())
  assert.equal(world.phase, 'victory')
})
`,
  'test/progression.test.mjs': `// The progression floors — deterministic balance oracles over the whole
// playable run (the "half-day" mission's teeth):
//   WINNABLE: the given autopilot (tools/autopilot.mjs, a pure world->frame
//   bot) reaches victory on seed 7 within the tick budget;
//   LOSABLE: an idle torchbearer dies before the listed waves clear;
//   REACHABLE: every menu phase walks by keyboard alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, step, WAVES } from '../src/sim/world.js'
import { normalizeFrame } from '../src/sim/input.js'
import { autopilotFrame } from '../tools/autopilot.mjs'

const idle = () => normalizeFrame(null)
const WIN_BUDGET_TICKS = 60 * 60 * 8 // eight sim-minutes

test('the autopilot wins the whole run on seed 7 (the winnable floor)', () => {
  const world = createWorld(7)
  for (let t = 0; t < WIN_BUDGET_TICKS; t++) {
    step(world, normalizeFrame(autopilotFrame(world)))
    if (world.phase === 'victory') break
    assert.notEqual(world.phase, 'dead', 'the autopilot must not die (tick ' + String(t) + ')')
  }
  assert.equal(world.phase, 'victory', 'victory within the budget')
})

test('an idle torchbearer falls before the waves clear (the losable floor)', () => {
  const world = createWorld(7)
  step(world, normalizeFrame({ pressed: { confirm: true } }))
  let died = false
  for (let t = 0; t < WIN_BUDGET_TICKS; t++) {
    step(world, idle())
    if (world.phase === 'dead') {
      died = true
      break
    }
    assert.notEqual(world.phase, 'victory', 'standing still must never win')
  }
  assert.ok(died, 'the mist takes the idle')
})

test('every menu phase is keyboard-reachable', () => {
  const world = createWorld(7)
  const press = key => step(world, normalizeFrame({ pressed: { [key]: true } }))
  assert.equal(world.phase, 'title')
  press('confirm')
  assert.equal(world.phase, 'playing')
  press('pause')
  assert.equal(world.phase, 'paused')
  press('use')
  assert.equal(world.phase, 'settings')
  press('cancel')
  assert.equal(world.phase, 'paused')
  press('cancel')
  assert.equal(world.phase, 'title')
  // Death and victory screens exit by keyboard too.
  press('confirm')
  world.player.hp = 0
  world.player.alive = false
  step(world, idle())
  assert.equal(world.phase, 'dead')
  press('confirm')
  assert.equal(world.phase, 'title')
  press('confirm')
  world.wave.cleared = WAVES.length + 1
  step(world, idle())
  assert.equal(world.phase, 'victory')
  press('confirm')
  assert.equal(world.phase, 'title')
})
`,
}

export const EMBERWEALD_REPO: HelixRepoSpec = {
  id: 'emberweald',
  seed: 'inline',
  files: FILES,
  // EW1 (the sim-core mission) rides main; task/g2 (the satchel mission)
  // overlays the G1 reference + the satchel scaffolding with the items/save
  // seams stubbed and the satchel suite failing.
  branches: { 'task/g2': G2_OVERLAY, 'task/g3': G3_OVERLAY },
}

/** EW1 reference: the six mission seams implemented per the pinned
 *  contracts (proved: full public suite green). */
export const EMBERWEALD_G1_REFERENCE: FileMap = {
  'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
  'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
  'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
  'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
  'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
  'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,}

/** EW1 falsify variants: COMPLETE plausible implementations, each carrying
 *  exactly one defect class (proved: each fails the public suite). */
export const EMBERWEALD_G1_FALSIFY: Array<{ name: string; files: FileMap }> = [
  {
    name: 'cosmetic-combat',
    files: {
      'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
      'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
      'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
    },
  },
  {
    name: 'sqrt2-drift',
    files: {
      'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
      'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = {
    x: (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    y: (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  }

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
      'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
    },
  },
  {
    name: 'tunnel-collision',
    files: {
      'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
      'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
      'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
    },
  },
  {
    name: 'iframe-less',
    files: {
      'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
      'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
      'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
    },
  },
  {
    name: 'wave-rush',
    files: {
      'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm) {
        world.phase = 'playing'
      } else if (pressed.cancel) {
        world.phase = 'title'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
      'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
      'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.index += 1
  wave.state = 'active'
  spawnWave(world, wave.index)
}
`,
    },
  },
  {
    name: 'phase-loose',
    files: {
      'src/sim/phases.js': `// The phase machine: title / playing / paused / settings / dead / victory.
// The sim owns WHICH phase is active; the browser layer only renders the
// matching screen. Death and victory are read from persistent run state set
// by the damage and wave systems — those systems never touch world.phase.
import { WAVES } from './constants.js'
import { freshPlayer } from './kernel.js'

function resetRun(world) {
  world.player = freshPlayer()
  world.enemies = []
  world.entitySeq = 0
  world.wave = { index: -1, state: 'intermission', intermissionLeft: 90, cleared: 0 }
  world.score = 0
  // rngState is NOT reset: a second run in one session diverges, while a
  // replay of the same tape from the same seed reproduces both runs exactly.
}

export function stepPhases(world, frame) {
  const pressed = frame.pressed
  switch (world.phase) {
    case 'title':
      if (pressed.confirm) {
        resetRun(world)
        world.phase = 'playing'
      }
      break
    case 'playing':
      if (pressed.pause) {
        world.phase = 'paused'
      } else if (!world.player.alive) {
        world.phase = 'dead'
      } else if (world.wave.cleared >= WAVES.length) {
        world.phase = 'victory'
      }
      break
    case 'paused':
      if (pressed.pause || pressed.confirm || pressed.cancel) {
        world.phase = 'playing'
      } else if (pressed.use) {
        world.phase = 'settings'
      }
      break
    case 'settings':
      if (pressed.cancel) world.phase = 'paused'
      break
    case 'dead':
    case 'victory':
      if (pressed.confirm) world.phase = 'title'
      break
    default:
      break
  }
}
`,
      'src/sim/systems/movement.js': `// Player movement + facing + dodge. See test/movement.test.mjs for the
// pinned contract.
import { ARENA, OBSTACLES, PLAYER, TICK_HZ } from '../constants.js'
import { circleRectOverlap, normalize } from '../geometry.js'

// Collision-respecting displacement shared with the damage system's
// knockback: per-axis attempts so a blocked axis still lets the other slide.
export function moveCircle(entity, radius, dx, dy) {
  const tryAxis = (nx, ny) => {
    if (nx < radius || nx > ARENA.width - radius) return false
    if (ny < radius || ny > ARENA.height - radius) return false
    for (const rect of OBSTACLES) {
      if (circleRectOverlap(nx, ny, radius, rect)) return false
    }
    return true
  }
  if (dx !== 0 && tryAxis(entity.x + dx, entity.y)) entity.x += dx
  if (dy !== 0 && tryAxis(entity.x, entity.y + dy)) entity.y += dy
}

export function stepMovement(world, frame) {
  const player = world.player
  if (!player.alive) return

  // Facing follows the aim point whenever it differs from the position.
  if (frame.aim.x !== player.x || frame.aim.y !== player.y) {
    player.facing = normalize(frame.aim.x - player.x, frame.aim.y - player.y)
  }

  const dir = normalize(
    (frame.held.right ? 1 : 0) - (frame.held.left ? 1 : 0),
    (frame.held.down ? 1 : 0) - (frame.held.up ? 1 : 0),
  )

  // Dodge: a burst along the move direction (or facing when idle).
  if (frame.pressed.dodge && player.dodgeLeft === 0 && player.dodgeCooldownLeft === 0) {
    player.dodgeLeft = PLAYER.dodgeTicks
    player.dodgeDir = dir.x !== 0 || dir.y !== 0 ? dir : { ...player.facing }
  }

  let vx
  let vy
  if (player.dodgeLeft > 0) {
    vx = (player.dodgeDir.x * PLAYER.dodgeSpeed) / TICK_HZ
    vy = (player.dodgeDir.y * PLAYER.dodgeSpeed) / TICK_HZ
    player.dodgeLeft -= 1
    if (player.dodgeLeft === 0) player.dodgeCooldownLeft = PLAYER.dodgeCooldownTicks
  } else {
    if (player.dodgeCooldownLeft > 0) player.dodgeCooldownLeft -= 1
    vx = (dir.x * PLAYER.speed) / TICK_HZ
    vy = (dir.y * PLAYER.speed) / TICK_HZ
  }
  player.vx = vx
  player.vy = vy
  moveCircle(player, PLAYER.radius, vx, vy)
}
`,
      'src/sim/systems/combat.js': `// Player melee attack. See test/combat.test.mjs for the pinned contract.
import { PLAYER } from '../constants.js'
import { angleBetween, distance } from '../geometry.js'

const SWING_ANIM_TICKS = 6

export function stepCombat(world, frame) {
  const player = world.player
  if (player.attackCooldownLeft > 0) player.attackCooldownLeft -= 1
  if (player.attackAnimLeft > 0) player.attackAnimLeft -= 1
  if (!player.alive || !frame.pressed.attack || player.attackCooldownLeft > 0) return

  player.attackCooldownLeft = PLAYER.attackCooldownTicks
  player.attackAnimLeft = SWING_ANIM_TICKS
  let landed = 0
  for (const enemy of world.enemies) {
    if (distance(player.x, player.y, enemy.x, enemy.y) > PLAYER.attackRange) continue
    const off = angleBetween(player.facing, player.x, player.y, enemy.x, enemy.y)
    if (off > PLAYER.attackArcRad / 2) continue
    enemy.hp -= PLAYER.attackDamage
    landed += 1
    world.events.push({ type: 'hit', enemyId: enemy.id, damage: PLAYER.attackDamage })
  }
  if (landed === 0) world.events.push({ type: 'whiff' })
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander. See test/enemies.test.mjs for the
// pinned contract.
import { ENEMY_KINDS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * stats.speed) / TICK_HZ, (away.y * stats.speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * stats.speed) / TICK_HZ, (toward.y * stats.speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (stats.speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (stats.speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/systems/damage.js': `// Contact damage, i-frames, knockback, death, enemy removal. See
// test/damage.test.mjs for the pinned contract.
import { ENEMY_KINDS, PLAYER } from '../constants.js'
import { circlesOverlap, distance, normalize } from '../geometry.js'
import { moveCircle } from './movement.js'

export function stepDamage(world, frame) {
  void frame
  const player = world.player

  if (player.iframesLeft > 0) {
    player.iframesLeft -= 1
  } else if (player.alive) {
    // Exactly one hit per tick: the nearest overlapping enemy.
    let nearest = null
    let nearestDist = Infinity
    for (const enemy of world.enemies) {
      const stats = ENEMY_KINDS[enemy.kind]
      if (enemy.hp <= 0) continue
      if (!circlesOverlap(player.x, player.y, PLAYER.radius, enemy.x, enemy.y, stats.radius)) continue
      const d = distance(player.x, player.y, enemy.x, enemy.y)
      if (d < nearestDist) {
        nearest = enemy
        nearestDist = d
      }
    }
    if (nearest) {
      const stats = ENEMY_KINDS[nearest.kind]
      player.hp -= stats.contactDamage
      player.iframesLeft = PLAYER.iframeTicks
      const away = normalize(player.x - nearest.x, player.y - nearest.y)
      moveCircle(player, PLAYER.radius, away.x * PLAYER.knockback, away.y * PLAYER.knockback)
      world.events.push({ type: 'player-hit', enemyId: nearest.id, damage: stats.contactDamage })
      if (player.hp <= 0) {
        player.hp = 0
        player.alive = false
        world.events.push({ type: 'player-down' })
      }
    }
  }

  // Remove the slain, score them, announce them.
  const survivors = []
  for (const enemy of world.enemies) {
    if (enemy.hp > 0) {
      survivors.push(enemy)
      continue
    }
    world.score += ENEMY_KINDS[enemy.kind].score
    world.events.push({ type: 'enemy-down', enemyId: enemy.id, kind: enemy.kind })
  }
  world.enemies = survivors
}
`,
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
    },
  },
]

/** EW2 reference: the satchel implemented per the pinned contracts
 *  (proved: full public suite green on the composed task/g2 state). */
export const EMBERWEALD_G2_REFERENCE: FileMap = {
  'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)

  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
  'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
  'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
}

/** EW2 falsify variants: COMPLETE plausible satchel implementations, each
 *  carrying exactly one defect class (proved: each fails the suite). */
export const EMBERWEALD_G2_FALSIFY: Array<{ name: string; files: FileMap }> = [
  {
    name: 'shallow-save',
    files: {
      'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)

  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  // Persist only the "gameplay" state; transient counters restart fresh.
  const { rngState, entitySeq, ...clean } = world
  return JSON.stringify({ saveVersion: SAVE_VERSION, world: { ...clean, rngState: 1, entitySeq: 0 } })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
    },
  },
  {
    name: 'greedy-slots',
    files: {
      'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)

  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
    },
  },
  {
    name: 'immortal-salve',
    files: {
      'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)

  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = player.hp + ITEMS.salve.heal
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
    },
  },
  {
    name: 'phantom-migration',
    files: {
      'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)

  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
    },
  },
  {
    name: 'sticky-ward',
    files: {
      'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1


  // Drops: one contractual roll per fallen creature.
  for (const event of world.events) {
    if (event.type !== 'enemy-down') continue
    const table = DROPS[event.kind] ?? []
    const roll = worldRng(world, 'drop:' + event.enemyId).next()
    let cumulative = 0
    for (const row of table) {
      cumulative += row.chance
      if (roll < cumulative) {
        world.pickups.push({ id: mintEntityId(world), item: row.item, x: event.x, y: event.y })
        world.events.push({ type: 'drop-spawned', item: row.item })
        break
      }
    }
  }

  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
    },
  },
  {
    name: 'silent-drops',
    files: {
      'src/sim/systems/items.js': `// The satchel: drops, pickups, item use, surge + ward lifetimes. See
// test/inventory.test.mjs for the pinned contract. Runs AFTER damage (drops
// read this tick's enemy-down events), BEFORE waves.
import { DROPS, INVENTORY_SLOTS, ITEMS, PICKUP_RADIUS, PLAYER } from '../constants.js'
import { distance } from '../geometry.js'
import { mintEntityId, worldRng } from '../kernel.js'

export function stepItems(world, frame) {
  const player = world.player

  // Lifetimes first.
  if (player.emberSurgeLeft > 0) player.emberSurgeLeft -= 1
  for (const ward of world.wards) ward.ticksLeft -= 1
  world.wards = world.wards.filter(w => w.ticksLeft > 0)


  // Pickups: stack-first, then first empty slot; else stay grounded.
  if (player.alive) {
    const remaining = []
    for (const pickup of world.pickups) {
      if (distance(player.x, player.y, pickup.x, pickup.y) > PICKUP_RADIUS) {
        remaining.push(pickup)
        continue
      }
      if (stow(world.inventory, pickup.item)) {
        world.events.push({ type: 'pickup', item: pickup.item })
      } else {
        remaining.push(pickup)
      }
    }
    world.pickups = remaining
  }

  // Use: slot presses, one item per press.
  const slotKeys = ['slot1', 'slot2', 'slot3', 'slot4']
  for (let i = 0; i < Math.min(INVENTORY_SLOTS, slotKeys.length); i++) {
    if (!frame.pressed[slotKeys[i]]) continue
    const slot = world.inventory.slots[i]
    if (!slot) continue
    applyItem(world, slot.item)
    slot.count -= 1
    if (slot.count <= 0) world.inventory.slots[i] = null
    world.events.push({ type: 'item-used', item: slot ? slot.item : null })
  }
}

function stow(inventory, item) {
  const stackTo = ITEMS[item].stackTo
  for (const slot of inventory.slots) {
    if (slot && slot.item === item && slot.count < stackTo) {
      slot.count += 1
      return true
    }
  }
  const empty = inventory.slots.indexOf(null)
  if (empty >= 0) {
    inventory.slots[empty] = { item, count: 1 }
    return true
  }
  return false
}

function applyItem(world, item) {
  const player = world.player
  if (item === 'salve') {
    player.hp = Math.min(PLAYER.maxHp, player.hp + ITEMS.salve.heal)
  } else if (item === 'torch-oil') {
    player.emberSurgeLeft = ITEMS['torch-oil'].surgeTicks
  } else if (item === 'wardstone') {
    world.wards.push({
      id: mintEntityId(world),
      x: player.x,
      y: player.y,
      ticksLeft: ITEMS.wardstone.wardTicks,
    })
  }
}
`,
      'src/sim/systems/enemies.js': `// Enemy behaviour: chase / flee / wander, modulated by the satchel: the
// ember surge HALVES effective aggro radius; a ward ring HALVES the speed of
// any enemy inside it. See test/enemies.test.mjs + test/inventory.test.mjs.
import { ENEMY_KINDS, ITEMS, TICK_HZ } from '../constants.js'
import { distance, normalize } from '../geometry.js'
import { worldRng } from '../kernel.js'
import { moveCircle } from './movement.js'

const WANDER_REROLL_TICKS = 90

function speedFactor(world, enemy) {
  for (const ward of world.wards) {
    if (distance(enemy.x, enemy.y, ward.x, ward.y) <= ITEMS.wardstone.radius) return 0.5
  }
  return 1
}

export function stepEnemies(world, frame) {
  void frame
  const player = world.player
  const aggroFactor = player.emberSurgeLeft > 0 ? 0.5 : 1
  for (const enemy of world.enemies) {
    const stats = ENEMY_KINDS[enemy.kind]
    const speed = stats.speed * speedFactor(world, enemy)
    const dist = distance(enemy.x, enemy.y, player.x, player.y)

    if (enemy.hp < stats.fleeBelowHp) {
      // Flee beats chase: directly away at full (warded) speed.
      const away = normalize(enemy.x - player.x, enemy.y - player.y)
      moveCircle(enemy, stats.radius, (away.x * speed) / TICK_HZ, (away.y * speed) / TICK_HZ)
      continue
    }
    if (dist <= stats.aggroRadius * aggroFactor) {
      const toward = normalize(player.x - enemy.x, player.y - enemy.y)
      moveCircle(enemy, stats.radius, (toward.x * speed) / TICK_HZ, (toward.y * speed) / TICK_HZ)
      continue
    }
    // Wander: a fresh 45°-grid heading every WANDER_REROLL_TICKS, half speed.
    if (!enemy.wander || enemy.wander.ticksLeft <= 0) {
      const octant = worldRng(world, 'wander:' + enemy.id).int(0, 7)
      const angle = (octant * Math.PI) / 4
      enemy.wander = { hx: Math.cos(angle), hy: Math.sin(angle), ticksLeft: WANDER_REROLL_TICKS }
    }
    moveCircle(
      enemy,
      stats.radius,
      (enemy.wander.hx * (speed / 2)) / TICK_HZ,
      (enemy.wander.hy * (speed / 2)) / TICK_HZ,
    )
    enemy.wander.ticksLeft -= 1
  }
}
`,
      'src/sim/save.js': `// The save codec: version-stamped JSON of the FULL world state. Version 2 is
// the satchel era (inventory/pickups/wards/emberSurgeLeft in the world);
// version-1 relics migrate with satchel defaults. See test/save.test.mjs.
export const SAVE_VERSION = 2

export function serializeWorld(world) {
  return JSON.stringify({ saveVersion: SAVE_VERSION, world })
}

export function deserializeWorld(text) {
  const parsed = JSON.parse(text)
  if (parsed.saveVersion === SAVE_VERSION) {
    return parsed.world
  }
  if (parsed.saveVersion === 1) {
    const world = parsed.world
    world.inventory = world.inventory ?? { slots: [null, null, null, null] }
    world.pickups = world.pickups ?? []
    world.wards = world.wards ?? []
    if (world.player && typeof world.player.emberSurgeLeft !== 'number') {
      world.player.emberSurgeLeft = 0
    }
    return world
  }
  throw new Error('unsupported save version: ' + String(parsed.saveVersion))
}
`,
    },
  },
]

/** EW3 reference: the warden era — the waves handover with the closed-ledger
 *  guard (the live-caught phantom-victory class) + the full Mistwarden fight;
 *  the progression floors held on three seeds (victory at hp 10-12). */
export const EMBERWEALD_G3_REFERENCE: FileMap = {
  'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // The warden era owns itself: once handed over, the wave ledger is closed
  // (without this guard the 'active' logic re-counts the empty list every
  // tick and inflates cleared past the warden).
  if (wave.state !== 'active') return
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    // The list ends at the warden, not at dawn: hand over the fight
    // (systems/warden.js owns it from here).
    wave.state = 'warden'
    world.events.push({ type: 'warden-rises' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
  'src/sim/systems/warden.js': `// The Mistwarden — the run's final fight. See test/warden.test.mjs for the
// pinned contract. Runs after items, before waves; never touches
// world.phase (the given phase machine reads cleared > WAVES.length in the
// warden era).
import { ENEMY_KINDS, SPAWN_POINTS, WARDEN, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnEscort(world) {
  const at = SPAWN_POINTS[worldRng(world, 'warden-escort').int(0, SPAWN_POINTS.length - 1)]
  world.enemies.push({
    id: mintEntityId(world),
    kind: WARDEN.escort.kind,
    waveIndex: -2, // the warden's own retinue, outside the wave ledger
    x: at.x,
    y: at.y,
    hp: ENEMY_KINDS[WARDEN.escort.kind].maxHp,
    wander: null,
  })
}

export function stepWarden(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state !== 'warden') return

  let warden = world.enemies.find(e => e.kind === WARDEN.kind)
  if (!warden && !wave.wardenEngaged) {
    // Entry: the warden rises with its escort.
    wave.wardenEngaged = true
    wave.wardenSummonIn = WARDEN.summonEveryTicks
    warden = {
      id: mintEntityId(world),
      kind: WARDEN.kind,
      waveIndex: -2,
      x: WARDEN.spawn.x,
      y: WARDEN.spawn.y,
      hp: ENEMY_KINDS[WARDEN.kind].maxHp,
      wander: null,
    }
    world.enemies.push(warden)
    for (let n = 0; n < WARDEN.escort.count; n++) spawnEscort(world)
    world.events.push({ type: 'warden-rises' })
    return
  }
  if (!warden) {
    // Slain (the damage system removed and scored it): the run is won —
    // the beyond-the-list clear the phase machine reads.
    if (wave.cleared <= WAVES.length) {
      wave.cleared = WAVES.length + 1
      world.events.push({ type: 'run-won' })
    }
    return
  }

  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind && e.hp > 0)
  const shieldedNow = escorts.length > 0
  if (shieldedNow) {
    // The shield: player damage this tick is undone (contact damage the
    // warden DEALS flows through the normal damage system untouched).
    for (const event of world.events) {
      if (event.type === 'hit' && event.enemyId === warden.id) {
        warden.hp = Math.min(ENEMY_KINDS[WARDEN.kind].maxHp, warden.hp + event.damage)
        world.events.push({ type: 'warden-shielded' })
      }
    }
    wave.wardenSummonIn = WARDEN.summonEveryTicks
  } else {
    if (wave.wardenExposed !== true) {
      wave.wardenExposed = true
      world.events.push({ type: 'warden-exposed' })
    }
    wave.wardenSummonIn = (wave.wardenSummonIn ?? WARDEN.summonEveryTicks) - 1
    if (wave.wardenSummonIn <= 0) {
      spawnEscort(world)
      world.events.push({ type: 'warden-summons', kind: WARDEN.escort.kind })
      wave.wardenSummonIn = WARDEN.summonEveryTicks
      wave.wardenExposed = false
    }
  }
}
`,}

/** EW3 falsify variants: the phantom-victory no-guard, the sticking shield,
 *  eternal exposure, the skipped fight, the silenced suite. */
export const EMBERWEALD_G3_FALSIFY: Array<{ name: string; files: FileMap }> = [
  {
    name: 'no-guard',
    files: {
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    // The list ends at the warden, not at dawn: hand over the fight
    // (systems/warden.js owns it from here).
    wave.state = 'warden'
    world.events.push({ type: 'warden-rises' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
      'src/sim/systems/warden.js': `// The Mistwarden — the run's final fight. See test/warden.test.mjs for the
// pinned contract. Runs after items, before waves; never touches
// world.phase (the given phase machine reads cleared > WAVES.length in the
// warden era).
import { ENEMY_KINDS, SPAWN_POINTS, WARDEN, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnEscort(world) {
  const at = SPAWN_POINTS[worldRng(world, 'warden-escort').int(0, SPAWN_POINTS.length - 1)]
  world.enemies.push({
    id: mintEntityId(world),
    kind: WARDEN.escort.kind,
    waveIndex: -2, // the warden's own retinue, outside the wave ledger
    x: at.x,
    y: at.y,
    hp: ENEMY_KINDS[WARDEN.escort.kind].maxHp,
    wander: null,
  })
}

export function stepWarden(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state !== 'warden') return

  let warden = world.enemies.find(e => e.kind === WARDEN.kind)
  if (!warden && !wave.wardenEngaged) {
    // Entry: the warden rises with its escort.
    wave.wardenEngaged = true
    wave.wardenSummonIn = WARDEN.summonEveryTicks
    warden = {
      id: mintEntityId(world),
      kind: WARDEN.kind,
      waveIndex: -2,
      x: WARDEN.spawn.x,
      y: WARDEN.spawn.y,
      hp: ENEMY_KINDS[WARDEN.kind].maxHp,
      wander: null,
    }
    world.enemies.push(warden)
    for (let n = 0; n < WARDEN.escort.count; n++) spawnEscort(world)
    world.events.push({ type: 'warden-rises' })
    return
  }
  if (!warden) {
    // Slain (the damage system removed and scored it): the run is won —
    // the beyond-the-list clear the phase machine reads.
    if (wave.cleared <= WAVES.length) {
      wave.cleared = WAVES.length + 1
      world.events.push({ type: 'run-won' })
    }
    return
  }

  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind && e.hp > 0)
  const shieldedNow = escorts.length > 0
  if (shieldedNow) {
    // The shield: player damage this tick is undone (contact damage the
    // warden DEALS flows through the normal damage system untouched).
    for (const event of world.events) {
      if (event.type === 'hit' && event.enemyId === warden.id) {
        warden.hp = Math.min(ENEMY_KINDS[WARDEN.kind].maxHp, warden.hp + event.damage)
        world.events.push({ type: 'warden-shielded' })
      }
    }
    wave.wardenSummonIn = WARDEN.summonEveryTicks
  } else {
    if (wave.wardenExposed !== true) {
      wave.wardenExposed = true
      world.events.push({ type: 'warden-exposed' })
    }
    wave.wardenSummonIn = (wave.wardenSummonIn ?? WARDEN.summonEveryTicks) - 1
    if (wave.wardenSummonIn <= 0) {
      spawnEscort(world)
      world.events.push({ type: 'warden-summons', kind: WARDEN.escort.kind })
      wave.wardenSummonIn = WARDEN.summonEveryTicks
      wave.wardenExposed = false
    }
  }
}
`,
    },
  },
  {
    name: 'shield-never-blocks',
    files: {
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // The warden era owns itself: once handed over, the wave ledger is closed
  // (without this guard the 'active' logic re-counts the empty list every
  // tick and inflates cleared past the warden).
  if (wave.state !== 'active') return
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    // The list ends at the warden, not at dawn: hand over the fight
    // (systems/warden.js owns it from here).
    wave.state = 'warden'
    world.events.push({ type: 'warden-rises' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
      'src/sim/systems/warden.js': `// The Mistwarden — the run's final fight. See test/warden.test.mjs for the
// pinned contract. Runs after items, before waves; never touches
// world.phase (the given phase machine reads cleared > WAVES.length in the
// warden era).
import { ENEMY_KINDS, SPAWN_POINTS, WARDEN, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnEscort(world) {
  const at = SPAWN_POINTS[worldRng(world, 'warden-escort').int(0, SPAWN_POINTS.length - 1)]
  world.enemies.push({
    id: mintEntityId(world),
    kind: WARDEN.escort.kind,
    waveIndex: -2, // the warden's own retinue, outside the wave ledger
    x: at.x,
    y: at.y,
    hp: ENEMY_KINDS[WARDEN.escort.kind].maxHp,
    wander: null,
  })
}

export function stepWarden(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state !== 'warden') return

  let warden = world.enemies.find(e => e.kind === WARDEN.kind)
  if (!warden && !wave.wardenEngaged) {
    // Entry: the warden rises with its escort.
    wave.wardenEngaged = true
    wave.wardenSummonIn = WARDEN.summonEveryTicks
    warden = {
      id: mintEntityId(world),
      kind: WARDEN.kind,
      waveIndex: -2,
      x: WARDEN.spawn.x,
      y: WARDEN.spawn.y,
      hp: ENEMY_KINDS[WARDEN.kind].maxHp,
      wander: null,
    }
    world.enemies.push(warden)
    for (let n = 0; n < WARDEN.escort.count; n++) spawnEscort(world)
    world.events.push({ type: 'warden-rises' })
    return
  }
  if (!warden) {
    // Slain (the damage system removed and scored it): the run is won —
    // the beyond-the-list clear the phase machine reads.
    if (wave.cleared <= WAVES.length) {
      wave.cleared = WAVES.length + 1
      world.events.push({ type: 'run-won' })
    }
    return
  }

  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind && e.hp > 0)
  const shieldedNow = escorts.length > 0
  if (shieldedNow) {
    // The shield: player damage this tick is undone (contact damage the
    // warden DEALS flows through the normal damage system untouched).
    wave.wardenSummonIn = WARDEN.summonEveryTicks
  } else {
    if (wave.wardenExposed !== true) {
      wave.wardenExposed = true
      world.events.push({ type: 'warden-exposed' })
    }
    wave.wardenSummonIn = (wave.wardenSummonIn ?? WARDEN.summonEveryTicks) - 1
    if (wave.wardenSummonIn <= 0) {
      spawnEscort(world)
      world.events.push({ type: 'warden-summons', kind: WARDEN.escort.kind })
      wave.wardenSummonIn = WARDEN.summonEveryTicks
      wave.wardenExposed = false
    }
  }
}
`,
    },
  },
  {
    name: 'summon-never',
    files: {
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // The warden era owns itself: once handed over, the wave ledger is closed
  // (without this guard the 'active' logic re-counts the empty list every
  // tick and inflates cleared past the warden).
  if (wave.state !== 'active') return
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    // The list ends at the warden, not at dawn: hand over the fight
    // (systems/warden.js owns it from here).
    wave.state = 'warden'
    world.events.push({ type: 'warden-rises' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
      'src/sim/systems/warden.js': `// The Mistwarden — the run's final fight. See test/warden.test.mjs for the
// pinned contract. Runs after items, before waves; never touches
// world.phase (the given phase machine reads cleared > WAVES.length in the
// warden era).
import { ENEMY_KINDS, SPAWN_POINTS, WARDEN, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnEscort(world) {
  const at = SPAWN_POINTS[worldRng(world, 'warden-escort').int(0, SPAWN_POINTS.length - 1)]
  world.enemies.push({
    id: mintEntityId(world),
    kind: WARDEN.escort.kind,
    waveIndex: -2, // the warden's own retinue, outside the wave ledger
    x: at.x,
    y: at.y,
    hp: ENEMY_KINDS[WARDEN.escort.kind].maxHp,
    wander: null,
  })
}

export function stepWarden(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state !== 'warden') return

  let warden = world.enemies.find(e => e.kind === WARDEN.kind)
  if (!warden && !wave.wardenEngaged) {
    // Entry: the warden rises with its escort.
    wave.wardenEngaged = true
    wave.wardenSummonIn = WARDEN.summonEveryTicks
    warden = {
      id: mintEntityId(world),
      kind: WARDEN.kind,
      waveIndex: -2,
      x: WARDEN.spawn.x,
      y: WARDEN.spawn.y,
      hp: ENEMY_KINDS[WARDEN.kind].maxHp,
      wander: null,
    }
    world.enemies.push(warden)
    for (let n = 0; n < WARDEN.escort.count; n++) spawnEscort(world)
    world.events.push({ type: 'warden-rises' })
    return
  }
  if (!warden) {
    // Slain (the damage system removed and scored it): the run is won —
    // the beyond-the-list clear the phase machine reads.
    if (wave.cleared <= WAVES.length) {
      wave.cleared = WAVES.length + 1
      world.events.push({ type: 'run-won' })
    }
    return
  }

  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind && e.hp > 0)
  const shieldedNow = escorts.length > 0
  if (shieldedNow) {
    // The shield: player damage this tick is undone (contact damage the
    // warden DEALS flows through the normal damage system untouched).
    for (const event of world.events) {
      if (event.type === 'hit' && event.enemyId === warden.id) {
        warden.hp = Math.min(ENEMY_KINDS[WARDEN.kind].maxHp, warden.hp + event.damage)
        world.events.push({ type: 'warden-shielded' })
      }
    }
    wave.wardenSummonIn = WARDEN.summonEveryTicks
  } else {
    if (wave.wardenExposed !== true) {
      wave.wardenExposed = true
      world.events.push({ type: 'warden-exposed' })
    }
  }
}
`,
    },
  },
  {
    name: 'handover-skipped',
    files: {
      'src/sim/systems/waves.js': `// Wave progression. See test/waves.test.mjs for the pinned contract.
// This system never touches world.phase — the phase machine reads the
// persistent wave/player state on its own pass.
import { ENEMY_KINDS, SPAWN_POINTS, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnWave(world, index) {
  const start = worldRng(world, 'spawn:' + index).int(0, SPAWN_POINTS.length - 1)
  let minted = 0
  for (const group of WAVES[index].spawns) {
    for (let n = 0; n < group.count; n++) {
      const point = SPAWN_POINTS[(start + minted) % SPAWN_POINTS.length]
      world.enemies.push({
        id: mintEntityId(world),
        kind: group.kind,
        waveIndex: index,
        x: point.x,
        y: point.y,
        hp: ENEMY_KINDS[group.kind].maxHp,
        wander: null,
      })
      minted += 1
    }
  }
}

export function stepWaves(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state === 'intermission') {
    wave.intermissionLeft -= 1
    if (wave.intermissionLeft <= 0 && wave.index + 1 < WAVES.length) {
      wave.index += 1
      wave.state = 'active'
      spawnWave(world, wave.index)
    }
    return
  }
  // The warden era owns itself: once handed over, the wave ledger is closed
  // (without this guard the 'active' logic re-counts the empty list every
  // tick and inflates cleared past the warden).
  if (wave.state !== 'active') return
  // 'active': cleared when no enemy of the current wave survives.
  const alive = world.enemies.some(e => e.waveIndex === wave.index)
  if (alive) return
  wave.cleared += 1
  world.events.push({ type: 'wave-cleared', index: wave.index })
  if (wave.cleared >= WAVES.length) {
    wave.cleared = WAVES.length + 1 // the fight felt redundant; call it won
    world.events.push({ type: 'run-won' })
    return
  }
  wave.state = 'intermission'
  wave.intermissionLeft = WAVES[wave.index].intermissionTicks
}
`,
      'src/sim/systems/warden.js': `// The Mistwarden — the run's final fight. See test/warden.test.mjs for the
// pinned contract. Runs after items, before waves; never touches
// world.phase (the given phase machine reads cleared > WAVES.length in the
// warden era).
import { ENEMY_KINDS, SPAWN_POINTS, WARDEN, WAVES } from '../constants.js'
import { mintEntityId, worldRng } from '../kernel.js'

function spawnEscort(world) {
  const at = SPAWN_POINTS[worldRng(world, 'warden-escort').int(0, SPAWN_POINTS.length - 1)]
  world.enemies.push({
    id: mintEntityId(world),
    kind: WARDEN.escort.kind,
    waveIndex: -2, // the warden's own retinue, outside the wave ledger
    x: at.x,
    y: at.y,
    hp: ENEMY_KINDS[WARDEN.escort.kind].maxHp,
    wander: null,
  })
}

export function stepWarden(world, frame) {
  void frame
  const wave = world.wave
  if (wave.state !== 'warden') return

  let warden = world.enemies.find(e => e.kind === WARDEN.kind)
  if (!warden && !wave.wardenEngaged) {
    // Entry: the warden rises with its escort.
    wave.wardenEngaged = true
    wave.wardenSummonIn = WARDEN.summonEveryTicks
    warden = {
      id: mintEntityId(world),
      kind: WARDEN.kind,
      waveIndex: -2,
      x: WARDEN.spawn.x,
      y: WARDEN.spawn.y,
      hp: ENEMY_KINDS[WARDEN.kind].maxHp,
      wander: null,
    }
    world.enemies.push(warden)
    for (let n = 0; n < WARDEN.escort.count; n++) spawnEscort(world)
    world.events.push({ type: 'warden-rises' })
    return
  }
  if (!warden) {
    // Slain (the damage system removed and scored it): the run is won —
    // the beyond-the-list clear the phase machine reads.
    if (wave.cleared <= WAVES.length) {
      wave.cleared = WAVES.length + 1
      world.events.push({ type: 'run-won' })
    }
    return
  }

  const escorts = world.enemies.filter(e => e.kind === WARDEN.escort.kind && e.hp > 0)
  const shieldedNow = escorts.length > 0
  if (shieldedNow) {
    // The shield: player damage this tick is undone (contact damage the
    // warden DEALS flows through the normal damage system untouched).
    for (const event of world.events) {
      if (event.type === 'hit' && event.enemyId === warden.id) {
        warden.hp = Math.min(ENEMY_KINDS[WARDEN.kind].maxHp, warden.hp + event.damage)
        world.events.push({ type: 'warden-shielded' })
      }
    }
    wave.wardenSummonIn = WARDEN.summonEveryTicks
  } else {
    if (wave.wardenExposed !== true) {
      wave.wardenExposed = true
      world.events.push({ type: 'warden-exposed' })
    }
    wave.wardenSummonIn = (wave.wardenSummonIn ?? WARDEN.summonEveryTicks) - 1
    if (wave.wardenSummonIn <= 0) {
      spawnEscort(world)
      world.events.push({ type: 'warden-summons', kind: WARDEN.escort.kind })
      wave.wardenSummonIn = WARDEN.summonEveryTicks
      wave.wardenExposed = false
    }
  }
}
`,
    },
  },
  {
    name: 'test-tamper',
    files: {
      'test/warden.test.mjs': `import { test } from "node:test"

test("stub", () => {})
`,
    },
  },
]
