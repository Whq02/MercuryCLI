import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GENERATED_ASSETS_MAP = 'scripts/gate/generated-assets.tsv'
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
  return [assets.join(' '), generator, check, sources.join(' ')].join('\t')
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
