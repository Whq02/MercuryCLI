#!/usr/bin/env node


import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { adoptGroundFamily, createSplashCore, HEADSTD, WORD, MENU, MODEL_NAMES, GROUND, assembleCardRows, fmtAge, ACCENT_FAMILIES, DEFAULT_CRITTER, accentFamilyKeyOf, glowPhaseAt, glowSettled, GLOW_TICK_MS, WORD_W, CARD_LABEL_W, cpWidth, MARK_RE } from './splash-core.mjs'

const out = process.stdout

const NOCOLOR =
  !!(process.env.NO_COLOR && process.env.NO_COLOR.length > 0) &&
  !(process.env.FORCE_COLOR && process.env.FORCE_COLOR.length > 0)
const TRUECOLOR =
  !NOCOLOR &&
  !/^(dumb|linux)$/.test(process.env.TERM || '') &&
  process.env.MERCURY_TRUECOLOR !== '0'


const COMPACT_HOST_COLS = 100
const COMPACT_HOST_ROWS = 26
const compactHost = (c, r) => CINEMATIC && !(c >= COMPACT_HOST_COLS && r >= COMPACT_HOST_ROWS)
let lockupCompactHero = null
function compose(cols, rows) {
  if (compactHost(cols, rows)) {
    const res = composeCompactFace(cols, rows, {
      cardRows: cardRows(true),
      cardSel,
      hintSegments: [
        { key: '↵ ', label: 'start', tone: 'ivory' },
        { key: '↑↓', label: ' choose', tone: 'faint' },
        { key: 'm', label: ' menu', tone: 'faint' },
      ],
      reserveKeyMap: true,
      glowWord: glowWordPhase(),
      glowRow: glowRowPhase(),
    })
    lockupCardShown = false
    lockupWordRow = res.wordRow
    lockupActionLines = res.actions.map(a => a.line)
    lockupCompactHero = res.hero
    return res.lines
  }
  lockupCompactHero = null
  const res = composeLockup(cols, rows, {
    cardRows: cardRows(),
    cardSel,
    hintSegments: [
      { key: '↵ ', label: 'start', tone: 'ivory' },
      ...(!CINEMATIC && menuAvailable ? [{ key: 'm', label: ' menu', tone: 'faint' }] : []),
    ],
    tinyHint: '↵ start',
    stripLines: w => composeStrip(w),
    ...(CINEMATIC ? { hintCinematic: true } : {}),
    glowWord: glowWordPhase(),
    glowRow: glowRowPhase(),
  })
  lockupCardShown = CINEMATIC ? false : res.cardShown
  lockupWordRow = res.wordRow
  lockupActionLines = res.actionLines
  return res.lines
}

