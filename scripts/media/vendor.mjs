import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const source = resolve(process.argv[2] ?? '.')
const target = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3] || source === target) throw new Error('Pass the engine bundle and destination.')
const manifestBytes = readFileSync(join(source, 'manifest.json'))
const manifest = JSON.parse(manifestBytes.toString('utf8'))
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version) || typeof manifest.runtimeTag !== 'string') throw new Error('Engine version and runtime tag are required.')
const names = Object.keys(manifest.files).sort()
for (const file of ['server.js', 'setup.js', 'config.js', 'catalog.json', 'LICENSE', 'NOTICE']) if (!names.includes(file)) throw new Error(`Missing bundle member: ${file}`)
if (JSON.stringify(readdirSync(source).sort()) !== JSON.stringify([...names, 'manifest.json'].sort())) throw new Error('Bundle files differ from its manifest.')
const payloads = names.map(path => {
  if (!/^[a-zA-Z0-9._-]+$/.test(path) || path === '.' || path === '..') throw new Error('Bundle members must be plain filenames.')
  const full = join(source, path)
  const info = lstatSync(full)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`)
  const bytes = readFileSync(full)
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[path]) throw new Error(`Bundle digest differs: ${path}`)
  return { path, bytes, mode: info.mode & 0o777 }
})
const stage = `${target}.stage-${randomUUID()}`
const previous = `${target}.previous-${randomUUID()}`
try {
  mkdirSync(stage, { recursive: true })
  for (const file of payloads) writeFileSync(join(stage, file.path), file.bytes, { flag: 'wx', mode: file.mode })
  writeFileSync(join(stage, 'manifest.json'), manifestBytes)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) renameSync(target, previous)
  try { renameSync(stage, target) } catch (error) { if (existsSync(previous)) renameSync(previous, target); throw error }
  rmSync(previous, { recursive: true, force: true })
} finally { rmSync(stage, { recursive: true, force: true }) }
console.log(`Vendored mercury-media-mcp ${manifest.version}: ${names.length} files`)
