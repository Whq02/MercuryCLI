#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'bare-family-words-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.MERCURY_XAI_API_BASE = 'http://127.0.0.1:1/xai/v1'
process.env.MERCURY_DEEPSEEK_API_BASE = 'http://127.0.0.1:1/deepseek'
process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/moonshot/v1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const chatBodies: Array<Record<string, unknown>> = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled === 'http://127.0.0.1:1/moonshot/v1/chat/completions') {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    chatBodies.push(body)
    const model = String(body.model ?? '')
    return new Response(
      sse({ id: 'chatcmpl-words', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'the wire answered' } }] }) +
        sse({ id: 'chatcmpl-words', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3 } }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch

console.log('============================================================')
console.log(' the bare family words: one resolver, two roads, one row')
console.log('============================================================')

;(await import('../../src/utils/config.ts')).enableConfigs()
const table = await import('../../src/utils/model/bareFamilyWords.ts').catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
check('the shared bare-family-word table exists (src/utils/model/bareFamilyWords.ts)', typeof table !== 'string', typeof table === 'string' ? table : '')
if (typeof table === 'string') {
  rmSync(scratch, { recursive: true, force: true })
  console.log('\n1 FAIL')
  process.exit(1)
}
const words = table
const { PROVIDER_ID_SPACES } = await import('../../src/services/providers/idSpaces.ts')
const model = await import('../../src/utils/model/model.ts')
const agent = await import('../../src/utils/model/agent.ts')
const engine = await import('../../src/utils/swarm/engineDispatch.ts')
const { keyLanePins, getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
const discovery = await import('../../src/utils/router/providerDiscovery.ts')
const xai = await import('../../src/services/providers/xai/xaiCatalogue.ts')
const deepseek = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')
const moonshot = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const { moonshotCallModel } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { GLM_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/zai.ts')
const { DEEPSEEK_DISPLAY_PINS } = await import('../../src/services/providers/deepseek/deepseekPins.ts')
const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { validateModel } = await import('../../src/utils/model/validateModel.ts')
const picker = await import('../../src/commands/model/mercuryModel.tsx')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type Road = { model?: string; backend?: string; displayLabel?: string; threw?: string }
const agentRoad = (word: string): Promise<Road> =>
  engine.resolveEngineDispatch(word).then(
    r => ({ ...(r ? { model: r.model, backend: r.backend, displayLabel: r.displayLabel } : {}) }),
    e => ({ threw: e instanceof Error ? e.message : String(e) }),
  )
const show = (v: unknown): string => JSON.stringify(v) ?? String(v)
const page = (data: unknown[], status = 200): typeof fetch => (async () => Response.json({ object: 'list', data }, { status })) as typeof fetch
const KEY_LANES = new Set(['zai', 'moonshot', 'deepseek', 'xai'])
const TABLE = words.BARE_FAMILY_WORDS
const wordOf = (route: string): string => TABLE.find(entry => entry.route === route)!.word

section('§1 the table: every declared bare class alias of a key lane, each on its own route, one grammar word each')
{
  check('the table carries glm, kimi, deepseek and grok', [...TABLE.map(entry => entry.word)].sort().join(',') === 'deepseek,glm,grok,kimi', TABLE.map(entry => entry.word).join(','))
  for (const entry of TABLE) {
    const space = PROVIDER_ID_SPACES.find(s => s.route === entry.route)
    check(`'${entry.word}' is the declared bare alias of the ${entry.route} id space`, space?.bareAliases?.includes(entry.word) === true, show(space))
    check(`'${entry.word}' is an Agent-tool class alias the grammar accepts`, engine.isEngineDispatchModel(entry.word) && engine.unrecognisedModelWordRefusal(entry.word) === null)
  }
  for (const space of PROVIDER_ID_SPACES.filter(s => KEY_LANES.has(s.route))) {
    for (const alias of space.bareAliases ?? []) {
      check(`the ${space.route} alias '${alias}' has a resolver in the table`, words.bareFamilyWordOf(alias)?.route === space.route, show(words.bareFamilyWordOf(alias)))
    }
  }
  check('the lookup trims and lowercases, and answers nothing for a word the table does not carry', words.bareFamilyWordOf(' Kimi ')?.word === 'kimi' && words.isBareFamilyWord('GROK') && words.bareFamilyWordOf('gpt') === undefined && words.resolveBareFamilyWord('gemini') === undefined && words.resolveBareFamilyWord('opus') === undefined)
}

section('§2 a keyless box: the session road answers each family\'s first recorded row, the bare word where no row is known')
{
  const expected: Record<string, string> = {
    glm: GLM_STATIC_CATALOGUE[0]!.id,
    kimi: KIMI_DISPLAY_PINS[0]!.id,
    deepseek: DEEPSEEK_DISPLAY_PINS[0]!.id,
    grok: 'grok',
  }
  check('the recorded heads are the pins this proof names', expected.glm === 'glm-5.3' && expected.kimi === 'kimi-k3' && expected.deepseek === 'deepseek-v4-pro', show(expected))
  for (const entry of TABLE) {
    const session = model.parseUserSpecifiedModel(entry.word)
    const head = keyLanePins(entry.route as 'zai')[0]?.id
    check(`'${entry.word}' resolves to ${expected[entry.word]} on the session road`, session === expected[entry.word], session)
    check(`  …which is the family's first catalogue row (keyLanePins[0]) or the bare word when the lane lists none`, session === (head ?? entry.word), `${session} vs ${String(head)}`)
    check(`  …the shared resolver says the same`, words.resolveBareFamilyWord(entry.word) === session)
    check(`  …case and whitespace fold, and a [1m] rider re-attaches exactly as grok's does`, model.parseUserSpecifiedModel(` ${entry.word.toUpperCase()} `) === session && model.parseUserSpecifiedModel(`${entry.word}[1m]`) === `${session}[1m]`, model.parseUserSpecifiedModel(`${entry.word}[1m]`))
    const road = await agentRoad(entry.word)
    check(`  …the agent road refuses keyless naming the ${entry.route} provider, never a stand-in`, road.threw !== undefined && road.threw.includes(`Engine provider ${entry.route} is unavailable`), show(road))
  }
  for (const word of ['glm', 'kimi', 'deepseek']) {
    const head = expected[word]!
    check(`'${word}': /model's confirmation names the row (renderDefaultModelSetting)`, model.renderDefaultModelSetting(word) === model.renderModelName(head), model.renderDefaultModelSetting(word))
    check(`'${word}': the status line reads the word and its row (modelDisplayString)`, model.modelDisplayString(word) === `${word} (${model.renderModelName(head)})`, model.modelDisplayString(word))
    check(`'${word}': renderModelSetting keeps the word, as it keeps grok`, model.renderModelSetting(word) === word && model.renderModelSetting('grok') === 'grok', model.renderModelSetting(word))
    check(`'${word}': the picker door maps the word onto the row's own option`, picker.modelChoiceRow(word) === head, picker.modelChoiceRow(word))
    check(`'${word}': a sub-agent named the word runs the row`, agent.getAgentModel(undefined, 'claude-opus-5', word) === head && agent.getAgentModel(word, 'claude-opus-5') === head, agent.getAgentModel(undefined, 'claude-opus-5', word))
    process.env.MERCURY_MODEL = word
    check(`'${word}': MERCURY_MODEL on the word is the main-loop model on the row, and the picker lists that row for its current mark`, model.getMainLoopModel() === head && getModelOptions().some(option => option.value === head), model.getMainLoopModel())
    delete process.env.MERCURY_MODEL
  }
}

section('§3 the two roads agree row for row, credentialed, over fixture lists')
{
  process.env.ZAI_API_KEY = 'zai-fixture-key'
  discovery.__resetProviderDiscoveryForTest()
  const glm = await agentRoad('glm')
  check("'glm' ⇒ the Z.AI catalogue's first row on both roads, with its display label", glm.backend === 'zai' && glm.model === GLM_STATIC_CATALOGUE[0]!.id && glm.displayLabel === GLM_STATIC_CATALOGUE[0]!.displayLabel && model.parseUserSpecifiedModel('glm') === glm.model, show(glm))
  const glmValid = await validateModel('glm')
  check("'glm' validates at the typing door with the key present", glmValid.valid === true, show(glmValid))

  process.env.DEEPSEEK_API_KEY = 'deepseek-fixture-key'
  discovery.__resetProviderDiscoveryForTest()
  deepseek.__resetDeepseekCatalogueForTest()
  await deepseek.refreshDeepseekCatalogue({ force: true, fetchImpl: page([{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }, { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }, { id: 'deepseek-fixture-next', object: 'model', owned_by: 'deepseek' }]) })
  check('the DeepSeek live list leads with the recorded rows in pin order, the unrecorded id after', deepseek.deepseekCatalogueRows().rows.map(row => row.id).join(',') === 'deepseek-v4-pro,deepseek-flash,deepseek-fixture-next', deepseek.deepseekCatalogueRows().rows.map(row => row.id).join(','))
  let ds = await agentRoad('deepseek')
  check("'deepseek' ⇒ deepseek-v4-pro on both roads, labelled DeepSeek V4 Pro", ds.backend === 'deepseek' && ds.model === 'deepseek-v4-pro' && ds.displayLabel === 'DeepSeek V4 Pro' && model.parseUserSpecifiedModel('deepseek') === ds.model, show(ds))
  await deepseek.refreshDeepseekCatalogue({ force: true, fetchImpl: page([{ id: 'deepseek-fixture-next', object: 'model', owned_by: 'deepseek' }]) })
  ds = await agentRoad('deepseek')
  check("a list of one unrecorded id: 'deepseek' ⇒ that id on both roads", ds.model === 'deepseek-fixture-next' && model.parseUserSpecifiedModel('deepseek') === 'deepseek-fixture-next' && keyLanePins('deepseek')[0]?.id === 'deepseek-fixture-next', show(ds))
  deepseek.__resetDeepseekCatalogueForTest()
  ds = await agentRoad('deepseek')
  check("with no list read the recorded rows stand in: 'deepseek' ⇒ deepseek-v4-pro on both roads", ds.model === 'deepseek-v4-pro' && model.parseUserSpecifiedModel('deepseek') === 'deepseek-v4-pro', show(ds))
  const dsValid = await validateModel('deepseek')
  check("'deepseek' validates at the typing door with the key present", dsValid.valid === true, show(dsValid))

  process.env.XAI_API_KEY = 'xai-fixture-key'
  discovery.__resetProviderDiscoveryForTest()
  xai.__resetXaiCatalogueForTest()
  await xai.refreshXaiCatalogue({ force: true, fetchImpl: page([{ id: 'grok-4.3', created: 1 }, { id: 'grok-fixture-new', created: 3 }, { id: 'grok-4.7', created: 2 }]) })
  let grok = await agentRoad('grok')
  check("'grok' ⇒ the newest live Grok row on both roads", grok.backend === 'xai' && grok.model === 'grok-fixture-new' && model.parseUserSpecifiedModel('grok') === 'grok-fixture-new', show(grok))
  await xai.refreshXaiCatalogue({ force: true, fetchImpl: page([]) })
  grok = await agentRoad('grok')
  check("a live empty list: the session road keeps the word 'grok' and the agent road refuses, no row invented", model.parseUserSpecifiedModel('grok') === 'grok' && grok.threw?.includes('no catalogue entry') === true, show(grok))

  process.env.MOONSHOT_API_KEY = 'moonshot-fixture-key'
  discovery.__resetProviderDiscoveryForTest()
  moonshot.__resetMoonshotCatalogueForTest()
  const planList = [
    { id: 'kimi-for-coding-highspeed', object: 'model', created: 400, owned_by: 'moonshot' },
    { id: 'kimi-for-coding', object: 'model', created: 300, owned_by: 'moonshot' },
    { id: 'k3-256k', object: 'model', created: 200, owned_by: 'moonshot' },
    { id: 'k3', object: 'model', created: 100, owned_by: 'moonshot' },
  ]
  await moonshot.refreshMoonshotCatalogue({ force: true, fetchImpl: page(planList) })
  check('the Moonshot list leads with the plan head k3 although its stamp is the oldest', moonshot.moonshotCatalogueRows().rows.map(row => row.id).join(',') === 'k3,k3-256k,kimi-for-coding,kimi-for-coding-highspeed', moonshot.moonshotCatalogueRows().rows.map(row => row.id).join(','))
  let kimi = await agentRoad('kimi')
  check("'kimi' ⇒ k3 on both roads, labelled K3", kimi.backend === 'moonshot' && kimi.model === 'k3' && kimi.displayLabel === 'K3' && model.parseUserSpecifiedModel('kimi') === 'k3', show(kimi))
  const qualified = await moonshot.qualifyMoonshotModel('kimi')
  check("the Moonshot qualifier resolves the bare word to the head row (the typing door and the wire read it)", qualified.kind === 'ok' && qualified.modelId === 'k3', show(qualified))
  const kimiValid = await validateModel('kimi')
  check("'kimi' validates at the typing door once the list serves a row", kimiValid.valid === true, show(kimiValid))
  chatBodies.length = 0
  const settled: Array<{ api: boolean; text: string }> = []
  for await (const item of moonshotCallModel({
    messages: [createUserMessage({ content: 'say hi' })],
    systemPrompt: ['fixture system prompt'],
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: 'kimi', isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' },
  } as never)) {
    if ((item as { type?: string }).type !== 'assistant') continue
    const message = item as { isApiErrorMessage?: boolean; message: { content: Array<{ type: string; text?: string }> } }
    settled.push({ api: message.isApiErrorMessage === true, text: message.message.content.map(block => block.text ?? '').join('') })
  }
  check("a turn handed the bare word 'kimi' puts k3 on the wire and settles clean", chatBodies.length === 1 && chatBodies[0]?.model === 'k3' && settled.some(item => item.text === 'the wire answered') && settled.every(item => !item.api), show({ bodies: chatBodies.map(body => body.model), settled }))
  await moonshot.refreshMoonshotCatalogue({ force: true, fetchImpl: page(planList.slice(0, 2)) })
  kimi = await agentRoad('kimi')
  check("a list without k3: 'kimi' ⇒ the base alias kimi-for-coding on both roads", kimi.model === 'kimi-for-coding' && model.parseUserSpecifiedModel('kimi') === 'kimi-for-coding', show(kimi))
  moonshot.__resetMoonshotCatalogueForTest()
  await moonshot.refreshMoonshotCatalogue({ force: true, fetchImpl: page([], 503) })
  kimi = await agentRoad('kimi')
  check("an unread list: the session road keeps the word 'kimi' and the agent road names the account and the reason", model.parseUserSpecifiedModel('kimi') === 'kimi' && kimi.threw === "The 'kimi' class cannot resolve — the MOONSHOT_API_KEY (env)'s model list has not been read (Moonshot models endpoint returned HTTP 503). Name an exact kimi-… id the account serves, or retry when the list lands.", show(kimi))
  const unread = await moonshot.qualifyMoonshotModel('kimi')
  check('the qualifier refuses the bare word typed while the list serves no row, naming the account and the error', unread.kind === 'refused' && unread.message.includes("Moonshot cannot resolve 'kimi'") && unread.message.includes('MOONSHOT_API_KEY (env)') && unread.message.includes('HTTP 503'), show(unread))
  const kimiRefused = await validateModel('kimi')
  check("'kimi' typed at /model is refused with those words, never saved as a bare word the wire cannot serve", kimiRefused.valid === false && (kimiRefused.error ?? '').includes("Moonshot cannot resolve 'kimi'"), show(kimiRefused))
  for (const key of ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY']) delete process.env[key]
  discovery.__resetProviderDiscoveryForTest()
  moonshot.__resetMoonshotCatalogueForTest()
  xai.__resetXaiCatalogueForTest()
}

section('§4 one resolver by construction: neither road spells a family word of its own')
{
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8')
  const dispatch = src('utils/swarm/engineDispatch.ts')
  check('the agent road resolves the words through the shared table', dispatch.includes('bareFamilyWordOf(modelParam)') && dispatch.includes('familyWord.headRow()') && !/modelParam === '(glm|kimi|deepseek|grok)'/.test(dispatch))
  const session = src('utils/model/model.ts')
  check('the session road resolves the words through the shared table', session.includes('resolveBareFamilyWord(lowered)') && !session.includes("case 'grok'") && !session.includes('xaiCatalogueRows'))
  const table = src('utils/model/bareFamilyWords.ts')
  check('the table reads each family through its own catalogue owner, required at call time', table.includes("require('../../services/providers/xai/xaiCatalogue.js')") && table.includes("require('../../services/providers/moonshot/moonshotCatalogue.js')") && table.includes("require('../../services/providers/deepseek/deepseekCatalogue.js')") && table.includes("require('../router/providers/zai.js')") && !/^import (?!type )/m.test(table))
  const tool = src('tools/AgentTool/AgentTool.tsx')
  check("the Agent tool's words say each family word means its newest row", tool.includes("'glm' (Z.AI's newest GLM row)") && tool.includes("'kimi' (Moonshot's newest Kimi row)") && tool.includes("'deepseek' (DeepSeek's newest row)") && tool.includes("'grok' (xAI's newest Grok row)"))
  const engines = readFileSync(join(import.meta.dir, '../../docs/ENGINES.md'), 'utf8')
  check('docs/ENGINES.md says the three words mean the newest row beside grok', /the family word `grok` means the newest Grok row[\s\S]{0,80}`deepseek`, `kimi` and `glm` mean the newest row/.test(engines))
  const readme = readFileSync(join(import.meta.dir, '../../README.md'), 'utf8')
  check('README.md names the four words as picks of the newest model', /A family word picks that family's newest\s+model: `\/model grok`, `\/model deepseek`, `\/model kimi` or `\/model glm`/.test(readme))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
