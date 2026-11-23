#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

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
check('gen-contract --check: the doc section, the skill reference and the bundled copy are byte-identical to the schemas', code === 0, 'run bun scripts/extensions/gen-contract.ts to regenerate docs/EXTENSIONS.md and the CONTRACT.md copies from src/integrations/extensions/manifest.ts, then commit them; ' + out.trim().slice(0, 300))

const template = readFileSync(join(ROOT, 'docs', 'templates', 'extension-source-README.md'), 'utf8')
const skillTemplate = readFileSync(join(ROOT, 'mercury-skills', 'extension-maker', 'references', 'README-template.md'), 'utf8')
check('the README template ships identically inside the skill', template === skillTemplate, 'make mercury-skills/extension-maker/references/README-template.md byte-identical to docs/templates/extension-source-README.md')

const skillSource = readFileSync(join(ROOT, 'mercury-skills', 'extension-maker', 'SKILL.md'), 'utf8')
let bundledOut = ''
let bundledCode = 0
try {
  bundledOut = execFileSync(process.execPath.includes('bun') ? process.execPath : `${process.env.HOME}/.bun/bin/bun`, ['run', join(ROOT, 'scripts', 'skills', 'gen-bundled.ts'), '--check', 'extension-maker'], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  const failed = error as { status?: number | null; stdout?: string; stderr?: string }
  bundledCode = failed.status ?? 1
  bundledOut = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
}
check('gen-bundled --check extension-maker: the bundled SKILL.md and references mirror the mercury-skills source', bundledCode === 0, 'run bun scripts/skills/gen-bundled.ts extension-maker to rewrite src/integrations/skills/bundled/extension-maker from mercury-skills/extension-maker; ' + bundledOut.trim().slice(0, 300))

const description = /description:\s*(.+)/.exec(skillSource)?.[1] ?? ''
check('the skill carries a non-empty description', description.trim().length > 20, 'give mercury-skills/extension-maker/SKILL.md a description: line of more than 20 characters; read: ' + description)
const J = (...parts: string[]): string => parts.join('')
check('the skill speaks no retired word', !new RegExp(J('plug', 'in'), 'i').test(skillSource) && !new RegExp(J('market', 'place'), 'i').test(skillSource), 'remove the retired word from mercury-skills/extension-maker/SKILL.md')
check('the skill states the two operator-act rules', /never add a source/i.test(skillSource) && /never approve/i.test(skillSource), 'mercury-skills/extension-maker/SKILL.md must say the agent never adds a source and never approves an extension')

{
  const { contributionsHash } = await import('../../src/integrations/extensions/manifest.ts')
  const { MANIFEST_FILE } = await import('../../src/integrations/extensions/paths.ts')
  const root = mkdtempSync(join(tmpdir(), 'contract-hash-'))
  try {
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    const manifest = { contributes: { skills: ['skills'] }, needs: {} }
    put(MANIFEST_FILE, JSON.stringify({ name: 'fixture', version: '1.0.0', ...manifest }))
    put('skills/fixture/SKILL.md', '---\ndescription: a fixture skill\n---\nbody\n')
    const approved = contributionsHash(manifest, root)
    put(MANIFEST_FILE, JSON.stringify({ name: 'fixture', version: '1.0.1', ...manifest }))
    check('a version bump alone (root manifest bytes) carries the approval over — the hash is unchanged', contributionsHash(manifest, root) === approved)
    put('skills/fixture/SKILL.md', '---\ndescription: a fixture skill\n---\nbody, changed\n')
    const afterBytes = contributionsHash(manifest, root)
    check('a changed delivered byte re-asks — the hash changes', afterBytes !== approved)
    put('skills/fixture/SKILL.md', '---\ndescription: a fixture skill\n---\nbody\n')
    check('restoring the byte restores the hash (the digest is over content, not mtime)', contributionsHash(manifest, root) === approved)
    put(`skills/fixture/${MANIFEST_FILE}`, '{}')
    check('only the ROOT manifest is excepted — a same-named file deeper in the tree is delivered content', contributionsHash(manifest, root) !== approved)
    rmSync(join(root, 'skills', 'fixture', MANIFEST_FILE))
    check('a changed need re-asks — the canonical blocks are in the hash too', contributionsHash({ ...manifest, needs: { ...manifest.needs, tools: ['Bash'] } } as never, root) !== approved)
  } finally {
    removeScratch(root)
  }
}

console.log(failures === 0 ? '\n ✅ CONTRACT IN SYNC — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