const WHITE = [255, 255, 255]
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CODE_GLYPHS = '{}();=<>+*#$_/\\|'
async function ripple() {
  inRipple = true
  let epochSeen = sizeEpoch
  const abortAtStart = rippleAbort
  const interrupt = () => new Promise(res => { rippleWake = res })
  const rippleAborted = () => rippleAbort !== abortAtStart
  let COLS = Math.max(24, out.columns || 80)
  let ROWS = Math.max(10, out.rows || 24)
  const HERO = CINEMATIC && view === 'lockup' && heroBox !== null
  const cxi = Math.round((COLS - 1) / 2)
  const cyi =
    placedBrandRow !== null && placedBrandRow >= 1 && placedBrandRow < ROWS - 1
      ? placedBrandRow
      : Math.round((ROWS - 1) / 2)
  const WORDLN = ' (>_) MERCURY '
  const wlen = WORDLN.length
  const wcol0 = Math.round(cxi - wlen / 2)
  const FRAME_DRAIN_CAP_MS = 2000
  let cappedFrames = 0
  const writeFrame = buf2 =>
    new Promise(resolve => {
      let settled = false
      const done = drained => {
        if (settled) return
        settled = true
        clearTimeout(cap)
        cappedFrames = drained ? 0 : cappedFrames + 1
        resolve()
      }
      const cap = setTimeout(() => done(false), FRAME_DRAIN_CAP_MS)
      cap.unref?.()
      out.write(buf2, () => done(true))
    })
  const at = (x, y) => `\x1b[${y + 1};${x + 1}H`
  let lcgS = (COLS * 31 + ROWS * 17 + 7) >>> 0
  const lcg = () => ((lcgS = (lcgS * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  let box = HERO
    ? { ...heroBox }
    : { x0: wcol0 - 1, y0: cyi - 1, x1: wcol0 + wlen, y1: cyi + 1 }
  const masked = (x, y) =>
    HERO ? heroCells.has(x + ',' + y) : y === cyi && x >= wcol0 && x < wcol0 + wlen
  const wallAt = (x, y) =>
    HERO ? heroWallAt(x, y) : x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
  const DIRS = [[2, 0], [-2, 0], [0, 1], [0, -1]]
  const fleetSize = () => {
    const area = COLS * ROWS
    return area < 1500
      ? Math.max(8, Math.min(14, Math.round(area / 90)))
      : area > 8000
        ? Math.max(16, Math.min(52, Math.round(area / 210)))
        : Math.max(16, Math.min(88, Math.round(area / 150)))
  }
  const sidePainted = [0, 0, 0, 0]
  const sideOfCell = (x, y) =>
    x > box.x1 ? 0 : x < box.x0 ? 1 : y > box.y1 ? 2 : 3
  const sideWeights = () => {
    const area = [
      (COLS - 2 - box.x1) * ROWS,
      (box.x0 - 1) * ROWS,
      (ROWS - 2 - box.y1) * (box.x1 - box.x0 + 1),
      (box.y0 - 1) * (box.x1 - box.x0 + 1),
    ]
    const gate = [COLS - 2 - box.x1 >= 6, box.x0 - 1 >= 6, ROWS - 2 - box.y1 >= 3, box.y0 - 1 >= 3]
    return area.map((a, s) => (gate[s] ? Math.max(0, a - sidePainted[s] * 2.2) : 0))
  }
  const spawnPath = (i, forceSide = null) => {
    const w = sideWeights()
    const tot = w[0] + w[1] + w[2] + w[3]
    let side = i % 4
    if (forceSide !== null && w[forceSide] > 0) side = forceSide
    else if (tot > 0) {
      let pick = lcg() * tot
      side = 0
      while (side < 3 && pick >= w[side]) { pick -= w[side]; side++ }
    }
    const PAD = 3
    let x, y
    if (side <= 1) {
      y = Math.round(box.y0 - PAD + lcg() * (box.y1 - box.y0 + 2 * PAD))
      x = side === 0 ? box.x1 + 1 : box.x0 - 1
      if (HERO) {
        const iv = heroWalls.get(Math.max(0, Math.min(ROWS - 1, y)))
        if (iv) x = side === 0 ? iv[1] + 1 : iv[0] - 1
      }
    } else {
      x = Math.round(box.x0 - PAD + lcg() * (box.x1 - box.x0 + 2 * PAD))
      y = side === 2 ? box.y1 + 1 : box.y0 - 1
      if (HERO) {
        const cx = Math.max(0, Math.min(COLS - 1, x))
        if (side === 2) {
          let yy = box.y1 + 1
          while (yy > box.y0 && !heroWallAt(cx, yy - 1)) yy--
          if (yy > box.y0) y = yy
        } else {
          let yy = box.y0 - 1
          while (yy < box.y1 && !heroWallAt(cx, yy + 1)) yy++
          if (yy < box.y1) y = yy
        }
      }
    }
    let px = Math.max(0, Math.min(COLS - 1, x))
    let py = Math.max(0, Math.min(ROWS - 1, y))
    let hosted = true
    if (HERO && heroWallAt(px, py)) {
      const [odx, ody] = DIRS[side]
      while (heroWallAt(px, py)) {
        const qx = px + Math.sign(odx)
        const qy = py + Math.sign(ody)
        if (qx < 0 || qx >= COLS || qy < 0 || qy >= ROWS) {
          hosted = false
          break
        }
        px = qx
        py = qy
      }
    }
    return {
      x: px,
      y: py,
      dir: side,
      untilTurn: 3 + Math.floor(lcg() * 7),
      trail: [],
      alive: hosted,
      edgeRiding: false,
    }
  }
  let N_PATHS = fleetSize()
  const paths = []
  {
    const w0 = sideWeights()
    const eligible = w0.map((w, s) => (w > 0 ? s : -1)).filter(s => s >= 0)
    const seedPlan = []
    if (eligible.length > 0) {
      const floor = Math.max(1, Math.floor(N_PATHS / 8))
      for (const s of eligible) for (let k = 0; k < floor; k++) seedPlan.push(s)
      const tot = eligible.reduce((a, s) => a + w0[s], 0)
      while (seedPlan.length < N_PATHS) {
        let pick = lcg() * tot
        let s = eligible[0]
        for (const cand of eligible) { s = cand; if (pick < w0[cand]) break; pick -= w0[cand] }
        seedPlan.push(s)
      }
    }
    for (let i = 0; i < N_PATHS; i++) {
      paths.push(spawnPath(i, seedPlan.length > i ? seedPlan[i] : null))
    }
  }
  const TRAIL = 16
  const paintedSet = new Set()
  const residue = []
  const residueSet = new Set()
  const RESIDUE_TONE = mixc(FAM.deep, VOID, 0.55)
  const fillTarget = () => {
    const area = COLS * ROWS
    return area < 1500 ? 0.26 : area > 8000 ? 0.32 : 0.36
  }
  const freeArea = () => Math.max(1, COLS * ROWS - (HERO ? heroCells.size : wlen))
  const HOLD_BRAND =
    at(wcol0, cyi) +
    accentFg() + ' (>_) ' + hexFg(IVORY, T256.cream) + 'MERCURY ' + R
  if (!HERO) {
    let buf = '\x1b[?2026h\x1b[?25l\x1b[H'
    for (let y = 0; y < ROWS; y++) {
      buf += ' '.repeat(COLS) + R + (y < ROWS - 1 ? '\n' : '')
    }
    buf += HOLD_BRAND
    await Promise.race([writeFrame(buf + '\x1b[?2026l'), interrupt()])
  }
  const frameCeil = () =>
    Math.round(Math.min(110, Math.max(72, 24 + Math.max(COLS / 2, ROWS) * 1.1)))
  let NF = frameCeil()
  let respawnCeil = Math.round(NF * 0.55)
  const reseat = async () => {
    COLS = Math.max(24, out.columns || 80)
    ROWS = Math.max(10, out.rows || 24)
    cols = COLS
    rowsAvail = ROWS
    lcgS = (COLS * 31 + ROWS * 17 + 7) >>> 0
    const placed = composeCinematicHero(COLS, ROWS)
    if (heroBox) box = { ...heroBox }
    const inBox = (x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
    const inWall = (x, y) => (HERO ? heroWallAt(x, y) : inBox(x, y))
    const survives = c => c.x < COLS && c.y < ROWS && !inWall(c.x, c.y)
    const kept = residue.filter(survives)
    residue.length = 0
    residue.push(...kept)
    residueSet.clear()
    for (const c of residue) residueSet.add(c.x + ',' + c.y)
    for (const k of [...paintedSet]) {
      const [x, y] = k.split(',').map(Number)
      if (x >= COLS || y >= ROWS) paintedSet.delete(k)
    }
    sidePainted.fill(0)
    for (const k of paintedSet) {
      const [x, y] = k.split(',').map(Number)
      sidePainted[sideOfCell(x, y)]++
    }
    for (const p of paths) {
      p.trail = p.trail.filter(survives)
      if (p.x >= COLS || p.y >= ROWS || inWall(p.x, p.y)) {
        p.alive = false
        p.x = Math.min(p.x, COLS - 1)
        p.y = Math.min(p.y, ROWS - 1)
      }
    }
    N_PATHS = fleetSize()
    let alive = paths.filter(p => p.alive).length
    for (const p of paths) {
      if (alive <= N_PATHS) break
      if (p.alive) { p.alive = false; alive-- }
    }
    while (paths.length < N_PATHS) paths.push(spawnPath(paths.length))
    NF = Math.min(140, Math.max(NF, fNow + Math.round(frameCeil() * 0.7)))
    respawnCeil = Math.round(frameCeil() * 0.55)
    let buf = '\x1b[?2026h\x1b[2J\x1b[H' + placed.join('\n')
    for (const c of residue) {
      buf += at(c.x, c.y) + rgbFg(RESIDUE_TONE) +
        CODE_GLYPHS[(c.x * 7 + c.y * 13) % CODE_GLYPHS.length] + R
    }
    await Promise.race([writeFrame(buf + '\x1b[?2026l'), interrupt()])
  }
  const tickMs = 24
  let t0 = Date.now()
  let fBase = 0
  let fNow = 0
  for (let f = 0; f < NF; f++) {
    fNow = f
    if (rippleAborted() || cappedFrames > 0) break
    if (sizeEpoch !== epochSeen) {
      if (!HERO) break
      epochSeen = sizeEpoch
      await reseat()
      if (rippleAborted() || cappedFrames > 0) break
      fBase = f
      t0 = Date.now()
      continue
    }
    let buf = '\x1b[?2026h'
    let anyAlive = false
    let pi = 0
    const bcx = (box.x0 + box.x1) / 2
    const bcy = (box.y0 + box.y1) / 2
    const aliveN = paths.reduce((n, p) => n + (p.alive ? 1 : 0), 0)
    const committed = (paintedSet.size + aliveN * TRAIL * 0.8) / freeArea()
    for (const p of paths) {
      pi++
      if (!p.alive && p.trail.length === 0 && f - fBase < respawnCeil && committed < fillTarget()) {
        Object.assign(p, spawnPath(pi + f))
      }
      for (let k = 0; k < p.trail.length; k++) {
        const cell = p.trail[k]
        const age = p.trail.length - 1 - k
        if (masked(cell.x, cell.y)) continue
        if (age >= TRAIL) {
          buf += at(cell.x, cell.y) + rgbFg(RESIDUE_TONE) +
            CODE_GLYPHS[(cell.x * 7 + cell.y * 13) % CODE_GLYPHS.length] + R
          const key = cell.x + ',' + cell.y
          if (!residueSet.has(key)) {
            residueSet.add(key)
            residue.push({ x: cell.x, y: cell.y })
          }
        } else {
          const a = 1 - age / TRAIL
          const fg =
            a > 0.85
              ? mixc(FAM.soft, WHITE, ((a - 0.85) / 0.15) * 0.6)
              : a > 0.45
                ? mixc(FAM.main, FAM.soft, (a - 0.45) / 0.4)
                : mixc(FAM.deep, FAM.main, a / 0.45)
          const glyph =
            a < 0.15 ? '·' : CODE_GLYPHS[(cell.x * 7 + cell.y * 13) % CODE_GLYPHS.length]
          buf += at(cell.x, cell.y) + rgbFg(fg) + glyph + R
        }
      }
      p.trail = p.trail.filter((_, k) => p.trail.length - 1 - k < TRAIL)
      if (!p.alive) continue
      if (!p.edgeRiding && --p.untilTurn <= 0) {
        const horiz = p.dir <= 1
        if (horiz) {
          const away = p.y <= bcy ? 3 : 2
          p.dir = lcg() < 0.75 ? away : away === 3 ? 2 : 3
        } else {
          const away = p.x <= bcx ? 1 : 0
          p.dir = lcg() < 0.75 ? away : away === 1 ? 0 : 1
        }
        p.untilTurn = 4 + Math.floor(lcg() * 8)
      }
      const [dx, dy] = DIRS[p.dir]
      const sub = Math.max(Math.abs(dx), Math.abs(dy))
      for (let s2 = 0; s2 < sub; s2++) {
        const nx = p.x + Math.sign(dx)
        const ny = p.y + Math.sign(dy)
        const xOut = nx < 0 || nx >= COLS
        const yOut = ny < 0 || ny >= ROWS
        if (xOut || yOut) {
          const atXBound = p.x === 0 || p.x === COLS - 1
          const atYBound = p.y === 0 || p.y === ROWS - 1
          if ((xOut && atYBound) || (yOut && atXBound)) {
            p.alive = false
            break
          }
          p.edgeRiding = true
          if (xOut) {
            p.x = nx < 0 ? 0 : COLS - 1
            p.dir = p.y <= bcy ? 3 : 2
          } else {
            p.y = ny < 0 ? 0 : ROWS - 1
            p.dir = p.x <= bcx ? 1 : 0
          }
          break
        }
        if (wallAt(nx, ny)) {
          p.dir = dy === 0 ? (p.y <= bcy ? 3 : 2) : (p.x <= bcx ? 1 : 0)
          p.untilTurn = 2 + Math.floor(lcg() * 5)
          break
        }
        p.x = nx
        p.y = ny
        if (!masked(p.x, p.y)) {
          p.trail.push({ x: p.x, y: p.y })
          const key = p.x + ',' + p.y
          if (!paintedSet.has(key)) {
            paintedSet.add(key)
            sidePainted[sideOfCell(p.x, p.y)]++
          }
        }
      }
      anyAlive = anyAlive || p.alive
    }
    if (!HERO) buf += HOLD_BRAND
    const drawn = writeFrame(buf + '\x1b[?2026l')
    if (!anyAlive && paths.every(p => p.trail.length === 0)) {
      await Promise.race([drawn, interrupt()])
      break
    }
    await Promise.race([
      Promise.all([drawn, sleep(Math.max(6, tickMs * (f - fBase + 1) - (Date.now() - t0)))]),
      interrupt(),
    ])
  }
  if (!rippleAborted() && cappedFrames === 0 && sizeEpoch === epochSeen) {
    for (const p of paths) {
      for (const c of p.trail) {
        const key = c.x + ',' + c.y
        if (!masked(c.x, c.y) && !residueSet.has(key)) {
          residueSet.add(key)
          residue.push({ x: c.x, y: c.y })
        }
      }
    }
    if (residue.length > 0) {
      const F = Math.max(6, Math.min(20, Math.round(residue.length / 140)))
      const cohort = Math.ceil(residue.length / F)
      const FADE_TONE = mixc(RESIDUE_TONE, VOID, 0.6)
      const tFade = Date.now()
      for (let s = 0; s <= F; s++) {
        if (rippleAborted() || cappedFrames > 0 || sizeEpoch !== epochSeen) break
        let buf = '\x1b[?2026h'
        for (const c of residue.slice(s * cohort, (s + 1) * cohort)) {
          buf += at(c.x, c.y) + rgbFg(FADE_TONE) +
            CODE_GLYPHS[(c.x * 7 + c.y * 13) % CODE_GLYPHS.length] + R
        }
        if (s > 0) for (const c of residue.slice((s - 1) * cohort, s * cohort)) {
          buf += at(c.x, c.y) + ' '
        }
        await Promise.race([
          Promise.all([writeFrame(buf + '\x1b[?2026l'), sleep(Math.max(6, tickMs * (s + 1) - (Date.now() - tFade)))]),
          interrupt(),
        ])
      }
    }
  }
  collapse(0, cappedFrames > 0 ? 400 : undefined)
}

const rippleEnabled = () =>
  TRUECOLOR &&
  process.env.MERCURY_LAUNCH_RIPPLE !== '0' &&
  process.env.MERCURY_REDUCED_MOTION !== '1'

function brandLine() {
  return (
    accentFg() + '(>_) ' + hexFg(IVORY, T256.cream) + 'MERCURY' + R +
    hexFg(FAINT, T256.faint) + (cancelled ? ' · launch cancelled' : ' · starting') + R
  )
}

const CONFIG_HOME = (() => {
  const explicit = process.env.MERCURY_CONFIG_DIR
  if (explicit) return explicit.normalize('NFC')
  const homeEnv = process.env.MERCURY_HOME
  if (homeEnv) return homeEnv.normalize('NFC')
  return join(homedir(), '.mercury').normalize('NFC')
})()
const BOOT_ENV_PATH = join(CONFIG_HOME, 'boot-env.json')

const chipReadFailures = []
const READ_FAILED = Symbol('chip-read-failed')
function noteChipFailure(chip, err) {
  if (err && err.code === 'ENOENT') return false
  chipReadFailures.push(chip + ': ' + ((err && (err.code || err.message)) || 'unknown'))
  return true
}
process.on('exit', () => {
  try {
    if (ONESHOT || chipReadFailures.length === 0) return
    process.stderr.write(
      'mercury splash: chip read failure(s) — ' + chipReadFailures.join(' · ') + '\n',
    )
  } catch {  }
})

function resolveConfigFile() {
  const dotConfig = join(CONFIG_HOME, '.config.json')
  if (existsSync(dotConfig)) return dotConfig
  return join(CONFIG_HOME, '.mercury.json')
}

function readSavedBootEnv() {
  try {
    const o = JSON.parse(readFileSync(BOOT_ENV_PATH, 'utf8'))
    if (o && o.version === 1 && o.env && typeof o.env === 'object' && !Array.isArray(o.env)) return o.env
  } catch {  }
  return {}
}

let menuRow = 0
const menuChoice = new Map()
for (const [env, v] of Object.entries(readSavedBootEnv())) {
  const row = MENU.find(r => r.env === env || (r.legacy && r.legacy === env))
  if (!row) continue
  const idx = row.choices.findIndex(c => c.v === v)
  if (idx > 0) menuChoice.set(row.env, idx)
}
const choiceOf = row => row.choices[menuChoice.get(row.env) || 0]

const BOOT_ENV_DEBOUNCE_MS = 120
let bootEnvTimer = null
let bootEnvDirty = false
function saveBootEnv() {
  bootEnvDirty = true
  clearTimeout(bootEnvTimer)
  bootEnvTimer = setTimeout(flushBootEnv, BOOT_ENV_DEBOUNCE_MS)
  bootEnvTimer.unref?.()
}
function flushBootEnv() {
  if (!bootEnvDirty) return
  bootEnvDirty = false
  clearTimeout(bootEnvTimer)
  const env = {}
  for (const row of MENU) {
    const ch = choiceOf(row)
    if (ch && ch.v !== null) env[row.env] = ch.v
  }
  try {
    mkdirSync(CONFIG_HOME, { recursive: true })
    writeFileSync(BOOT_ENV_PATH, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), env }, null, 2) + '\n')
  } catch {  }
}


function readHead(file, n = 4096) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(n)
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got)
      if (r <= 0) break
      got += r
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const projectDisplayName = dir => {
  const base = basename(dir)
  if (base === '.mercury') {
    const parent = basename(dirname(dir))
    if (parent && parent !== base) return parent
  }
  return base || dir
}

