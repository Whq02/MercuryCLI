const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { types } = require('node:util')
const { syncBuiltinESMExports } = require('node:module')

const INSTALLED = Symbol.for('mercury.proof.guard')
const REFUSED = 'EPROOFGUARD'
const GUARDED_OPERATIONS = [
  { name: 'rm', acts: [0], lands: [] },
  { name: 'rmdir', acts: [0], lands: [] },
  { name: 'unlink', acts: [0], lands: [] },
  { name: 'rename', acts: [0], lands: [1] },
  { name: 'symlink', acts: [], lands: [1] },
  { name: 'link', acts: [], lands: [1] },
]
const ACCOUNT_RECORD_HOME_AT = { darwin: 48, linux: 32 }
const NAMES_FOLD = process.platform === 'darwin'
const NO_ENTRY = ['ENOENT', 'ENOTDIR']
const LINKS_FOLLOWED = 40
const lstat = fs.lstatSync
const stat = fs.statSync
const realpath = fs.realpathSync
const readlink = fs.readlinkSync
let roots = []

function proofEntry() {
  const scripts = path.dirname(__dirname)
  const vendor = path.join(scripts, 'vendor')
  const entry = typeof globalThis.Bun?.main === 'string' ? globalThis.Bun.main : process.argv[1] || ''
  const under = folder => entry === folder || entry.startsWith(folder + path.sep)
  return under(scripts) && !under(vendor)
}
function systemLibraries() {
  if (process.env.MERCURY_SUITE_LIBC) return [process.env.MERCURY_SUITE_LIBC]
  return process.platform === 'darwin' ? ['libSystem.B.dylib'] : ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`]
}
function openSystemLibrary(symbols) {
  const { dlopen } = require('bun:ffi')
  const names = systemLibraries()
  for (const name of names) {
    try {
      return dlopen(name, symbols)
    } catch {}
  }
  throw new Error(`${names.join(', ')} did not open`)
}
function accountHome() {
  let home
  if (process.versions.bun) {
    const at = ACCOUNT_RECORD_HOME_AT[process.platform]
    if (at === undefined) throw new Error(`no account record is read on ${process.platform}`)
    const { FFIType, read, CString } = require('bun:ffi')
    const record = openSystemLibrary({ getpwuid: { args: [FFIType.u32], returns: FFIType.ptr } }).symbols.getpwuid(process.getuid())
    const text = record ? read.ptr(record, at) : 0
    if (!text) throw new Error(`uid ${process.getuid()} has no account record`)
    home = new CString(text).toString()
  } else {
    home = os.userInfo().homedir
  }
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error(`the account record names no home: ${JSON.stringify(home)}`)
  return home
}
function accountRoots() {
  const uid = process.getuid()
  let temp = '/tmp'
  try {
    temp = realpath(temp)
  } catch {}
  const found = [{ label: "the account's temp root", path: path.join(temp, `mercury-${uid}`) }]
  try {
    const home = accountHome()
    const cache = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'mercury-nodejs')
    found.push({ label: "the account's config home", path: path.join(home, '.mercury') })
    found.push({ label: "the account's cache home", path: cache })
    found.push({ label: "the account's session folders in its cache home", path: path.join(cache, `mercury-${uid}`) })
  } catch (error) {
    process.stderr.write(`proof guard: the account's home could not be read (${error.message}); its config home and cache home are not guarded in this process\n`)
  }
  return found
}
function namedRoots() {
  return (process.env.MERCURY_SUITE_GUARDED || '').split(path.delimiter).filter(Boolean).map(entry => ({ label: 'a guarded root', path: path.resolve(entry) }))
}
function above(folder) {
  const chain = [folder]
  while (path.dirname(chain[chain.length - 1]) !== chain[chain.length - 1]) chain.push(path.dirname(chain[chain.length - 1]))
  return chain
}
function settled(root) {
  let folder = path.dirname(root.path)
  try {
    folder = realpath(folder)
  } catch {}
  const name = path.basename(root.path)
  return { label: root.label, path: path.join(folder, name), folder, name, held: above(folder) }
}
function seen(target, follow) {
  let found
  try {
    found = (follow ? stat : lstat)(target, { bigint: true, throwIfNoEntry: false })
  } catch (error) {
    if (NO_ENTRY.includes(error.code)) return null
    throw error
  }
  return found ? { key: found.ino ? `${found.dev}:${found.ino}` : '', folder: found.isDirectory(), link: found.isSymbolicLink() } : null
}
function onDisk(spelled) {
  return Buffer.from(spelled, 'latin1')
}
function said(spelled) {
  return onDisk(spelled).toString()
}
function folded(name) {
  return NAMES_FOLD ? name.normalize('NFC').toLowerCase() : name
}
function bare(place) {
  let end = place.length
  while (end > 1 && place[end - 1] === path.sep) end--
  return place.slice(0, end)
}
function behindLinks(place) {
  for (let followed = 0; followed < LINKS_FOLLOWED; followed++) {
    let to
    try {
      to = readlink(onDisk(place), { encoding: 'buffer' }).toString('latin1')
    } catch (error) {
      if (error.code === 'EINVAL' || NO_ENTRY.includes(error.code)) return place
      throw error
    }
    place = bare(path.isAbsolute(to) ? to : `${path.dirname(place)}${path.sep}${to}`)
  }
  return place
}
function landing(target) {
  const place = target.endsWith(path.sep) ? behindLinks(bare(target)) : target
  const last = path.basename(place)
  if (last === '' || last === '.' || last === '..') return null
  const folder = seen(onDisk(path.dirname(place)), true)
  if (folder === null || folder.key === '') return null
  const name = folded(said(last))
  for (const root of roots) {
    if (folded(root.name) !== name) continue
    if (seen(root.folder, true)?.key === folder.key) return { how: 'is', root }
  }
  return null
}
function standing(target, lands) {
  const here = seen(onDisk(target), false)
  if (here === null) return lands ? landing(target) : null
  if (here.key === '') return null
  for (const root of roots) {
    const stands = seen(root.path, false)
    const behind = stands !== null && stands.link ? seen(root.path, true) : null
    if (stands?.key === here.key || behind?.key === here.key) return { how: 'is', root }
    if (!here.folder) continue
    let held = root.held
    if (behind !== null) {
      try {
        held = held.concat(above(path.dirname(realpath(root.path))))
      } catch {}
    }
    if (held.some(folder => seen(folder, true)?.key === here.key)) return { how: 'holds', root }
  }
  return null
}
function bytes(raw) {
  if (typeof raw === 'string') return Buffer.from(raw)
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (types.isAnyArrayBuffer(raw)) return Buffer.from(raw)
  if (types.isStringObject(raw)) return Buffer.from(String(raw))
  if (typeof raw === 'object' && raw !== null) return Buffer.from(fileURLToPath(raw))
  return null
}
function kind(raw) {
  if (raw === null) return 'null'
  return typeof raw === 'object' ? Object.prototype.toString.call(raw).slice(8, -1) : typeof raw
}
function denied(operation, target, why, rule) {
  const error = new Error(`proof guard: ${operation} refused: ${why}; ${rule}`)
  error.code = REFUSED
  error.syscall = operation
  error.path = target
  process.stderr.write(`${error.message}\n`)
  return error
}
function refusal(operation, raw, lands) {
  const unjudged = 'a call whose path the guard cannot judge does not go through'
  let read = null
  try {
    read = bytes(raw)
  } catch {}
  if (read === null) return denied(operation, undefined, `its path is a value the guard does not read (${kind(raw)})`, unjudged)
  if (read.length === 0) return null
  const target = read.toString()
  let found
  try {
    found = standing(read.toString('latin1'), lands)
  } catch (error) {
    return denied(operation, target, `${target} could not be checked (${error.message})`, unjudged)
  }
  if (found === null) return null
  return denied(operation, target, `${target} ${found.how} ${found.root.label} (${found.root.path})`, 'a proof removes, renames and links over only what its own run made')
}
function refused(operation, shape, words) {
  for (const [indexes, lands] of [[shape.acts, false], [shape.lands, true]]) {
    for (const index of indexes) {
      const error = refusal(operation, words[index], lands)
      if (error) return error
    }
  }
  return null
}
function replace(holder, said, name, guarded) {
  holder[name] = guarded
  if (holder[name] !== guarded) throw new Error(`${said}.${name} could not be replaced`)
}
function carryProofGuard(env) {
  const options = { NODE_OPTIONS: `--require=${JSON.stringify(__filename)}`, BUN_OPTIONS: `"--preload=${__filename}"` }
  for (const [name, option] of Object.entries(options)) {
    if (!(env[name] || '').includes(option)) env[name] = env[name] ? `${env[name]} ${option}` : option
  }
}
function installProofGuard() {
  if (globalThis[INSTALLED] || process.platform === 'win32') return
  if (!process.env.MERCURY_SUITE_TMPDIR && !process.env.MERCURY_SUITE_OF_ONE && !proofEntry()) return
  try {
    roots = accountRoots().concat(namedRoots()).map(settled)
    for (const shape of GUARDED_OPERATIONS) {
      const sync = fs[`${shape.name}Sync`]
      const callback = fs[shape.name]
      const promised = fs.promises[shape.name]
      replace(fs, 'fs', `${shape.name}Sync`, function() {
        const error = refused(`${shape.name}Sync`, shape, arguments)
        if (error) throw error
        return sync.apply(this, arguments)
      })
      replace(fs, 'fs', shape.name, function() {
        const error = refused(shape.name, shape, arguments)
        if (!error) return callback.apply(this, arguments)
        const done = arguments[arguments.length - 1]
        if (typeof done !== 'function') throw error
        process.nextTick(done, error)
      })
      replace(fs.promises, 'fs.promises', shape.name, async function() {
        const error = refused(`promises.${shape.name}`, shape, arguments)
        if (error) throw error
        return promised.apply(this, arguments)
      })
    }
    syncBuiltinESMExports()
    globalThis[INSTALLED] = roots.map(root => root.path)
  } catch (error) {
    process.stderr.write(`proof guard: not installed (${error.message}); this process can remove, rename and link over the account's own temp root, config home and cache home\n`)
  }
}
module.exports = { proofEntry, openSystemLibrary, carryProofGuard }
installProofGuard()
