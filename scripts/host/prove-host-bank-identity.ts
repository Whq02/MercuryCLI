import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
process.env.HOME = f.home
try {
  const bank = await import(f.root + '/src/services/host/bank.ts')
  const { HOST_RECIPES } = await import(f.root + '/src/services/host/recipes.ts')
  const bytes = Buffer.from('fixture-private-weights')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const recipe = { ...HOST_RECIPES[0], id: 'bank-identity-fixture', model: 'fixture/private-repo', weightFile: 'weights.gguf', weightsGb: bytes.length / 1e9, include: '', weightManifest: { model: 'fixture/private-repo', include: '', revision: 'a'.repeat(40), files: [{ path: 'weights.gguf', size: bytes.length, sha256: hash }] } }
  const folder = bank.rememberBankFolder(join(f.home, 'bank'))
  const path = join(folder, 'private-repo')
  mkdirSync(path)
  writeFileSync(join(path, 'weights.gguf'), bytes)
  writeFileSync(join(path, 'SHA256SUMS'), hash + '  weights.gguf\n')
  assert.ok(bank.bankState(recipe).banked, 'a repo-only folder with the model checksum manifest is banked')
  assert.equal(bank.bankState(recipe).path, path)
  await bank.verifyBank(recipe, folder, new AbortController().signal)
  assert.ok(bank.bankState(recipe).verifiedAt)
  const renamed = join(folder, 'another-name')
  renameSync(path, renamed)
  assert.equal(bank.bankState(recipe).path, renamed)
  await bank.verifyBank(recipe, folder, new AbortController().signal)
  assert.ok(bank.bankedHostRecipes().some((row: any) => row.id === recipe.id))
  assert.equal(bank.bankModelFolder(folder, recipe), join(folder, 'fixture--private-repo'))
  const unrelated = { ...recipe, id: 'unrelated', model: 'fixture/unrelated', weightManifest: { ...recipe.weightManifest, model: 'fixture/unrelated', files: [{ path: 'weights.gguf', size: bytes.length, sha256: 'f'.repeat(64) }] } }
  assert.equal(bank.bankState(unrelated).banked, false)
  writeFileSync(join(renamed, 'weights.gguf'), Buffer.alloc(bytes.length))
  await assert.rejects(bank.verifyBank(recipe, folder, new AbortController().signal), /hash differs/)
  console.log('PASS checksum identity finds repo-only and renamed folders; verify reads the discovered path; new folders keep org--repo names; other model hashes and corruption never pass')
} finally { f.close() }
