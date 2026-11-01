import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function seed(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'score.mjs'), 'export const score = value => value;\n')
  writeFileSync(join(cwd, 'check.mjs'), 'import assert from "node:assert/strict";\nimport { existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { score } from "./score.mjs";\nassert.equal(score(150), 100);\nassert.equal(score(-10), 0);\nassert.equal(score(42), 42);\nif (process.env.OUTCOME_HOLD) {\n  writeFileSync(join(process.env.OUTCOME_HOLD, "ready"), "ready");\n  while (!existsSync(join(process.env.OUTCOME_HOLD, "release"))) await new Promise(resolve => setTimeout(resolve, 10));\n}\n')
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"type":"module","scripts":{"test":"node check.mjs"}}\n')
  const git = (args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }) }
  git(['init', '-q'])
  git(['add', '--', 'score.mjs', 'check.mjs', 'package.json'])
  git(['commit', '-qm', 'Seed bounded score'])
}