function scanRecentProjects() {
  try {
    const root = join(CONFIG_HOME, 'projects')
    const perDir = []
    for (const d of readdirSync(root)) {
      const dir = join(root, d)
      let names
      try {
        names = readdirSync(dir)
      } catch { continue }
      let card = null
      if (names.includes('project.json')) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
          if (raw && raw.schema === 1 && typeof raw.dir === 'string' && raw.dir && typeof raw.firstChatAt === 'number') {
            card = { dir: raw.dir, firstChatAt: raw.firstChatAt }
          }
        } catch {  }
      }
      let newest = 0
      let newestFile = null
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue
        try {
          const st = statSync(join(dir, f))
          if (st.mtimeMs > newest) {
            newest = st.mtimeMs
            newestFile = join(dir, f)
          }
        } catch {  }
      }
      if (!newestFile && !card) continue
      perDir.push({ file: newestFile, mtime: Math.max(newest, card ? card.firstChatAt : 0), card })
    }
    perDir.sort((a, b) => b.mtime - a.mtime)
    const seen = []
    for (const e of perDir.slice(0, 32)) {
      let cwd = e.card ? e.card.dir : null
      if (!cwd && e.file) {
        try {
          const head = readHead(e.file)
          const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
          if (m) cwd = JSON.parse('"' + m[1] + '"')
        } catch {  }
      }
      if (!cwd) continue
      const normPath = p => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/')
      const tmpN = tmpdir() ? normPath(tmpdir()).replace(/\/+$/, '') : ''
      const isTmpPath = p => {
        const n = normPath(p)
        return (
          n.startsWith('/tmp/') ||
          n.startsWith('/private/tmp/') ||
          n.startsWith('/private/var/folders/') ||
          (tmpN ? n === tmpN || n.startsWith(tmpN + '/') : false)
        )
      }
      if (!isTmpPath(CONFIG_HOME + '/') && isTmpPath(cwd)) continue
      try {
        if (!statSync(cwd).isDirectory()) continue
      } catch { continue }
      if (seen.some(s => s.dir === cwd)) continue
      seen.push({
        dir: cwd,
        base: projectDisplayName(cwd),
        ageMs: Date.now() - e.mtime,
      })
      if (seen.length >= 10) break
    }
    return seen
  } catch {
    return []
  }
}
const recentSeen = scanRecentProjects()
const recentLast = recentSeen[0] || null
const recentProject =
  recentSeen.find(s => s.dir !== process.cwd() && (!recentLast || s.dir !== recentLast.dir)) || null
