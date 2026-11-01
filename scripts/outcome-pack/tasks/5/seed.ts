import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function seed(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'receipt.mjs'), 'export const receipt = name => name;\n')
  writeFileSync(join(cwd, 'check.mjs'), 'import assert from "node:assert/strict";\nimport { receipt } from "./receipt.mjs";\nassert.equal(receipt("alice"), "approved: alice\\n");\n')
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"type":"module","scripts":{"test":"node check.mjs"}}\n')
  const git = (args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }) }
  git(['init', '-q'])
  git(['add', '--', 'receipt.mjs', 'check.mjs', 'package.json'])
  git(['commit', '-qm', 'Seed approved receipt'])
}
