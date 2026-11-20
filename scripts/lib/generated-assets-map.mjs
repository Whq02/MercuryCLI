import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GENERATED_ASSETS_MAP = 'scripts/gate/generated-assets.tsv'
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function words(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/\s+/)
  return list.map(word => String(word).trim()).filter(Boolean)
}

export function formatGeneratedAssetRow(row) {
  const assets = words(row.assets)
  const sources = words(row.sources)
  const generator = String(row.generator ?? '').trim()
  if (assets.length === 0) throw new Error('a generated-asset row names no asset')
  if (generator === '') throw new Error(`the row for ${assets.join(' ')} names no generator`)
  if (sources.length === 0) throw new Error(`the row for ${assets.join(' ')} names no sources`)
  const check = row.check === null || row.check === undefined || String(row.check).trim() === '' ? '-' : String(row.check).trim()
  if (row.build === true && check === '-') throw new Error(`the row for ${assets.join(' ')} asks the build to check it and names no check`)
  return [assets.join(' '), generator, check, sources.join(' '), ...(row.build === true ? ['build'] : [])].join('\t')
}

export function buildCheckedRows(text) {
  return text
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .map(line => line.split('\t').map(column => column.trim()))
    .filter(columns => columns[4] === 'build')
    .map(([assets, generator, check]) => ({ assets, generator, check }))
}

function runBuildCheck(root, row) {
  const [, script, ...flags] = row.check.split(/\s+/)
  return new Promise(done => {
    const child = spawn(process.execPath, [resolve(root, script), ...flags], { cwd: root })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => done({ row, error }))
    child.on('close', (status, signal) => done({ row, status, signal, output }))
  })
}

export async function staleBuildAssets(root = REPOSITORY_ROOT) {
  const path = resolve(root, GENERATED_ASSETS_MAP)
  if (!existsSync(path)) return []
  const stale = []
  for (const run of await Promise.all(buildCheckedRows(readFileSync(path, 'utf8')).map(row => runBuildCheck(root, row)))) {
    if (run.error !== undefined || run.status === null) {
      console.error(`generated-assets: ${run.row.check} did not run (${run.error?.message ?? `ended by ${run.signal}`}), so the build goes on without it`)
      continue
    }
    if (run.status !== 0) stale.push({ ...run.row, output: run.output.trim() })
  }
  return stale
}

function generatorOf(line) {
  return String(line.split('\t')[1] ?? '').trim()
}

export function upsertGeneratedAssetRow(text, row) {
  const line = formatGeneratedAssetRow(row)
  const generator = generatorOf(line)
  const lines = text.split('\n')
  const body = text.endsWith('\n') ? lines.slice(0, -1) : lines
  const index = body.findIndex(existing => existing.trim() !== '' && !existing.trimStart().startsWith('#') && generatorOf(existing) === generator)
  if (index === -1) {
    body.push(line)
    return { text: `${body.join('\n')}\n`, action: 'added', line }
  }
  if (body[index] === line) return { text, action: 'unchanged', line }
  body[index] = line
  return { text: `${body.join('\n')}\n`, action: 'updated', line }
}

export function registerGeneratedAsset(row, options = {}) {
  const root = options.root ?? REPOSITORY_ROOT
  const path = resolve(root, GENERATED_ASSETS_MAP)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const result = upsertGeneratedAssetRow(before, row)
  if (result.action !== 'unchanged') writeFileSync(path, result.text)
  return { path, action: result.action, line: result.line }
}

export function registerOnlyRequested(row, argv = process.argv.slice(2)) {
  if (!argv.includes('--register')) return false
  const result = registerGeneratedAsset(row)
  console.log(`generated-assets: ${result.action} — ${result.line.split('\t')[0]} → ${GENERATED_ASSETS_MAP}`)
  return true
}