const cwdProject = recentSeen.find(s => s.dir === process.cwd()) || null

let modelLabelCached = null
function modelLabel() {
  if (modelLabelCached !== null) return modelLabelCached
  modelLabelCached = computeModelLabel()
  return modelLabelCached
}
function computeModelLabel() {
  try {
    const s = JSON.parse(readFileSync(join(CONFIG_HOME, 'settings.json'), 'utf8'))
    const m = typeof s.model === 'string' ? s.model.trim() : null
    if (!m) return 'default'
    const oneM = /\[1m\]$/i.test(m)
    const bare = m.replace(/\[1m\]$/i, '').trim()
    const key = bare.toLowerCase()
    const known = Object.hasOwn(MODEL_NAMES, key) ? MODEL_NAMES[key] : undefined
    const base = known || (bare.length > 18 ? bare.slice(0, 17) + '…' : bare)
    return base + (oneM ? ' (1M)' : '')
  } catch {
    return 'default'
  }
}
function computeCritterKey() {
  let c = (process.env.MERCURY_CRITTER ?? '').trim()
  if (!c) {
    try {
      const cfg = JSON.parse(readFileSync(resolveConfigFile(), 'utf8'))
      if (typeof cfg.defaultCritter === 'string') c = cfg.defaultCritter.trim()
    } catch (err) { noteChipFailure('theme', err)  }
  }
  return c ? accentFamilyKeyOf(c) : DEFAULT_CRITTER
}
const CRITTER_KEY = computeCritterKey()
function critterLabel() {
  return CRITTER_KEY.charAt(0).toUpperCase() + CRITTER_KEY.slice(1)
}

