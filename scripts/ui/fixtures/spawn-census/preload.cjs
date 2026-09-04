'use strict'
const LOG_DIR = process.env.SPAWN_CENSUS_DIR
if (!LOG_DIR) return
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const Module = require('module')
const { performance } = require('perf_hooks')

const origAppend = fs.appendFileSync
const origWriteFileSync = fs.writeFileSync
const PID = process.pid
const OUT = path.join(LOG_DIR, `census-${PID}.jsonl`)
const FLUSH_MS = 2_000
const SAMPLE_MS = 50
const STALL_MS = 30
const SLOW_MS = 5

let win = fresh()
function fresh() {
  return { spawns: [], stalls: [], slowSync: [], tsReads: [], maxStallMs: 0 }
}
const slowRing = []
function noteSlow(name, t0, t1, detail) {
  const ms = t1 - t0
  if (ms < SLOW_MS) return
  const label = detail ? `${name} ${String(detail).slice(0, 160)}` : name
  slowRing.push({ t0, t1, label })
  if (slowRing.length > 400) slowRing.shift()
  win.slowSync.push({ t: Math.round(t0), ms: Math.round(ms * 10) / 10, label })
}
const nowMs = () => Date.now()

{
  const orig = fs.readFileSync
  fs.readFileSync = function (p, ...rest) {
    const a = performance.now()
    const at = nowMs()
    try {
      return orig.call(this, p, ...rest)
    } finally {
      const ms = performance.now() - a
      try {
        const name = typeof p === 'string' ? p : ''
        if (/typescript\.js$/.test(name)) win.tsReads.push({ t: at, path: name, ms: Math.round(ms * 10) / 10 })
        noteSlow('readFileSync', at, at + ms, name)
      } catch {}
    }
  }
}

function argsOf(a) {
  return Array.isArray(a) ? a.slice(0, 10).map(x => String(x).slice(0, 80)) : []
}
function wrapSync(fn) {
  const orig = cp[fn]
  if (typeof orig !== 'function') return
  cp[fn] = function (cmd, ...rest) {
    const a = performance.now()
    const at = nowMs()
    let err = null
    try {
      return orig.call(this, cmd, ...rest)
    } catch (e) {
      err = e
      throw e
    } finally {
      const ms = performance.now() - a
      try {
        const rec = { t: at, kind: fn, sync: true, cmd: String(cmd).slice(0, 160), args: argsOf(rest[0]), ms: Math.round(ms * 10) / 10 }
        if (err) rec.err = String((err && err.code) || err).slice(0, 60)
        win.spawns.push(rec)
        noteSlow(fn, at, at + ms, `${rec.cmd} ${rec.args.join(' ')}`)
      } catch {}
    }
  }
}
function wrapAsync(fn) {
  const orig = cp[fn]
  if (typeof orig !== 'function') return
  cp[fn] = function (cmd, ...rest) {
    const a = performance.now()
    const rec = { t: nowMs(), kind: fn, sync: false, cmd: String(cmd).slice(0, 160), args: argsOf(rest[0]) }
    try {
      win.spawns.push(rec)
    } catch {}
    const child = orig.call(this, cmd, ...rest)
    try {
      if (child && typeof child.once === 'function') child.once('exit', () => { rec.ms = Math.round((performance.now() - a) * 10) / 10 })
    } catch {}
    return child
  }
}
for (const fn of ['spawnSync', 'execFileSync', 'execSync']) wrapSync(fn)
for (const fn of ['spawn', 'execFile', 'exec', 'fork']) wrapAsync(fn)
try {
  Module.syncBuiltinESMExports()
} catch {}

let last = performance.now()
const sampler = setInterval(() => {
  const now = performance.now()
  const drift = now - last - SAMPLE_MS
  last = now
  if (drift > STALL_MS) {
    const t1 = nowMs()
    const t0 = t1 - drift - SAMPLE_MS
    const overlap = []
    for (const s of slowRing) if (s.t1 >= t0 - 5 && s.t0 <= t1 + 5) overlap.push(s.label)
    win.stalls.push({ t: Math.round(t0), ms: Math.round(drift), overlap: overlap.slice(-8) })
    if (drift > win.maxStallMs) win.maxStallMs = Math.round(drift)
  }
}, SAMPLE_MS)
sampler.unref()

function flush(reason) {
  const w = win
  win = fresh()
  if (reason !== 'exit' && w.spawns.length === 0 && w.stalls.length === 0 && w.tsReads.length === 0) return
  const line = JSON.stringify({ t: nowMs(), pid: PID, reason, spawns: w.spawns, stalls: w.stalls.slice(0, 80), slowSync: w.slowSync.slice(0, 80), tsReads: w.tsReads, maxStallMs: w.maxStallMs })
  try {
    origAppend.call(fs, OUT, line + '\n')
  } catch {}
}
const flusher = setInterval(() => flush('tick'), FLUSH_MS)
flusher.unref()
process.on('exit', () => flush('exit'))
try {
  origWriteFileSync.call(fs, path.join(LOG_DIR, `proc-${PID}.json`), JSON.stringify({ pid: PID, ppid: process.ppid, argv: process.argv, cwd: process.cwd(), t0: nowMs() }))
} catch {}
