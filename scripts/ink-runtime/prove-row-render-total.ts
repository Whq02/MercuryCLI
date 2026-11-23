#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import * as React from 'react'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'row-total-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { render } = await import('../../src/screen/themedRenderer.ts')
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { Byline } = await import('../../src/screen/theme/Byline.tsx')
const { RowErrorBoundary } = await import('../../src/screen/messages/RowErrorBoundary.tsx')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { default: stripAnsi } = await import('strip-ansi')
const AgentUI = await import('../../src/tools/crewmate/rows.tsx')
const EvalUI = await import('../../src/tools/eval/rows.tsx')
const SkillUI = await import('../../src/tools/skill/rows.tsx')
const { normalizeMessages } = await import('../../src/engine/messages/messages.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ' — fix the row that threw: Byline in src/screen/theme/Byline.tsx, RowErrorBoundary in src/screen/messages/RowErrorBoundary.tsx, or the tool UI named in the label (src/tools/skill/rows.tsx, src/tools/crewmate/rows.tsx, src/tools/eval/rows.tsx)'}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const makeStdout = (): { stream: NodeJS.WriteStream; text: () => string } => {
  const emitter = new EventEmitter() as NodeJS.WriteStream & EventEmitter
  let buffer = ''
  Object.assign(emitter, {
    columns: 100,
    rows: 40,
    isTTY: false,
    write(chunk: string | Uint8Array): boolean {
      buffer += String(chunk)
      return true
    },
  })
  return { stream: emitter, text: () => buffer }
}

const tryRender = async (node: React.ReactNode): Promise<{ ok: boolean; output: string; error?: string }> => {
  const { stream, text } = makeStdout()
  try {
    const instance = await render(node, { stdout: stream })
    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()
    await instance.waitUntilExit().catch(() => {})
    const output = text()
    return { ok: !output.includes('RENDER ERROR'), output }
  } catch (error) {
    return { ok: false, output: text(), error: String(error).slice(0, 120) }
  }
}

section('§1 THE OPERATOR REPRO')
{
  const loaded = await tryRender(SkillUI.renderToolResultMessage({ status: 'ok' } as never))
  check('the "Skill loaded" row renders instead of the app-root crash screen', loaded.ok, loaded.error ?? JSON.stringify(loaded.output.slice(0, 80)))
  check('and the byline text paints', loaded.ok && loaded.output.includes('Skill loaded'), JSON.stringify(loaded.output.slice(0, 80)))
  const forked = await tryRender(SkillUI.renderToolResultMessage({ status: 'forked' } as never))
  check('the forked branch ("Done") renders too', forked.ok && forked.output.includes('Done'), forked.error)
}

section('§2 BYLINE IS TOTAL')
{
  const bare = await tryRender(
    React.createElement(Box, null, React.createElement(Byline, null, 'a bare string child')),
  )
  check('a bare string child renders (wrapped in Text at the component)', bare.ok, bare.error ?? JSON.stringify(bare.output.slice(0, 60)))
  check('and paints', bare.ok && bare.output.includes('a bare string child'))
  const mixed = await tryRender(
    React.createElement(
      Box,
      null,
      React.createElement(Byline, null, 'left', React.createElement(Text, null, 'right')),
    ),
  )
  check('mixed string+element children keep the middot separator law', mixed.ok && mixed.output.includes('·'), JSON.stringify(mixed.output.slice(0, 60)))
}

section('§3 THE ROW BOUNDARY')
{
  const caught = await tryRender(
    React.createElement(
      RowErrorBoundary,
      null,
      React.createElement(Box, null, 'raw string straight into a Box'),
    ),
  )
  check('the boundary catches the raw invariant class (app survives)', caught.ok, caught.error)
  check(
    'and degrades to the one errored line',
    caught.output.includes('could not be rendered'),
    JSON.stringify(caught.output.slice(0, 100)),
  )
}

