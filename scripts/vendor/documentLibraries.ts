import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

type Package = { name: string; version: string; license?: string }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const lockedForms = (bytes: Buffer): Buffer[] => [bytes, Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')]
export async function vendorDocumentLibraries(root: string, output: string) {
  const lockPath = join(root, 'vendor/document-libs.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages: { name: string; version: string; license: string }[]; licenceSources: { name: string; version: string; file: string; sha256: string; url: string }[] }
  const require = createRequire(join(root, 'package.json'))
  const entrypoints = lock.packages.map(row => require.resolve(row.name === 'exceljs' ? 'exceljs/lib/exceljs.bare.js' : row.name))
  const graph = await Bun.build({ entrypoints, target: 'node', write: false, metafile: true })
  if (!graph.success) throw new Error(graph.logs.map(String).join('\n'))
  const packageDirs = new Set<string>()
  for (const input of Object.keys(graph.metafile!.inputs)) {
    let dir = dirname(resolve(root, input))
    if (!dir.includes('node_modules')) continue
    while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
    packageDirs.add(realpathSync(dir))
  }
  const destination = join(output, 'vendor/document-libs')
  mkdirSync(destination, { recursive: true })
  copyFileSync(lockPath, join(destination, 'document-libs.lock.json'))
  const packages: { name: string; version: string; license: string; files: { name: string; bytes: number; sha256: string }[] }[] = []
  for (const dir of packageDirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Package
    const names = readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name) && statSync(join(dir, name)).isFile())
    if (!names.length) names.push(...readdirSync(dir).filter(name => /^readme(\.|$)/i.test(name) && /Permission is hereby granted|Redistribution and use in source and binary forms/i.test(readFileSync(join(dir, name), 'utf8'))))
    const licenceSource = lock.licenceSources.find(row => row.name === pkg.name && row.version === pkg.version)
    const sourceFiles = names.map(name => ({ name, path: join(dir, name), sha256: undefined as string | undefined }))
    if (!sourceFiles.length && licenceSource) sourceFiles.push({ name: 'LICENSE', path: join(root, 'vendor', licenceSource.file), sha256: licenceSource.sha256 })
    if (!sourceFiles.length) throw new Error(`No licence file for bundled document dependency ${pkg.name}@${pkg.version}`)
    const dest = join(destination, 'licences', `${pkg.name.replaceAll('/', '_')}@${pkg.version}`)
    mkdirSync(dest, { recursive: true })
    const files = sourceFiles.map(file => {
      const read = readFileSync(file.path)
      const bytes = file.sha256 ? lockedForms(read).find(form => digest(form) === file.sha256) : read
      if (!bytes) throw new Error(`Document licence differs from its lock: ${pkg.name}`)
      writeFileSync(join(dest, file.name), bytes)
      return { name: file.name, bytes: bytes.length, sha256: digest(bytes) }
    })
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'see licence file', files })
  }
  for (const row of lock.packages) {
    const actual = JSON.parse(readFileSync(join(root, 'node_modules', row.name, 'package.json'), 'utf8')) as Package
    if (actual.version !== row.version || actual.license !== row.license) throw new Error(`Document dependency differs from its lock: ${row.name}`)
    if (!packages.some(p => p.name === row.name)) throw new Error(`Document dependency absent from bundle graph: ${row.name}`)
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  writeFileSync(join(destination, 'licences.json'), JSON.stringify(packages, null, 2) + '\n')
  return { bundled: true, path: 'vendor/document-libs', packages: lock.packages.map(p => ({ name: p.name, version: p.version, license: p.license })), licenceFiles: packages.reduce((n, p) => n + p.files.length, 0), licenceBytes: packages.reduce((n, p) => n + p.files.reduce((m, f) => m + f.bytes, 0), 0) }
}
