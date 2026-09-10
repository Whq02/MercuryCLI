#!/usr/bin/env bun
import { check, finish, section, sourceText } from './computerProofKit.ts'
import { toolContext } from './computerToolKit.ts'

const { getAllBaseTools } = await import('../../src/tools.ts')
const { ComputerTool, COMPUTER_TOOL_NAME } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { setIsInteractive, getIsInteractive } = await import('../../src/bootstrap/state.ts')
const teammate = await import('../../src/utils/teammate.ts')
const agents = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { ALL_AGENT_DISALLOWED_TOOLS } = await import('../../src/constants/tools.ts')

resetDesktopDriverForTest()
const names = (): string[] => getAllBaseTools().map(t => t.name)

section('§1 the catalogue: absent with the flag off, present after Browser with it on')
{
  delete process.env.MERCURY_COMPUTER_USE
  check('flag unset: Computer is absent from the base tools', !names().includes('Computer'), names().join(','))
  process.env.MERCURY_COMPUTER_USE = '1'
  const list = names()
  const at = list.indexOf('Computer')
  check('flag set: Computer is present', at >= 0, list.join(','))
  check('…immediately after Browser', at > 0 && list[at - 1] === 'Browser', list.slice(Math.max(0, at - 2), at + 2).join(','))
  check('the constant spells the catalogue name', COMPUTER_TOOL_NAME === 'Computer' && ComputerTool.name === COMPUTER_TOOL_NAME)
}

section('§2 a headless run is refused by name')
{
  const wasInteractive = getIsInteractive()
  setIsInteractive(false)
  const verdict = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext({ interactive: false }))
  check('validateInput refuses with the headless text', verdict.result === false && verdict.message === 'the Computer tool drives the screen of an interactive session; this headless run has no operator at the screen', JSON.stringify(verdict))
  setIsInteractive(wasInteractive)
  const back = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext())
  check('an interactive session is accepted again', back.result === true, JSON.stringify(back))
}

section('§3 a teammate is refused by name')
{
  teammate.setDynamicTeamContext({ agentId: 'mate-1', teamName: 'crew', planModeRequired: false } as never)
  check('the seam reads as a teammate', teammate.isTeammate() === true)
  const verdict = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext())
  check('validateInput refuses with the teammate text', verdict.result === false && verdict.message === 'the Computer tool drives the operator\'s own screen; a teammate never drives it in this release — the main session does', JSON.stringify(verdict))
  teammate.clearDynamicTeamContext()
  const back = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext())
  check('the main session is accepted again', back.result === true, JSON.stringify(back))
}

section('§4 no agent ever carries the tool')
{
  const pool = getAllBaseTools()
  check('the pool under test carries Computer', pool.some(t => t.name === 'Computer'))
  for (const isBuiltIn of [true, false]) {
    for (const isAsync of [false, true]) {
      const kept = agents.filterToolsForAgent({ tools: pool, isBuiltIn, isAsync }).map(t => t.name)
      check(`filterToolsForAgent drops Computer (isBuiltIn ${isBuiltIn}, isAsync ${isAsync})`, !kept.includes('Computer'), kept.join(','))
    }
  }
  check('the all-agents denial set names Computer', ALL_AGENT_DISALLOWED_TOOLS.has('Computer'))
  const runAgent = sourceText('src/tools/AgentTool/runAgent.ts')
  check('runAgent filters the name out of every worker\'s pool (the workflow road never passes the agent filter)', runAgent.includes('COMPUTER_TOOL_NAME'))
  const asAgent = await ComputerTool.validateInput!({ action: 'screenshot' } as never, toolContext({ agentId: 'agent-x' }))
  check('a context carrying an agent id is refused with the sub-agent text', asAgent.result === false && asAgent.message === 'the Computer tool drives the operator\'s own screen; a sub-agent never carries it in this release — the main session does', JSON.stringify(asAgent))
}

section('§5 the MCP serve surface filters the tool in both handlers')
{
  const source = sourceText('src/entrypoints/mcp.ts')
  const mentions = source.split('COMPUTER_TOOL_NAME').length - 1
  check('mcp.ts names COMPUTER_TOOL_NAME in its import and both handlers (three mentions or more)', mentions >= 3, `${mentions} mentions`)
  const listHandler = source.indexOf("setRequestHandler('tools/list'")
  const callHandler = source.indexOf("setRequestHandler('tools/call'")
  const inList = listHandler >= 0 && callHandler > listHandler && source.slice(listHandler, callHandler).includes('COMPUTER_TOOL_NAME')
  const inCall = callHandler >= 0 && source.slice(callHandler).includes('COMPUTER_TOOL_NAME')
  check("the tools/list handler filters by the name", inList)
  check("the tools/call handler filters by the name", inCall)
}

finish('prove-computer-refusals')