section('§4 NESTED PROGRESS ROWS (AGENT, EVAL, SKILL)')
{
  const fakeTool = {
    name: 'FakeRead',
    userFacingName: () => 'FakeRead',
    renderToolUseMessage: (input: { path?: string }) => input?.path ?? '',
    renderToolResultMessage: (content: unknown) => React.createElement(Text, null, `RESULT:${String(content)}`),
    inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  } as never
  const assistantToolCall = {
    type: 'assistant',
    uuid: 'a-1',
    timestamp: '2026-11-20T10:00:00.000Z',
    message: {
      id: 'msg-1',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: 'toolu_sub1', name: 'FakeRead', input: { path: 'foo.ts' } }],
    },
  }
  const userToolResult = normalizeMessages([
    {
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-11-20T10:00:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_sub1', content: 'file-contents' }],
      },
    },
  ] as never)[0]!
  const assistantText = {
    type: 'assistant',
    uuid: 'a-2',
    timestamp: '2026-11-20T10:00:02.000Z',
    message: {
      id: 'msg-2',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'finished reading foo.ts' }],
    },
  }
  const mkProgress = (id: string, data: unknown) =>
    ({
      type: 'progress',
      uuid: id,
      timestamp: '2026-11-20T10:00:00.000Z',
      toolUseID: 'toolu_parent',
      parentToolUseID: 'toolu_parent',
      data,
    }) as never
  const wrapApp = (node: React.ReactNode): React.ReactNode =>
    React.createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: node })

  const agentProgress = [
    mkProgress('p1', { type: 'agent_progress', message: assistantToolCall, prompt: 'read foo' }),
    mkProgress('p2', { type: 'agent_progress', message: userToolResult }),
    mkProgress('p3', { type: 'agent_progress', message: assistantText }),
  ]
  const evalProgress = [
    mkProgress('e1', { type: 'eval_progress', kind: 'nested', message: assistantToolCall }),
    mkProgress('e2', { type: 'eval_progress', kind: 'nested', message: userToolResult }),
    mkProgress('e3', { type: 'eval_progress', kind: 'nested', message: assistantText }),
  ]
  const skillProgress = [
    mkProgress('s1', { type: 'skill_progress', message: assistantToolCall }),
    mkProgress('s2', { type: 'skill_progress', message: userToolResult }),
    mkProgress('s3', { type: 'skill_progress', message: assistantText }),
  ]

  const agentLive = await tryRender(
    wrapApp(AgentUI.renderToolUseProgressMessage(agentProgress, { tools: [fakeTool], verbose: true })),
  )
  const agentLiveText = stripAnsi(agentLive.output)
  check(
    'AgentTool progress renders nested tool call and text without root error',
    agentLive.ok && agentLiveText.includes('FakeRead') && agentLiveText.includes('foo.ts') && agentLiveText.includes('finished reading foo.ts'),
    agentLive.error ?? JSON.stringify(agentLiveText.slice(0, 160)),
  )

  const agentTranscript = await tryRender(
    wrapApp(
      AgentUI.renderToolResultMessage(
        {
          status: 'completed',
          prompt: 'read foo',
          content: [{ type: 'text', text: 'all done' }],
          totalToolUseCount: 1,
          totalDurationMs: 1000,
        } as never,
        agentProgress,
        { tools: [fakeTool], verbose: true, isTranscriptMode: true },
      ),
    ),
  )
  const agentTranscriptText = stripAnsi(agentTranscript.output)
  check(
    'AgentTool transcript result renders nested tool call and text without root error',
    agentTranscript.ok && agentTranscriptText.includes('FakeRead') && agentTranscriptText.includes('foo.ts') && agentTranscriptText.includes('finished reading foo.ts'),
    agentTranscript.error ?? JSON.stringify(agentTranscriptText.slice(0, 160)),
  )

  const evalLive = await tryRender(
    wrapApp(EvalUI.renderEvalProgressMessage(evalProgress, { tools: [fakeTool], verbose: true })),
  )
  const evalLiveText = stripAnsi(evalLive.output)
  check(
    'EvalTool progress renders nested tool call and text without root error',
    evalLive.ok && evalLiveText.includes('FakeRead') && evalLiveText.includes('foo.ts') && evalLiveText.includes('finished reading foo.ts'),
    evalLive.error ?? JSON.stringify(evalLiveText.slice(0, 160)),
  )

  const skillLive = await tryRender(
    wrapApp(SkillUI.renderToolUseProgressMessage(skillProgress, { tools: [fakeTool], verbose: true })),
  )
  const skillLiveText = stripAnsi(skillLive.output)
  check(
    'SkillTool progress renders nested tool call and text without root error',
    skillLive.ok && skillLiveText.includes('FakeRead') && skillLiveText.includes('foo.ts') && skillLiveText.includes('finished reading foo.ts'),
    skillLive.error ?? JSON.stringify(skillLiveText.slice(0, 160)),
  )
}


rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-row-render-total: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-row-render-total: all green')
