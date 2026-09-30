const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')

const folders = new Set()
let installed = false
function registerProofScratch(folder) {
  folders.add(folder)
  return folder
}
function keepProofScratch(folder) {
  for (const candidate of folders) {
    if (Buffer.from(candidate).equals(Buffer.from(folder))) folders.delete(candidate)
  }
}
function scratchPrefix(prefix) {
  const root = process.env.MERCURY_SUITE_TMPDIR
  if (!root) return prefix
  try {
    const value = prefix instanceof URL ? fileURLToPath(prefix) : String(prefix)
    if (/^\/(?:private\/)?tmp\/mw\//.test(value)) {
      const base = Buffer.from(root + path.sep)
      return Buffer.isBuffer(prefix)
        ? Buffer.concat([base, prefix.subarray(prefix.lastIndexOf(47) + 1)])
        : root + path.sep + value.slice(value.lastIndexOf('/') + 1)
    }
  } catch {
    return prefix
  }
  return prefix
}
function processStartedAt() {
  const { execFileSync } = require('node:child_process')
  for (const ps of ['ps', '/bin/ps', '/usr/bin/ps']) {
    try {
      const started = execFileSync(ps, ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim()
      if (started) return started
    } catch {}
  }
  return '?'
}
function processFolder() {
  try {
    return process.cwd() || '?'
  } catch {
    return '?'
  }
}
function writeLedgerEntry(ledger) {
  try {
    fs.mkdirSync(ledger, { recursive: true })
    fs.writeFileSync(path.join(ledger, `${process.pid}.entry`), [process.pid, process.env.MERCURY_SUITE_RUNNER_PID || process.ppid, processStartedAt(), processFolder(), process.execPath].join('\t') + '\n')
  } catch {}
}
function installProofScratch() {
  if (installed) return
  installed = true
  const runRoot = process.env.MERCURY_SUITE_TMPDIR
  const ledger = process.env.MERCURY_PROCESS_LEDGER_DIR
  if (ledger) writeLedgerEntry(ledger)
  const sync = fs.mkdtempSync
  const callback = fs.mkdtemp
  const promise = fs.promises.mkdtemp
  fs.mkdtempSync = function(prefix, options) {
    return registerProofScratch(sync.call(this, scratchPrefix(prefix), options))
  }
  fs.mkdtemp = function(prefix, options, done) {
    if (typeof options !== 'function' && typeof done !== 'function') return callback.apply(this, arguments)
    if (typeof options === 'function') { done = options; options = undefined }
    return callback.call(this, scratchPrefix(prefix), options, (error, folder) => {
      if (!error) registerProofScratch(folder)
      done(error, folder)
    })
  }
  fs.promises.mkdtemp = async function(prefix, options) {
    return registerProofScratch(await promise.call(this, scratchPrefix(prefix), options))
  }
  syncBuiltinESMExports()
  if (!process.env.MERCURY_SUITE_BROWSER_CLEANER) {
    try {
      require('./proofBrowser.cjs').installProofBrowser(profile => {
        const root = process.env.MERCURY_SUITE_TMPDIR
        return folders.has(profile) || Boolean(root && path.resolve(profile).startsWith(path.resolve(root) + path.sep))
      })
    } catch {}
  }
  process.on('exit', () => {
    if (runRoot) return
    for (const folder of [...folders].reverse()) {
      try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 }) } catch (error) {
        process.stderr.write(`proof scratch cleanup failed: ${folder}: ${error.message}\n`)
        process.exitCode = process.exitCode || 1
      }
    }
  })
}
module.exports = { installProofScratch, registerProofScratch, keepProofScratch }
if (process.env.MERCURY_SUITE_TMPDIR) {
  try {
    installProofScratch()
  } catch {}
}
