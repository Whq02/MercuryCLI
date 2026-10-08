import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'provider-road-skill-'))
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
try {
  const entry = join(scratch, 'entry.ts')
  writeFileSync(entry, `export { registerProviderApisSkill } from ${JSON.stringify(join(root, 'src/skills/bundled/provider-apis.ts'))}\nexport { getBundledSkills, getBundledSkillExtractDir } from ${JSON.stringify(join(root, 'src/skills/bundledSkills.ts'))}\n`)
  const built = await Bun.build({ entrypoints: [entry], outdir: join(scratch, 'out'), target: 'bun', format: 'esm', loader: { '.md': 'text' }, define: { 'MACRO.VERSION': JSON.stringify('1.0.0'), 'process.env.NODE_ENV': JSON.stringify('test') } })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  const registry = await import(pathToFileURL(join(scratch, 'out/entry.js')).href)
  registry.registerProviderApisSkill()
  const command = registry.getBundledSkills().find((item: { name: string }) => item.name === 'provider-apis')
  check('the real generated wrapper registers provider-apis', command?.type === 'prompt')
  check('discovery names provider engineering first and excludes sign-in', command.description.startsWith('Use when building or changing a Mercury model-provider road') && command.description.includes('Not for account sign-in'))
  check('the optional argument hint permits a bare invocation', command.argumentHint === '[provider road or task]')
  const positive = "fix encrypted reasoning replay on Mercury's OpenRouter road"
  const negative = 'How do I sign in to an account?'
  const blocks = await command.getPromptForCommand(positive, {} as never)
  const text = blocks.map((block: { text?: string }) => block.text ?? '').join('')
  const base = registry.getBundledSkillExtractDir('provider-apis')
  check('the positive example loads the body with arguments appended', text.includes('# Provider APIs') && text.endsWith(`\n\n${positive}`))
  check('the negative example is explicitly routed away in the loaded guidance', text.includes(`“${negative}” does not`) && text.includes('`/logins` or `/accounts`'))
  check('the loader supplies a real extracted reference base', text.startsWith(`Base directory for this skill: ${base} `) && existsSync(base))
  const refs = readdirSync(join(root, 'mercury-skills/provider-apis/references')).sort()
  for (const ref of refs) {
    const source = readFileSync(join(root, 'mercury-skills/provider-apis/references', ref), 'utf8')
    check(`the loader extracts ${ref} byte-identically`, readFileSync(join(base, 'references', ref), 'utf8') === source)
    for (const [, target] of source.matchAll(/`((?:src|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|sh|mjs))`/g)) check(`${ref}: checkout owner exists ${target}`, existsSync(join(root, target!)))
    if (ref === 'chat-completions.md') {
      for (const [, target] of source.matchAll(/`((?!(?:scripts|src)\/)[A-Za-z0-9_./-]+\.ts)`/g)) check(`shared-family owner exists ${target}`, existsSync(join(root, 'src/services/providers', target!)))
    }
  }
  for (const [, target] of text.matchAll(/`((?:src|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|sh|mjs))`/g)) check(`body checkout owner exists ${target}`, existsSync(join(root, target!)))
  check('the provider decides and Retry-After precedes a plan-window reading', text.includes('The provider decides on usage.') && text.includes('never a door that prevents sending') && text.includes('explicit `Retry-After` first') && text.includes('response body identifies that window'))
  check('the meter rule requires management and billing research', text.includes('Every family must show a meter.') && text.includes('management, billing and admin APIs'))
  check('the proof guidance requires fixture isolation and operator consent for live calls', text.includes('scratch home') && text.includes("live model call needs the operator's explicit authorisation"))
  console.log('Routing evidence: positive invocation expanded through the real loader; negative example checked against its loaded discovery guidance, not a live model classifier.')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} provider-road-skill: ${failures} failures`)
process.exit(failures ? 1 : 0)