// global-config theme, else the default appearance — True Black. The
const DEFAULT_THEME_FAMILY = 'true-black'
function persistedThemeName() {
  const pin = process.env.MERCURY_THEME_PIN
  if (pin) return String(pin).toLowerCase().trim()
  try {
    const stored = JSON.parse(readFileSync(resolveConfigFile(), 'utf8')).theme
    return typeof stored === 'string' ? stored.toLowerCase().trim() : ''
  } catch {
    return ''
  }
}
const persistedTheme = persistedThemeName() || DEFAULT_THEME_FAMILY
adoptGroundFamily(persistedTheme === 'true-black' ? 'true-black' : 'dark')

const core = createSplashCore({ nocolor: NOCOLOR, truecolor: TRUECOLOR, accent: CRITTER_KEY })
const {
  R, DIM,
  rgbFg, rgbBg, hexFg,
  composeLockup, composeCompactFace, placeBlock,
  composeStrip: coreComposeStrip,
  composeBootMenu: coreComposeBootMenu,
  mixc,
  T256, VOID, FAINT, IVORY,
  ACCENT: FAM, ACCENT_HEX, accentFg,
} = core
let accountLabelCached = false
function accountLabel() {
  if (accountLabelCached !== false) return accountLabelCached
  accountLabelCached = computeAccountLabel()
  return accountLabelCached
}
function computeAccountLabel() {
  try {
    const o = JSON.parse(readFileSync(resolveConfigFile(), 'utf8'))
    const email =
      o && o.oauthAccount && typeof o.oauthAccount.emailAddress === 'string'
        ? o.oauthAccount.emailAddress.trim()
        : null
    if (!email) return null
    return email.length > 26 ? email.slice(0, 25) + '…' : email
  } catch (err) {
    return noteChipFailure('account', err) ? READ_FAILED : null
  }
}
let certInfoCached = false
function certInfo() {
  if (certInfoCached !== false) return certInfoCached
  certInfoCached = computeCertInfo()
  return certInfoCached
}
function computeCertInfo() {
  for (const projDir of ['.mercury']) {
    try {
      const o = JSON.parse(
        readFileSync(join(process.cwd(), projDir, 'doctor', 'last-cert.json'), 'utf8'),
      )
      if (o && typeof o.verdict === 'string') {
        const t = Date.parse(o.ranAt)
        return { verdict: o.verdict, age: Number.isFinite(t) ? fmtAge(Date.now() - t) : null }
      }
    } catch (err) { noteChipFailure('health(' + projDir + ')', err)  }
  }
  return null
}

let lastSplashAction = null
let lastSplashActionDir = null
const LAUNCH_ID = process.env.MERCURY_LAUNCH_ID || null

function writeSplashAction(action, dir) {
  lastSplashAction = action
  lastSplashActionDir = dir || null
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return
  try {
    mkdirSync(CONFIG_HOME, { recursive: true })
    writeFileSync(
      join(CONFIG_HOME, 'splash-action.json'),
      JSON.stringify({ version: 1, ts: Date.now(), action, ...(dir ? { dir } : {}), ...(LAUNCH_ID ? { launchId: LAUNCH_ID } : {}) }) + '\n',
    )
  } catch {  }
}

function writeScreenReceipt(screen) {
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return
  try {
    mkdirSync(CONFIG_HOME, { recursive: true })
    writeFileSync(
      join(CONFIG_HOME, 'splash-action.json'),
      JSON.stringify({
        version: 1,
        ts: Date.now(),
        ...(lastSplashAction ? { action: lastSplashAction } : {}),
        ...(lastSplashActionDir ? { dir: lastSplashActionDir } : {}),
        ...(LAUNCH_ID ? { launchId: LAUNCH_ID } : {}),
        screen,
      }) + '\n',
    )
  } catch {  }
}

function stampBootAttempt() {
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return
  try {
    const p = join(CONFIG_HOME, 'boot-attempts.json')
    let attempts = []
    try {
      const o = JSON.parse(readFileSync(p, 'utf8'))
      if (o && o.version === 1 && Array.isArray(o.attempts)) {
        attempts = o.attempts.filter(t => typeof t === 'number')
      }
    } catch {  }
    attempts.push(Date.now())
    if (attempts.length > 20) attempts = attempts.slice(-20)
    writeFileSync(p, JSON.stringify({ version: 1, attempts }) + '\n')
  } catch {  }
}

let cardSel = 0
let lockupCardShown = false

function cardRows(menuRows = menuAvailable) {
  return assembleCardRows({
    cwdBase: projectDisplayName(process.cwd()),
    continueTarget: cwdProject
      ? { base: cwdProject.base, ageMs: cwdProject.ageMs, cross: false }
      : recentLast
        ? { base: recentLast.base, ageMs: recentLast.ageMs, cross: true }
        : null,
    menuAvailable: menuRows,
    concourse: process.env.MERCURY_SPLASH_CHAT === '1' ? null : { ctx: 'the multi-session board, once' },
  })
}


function composeStrip(w) {
  const cert = certInfo()
  const acct = accountLabel()
  return coreComposeStrip(
    {
      model: modelLabel(),
      critter: critterLabel(),
      critterHue: ACCENT_HEX,
      dir: projectDisplayName(process.cwd()),
      acct:
        acct === READ_FAILED
          ? { state: 'unreadable' }
          : acct
            ? { state: 'email', text: acct }
            : { state: 'none' },
      health: cert ? { verdict: cert.verdict, age: cert.age } : null,
    },
    w,
  )
}

function activateCardRow(r2) {
  if (r2.key === 'menu') {
    view = 'menu'
    paintView()
    return
  }
  leaving = true
  if (r2.key === 'continue')
    writeSplashAction('continue', cwdProject ? undefined : recentLast ? recentLast.dir : undefined)
  else if (r2.key === 'doctor') writeSplashAction('doctor')
  else if (r2.key === 'concourse') writeSplashAction('concourse')
  else if (r2.key === 'sessions') writeSplashAction('resume')
  else if (r2.key === 'kit') writeSplashAction('kit')
  else if (r2.key === 'saturn') writeSplashAction('saturn')
  else if (r2.key === 'logins') writeSplashAction('logins')
  else if (r2.key === 'agents') writeSplashAction('agents')
  launch()
}

