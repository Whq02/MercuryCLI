import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dir, '../..')
try {
  const entry = join(proofHome, 'skill-entry.ts')
  writeFileSync(entry, `export { registerResearchSkill } from ${JSON.stringify(join(root, 'src/skills/bundled/research.ts'))}\nexport { getBundledSkills } from ${JSON.stringify(join(root, 'src/skills/bundledSkills.ts'))}\n`)
  const built = await Bun.build({ entrypoints: [entry], outdir: join(proofHome, 'out'), target: 'bun', format: 'esm', loader: { '.md': 'text' }, define: { 'MACRO.VERSION': '"1.0.0"', 'process.env.NODE_ENV': '"test"' } })
  assert.equal(built.success, true, built.logs.map(String).join('\n'))
  const registry = await import(pathToFileURL(join(proofHome, 'out/skill-entry.js')).href)
  registry.registerResearchSkill()
  const skill = registry.getBundledSkills().find((s: any) => s.name === 'research')
  assert.equal(skill.type, 'prompt')
  assert.equal(skill.loadedFrom, 'bundled')
  assert.equal(skill.userInvocable, false)
  assert.equal(skill.disableModelInvocation, false)
  assert.equal(skill.argumentHint, '[question or corpus]')
  assert.match(skill.description, /^Use when researching papers or a document corpus/)
  assert.match(skill.description, /Not for a quick factual lookup or editing application code/)
  const positive = 'Compare these papers and produce a cited DOCX and PDF report'
  const negative = 'Fix the login form'
  const expanded = (await skill.getPromptForCommand(positive, {})).map((b: any) => b.text ?? '').join('')
  assert.ok(expanded.endsWith(`\n\n${positive}`))
  assert.ok(expanded.includes(`“${negative}” does not`))
  for (const phrase of ['exact page', 'printed page label', 'OCR', 'Document inspect', 'Document create', 'Document cite', 'only when live Crossref resolution is wanted', 'Keep source files unchanged']) assert.ok(expanded.includes(phrase), phrase)
  assert.equal(readFileSync(join(root, 'mercury-skills/research/SKILL.md'), 'utf8'), readFileSync(join(root, 'src/skills/bundled/research/SKILL.md'), 'utf8'))
  console.log('PASS research: real generated loader, model-only discovery, arguments appended, positive request expanded and negative example excluded by the loaded guidance; no live classifier call')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
