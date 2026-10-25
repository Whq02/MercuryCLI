#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const README = join(ROOT, 'README.md')
const LINE = /^Mercury CLI is designed, built and maintained by \*\*Waleed Al Qusous\*\* as its sole developer: seven months from the first line to this release, (\d+) public releases, ([\d,]+) lines of TypeScript and ([\d,]+) proofs, built with the AI agents it now runs\./m

function walk(dir, keep) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path, keep))
    else if (keep(name)) out.push(path)
  }
  return out
}

function authorFacts(root = ROOT) {
  const releases = readdirSync(join(root, 'docs', 'releases'))
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .filter(name => /^# .* — published \d{4}-\d{2}-\d{2}/.test(readFileSync(join(root, 'docs', 'releases', name), 'utf8').split('\n')[0] ?? '')).length
  const sourceLines = walk(join(root, 'src'), name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .reduce((sum, path) => sum + readFileSync(path, 'utf8').split('\n').length - 1, 0)
  const proofs = walk(join(root, 'scripts'), name => /^prove-.*\.tsx?$/.test(name)).length
  return { releases, sourceLines: Math.round(sourceLines / 1000) * 1000, proofs: Math.floor(proofs / 100) * 100 }
}

export function authorLine(facts) {
  const n = value => value.toLocaleString('en-US')
  return `Mercury CLI is designed, built and maintained by **Waleed Al Qusous** as its sole developer: seven months from the first line to this release, ${facts.releases} public releases, ${n(facts.sourceLines)} lines of TypeScript and ${n(facts.proofs)} proofs, built with the AI agents it now runs.`
}

export function readmeAuthorState(root = ROOT) {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const match = LINE.exec(readme)
  const facts = authorFacts(root)
  const stated = match ? { releases: Number(match[1]), sourceLines: Number(match[2].replace(/,/g, '')), proofs: Number(match[3].replace(/,/g, '')) } : null
  return { present: match !== null, stated, facts, current: stated !== null && stated.releases === facts.releases && stated.sourceLines === facts.sourceLines && stated.proofs === facts.proofs }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] ?? 'check'
  const state = readmeAuthorState()
  if (mode === 'write') {
    if (!state.present) { console.error('README.md carries no Author line to rewrite'); process.exit(2) }
    const readme = readFileSync(README, 'utf8')
    writeFileSync(README, readme.replace(LINE, authorLine(state.facts)))
    console.log(`README author line: ${state.facts.releases} releases · ${state.facts.sourceLines.toLocaleString('en-US')} lines · ${state.facts.proofs.toLocaleString('en-US')} proofs`)
    process.exit(0)
  }
  console.log(`${state.current ? 'current' : 'STALE'} — README says ${JSON.stringify(state.stated)}; the tree says ${JSON.stringify(state.facts)}`)
  process.exit(state.current ? 0 : 1)
}
