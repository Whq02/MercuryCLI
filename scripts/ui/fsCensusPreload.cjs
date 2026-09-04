'use strict'
const DIR = process.env.MERCURY_FS_CENSUS_DIR
if (!DIR) return
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const Module = require('module')

const origAppend = fs.appendFileSync
const origWriteFileSync = fs.writeFileSync
const PID = process.pid
const OUT = path.join(DIR, `census-${PID}.jsonl`)

const families = [
  ['project', process.env.MERCURY_FS_CENSUS_PROJECT || ' '],
  ['confighome', process.env.MERCURY_CONFIG_DIR || ' '],
  ['home', process.env.HOME || ' '],
]
function familyOf(p) {
  if (typeof p !== 'string') {
    if (p instanceof Buffer) p = p.toString()
    else if (p && typeof p === 'object' && typeof p.toString === 'function') p = String(p)
    else return 'fd-or-other'
  }
  for (const [name, root] of families) if (root !== ' ' && (p === root || p.startsWith(root + '/'))) return name
  if (p.startsWith('/private/tmp') || p.startsWith('/tmp') || p.startsWith('/var/folders')) return 'tmp'
  return 'other'
}

let win = fresh()
function fresh() {
  return { fs: Object.create(null), top: Object.create(null), spawns: [] }
}
function bump(fn, p) {
  const fam = familyOf(p)
  const key = `${fn}:${fam}`
  win.fs[key] = (win.fs[key] || 0) + 1
  if (fam === 'confighome' || fam === 'project') {
    const k = `${fn} ${typeof p === 'string' ? p : String(p)}`
    win.top[k] = (win.top[k] || 0) + 1
  }
}
function wrapPath(obj, fn, label) {
  const orig = obj[fn]
  if (typeof orig !== 'function') return
  obj[fn] = function (p, ...rest) {
    try {
      bump(label || fn, p)
    } catch {}
    return orig.call(this, p, ...rest)
  }
}
for (const fn of ['readdirSync', 'readFileSync', 'statSync', 'lstatSync', 'openSync', 'existsSync', 'accessSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'realpathSync', 'utimesSync']) wrapPath(fs, fn)
for (const fn of ['readdir', 'readFile', 'stat', 'lstat', 'open', 'access', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'realpath', 'utimes']) wrapPath(fs, fn, fn + '(cb)')
for (const fn of ['readdir', 'readFile', 'stat', 'lstat', 'open', 'access', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'realpath', 'utimes']) wrapPath(fs.promises, fn, fn + '(p)')
{
  const origWatch = fs.watch
  fs.watch = function (p, ...rest) {
    try {
      bump('watch', p)
    } catch {}
    return origWatch.call(this, p, ...rest)
  }
}
function wrapSpawn(fn, sync) {
  const orig = cp[fn]
  if (typeof orig !== 'function') return
  cp[fn] = function (cmd, ...rest) {
    try {
      const args = Array.isArray(rest[0]) ? rest[0].slice(0, 4).map(x => String(x).slice(0, 40)) : []
      win.spawns.push({ t: Date.now(), kind: fn, cmd: String(cmd).slice(0, 80), args, sync })
    } catch {}
    return orig.call(this, cmd, ...rest)
  }
}
for (const fn of ['spawnSync', 'execFileSync', 'execSync']) wrapSpawn(fn, true)
for (const fn of ['spawn', 'execFile', 'exec', 'fork']) wrapSpawn(fn, false)
try {
  Module.syncBuiltinESMExports()
} catch {}

function flush(reason) {
  const w = win
  win = fresh()
  const top = Object.entries(w.top)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
  const line = JSON.stringify({ t: Date.now(), pid: PID, reason, fs: w.fs, top, spawns: w.spawns })
  try {
    origAppend.call(fs, OUT, line + '\n')
  } catch {}
}
const flusher = setInterval(() => flush('tick'), 10_000)
flusher.unref()
process.on('exit', () => flush('exit'))
try {
  origWriteFileSync.call(fs, path.join(DIR, `proc-${PID}.json`), JSON.stringify({ pid: PID, ppid: process.ppid, argv: process.argv, cwd: process.cwd(), t0: Date.now() }))
} catch {}
