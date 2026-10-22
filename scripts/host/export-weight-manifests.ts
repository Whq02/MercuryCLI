import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HOST_RECIPES } from '../../src/services/host/recipes.ts'

type TreeFile = { type: string; path: string; size: number; oid: string; lfs?: { oid: string } }
type Manifest = { model: string; include: string; revision: string; readAt: string; source: string; files: { path: string; size: number; sha256?: string; git?: string }[] }
const path = resolve(import.meta.dir, '../../assets/host/weights.json')
const original = readFileSync(path, 'utf8')
const manifests: Manifest[] = JSON.parse(original)
const check = process.argv.includes('--check')
for (const recipe of HOST_RECIPES.filter(row => row.engine === 'llamacpp')) {
  const index = manifests.findIndex(row => row.model === recipe.model && row.include === (recipe.include ?? ''))
  assert.ok(index >= 0, `No pinned revision for ${recipe.id}`)
  const previous = manifests[index]!
  const source = `https://huggingface.co/api/models/${recipe.model}/tree/${previous.revision}?recursive=true&limit=1000`
  const tree: TreeFile[] = []
  let next: string | undefined = source
  while (next) {
    assert.equal(new URL(next).origin, 'https://huggingface.co')
    const response = await fetch(next, { redirect: 'error', signal: AbortSignal.timeout(30000) })
    assert.ok(response.ok, `${next}: HTTP ${response.status}`)
    tree.push(...await response.json() as TreeFile[])
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
  }
  const quant = new RegExp('^' + (recipe.include ?? '*').split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const files = tree.filter(file => file.type === 'file' && (quant.test(file.path) || file.path === recipe.mmproj)).map(file => ({ path: file.path, size: file.size, ...(file.lfs ? { sha256: file.lfs.oid } : { git: file.oid }) }))
  assert.ok(!recipe.mmproj || files.some(file => file.path === recipe.mmproj), `Missing projector ${recipe.mmproj}`)
  assert.equal(files.reduce((sum, file) => sum + file.size, 0), Math.round(recipe.weightsGb * 1e9), `${recipe.id}: weightsGb must include every downloaded file`)
  manifests[index] = { ...previous, readAt: check ? previous.readAt : new Date().toISOString().slice(0, 10), source, files }
  console.log(`${recipe.id}: ${files.length} pinned files, ${recipe.weightsGb} GB`)
}
const json = JSON.stringify(manifests) + (original.endsWith('\n') ? '\n' : '')
if (check) assert.equal(json, original, 'GGUF weight manifests differ from the pinned Hub trees')
else writeFileSync(path, json)
