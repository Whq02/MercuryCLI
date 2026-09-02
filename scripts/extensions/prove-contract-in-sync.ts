#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-contract-in-sync.ts — the doc and the skill
//  cannot drift from the schema or from each other. Regenerates the
//  contract from the runtime schemas and fails on ANY byte difference
//  against docs/EXTENSIONS.md's contract section, the skill's CONTRACT.md
//  reference and its bundled copy; also pins that the README template the
//  runtime embeds IS docs/templates/extension-source-README.md, and that
//  the bundled skill's SKILL.md mirrors the mercury-skills source.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' one source of truth — the contract cannot drift')
console.log('============================================================')

let out = ''
let code = 0
try {
  out = execFileSync(process.execPath.includes('bun') ? process.execPath : `${process.env.HOME}/.bun/bin/bun`, ['run', join(import.meta.dir, 'gen-contract.ts'), '--check'], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  const failed = error as { status?: number | null; stdout?: string; stderr?: string }
  code = failed.status ?? 1
  out = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
}
check('gen-contract --check: the doc section, the skill reference and the bundled copy are byte-identical to the schemas', code === 0, out.trim().slice(0, 300))

const template = readFileSync(join(ROOT, 'docs', 'templates', 'extension-source-README.md'), 'utf8')
const skillTemplate = readFileSync(join(ROOT, 'mercury-skills', 'extension-maker', 'references', 'README-template.md'), 'utf8')
check('the README template ships identically inside the skill', template === skillTemplate)
const bundledTemplate = readFileSync(join(ROOT, 'src', 'skills', 'bundled', 'extension-maker', 'references', 'README-template.md'), 'utf8')
check('…and in the bundled copy', template === bundledTemplate)

const skillSource = readFileSync(join(ROOT, 'mercury-skills', 'extension-maker', 'SKILL.md'), 'utf8')
const skillBundled = readFileSync(join(ROOT, 'src', 'skills', 'bundled', 'extension-maker', 'SKILL.md'), 'utf8')
check('the bundled SKILL.md mirrors the mercury-skills source (gen-bundled ran)', skillSource === skillBundled)

const description = /description:\s*(.+)/.exec(skillSource)?.[1] ?? ''
check('the skill carries a non-empty description', description.trim().length > 20, description)
const J = (...parts: string[]): string => parts.join('')
const body = skillSource + readFileSync(join(ROOT, 'docs', 'EXTENSIONS.md'), 'utf8')
check('neither the doc nor the skill speaks a retired word', !new RegExp(J('plug', 'in'), 'i').test(body) && !new RegExp(J('market', 'place'), 'i').test(body))
check('the skill states the two operator-act rules', /never add a source/i.test(skillSource) && /never approve/i.test(skillSource))

console.log(failures === 0 ? '\n ✅ CONTRACT IN SYNC — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