function menuData() {
  const pinOf = r2 => process.env[r2.env] !== undefined
    ? process.env[r2.env]
    : r2.legacy
      ? process.env[r2.legacy]
      : undefined
  const effectiveOf = env => {
    const r2 = MENU.find(x => x.env === env)
    if (!r2) return null
    const pin = pinOf(r2)
    return pin !== undefined ? pin : choiceOf(r2).v
  }
  const entries = MENU.map(r2 => {
    const ch = choiceOf(r2)
    const pinnedVal = pinOf(r2)
    const follows = r2.defaultFollows
    return {
      label: r2.label,
      group: r2.group,
      summary: r2.summary,
      valueLabel: ch.v === null && follows && effectiveOf(follows.env) === follows.value ? follows.label : ch.l,
      valueIsDefault: ch.v === null,
      pinnedVal: pinnedVal === undefined ? null : pinnedVal,
      detail: r2.detail || null,
    }
  })
  const val = env => {
    const r2 = MENU.find(x => x.env === env || x.legacy === env)
    return r2 ? choiceOf(r2).v : null
  }
  const changed = MENU.filter(r2 => choiceOf(r2).v !== null).length
  const harness = [
    val('MERCURY_PARTY') === '1' ? 'party' : null,
    process.env.MERCURY_HELM_HOME === '0' ? null : 'helm',
    process.env.MERCURY_HELM_CONSOLE === '0' ? null : 'console',
  ].filter(Boolean)
  return {
    entries,
    selIdx: menuRow,
    summary: {
      profile: changed > 0 ? `custom · ${changed} set` : 'default',
      harness: harness.join(' · ') || 'none',
      integrity: val('MERCURY_THEMIS') || 'off',
      integritySet: !!val('MERCURY_THEMIS'),
    },
    environment: {
      model: modelLabel(),
      critter: critterLabel(),
      critterHue: ACCENT_HEX,
      dirBase: projectDisplayName(process.cwd()),
      dirTail: gitEnvTail(),
    },
    statusRight: `${changed > 0 ? `${changed} choice${changed === 1 ? '' : 's'} saved to boot-env.json` : 'no blocking issues detected'} — you can launch Mercury.`,
    legend: '↑↓ move · ↵ change (saved) · s launch · esc back',
    legendClassic: '↵ change (saved) · ↑↓ move · s launch · esc back',
    glowWord: glowWordPhase(),
  }
}
function composeMenu(cols) {
  return coreComposeBootMenu(cols, rowsAvail, menuData()).lines
}

let gitProbe = null
function gitEnvTail() {
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return ''
  if (gitProbe === null) {
    try {
      const b = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8', timeout: 800,
      })
      if (b.status === 0) {
        const st = spawnSync('git', ['status', '--porcelain', '-uno'], {
          encoding: 'utf8', timeout: 1500,
        })
        gitProbe = {
          branch: b.stdout.trim() || null,
          clean: st.status === 0 ? st.stdout.trim() === '' : null,
        }
      } else gitProbe = { branch: null, clean: null }
    } catch {
      gitProbe = { branch: null, clean: null }
    }
  }
  if (!gitProbe.branch) return ''
  return `  ⌥${gitProbe.branch}` + (gitProbe.clean === null ? '' : gitProbe.clean ? ' · clean' : ' · uncommitted')
}


if (process.env.MERCURY_SPLASH === 'off' || process.env.MERCURY_SPLASH === 'static' || !out.isTTY) process.exit(0)

let cols = Math.max(20, out.columns || 80)
let rowsAvail = Math.max(8, out.rows || 24)
const computeMenuAvailable = () => MENU.length > 0 && cols >= 64 && rowsAvail >= 13
let menuAvailable = computeMenuAvailable()

const ONESHOT = process.env.MERCURY_SPLASH_ONESHOT === '1'
let view = process.env.MERCURY_SPLASH_VIEW === 'menu' && menuAvailable ? 'menu' : 'lockup'

const _fsRaw = String(process.env.MERCURY_FULLSCREEN ?? '').toLowerCase().trim()
const HOLD_ALT_FOR_HANDOFF = _fsRaw === '' || !['0', 'false', 'no', 'off'].includes(_fsRaw)
const CINEMATIC = HOLD_ALT_FOR_HANDOFF && !process.env.MERCURY_SPLASH_VIEW

const OSC11_GROUND =
  TRUECOLOR && process.env.MERCURY_OASIS_BG !== '0'
function frame(block) {
  return block.join('\n')
}

let lockupWordRow = null
let lockupActionLines = []
let placedBrandRow = null

