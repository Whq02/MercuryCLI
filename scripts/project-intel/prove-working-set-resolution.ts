import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { assembleContextCapsule, importNeighbours, pathTokens } = await import('../../src/services/projectIntel/capsule.js')
const { projectImpact } = await import('../../src/services/projectIntel/impact.js')
const root = mkdtempSync(join(tmpdir(), 'working-set-paths-'))
const put = (file: string, text: string) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
try {
  put('tsconfig.json', '{\n// fixture aliases\n"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"],"@escape/*":["../*"]}},\n}')
  put('src/core/unique.ts', 'export function calculateCharge() { return 1 }\nexport function price() { return 1 }\n')
  put('src/main.ts', 'import { calculateCharge } from "@/core/unique"\nexport const run = calculateCharge\n')
  put('tests/unique.test.ts', 'import { calculateCharge } from "@/core/unique.js"\n')
  put('src/one/shared.ts', 'export const first = 1\n')
  put('src/two/shared.ts', 'export const second = 2\n')
  const failures: string[] = []
  for (const task of ['check unique.ts', 'check @/core/unique', 'check calculateCharge', 'check price']) {
    if (!pathTokens(task, root).includes('src/core/unique.ts')) failures.push(`unresolved task: ${task}`)
    if (!assembleContextCapsule({ workspace: root, task })?.items.some(item => item.path === 'src/core/unique.ts')) failures.push(`capsule missing: ${task}`)
  }
  if (!importNeighbours(root, 'src/main.ts').includes('src/core/unique.ts')) failures.push('forward alias import missing')
  const impact = projectImpact(root, 'unique.ts')
  if (!impact?.established.importedBy.includes('src/main.ts') || !impact.established.tests.includes('tests/unique.test.ts')) failures.push('alias reverse impact missing')
  assert.deepEqual(pathTokens('check shared.ts', root), [], 'ambiguous basename does not guess')
  assert.deepEqual(pathTokens('check @escape/outside.ts', root), [], 'alias cannot escape the workspace')
  assert.deepEqual(failures, [])
  put('fs.ts', 'export const fakeFs = 1\n')
  put('src/external.ts', 'import fs from "fs"\n')
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  assert.deepEqual(importNeighbours(root, 'src/external.ts'), [], 'a bare package does not resolve against the project root without baseUrl or paths')
  const capsule = assembleContextCapsule({ workspace: root, task: 'check calculateCharge', budget: { maxItems: 1, maxBytes: 512 } })
  assert.ok(capsule && capsule.items.length <= 1 && Buffer.byteLength(JSON.stringify(capsule.items)) <= 512)
  console.log('working-set aliases, filenames, symbols and impact: PASS')
} finally { rmSync(root, { recursive: true, force: true }) }
