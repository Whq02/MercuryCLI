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
  writeFileSync(entry, `export { registerProviderApisSkill } from ${JSON.stringify(join(root, 'src/integrations/skills/bundled/provider-apis.ts'))}\nexport { getBundledSkills, getBundledSkillExtractDir } from ${JSON.stringify(join(root, 'src/integrations/skills/bundledSkills.ts'))}\nexport { classifyModelRoute, PROVIDER_ID_SPACES } from ${JSON.stringify(join(root, 'src/models/roads/idSpaces.ts'))}\nexport { MISTRAL_DISPLAY_PINS } from ${JSON.stringify(join(root, 'src/models/facts/pins/mistralPins.ts'))}\nexport { buildMistralExtras } from ${JSON.stringify(join(root, 'src/models/roads/mistral/mistralCallModel.ts'))}\n`)
  const built = await Bun.build({ entrypoints: [entry], outdir: join(scratch, 'out'), target: 'bun', format: 'esm', loader: { '.md': 'text' }, define: { 'MACRO.VERSION': JSON.stringify('1.0.0'), 'process.env.NODE_ENV': JSON.stringify('test') } })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  const registry = await import(pathToFileURL(join(scratch, 'out/entry.js')).href)
  registry.registerProviderApisSkill()
  const command = registry.getBundledSkills().find((item: { name: string }) => item.name === 'provider-apis')
  check('the real generated wrapper registers provider-apis', command?.type === 'prompt', 'registerProviderApisSkill in src/integrations/skills/bundled/provider-apis.ts must register a prompt skill named provider-apis')
  check('discovery names provider engineering first and excludes sign-in', command.description.startsWith('Use when building or changing a Mercury model-provider road') && command.description.includes('Not for account sign-in'), 'fix the description in src/integrations/skills/bundled/provider-apis.ts or the skill frontmatter under mercury-skills/provider-apis: start with Use when building or changing a Mercury model-provider road and say Not for account sign-in')
  check('the optional argument hint permits a bare invocation', command.argumentHint === '[provider road or task]', 'set the argument hint in src/integrations/skills/bundled/provider-apis.ts to [provider road or task]')
  const positive = "fix encrypted reasoning replay on Mercury's OpenRouter road"
  const negative = 'How do I sign in to an account?'
  const blocks = await command.getPromptForCommand(positive, {} as never)
  const text = blocks.map((block: { text?: string }) => block.text ?? '').join('')
  const base = registry.getBundledSkillExtractDir('provider-apis')
  check('the positive example loads the body with arguments appended', text.includes('# Provider APIs') && text.endsWith(`\n\n${positive}`), 'the prompt built by getPromptForCommand in src/integrations/skills/bundled/provider-apis.ts must carry the skill body and end with the arguments after a blank line')
  check('discovery excludes sign-in, UI selection and unrelated SDKs', command.description.includes('Not for account sign-in, choosing a model in the UI or unrelated SDKs.'), 'the description in src/integrations/skills/bundled/provider-apis.ts must end its exclusions with Not for account sign-in, choosing a model in the UI or unrelated SDKs.')
  const negativeBlocks = await command.getPromptForCommand(negative, {} as never)
  check('explicit invocation preserves the argument even when automatic discovery excludes it', negativeBlocks.map((block: { text?: string }) => block.text ?? '').join('').endsWith(`\n\n${negative}`), 'getPromptForCommand in src/integrations/skills/bundled/provider-apis.ts must append the arguments unchanged whatever the description excludes')
  check('the loader supplies a real extracted reference base', text.startsWith(`Base directory for this skill: ${base} `) && existsSync(base), 'getBundledSkillExtractDir in src/integrations/skills/bundledSkills.ts must return an extracted directory, and the prompt must begin with Base directory for this skill: followed by it')
  const refs = readdirSync(join(root, 'mercury-skills/provider-apis/references')).sort()
  for (const ref of refs) {
    const source = readFileSync(join(root, 'mercury-skills/provider-apis/references', ref), 'utf8')
    check(`the loader extracts ${ref} byte-identically`, readFileSync(join(base, 'references', ref), 'utf8') === source, `the extract of provider-apis in src/integrations/skills/bundledSkills.ts must copy mercury-skills/provider-apis/references/${ref} unchanged`)
  }
  check('the provider decides and Retry-After precedes a plan-window reading', text.includes('The provider decides on usage.') && text.includes('never a door that prevents sending') && text.includes('explicit `Retry-After` first') && text.includes('response body identifies that window'), 'restore the retry and plan-window guidance in mercury-skills/provider-apis (the skill body and its references)')
  check('the meter rule requires management and billing research', text.includes('Every family must show a meter.') && text.includes('management, billing and admin APIs'), 'restore the meter rule in the skill body under mercury-skills/provider-apis')
  check('the proof guidance requires fixture isolation and operator consent for live calls', text.includes('scratch home') && text.includes("live model call needs the operator's explicit authorisation"), 'restore the fixture isolation and live-call consent guidance in the skill body under mercury-skills/provider-apis')
  const models = readFileSync(join(base, 'references/models.md'), 'utf8')
  const sources = readFileSync(join(base, 'references/live-sources.md'), 'utf8')
  const chat = readFileSync(join(base, 'references/chat-completions.md'), 'utf8')
  check('routing guidance names classifier and pins rather than copying a bare-prefix inventory', models.includes('src/models/roads/idSpaces.ts') && !text.includes('Bare `gpt-`') && !models.includes('(`moonshot`, `deepseek`'), 'mercury-skills/provider-apis/references/models.md must name src/models/roads/idSpaces.ts and carry no copied bare-prefix list')
  check('the release-clock appendix points to its owner without a copied assignment', sources.includes('src/models/sign-in/oauth/oauth.ts') && sources.includes('ANTHROPIC_CLIENT_CONTRACT_VERSION') && !/ANTHROPIC_CLIENT_CONTRACT_(?:VERSION|AS_OF)\s*=/.test(sources), 'mercury-skills/provider-apis/references/live-sources.md must point to src/models/sign-in/oauth/oauth.ts and not copy the constant assignment')
  check('chat guidance is an on-demand index, not the all-family wire table', chat.includes('chat-native.md') && chat.includes('chat-hosted.md') && chat.includes('chat-local.md') && !chat.includes('| Dispatch and wire |'), 'mercury-skills/provider-apis/references/chat-completions.md must index chat-native.md, chat-hosted.md and chat-local.md and not hold the all-family wire table')
  for (const ref of refs) check(`entry makes ${ref} directly discoverable`, text.includes(`references/${ref}`), `the skill body under mercury-skills/provider-apis must mention references/${ref}`)
  for (const space of registry.PROVIDER_ID_SPACES) {
    for (const id of space.bareModelIds ?? []) check(`exact pin ${id} keeps ${space.route} ahead of prefixes`, registry.classifyModelRoute(id, {}).route === space.route, 'fix classifyModelRoute or PROVIDER_ID_SPACES in src/models/roads/idSpaces.ts')
    for (const prefix of space.barePrefixes ?? []) check(`declared prefix ${prefix} resolves through the classifier`, registry.classifyModelRoute(`${prefix}skill-fixture`, {}).route === space.route, 'fix classifyModelRoute or PROVIDER_ID_SPACES in src/models/roads/idSpaces.ts')
    if (space.qualifiedPrefix) check(`carrier ${space.qualifiedPrefix} wins over a native-looking inner id`, registry.classifyModelRoute(`${space.qualifiedPrefix}deepseek-skill-fixture`, {}).route === space.route, 'fix classifyModelRoute or PROVIDER_ID_SPACES in src/models/roads/idSpaces.ts')
  }
  check('unknown ids do not fall through to Anthropic', registry.classifyModelRoute('skill-fixture-unknown', {}).kind === 'unrecognised', 'classifyModelRoute in src/models/roads/idSpaces.ts must return kind unrecognised for an unknown id')
  for (const pin of registry.MISTRAL_DISPLAY_PINS) {
    const args = { wireModel: pin.id, effortValue: undefined, thinkingEnabled: false, maxOutputTokensOverride: undefined }
    const off = registry.buildMistralExtras(args)
    const expected = pin.reasoning && pin.efforts.length ? pin.efforts.includes('none') ? 'none' : pin.efforts[0] : undefined
    check(`${pin.id}: thinking off follows model facts, not a universal none`, off.reasoning_effort === expected, `buildMistralExtras in src/models/roads/mistral/mistralCallModel.ts returned ${String(off.reasoning_effort)}, expected ${String(expected)} from the pin in src/models/facts/pins/mistralPins.ts`)
    for (const effort of pin.efforts) check(`${pin.id}: selected ${effort} survives request assembly`, registry.buildMistralExtras({ ...args, thinkingEnabled: true, effortValue: effort }).reasoning_effort === effort, 'buildMistralExtras in src/models/roads/mistral/mistralCallModel.ts must pass the selected effort through as reasoning_effort')
  }
  console.log('Routing evidence: real loader expansion, discovery exclusions and classifier/request-builder fixtures; not a live model routing or provider-conformance evaluation.')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} provider-road-skill: ${failures} failures`)
process.exit(failures ? 1 : 0)
