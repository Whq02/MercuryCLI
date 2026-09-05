'use strict'
const DIR = process.env.DAEMON_CENSUS_DIR
if (DIR) {
  const fs = require('fs')
  const path = require('path')
  const cp = require('child_process')
  const Module = require('module')
  const origAppend = fs.appendFileSync
  const OUT = path.join(DIR, `census-${process.pid}.jsonl`)
  let spawns = []
  let fsBySec = Object.create(null)
  let fdBySec = Object.create(null)
  const sec = () => Math.floor(Date.now() / 1000)
  const pathText = p => {
    if (typeof p === 'string') return p
    if (p instanceof Buffer) return p.toString()
    if (p && typeof p === 'object' && typeof p.toString === 'function') return String(p)
    return 'fd-or-other'
  }
  let flushing = false
  const bump = (table, key) => {
    if (flushing) return
    const s = sec()
    const bucket = table[s] || (table[s] = Object.create(null))
    bucket[key] = (bucket[key] || 0) + 1
  }
  const wrapPath = (obj, fn, label) => {
    const orig = obj[fn]
    if (typeof orig !== 'function') return
    obj[fn] = function (p, ...rest) {
      try {
        bump(fsBySec, `${label} ${pathText(p)}`)
      } catch {
      }
      return orig.call(this, p, ...rest)
    }
  }
  const wrapFd = (obj, fn) => {
    const orig = obj[fn]
    if (typeof orig !== 'function') return
    obj[fn] = function (fd, ...rest) {
      try {
        if (fd !== 1 && fd !== 2) bump(fdBySec, `${fn} fd`)
      } catch {
      }
      return orig.call(this, fd, ...rest)
    }
  }
  for (const fn of ['readdirSync', 'readFileSync', 'statSync', 'lstatSync', 'openSync', 'existsSync', 'accessSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'realpathSync', 'opendirSync', 'rmSync', 'copyFileSync', 'utimesSync']) wrapPath(fs, fn, fn)
  for (const fn of ['readdir', 'readFile', 'stat', 'lstat', 'open', 'access', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'realpath', 'opendir', 'rm', 'copyFile']) wrapPath(fs, fn, `${fn}(cb)`)
  for (const fn of ['readdir', 'readFile', 'stat', 'lstat', 'open', 'access', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'realpath', 'opendir', 'rm', 'copyFile']) wrapPath(fs.promises, fn, `${fn}(p)`)
  wrapPath(fs, 'watch', 'watch')
  wrapPath(fs, 'watchFile', 'watchFile')
  for (const fn of ['readSync', 'writeSync', 'fstatSync']) wrapFd(fs, fn)
  const argsOf = a => (Array.isArray(a) ? a.slice(0, 6).map(x => String(x).slice(0, 80)) : [])
  const wrapSpawn = fn => {
    const orig = cp[fn]
    if (typeof orig !== 'function') return
    cp[fn] = function (cmd, ...rest) {
      try {
        spawns.push({ t: Date.now(), kind: fn, cmd: String(cmd).slice(0, 120), args: argsOf(rest[0]) })
      } catch {
      }
      return orig.call(this, cmd, ...rest)
    }
  }
  for (const fn of ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork']) wrapSpawn(fn)
  try {
    Module.syncBuiltinESMExports()
  } catch {
  }
  const flush = reason => {
    const line = JSON.stringify({ t: Date.now(), pid: process.pid, reason, spawns, fs: fsBySec, fd: fdBySec })
    spawns = []
    fsBySec = Object.create(null)
    fdBySec = Object.create(null)
    flushing = true
    try {
      origAppend.call(fs, OUT, line + '\n')
    } catch {
    } finally {
      flushing = false
    }
  }
  const flusher = setInterval(() => flush('tick'), 5_000)
  flusher.unref()
  process.on('exit', () => flush('exit'))
}