let heroCells = new Set()
let heroBox = null
let heroWalls = new Map()
const heroWallAt = (x, y) => {
  const iv = heroWalls.get(y)
  return iv !== undefined && x >= iv[0] && x <= iv[1]
}
const SGR_STRIP_RE = /\x1b\[[0-9;]*m/g
function captureHeroFacts(placed) {
  heroCells = new Set()
  heroBox = null
  heroWalls = new Map()
  const rowSpan = new Map()
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  placed.forEach((line, y) => {
    const t = line.replace(SGR_STRIP_RE, '')
    let x = 0
    for (const ch of t) {
      const w = MARK_RE.test(ch) ? 0 : cpWidth(ch.codePointAt(0))
      if (ch !== ' ' && w > 0) {
        for (let k = 0; k < w; k++) heroCells.add(x + k + ',' + y)
        const s = rowSpan.get(y)
        if (s === undefined) rowSpan.set(y, [x, x + w - 1])
        else {
          if (x < s[0]) s[0] = x
          if (x + w - 1 > s[1]) s[1] = x + w - 1
        }
        if (x < x0) x0 = x
        if (x + w - 1 > x1) x1 = x + w - 1
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      x += w
    }
  })
  if (x1 >= 0) {
    const STATUS_MARGIN = 5
    let statusRow = -1
    for (const y of rowSpan.keys()) if (y > statusRow) statusRow = y
    const ssp = rowSpan.get(statusRow)
    if (ssp) {
      ssp[0] -= STATUS_MARGIN
      ssp[1] += STATUS_MARGIN
    }
    heroBox = { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 }
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      let lo = Infinity, hi = -1
      for (let yy = y - 1; yy <= y + 1; yy++) {
        const sp = rowSpan.get(yy)
        if (sp) {
          if (sp[0] < lo) lo = sp[0]
          if (sp[1] > hi) hi = sp[1]
        }
      }
      if (hi >= 0) heroWalls.set(y, [lo - 1, hi + 1])
    }
  }
}

function composeCinematicHero(C, Rw) {
  const block = compose(C, Rw)
  const { placed: full, top } = placeBlock(block, Rw)
  let placed = full
  if (lockupCompactHero !== null) {
    placed = lockupCompactHero
  } else if (lockupActionLines.length > 0) {
    placed = full.slice(0, top + Math.min(...lockupActionLines) - 1)
  }
  placedBrandRow = lockupWordRow !== null ? top + lockupWordRow : null
  captureHeroFacts(placed)
  return placed
}

const glowEnabled = () =>
  TRUECOLOR &&
  !ONESHOT &&
  !CINEMATIC &&
  process.env.MERCURY_REDUCED_MOTION !== '1'
let glowTimer = null
let glowWordStart = null
let glowRowStart = null
let glowViewArmed = null
let lastPlaced = null
let lastPlacedEpoch = -1
let sizeEpoch = 0

const glowWordPhase = () =>
  glowWordStart === null ? null : glowPhaseAt(Date.now() - glowWordStart, WORD_W)
const glowRowPhase = () =>
  glowRowStart === null || cardSel < 0
    ? null
    : glowPhaseAt(Date.now() - glowRowStart, CARD_LABEL_W)

function glowLive() {
  const now = Date.now()
  const wordLive =
    glowWordStart !== null &&
    !glowSettled(now - glowWordStart) &&
    (view === 'lockup' || view === 'menu')
  const rowLive =
    glowRowStart !== null &&
    !glowSettled(now - glowRowStart) &&
    view === 'lockup' &&
    cardSel >= 0 &&
    lockupCardShown
  return wordLive || rowLive
}
function ensureGlowTimer() {
  if (glowTimer !== null || !glowEnabled() || !glowLive()) return
  glowTimer = setInterval(glowTick, GLOW_TICK_MS)
  glowTimer.unref?.()
}
function stopGlowTimer() {
  if (glowTimer !== null) {
    clearInterval(glowTimer)
    glowTimer = null
  }
}
function armGlowWord() {
  if (!glowEnabled()) return
  glowWordStart = Date.now()
  ensureGlowTimer()
}
function armGlowRow() {
  if (!glowEnabled()) return
  glowRowStart = Date.now()
  ensureGlowTimer()
}
function glowTick() {
  if (leaving || exiting || inRipple) {
    stopGlowTimer()
    return
  }
  const alive = glowLive()
  repaintChangedLines()
  if (!alive) stopGlowTimer()
}
function repaintChangedLines() {
  if (lastPlaced === null) return
  if (lastPlacedEpoch !== sizeEpoch) return
  const block = view === 'menu' ? composeMenu(cols) : compose(cols, rowsAvail)
  const { placed } = placeBlock(block, rowsAvail)
  let buf = ''
  const n = Math.max(placed.length, lastPlaced.length)
  for (let i = 0; i < n; i++) {
    const next = placed[i] ?? ''
    if (next !== (lastPlaced[i] ?? '')) buf += `\x1b[${i + 1};1H` + next
  }
  lastPlaced = placed
  if (buf) out.write('\x1b[?2026h' + buf + '\x1b[?2026l' )
}

function paintView() {
  const snapCols = Math.max(20, out.columns || 80)
  const snapRows = Math.max(8, out.rows || 24)
  cols = snapCols
  rowsAvail = snapRows
  const block = view === 'menu' ? composeMenu(snapCols) : compose(snapCols, snapRows)
  const { placed: placedFull, top } = placeBlock(block, snapRows)
  let placed = placedFull
  if (CINEMATIC && view === 'lockup' && lockupCompactHero !== null) {
    placed = lockupCompactHero
  } else if (CINEMATIC && view === 'lockup' && lockupActionLines.length > 0) {
    placed = placedFull.slice(0, top + Math.min(...lockupActionLines) - 1)
  }
  placedBrandRow = view === 'lockup' && lockupWordRow !== null ? top + lockupWordRow : null
  if (CINEMATIC && view === 'lockup') captureHeroFacts(placed)
  lastPlaced = placed
  lastPlacedEpoch = sizeEpoch
  if (view !== glowViewArmed) {
    glowViewArmed = view
    if (view === 'lockup' || view === 'menu') armGlowWord()
    if (view === 'lockup' && cardSel >= 0) armGlowRow()
  }
  out.write('\x1b[?2026h\x1b[2J\x1b[H' + frame(placed) + '\x1b[?2026l')
}

out.write('\x1b[?1049h\x1b[?1007h\x1b[?25l')
if (OSC11_GROUND)
  out.write('\x1b]11;#' + GROUND.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase() + '\x07')
paintView()
if (CINEMATIC && !ONESHOT) {
  setImmediate(() => {
    if (leaving || exiting) return
    leaving = true
    launch()
  })
}

function holdFrame(C, Rw) {
  const at2 = (x, y) => `\x1b[${y + 1};${x + 1}H`
  const HINT = 'starting…  (stuck? type: reset↵)'
  const hint = DIM + hexFg(FAINT, T256.faint) + HINT + R
  if (CINEMATIC && view === 'lockup') {
    const placed = composeCinematicHero(C, Rw)
    const hasInk = l => l.replace(SGR_STRIP_RE, '').trim().length > 0
    let lastContent = -1
    for (let i = 0; i < placed.length; i++) if (hasInk(placed[i])) lastContent = i
    let buf = ''
    placed.forEach((line, i) => {
      if (i === lastContent && lastContent > 0) return
      if (hasInk(line)) buf += at2(0, i) + line
    })
    const hy =
      lastContent > 0
        ? lastContent
        : Math.min(Rw - 1, (placedBrandRow ?? Math.round((Rw - 1) / 2)) + 2)
    const hc = Math.max(0, Math.round((C - HINT.length) / 2))
    return buf + at2(hc, hy) + hint
  }
  const cxi2 = Math.round((C - 1) / 2)
  const cyi2 =
    placedBrandRow !== null && placedBrandRow >= 1 && placedBrandRow < Rw - 1
      ? placedBrandRow
      : Math.round((Rw - 1) / 2)
  const WORD = ' (>_) MERCURY '
  const wc = Math.max(0, Math.round(cxi2 - WORD.length / 2))
  let buf = ''
  const brand =
    accentFg() + ' (>_) ' + hexFg(IVORY, T256.cream) + 'MERCURY ' + R
  buf += at2(wc, cyi2) + brand
  const hy = Math.min(Rw - 1, cyi2 + 2)
  const hc = Math.max(0, Math.round(cxi2 - HINT.length / 2))
  buf += at2(hc, hy) + hint
  return buf
}
function restoreAndBrand() {
  if (HOLD_ALT_FOR_HANDOFF && !cancelled) {
    const C = Math.max(24, out.columns || 80)
    const Rw = Math.max(8, out.rows || 24)
    const parkInk = TRUECOLOR
      ? `\x1b[38;2;${VOID.join(';')}m\x1b[48;2;${VOID.join(';')}m`
      : '\x1b[30;40m\x1b[8m'
    out.write(
      '\x1b[?2026h' +
      '\x1b[?1049l' + brandLine() + '\n' +
      '\x1b[?1049h\x1b[?1007h\x1b[?25l\x1b[2J' + holdFrame(C, Rw) +
      '\x1b[H' + parkInk + '\x1b[?25l' +
      '\x1b[?2026l',
    )
    screenAtExit = 'held'
    writeScreenReceipt('held')
    stampBootAttempt()
  } else {
    if (OSC11_GROUND) out.write('\x1b]111\x07')
    out.write('\x1b[?1007l')
    out.write('\x1b[?1049l')
    out.write(brandLine() + '\n')
    out.write('\x1b[?25h')
    screenAtExit = 'restored'
    writeScreenReceipt('restored')
    if (!cancelled) stampBootAttempt()
  }
  try { process.stdin.setRawMode(false) } catch {  }
}

let exiting = false
let screenAtExit = null
function collapse(code, drainCapMs = 2000) {
  if (exiting) return
  exiting = true
  restoreAndBrand()
  flushBootEnv()
  let exitCode = code
  if (cancelled) exitCode = 130
  else if (code === 0 && screenAtExit === 'restored') exitCode = 20
  const bye = () => process.exit(exitCode)
  setTimeout(bye, drainCapMs)
  out.write('', bye)
}

let cancelled = false
function cancelExit() {
  if (leaving && !inRipple) return
  cancelled = true
  writeSplashAction('cancel')
  if (leaving && inRipple) {
    fireRippleInterrupt()
    collapse(130, 1000)
    return
  }
  leaving = true
  collapse(130)
}


let inRipple = false
let rippleAbort = 0
let rippleWake = null
function wakeRippleWaiters() {
  if (rippleWake) { rippleWake(); rippleWake = null }
}
function fireRippleInterrupt() {
  rippleAbort++
  wakeRippleWaiters()
}
let resizeTimer = null
out.on('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    cols = Math.max(20, out.columns || 80)
    rowsAvail = Math.max(8, out.rows || 24)
    menuAvailable = computeMenuAvailable()
    if (view === 'menu' && !menuAvailable) view = 'lockup'
    sizeEpoch++
    if (inRipple) wakeRippleWaiters()
    if (!inRipple && !leaving) paintView()
  }, 60)
})

