const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')

const folders = new Set()
let installed = false
function registerProofScratch(folder) {
  folders.add(String(folder))
  return folder
}
function keepProofScratch(folder) {
  folders.delete(String(folder))
}
function scratchPrefix(prefix) {
  const root = process.env.MERCURY_SUITE_TMPDIR
  if (!root) return prefix
  const value = prefix instanceof URL ? fileURLToPath(prefix) : String(prefix)
  if (/^\/(?:private\/)?tmp\/mw\//.test(value)) return path.join(root, path.basename(value))
  return prefix
}
function installProofScratch() {
  if (installed) return
  installed = true
  const ledger = process.env.MERCURY_PROCESS_LEDGER_DIR
  if (ledger) {
    const { execFileSync } = require('node:child_process')
    try {
      fs.mkdirSync(ledger, { recursive: true })
      const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
      fs.writeFileSync(path.join(ledger, `${process.pid}.entry`), [process.pid, process.env.MERCURY_SUITE_RUNNER_PID || process.ppid, started, process.cwd(), process.execPath].join('\t') + '\n')
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }
  }
  const sync = fs.mkdtempSync
  const callback = fs.mkdtemp
  const promise = fs.promises.mkdtemp
  fs.mkdtempSync = function(prefix, options) {
    return registerProofScratch(sync.call(this, scratchPrefix(prefix), options))
  }
  fs.mkdtemp = function(prefix, options, done) {
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
  process.on('exit', () => {
    for (const folder of [...folders].reverse()) {
      try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 }) } catch (error) {
        process.stderr.write(`proof scratch cleanup failed: ${folder}: ${error.message}\n`)
        process.exitCode = process.exitCode || 1
      }
    }
  })
}
module.exports = { installProofScratch, registerProofScratch, keepProofScratch }
if (process.env.MERCURY_SUITE_TMPDIR) installProofScratch()
