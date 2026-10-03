#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
{
  const contract = readFileSync(join(ROOT, 'docs', 'EXTENSIONS.md'), 'utf8')
  const contributesRow = contract.split('\n').find(line => line.startsWith('| `contributes` |')) ?? ''
  check('the contributes row says which kinds keep the operator\'s own shape and that commands are the extension\'s own, as the page\'s paragraph does', /Skills, agents, hooks and servers keep the shape the operator places by hand/.test(contributesRow) && /commands are the extension's own/.test(contributesRow) && !/Every kind mirrors/.test(contributesRow), contributesRow.slice(0, 200))
}
check('the skill states the two operator-act rules', /never add a source/i.test(skillSource) && /never approve/i.test(skillSource))

{
  const { contributionsHash } = await import('../../src/extensions/manifest.ts')
  const { MANIFEST_FILE } = await import('../../src/extensions/paths.ts')
  const contract = readFileSync(join(ROOT, 'docs', 'EXTENSIONS.md'), 'utf8')
  const sentence = contract.split('\n').find(line => line.startsWith('- approval is per contributions hash')) ?? ''
  check('the approval sentence names the delivered-file digest and the root-manifest exception', /every delivered file/.test(sentence) && sentence.includes(`root \`${MANIFEST_FILE}\` itself excepted`) && /changed delivered byte re-asks/.test(sentence), sentence.slice(0, 200))
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
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\n ✅ CONTRACT IN SYNC — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
