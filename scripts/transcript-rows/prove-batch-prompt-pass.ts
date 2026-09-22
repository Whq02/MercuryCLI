#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ContentBlockParam } from '../../src/types/wire.js'
import type { Message, UserMessage } from '../../src/types/message.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-batch-prompt-')))
const originalCwd = process.cwd()
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const cwd = join(scratch, 'project')
mkdirSync(cwd)
writeFileSync(join(cwd, 'notes.txt'), 'THE-NOTES-BODY\n')
process.chdir(cwd)

let failures = 0
let checks = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

try {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { setOriginalCwd, setCwdState, getSessionId } = await import('../../src/bootstrap/state.ts')
  setOriginalCwd(cwd)
  setCwdState(cwd)
  const { processUserInput } = await import('../../src/utils/processUserInput/processUserInput.ts')
  const { builtinCommands, sessionSeatCommandTable } = await import('../../src/commands.ts')
  const { planApiConversation } = await import('../../src/utils/messages/apiPlan.ts')
  const { addFunctionHook } = await import('../../src/utils/hooks/sessionHooks.ts')
  const { storeImage, storedImageRefBlock } = await import('../../src/utils/imageStore.ts')
  const table = sessionSeatCommandTable([...builtinCommands()])
  const appState: Record<string, unknown> = {
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
    sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, todos: {},
  }
  const setAppState = (f: (prev: Record<string, unknown>) => Record<string, unknown>): void => { Object.assign(appState, f(appState)) }
  const hookSaw: string[] = []
  const blocked = new Set<string>()
  addFunctionHook(setAppState as never, getSessionId(), 'UserPromptSubmit', '', (_messages, _signal, extra) => {
    const input = extra?.hookInput
    const prompt = input && 'prompt' in input ? String(input.prompt) : ''
    hookSaw.push(prompt)
    return blocked.has(prompt) ? 'this line is blocked' : true
  }, 'prompt blocked', { id: 'batch-prompt-spy' })

  const context = () => ({
    options: { commands: table, tools: [], mcpClients: [], isNonInteractiveSession: true },
    getAppState: () => appState, setAppState, messages: [],
    abortController: new AbortController(), readFileState: new Map(), setToolJSX: () => {},
  })
  const run = (values: Array<string | ContentBlockParam[]>, uuids: string[], isMeta = false) => processUserInput({
    input: values[0]!, mode: 'prompt', setToolJSX: () => {}, context: context() as never,
    messages: [], querySource: 'sdk', uuid: uuids[0], isMeta,
    ...(values.length > 1 ? { batchUuids: uuids, batchTail: values.slice(1).map((value, i) => ({ value, uuid: uuids[i + 1] })) } : {}),
  })
  const users = (rows: Message[]): UserMessage[] => rows.filter((row): row is UserMessage => row.type === 'user')
  const files = (rows: Message[]): string[] => rows.flatMap(row =>
    row.type === 'attachment' && 'filename' in row.attachment && typeof row.attachment.filename === 'string'
      ? [row.attachment.filename] : [],
  )
  const first = 'the line at the return'
  const second = 'and please read @notes.txt too'
  const ids = [randomUUID(), randomUUID(), randomUUID()]

  const joined = await run([`${first}\n${second}`], [ids[1]!])
  check('the joined input attaches the mentioned file', files(joined.messages).some(file => file.endsWith('notes.txt')))
  check('the joined input runs its prompt hook', JSON.stringify(hookSaw.splice(0)) === JSON.stringify([`${first}\n${second}`]))

  const batch = await run([first, second], ids.slice(0, 2))
  const rows = users(batch.messages)
  check('each line keeps one adjacent row under its own identity', rows.length === 2 && rows.every((row, i) => row.uuid === ids[i]) && batch.messages[0] === rows[0] && batch.messages[1] === rows[1])
  check('the later mention attaches the same file as the joined input', JSON.stringify(files(batch.messages)) === JSON.stringify(files(joined.messages)), JSON.stringify(files(batch.messages)))
  check('every prompt runs its hook once in send order', JSON.stringify(hookSaw.splice(0)) === JSON.stringify([first, second]))
  const planned = users(planApiConversation(batch.messages).selected)
  check('the planner still folds the prompts into the old newline-joined text', planned.length === 1 && planned[0]?.message.content === `${first}\n${second}`)

  const slashBatch = await run([first, '/help'], ids.slice(0, 2))
  check('a later slash line remains prompt text rather than invoking a command', slashBatch.shouldQuery && users(slashBatch.messages).length === 2 && users(slashBatch.messages)[1]?.message.content === '/help' && users(planApiConversation(slashBatch.messages).selected)[0]?.message.content === `${first}\n/help`)
  check('a later slash line still passes its prompt hook', JSON.stringify(hookSaw.splice(0)) === JSON.stringify([first, '/help']))

  const plain = [first, 'the line after the return', 'the third line']
  for (const denied of [[1], [0], [2], [0, 1, 2]]) {
    blocked.clear()
    denied.forEach(i => blocked.add(plain[i]!))
    const result = await run(plain, ids)
    const allowed = plain.filter((_, i) => !denied.includes(i))
    const acceptedIds = ids.filter((_, i) => !denied.includes(i))
    const accepted = users(result.messages)
    const label = `blocked positions ${denied.map(i => i + 1).join(',')}`
    check(`${label}: every line still passes the hook in order`, JSON.stringify(hookSaw.splice(0)) === JSON.stringify(plain))
    check(`${label}: only accepted lines keep their own prompt rows`, JSON.stringify(accepted.map(row => row.uuid)) === JSON.stringify(acceptedIds))
    check(`${label}: each blocked line keeps the ordinary warning`, result.messages.filter(row => row.type === 'system' && row.content.includes('Operation blocked by hook: this line is blocked')).length === denied.length)
    check(`${label}: the surviving prompts alone determine whether the model runs`, result.shouldQuery === (allowed.length > 0) && (allowed.length > 0 || (result.hookBlocked === true && result.resultText?.includes('this line is blocked') === true)))
    const projected = users(planApiConversation(result.messages).selected)
    check(`${label}: blocked text never reaches the model; the accepted lines still fold`, allowed.length === 0 ? projected.length === 0 : projected.length === 1 && projected[0]?.message.content === allowed.join('\n'))
  }
  blocked.clear()

  const paste = { id: 7, type: 'image' as const, mediaType: 'image/jpeg', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
  await storeImage(paste)
  const ref = storedImageRefBlock(paste)
  check('the stored image fixture exists', ref !== null)
  const imagePrompt = [ref!, { type: 'text', text: 'read this image' }] as ContentBlockParam[]
  const singleImage = await run([imagePrompt], [ids[1]!])
  hookSaw.splice(0)
  const imageBatch = await run([first, imagePrompt, plain[2]!], ids)
  const imageRow = users(imageBatch.messages).find(row => row.uuid === ids[1])
  const image = Array.isArray(imageRow?.message.content) ? imageRow.message.content.find(block => block.type === 'image') : undefined
  check('the later stored image is read back and normalized exactly as a single prompt', JSON.stringify(imageRow?.message.content) === JSON.stringify(users(singleImage.messages)[0]?.message.content) && image?.type === 'image' && image.source.type === 'base64' && image.source.media_type === 'image/png')
  const metadata = users(imageBatch.messages).filter(row => row.isMeta && typeof row.message.content === 'string' && row.message.content.includes('[Image dimensions:'))
  check('the later image receives its dimension line', metadata.length === 1 && metadata[0]?.message.content === '[Image dimensions: 1x1]')
  check('image metadata does not split the identity rows or the planner fold', imageBatch.messages.slice(0, 3).every((row, i) => row.type === 'user' && row.uuid === ids[i]) && users(planApiConversation(imageBatch.messages).selected).length === 2)
  check('the block-array prompt runs its hook too', JSON.stringify(hookSaw.splice(0)) === JSON.stringify([first, 'read this image', plain[2]!]))

  const metaBatch = await run(plain, ids, true)
  check('the batch preserves the meta flag and permission mode on every prompt', users(metaBatch.messages).length === 3 && users(metaBatch.messages).every(row => row.isMeta === true && row.permissionMode === 'default'))
} finally {
  process.chdir(originalCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