if (ONESHOT) {
  setTimeout(() => process.exit(0), 2000)
  out.write('\x1b[?25h', () => process.exit(0))
} else {
  for (const f of ['splash-action.json', 'splash-action.txt']) {
    try {
      const p = join(CONFIG_HOME, f)
      if (Date.now() - statSync(p).mtimeMs > 10 * 60 * 1000) unlinkSync(p)
    } catch {  }
  }
}

function launch() {
  if (rippleEnabled()) void ripple()
  else collapse(0)
}
function cycleChoice(d) {
  const row = MENU[menuRow]
  const n = row.choices.length
  menuChoice.set(row.env, (((menuChoice.get(row.env) || 0) + d) % n + n) % n)
  saveBootEnv()
  paintView()
}

try { process.stdin.setRawMode(true) } catch {  }
process.stdin.resume()
let leaving = false

const ESC_TIMEOUT_MS = 15
const isPartialEscape = s => s === '\x1b' || /^\x1b(\[|O)[0-9;]*$/.test(s)
const coalesceStep = (pending, chunk) => {
  const merged = pending + chunk
  return isPartialEscape(merged) ? { dispatch: null, pending: merged } : { dispatch: merged, pending: '' }
}
let pendingInput = ''
let pendingTimer = null
process.stdin.on('data', buf => {
  const step = coalesceStep(pendingInput, buf.toString('utf8'))
  pendingInput = step.pending
  clearTimeout(pendingTimer)
  if (step.dispatch !== null) {
    handleKey(step.dispatch)
    return
  }
  pendingTimer = setTimeout(() => {
    const s = pendingInput
    pendingInput = ''
    if (s) handleKey(s)
  }, ESC_TIMEOUT_MS)
  pendingTimer.unref?.()
})

function handleKey(s) {
  if (s === '\x03') { cancelExit(); return }
  if (CINEMATIC) {
    const isEnter = s === '\r' || s === '\n' || s === '\r\n'
    if (!isEnter) return
    if (inRipple) { fireRippleInterrupt(); return }
    if (!leaving) { leaving = true; launch() }
    return
  }
  if (leaving) return
  if (view === 'lockup') {
    if ((s === 'm' || s === 'M') && menuAvailable) { view = 'menu'; paintView(); return }
    const isUp = s === '\x1b[A' || s === '\x1bOA'
    const isDown = s === '\x1b[B' || s === '\x1bOB'
    if (isUp || isDown) {
      if (!lockupCardShown) return
      const n = cardRows().length
      if (n === 0) return
      cardSel = isDown ? (cardSel + 1) % n : cardSel <= 0 ? n - 1 : cardSel - 1
      armGlowRow()
      paintView()
      return
    }
    if (s === '\x1b' && cardSel >= 0) { cardSel = -1; paintView(); return }
    const isEnter = s === '\r' || s === '\n' || s === '\r\n'
    if (isEnter && lockupCardShown && cardSel >= 0) {
      activateCardRow(cardRows()[cardSel])
      return
    }
    if (isEnter) {
      leaving = true
      launch()
      return
    }
    return
  }
  if (s === '\x1b') { view = 'lockup'; paintView(); return }
  if (s === '\x1b[A' || s === '\x1bOA' || s === 'k') { menuRow = (menuRow + MENU.length - 1) % MENU.length; paintView(); return }
  if (s === '\x1b[B' || s === '\x1bOB' || s === 'j') { menuRow = (menuRow + 1) % MENU.length; paintView(); return }
  if (s === '\x1b[D' || s === '\x1bOD') { cycleChoice(-1); return }
  if (s === '\r' || s === '\n' || s === '\r\n' || s === ' ' || s === '\x1b[C' || s === '\x1bOC') { cycleChoice(1); return }
  if (s === 's' || s === 'S') { saveBootEnv(); leaving = true; launch(); return }
}
process.on('SIGINT', cancelExit)
process.on('SIGTERM', cancelExit)
const idleRaw = Number(process.env.MERCURY_SPLASH_IDLE_MS)
const IDLE_MS = Number.isFinite(idleRaw) && idleRaw >= 500 ? idleRaw : 30 * 60 * 1000
if (!CINEMATIC) setTimeout(cancelExit, IDLE_MS).unref?.()
