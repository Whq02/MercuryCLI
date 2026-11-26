#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, ROOT, section } from './computerProofKit.ts'
import { COMPUTER_ACTIONS, COMPUTER_ACTS, COMPUTER_READ_ONLY, toolContext } from './computerToolKit.ts'

const { ComputerTool, COMPUTER_TOOL_NAME, HOLD_CAP_MS, TYPE_TEXT_CAP } = await import('../../src/tools/computer/ComputerTool.ts')
const { zodToJsonSchema } = await import('../../src/platform/primitives/zodToJsonSchema.ts')
const { validateToolCapability } = await import('../../src/permissions/capability/contract.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { resetDesktopDriverForTest } = await import('../../src/integrations/desktop/resolveDriver.ts')

const DESCRIPTION_BUDGET = 160
const PROMPT_BUDGET = 720
const SCHEMA_BUDGET = 2_700
const NEEDLES = ['anthropic', 'claude', 'openai', 'gpt', 'gemini', 'google', 'deepseek', 'moonshot', 'kimi', 'z.ai', 'zhipu', 'hugging', 'openrouter', 'ollama', 'compat']

resetDesktopDriverForTest()
const schema = zodToJsonSchema(ComputerTool.inputSchema)
const schemaText = JSON.stringify(schema)
const description = await ComputerTool.description({ action: 'screenshot' } as never, { isNonInteractiveSession: false, toolPermissionContext: getEmptyToolPermissionContext(), tools: [] })
const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools: [], agents: [] })
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

section('§1 the fifteen actions, in order, on the capability and on the schema')
{
  check('the tool is named Computer', ComputerTool.name === 'Computer' && COMPUTER_TOOL_NAME === 'Computer')
  const declared = ComputerTool.capability?.operations ?? []
  check('capability.operations is exactly the fifteen names in order', JSON.stringify(declared) === JSON.stringify(COMPUTER_ACTIONS), JSON.stringify(declared))
  const properties = (schema.properties ?? {}) as Record<string, { enum?: string[] }>
  check('the schema\'s action enum is the same fifteen in the same order', JSON.stringify(properties.action?.enum) === JSON.stringify(COMPUTER_ACTIONS), JSON.stringify(properties.action))
  const unknown = ComputerTool.inputSchema.safeParse({ action: 'screenshot', bogus: 1 })
  check('an unknown key is refused by the strict object', unknown.success === false)
  const plain = ComputerTool.inputSchema.safeParse({ action: 'screenshot' })
  check('a bare screenshot parses', plain.success === true)
}

section('§2 the per-action table refuses by name through validateInput on the fake driver')
{
  const context = toolContext()
  const refused = async (input: Record<string, unknown>, needle: string): Promise<void> => {
    const verdict = await ComputerTool.validateInput!(input as never, context)
    check(`${JSON.stringify(input)} refuses naming ${needle}`, verdict.result === false && verdict.message.includes(needle), JSON.stringify(verdict))
  }
  const accepted = async (input: Record<string, unknown>): Promise<void> => {
    const verdict = await ComputerTool.validateInput!(input as never, context)
    check(`${JSON.stringify(input)} is accepted`, verdict.result === true, JSON.stringify(verdict))
  }
  await refused({ action: 'click', x: 1 }, 'y')
  await refused({ action: 'doubleClick', y: 1 }, 'x')
  await refused({ action: 'rightClick' }, 'x')
  await refused({ action: 'move', x: 1 }, 'y')
  await refused({ action: 'drag', x: 1, y: 1, toY: 2 }, 'toX')
  await refused({ action: 'drag', x: 1, y: 1, toX: 2 }, 'toY')
  await refused({ action: 'scroll', x: 1, y: 1 }, 'd')
  await refused({ action: 'type', text: 'a\u0000b' }, 'control')
  await refused({ action: 'type', text: '' }, 'text')
  await refused({ action: 'type', text: 'x'.repeat(TYPE_TEXT_CAP + 1) }, String(TYPE_TEXT_CAP))
  await refused({ action: 'type' }, 'text')
  await refused({ action: 'hold', key: 'shift', durationMs: 10 }, 'durationMs')
  await refused({ action: 'hold', key: 'shift', durationMs: 9_000 }, String(HOLD_CAP_MS))
  await refused({ action: 'hold', key: 'shift' }, 'durationMs')
  await refused({ action: 'key', key: 'cmd+q+w' }, 'cmd+q+w')
  await refused({ action: 'key' }, 'key')
  await refused({ action: 'key', key: 'NoSuchKey' }, 'NoSuchKey')
  await accepted({ action: 'screenshot' })
  await accepted({ action: 'screenshot', display: 0, label: 'first' })
  await accepted({ action: 'wait' })
  await accepted({ action: 'cursor' })
  await accepted({ action: 'displays' })
  await accepted({ action: 'frontmost' })
  await accepted({ action: 'click', x: 812, y: 300 })
  await accepted({ action: 'click', x: 812, y: 300, modifiers: ['Shift'], settleMs: 0, capture: false })
  await accepted({ action: 'drag', x: 1, y: 1, toX: 2, toY: 2 })
  await accepted({ action: 'scroll', x: 1, y: 1, dy: 3 })
  await accepted({ action: 'scroll', x: 1, y: 1, dx: -2 })
  await accepted({ action: 'type', text: 'hello\n\tworld' })
  await accepted({ action: 'key', key: 'cmd+shift+s' })
  await accepted({ action: 'key', key: 'Enter' })
  await accepted({ action: 'key', key: 'ArrowUp' })
  await accepted({ action: 'key', key: 'a' })
  await accepted({ action: 'hold', key: 'shift', durationMs: 500 })
}

