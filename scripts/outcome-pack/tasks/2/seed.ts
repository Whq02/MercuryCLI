import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function seed(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'greet.mjs'), 'console.log("hello, " + process.argv[2]);\n')
  writeFileSync(join(cwd, 'check.mjs'), 'import assert from "node:assert/strict";\nimport { spawnSync } from "node:child_process";\nconst run = args => spawnSync(process.execPath, ["greet.mjs", ...args], { encoding: "utf8" });\nassert.equal(run(["alice"]).stdout, "hello, alice\\n");\nassert.equal(run([]).status, 2);\n')
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"type":"module","scripts":{"test":"node check.mjs"}}\n')
  const git = (args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }) }
  git(['init', '-q'])
  git(['add', '--', 'greet.mjs', 'check.mjs', 'package.json'])
  git(['commit', '-qm', 'Seed greeting'])
}
