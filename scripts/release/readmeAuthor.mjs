#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const README = join(ROOT, 'README.md')
const LINE = /^Mercury CLI is designed, built and maintained by \*\*Waleed Al Qusous\*\* as its sole developer: seven months from the first line to this release, (\d+) public releases\./m

function authorFacts(root = ROOT) {
  const releases = readdirSync(join(root, 'docs', 'releases'))
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .filter(name => /^# .* — published \d{4}-\d{2}-\d{2}/.test(readFileSync(join(root, 'docs', 'releases', name), 'utf8').split('\n')[0] ?? '')).length
  return { releases }
}

export function authorLine(facts) {
  return `Mercury CLI is designed, built and maintained by **Waleed Al Qusous** as its sole developer: seven months from the first line to this release, ${facts.releases} public releases.`
}

export function readmeAuthorState(root = ROOT) {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const match = LINE.exec(readme)
  const facts = authorFacts(root)
  const stated = match ? { releases: Number(match[1]) } : null
  return { present: match !== null, stated, facts, current: stated !== null && stated.releases === facts.releases }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] ?? 'check'
  const state = readmeAuthorState()
  if (mode === 'write') {
    if (!state.present) { console.error('README.md carries no Author line to rewrite'); process.exit(2) }
    const readme = readFileSync(README, 'utf8')
    writeFileSync(README, readme.replace(LINE, authorLine(state.facts)))
    console.log(`README author line: ${state.facts.releases} releases`)
    process.exit(0)
  }
  console.log(`${state.current ? 'current' : 'STALE'} — README says ${JSON.stringify(state.stated)}; the tree says ${JSON.stringify(state.facts)}`)
  process.exit(state.current ? 0 : 1)
}