section('§3 the byte budgets and the needles')
{
  check(`description() is at most ${DESCRIPTION_BUDGET} bytes`, bytes(description) <= DESCRIPTION_BUDGET, `${bytes(description)} bytes: ${description}`)
  check(`prompt() is at most ${PROMPT_BUDGET} bytes`, bytes(prompt) <= PROMPT_BUDGET, `${bytes(prompt)} bytes`)
  check(`the JSON schema is at most ${SCHEMA_BUDGET} bytes`, bytes(schemaText) <= SCHEMA_BUDGET, `${bytes(schemaText)} bytes`)
  const corpus = `${description}\n${prompt}\n${schemaText}`.toLowerCase()
  const found = NEEDLES.filter(needle => corpus.includes(needle))
  check('no vendor or route word appears in the description, the prompt or the schema', found.length === 0, found.join(', '))
  check('the prompt teaches the coordinate rule, the ask rule and the stop key', prompt.includes('pixels of its last screenshot') && prompt.includes('first act of a session asks once') && prompt.includes('esc'))
  check('the loop breaker stays verbatim', prompt.includes('After the same act twice with an unchanged result, read the screen before acting again.'))
  check('the description has no other tool or action dictionary', !/Eval|click\(x|type\(text|sequence\(steps\)/.test(prompt))
  const wire = ComputerTool.inputJSONSchema as any
  check('the model schema keeps every inline field within its measured ceiling', bytes(JSON.stringify(wire)) <= 8150)
  check('the step action enum excludes sequence while the top-level enum retains it', wire.properties.action.enum.includes('sequence') && !wire.properties.steps.items.properties.action.enum.includes('sequence'))
  check('field semantics are on the top-level fields, not repeated on steps', wire.properties.key.description.includes('cmd/ctrl/alt/shift') && wire.properties.verify.description.includes('not task success') && wire.properties.steps.items.properties.key.description === undefined)
}

section('§4 the shape fields')
{
  check('shouldDefer is true', ComputerTool.shouldDefer === true)
  check("interruptBehavior() is 'cancel'", ComputerTool.interruptBehavior?.() === 'cancel')
  const validation = validateToolCapability(ComputerTool.capability)
  check('the capability declaration validates', validation.ok, JSON.stringify(validation))
  check("the capability gate is the opt-in flag and its proof is the asks proof", ComputerTool.capability?.gate === 'MERCURY_COMPUTER_USE' && ComputerTool.capability?.proof === 'scripts/computer/prove-computer-asks.ts')
  check('the capability proof exists', existsSync(join(ROOT, 'scripts', 'computer', 'prove-computer-asks.ts')))
  for (const action of COMPUTER_READ_ONLY) check(`isReadOnly(${action}) is true`, ComputerTool.isReadOnly({ action } as never) === true)
  for (const action of COMPUTER_ACTS) check(`isReadOnly(${action}) is false`, ComputerTool.isReadOnly({ action } as never) === false)
  for (const action of COMPUTER_ACTIONS) {
    const safe = ComputerTool.isConcurrencySafe({ action } as never)
    const expected = action === 'cursor' || action === 'displays' || action === 'frontmost'
    check(`isConcurrencySafe(${action}) is ${expected}`, safe === expected)
  }
  check('userFacingName() is Computer', ComputerTool.userFacingName({ action: 'screenshot' } as never) === 'Computer')
  check('the result size cap is 20000', ComputerTool.maxResultSizeChars === 20_000)
  check('the roster hint names desktop input without clipping', ComputerTool.searchHint === 'inspect desktop applications and operate their mouse and keyboard' && ComputerTool.searchHint.length <= 100)
  check('isEnabled() follows the flag', ComputerTool.isEnabled() === true)
}

section('§5 E4: tool description and prompt lead with find for a known role/name while keeping pixels available, backed by real tool results')
{
  const { writeFileSync } = await import('node:fs')
  const { scratchDir } = await import('./computerProofKit.ts')
  const { allowEverything, ownerOf } = await import('./computerToolKit.ts')
  const { createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
  const { forgetDesktopOwner } = await import('../../src/integrations/desktop/desktopSession.ts')
  type ComputerInput = import('../../src/tools/computer/ComputerTool.ts').Input
  const sceneFile = join(scratchDir('schema-e4'), 'scene.json')
  const app = { identity: 'com.example.Editor', name: 'Editor', pid: 4242, windowId: 'editor', title: 'Workspace', bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  writeFileSync(sceneFile, JSON.stringify({
    displays: [{ index: 0, id: 'e4', originX: 0, originY: 0, width: 1280, height: 800, scale: 2, primary: true }],
    frontmost: app,
    cursor: { x: 200, y: 200 },
    lines: ['Workspace'],
    tree: [{
      role: 'AXWindow',
      title: 'Workspace',
      focused: true,
      frame: app.bounds,
      children: [
        { role: 'AXButton', title: 'Save', frame: { x: 380, y: 90, width: 80, height: 28 } },
        ...Array.from({ length: 30 }, (_, i) => ({
          role: 'AXGroup (AXDocumentArticle)',
          title: `Feed post #${i + 1}: release checklist update`,
          value: `Summary of item ${i + 1} with status green`,
          frame: { x: 40, y: 140 + i * 20, width: 900, height: 18 },
        })),
      ],
    }],
  }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = sceneFile
  resetDesktopDriverForTest()
  const ctx = toolContext()
  forgetDesktopOwner(ownerOf(ctx))
  const callReal = async (id: string, input: ComputerInput) => {
    const parent = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Computer', input }] })
    return ComputerTool.call(input, ctx, allowEverything, parent)
  }
  const found = await callReal('e4-find', { action: 'find', target: { role: 'AXButton', name: 'Save' } })
  const tree = await callReal('e4-tree', { action: 'tree' })
  const shot = await callReal('e4-shot', { action: 'screenshot' })
  check('real tool results show find costs less than tree (fewer chars) and screenshot (0 images, fewer chars)', found.data.outcome === 'succeeded' && tree.data.outcome === 'succeeded' && shot.data.outcome === 'succeeded' && found.data.imagePath === undefined && shot.data.imagePath !== undefined && found.data.result.length < tree.data.result.length && found.data.result.length < shot.data.result.length, `find=${found.data.result.length} tree=${tree.data.result.length} shot=${shot.data.result.length}`)
  const findPos = description.indexOf('find')
  const shotPos = description.indexOf('screenshot')
  check('returned description() leads with find before screenshot while keeping screenshot available', findPos >= 0 && shotPos > findPos, description)
  const promptFindPos = prompt.indexOf('find')
  const promptShotPos = prompt.indexOf('screenshot')
  check('returned prompt() points to find first for a known role/name while keeping pixels/coordinates available', promptFindPos >= 0 && promptShotPos > promptFindPos && prompt.includes('role/name') && prompt.includes('pixels'), prompt)
  forgetDesktopOwner(ownerOf(ctx))
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  resetDesktopDriverForTest()
}

finish('prove-computer-schema')
