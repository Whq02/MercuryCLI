import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function seed(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'result.mjs'), 'export const result = names => names.join(",");\n')
  writeFileSync(join(cwd, 'check.mjs'), 'import assert from "node:assert/strict";\nimport { result } from "./result.mjs";\nassert.equal(result(["alice", "bob"]), "saved: alice, bob\\n");\n')
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"type":"module","scripts":{"test":"node check.mjs"}}\n')
  const git = (args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }) }
  git(['init', '-q'])
  git(['add', '--', 'result.mjs', 'check.mjs', 'package.json'])
  git(['commit', '-qm', 'Seed persisted result'])
}
