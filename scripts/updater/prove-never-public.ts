#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}


const wf = readFileSync(join(ROOT, '.github', 'workflows', 'private-release.yml'), 'utf8')
check('workflow has no npm publish', !wf.includes('npm publish'))
check('workflow has no public-bucket upload', !wf.includes('storage.googleapis') && !wf.includes('aws s3'))
check('workflow marks every labelled tag prerelease', wf.includes("PRERELEASE='--prerelease'"))
check('workflow uses the repo-scoped github.token only', wf.includes('GH_TOKEN: ${{ github.token }}') && !wf.includes('PERSONAL_ACCESS_TOKEN'))
check('workflow release step targets gh release create (this repo)', wf.includes('gh release create'))

console.log('')
if (failures === 0) {
  console.log('PASS prove-never-public')
  process.exit(0)
}
console.log(`FAIL prove-never-public (${failures})`)
process.exit(1)
