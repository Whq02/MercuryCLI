#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, ROOT, section } from './computerProofKit.ts'
import { COMPUTER_ACTIONS, COMPUTER_ACTS, COMPUTER_READS, toolContext } from './computerToolKit.ts'

const { ComputerTool, COMPUTER_TOOL_NAME, HOLD_CAP_MS, TYPE_TEXT_CAP } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const { validateToolCapability } = await import('../../src/utils/capability/contract.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')

const DESCRIPTION_BUDGET = 160
const PROMPT_BUDGET = 2_500
const SCHEMA_BUDGET = 2_600
const NEEDLES = ['anthropic', 'claude', 'openai', 'gpt', 'gemini', 'google', 'deepseek', 'moonshot', 'kimi', 'z.ai', 'zhipu', 'hugging', 'openrouter', 'ollama', 'compat']

resetDesktopDriverForTest()
const schema = zodToJsonSchema(ComputerTool.inputSchema)
const schemaText = JSON.stringify(schema)
const description = await ComputerTool.description({ action: 'screenshot' } as never, { isNonInteractiveSession: false, toolPermissionContext: getEmptyToolPermissionContext(), tools: [] })
const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools: [], agents: [] })
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

section('§1 the fourteen actions, in order, on the capability and on the schema')
{
  check('the tool is named Computer', ComputerTool.name === 'Computer' && COMPUTER_TOOL_NAME === 'Computer')
  const declared = ComputerTool.capability?.operations ?? []
  check('capability.operations is exactly the fourteen names in order', JSON.stringify(declared) === JSON.stringify(COMPUTER_ACTIONS), JSON.stringify(declared))
  const properties = (schema.properties ?? {}) as Record<string, { enum?: string[] }>
  check('the schema\'s action enum is the same fourteen in the same order', JSON.stringify(properties.action?.enum) === JSON.stringify(COMPUTER_ACTIONS), JSON.stringify(properties.action))
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
  check('the prompt teaches the coordinate rule, the ask rule and the stop key', prompt.includes('pixels of the last screenshot') && prompt.includes('first act in an application') && prompt.includes('esc'))
}

section('§4 the shape fields')
{
  check('shouldDefer is true', ComputerTool.shouldDefer === true)
  check("interruptBehavior() is 'cancel'", ComputerTool.interruptBehavior?.() === 'cancel')
  const validation = validateToolCapability(ComputerTool.capability)
  check('the capability declaration validates', validation.ok, JSON.stringify(validation))
  check("the capability gate is the opt-in flag and its proof is the asks proof", ComputerTool.capability?.gate === 'MERCURY_COMPUTER_USE' && ComputerTool.capability?.proof === 'scripts/computer/prove-computer-asks.ts')
  check('the capability proof exists', existsSync(join(ROOT, 'scripts', 'computer', 'prove-computer-asks.ts')))
  for (const action of COMPUTER_READS) check(`isReadOnly(${action}) is true`, ComputerTool.isReadOnly({ action } as never) === true)
  for (const action of COMPUTER_ACTS) check(`isReadOnly(${action}) is false`, ComputerTool.isReadOnly({ action } as never) === false)
  for (const action of COMPUTER_ACTIONS) {
    const safe = ComputerTool.isConcurrencySafe({ action } as never)
    const expected = action === 'cursor' || action === 'displays' || action === 'frontmost'
    check(`isConcurrencySafe(${action}) is ${expected}`, safe === expected)
  }
  check('userFacingName() is Computer', ComputerTool.userFacingName({ action: 'screenshot' } as never) === 'Computer')
  check('the result size cap is 20000', ComputerTool.maxResultSizeChars === 20_000)
  check('the search hint names computer use', typeof ComputerTool.searchHint === 'string' && ComputerTool.searchHint.toLowerCase().includes('computer use'))
  check('isEnabled() follows the flag', ComputerTool.isEnabled() === true)
}

finish('prove-computer-schema')
