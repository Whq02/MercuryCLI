#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { KEY, mountOffscreen, settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { installFixture, proofHome, removeProofHome, root, serverPath } from './fixture.ts'

process.env.FORCE_COLOR = '3'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', IS_DEV: false }

const project = join(proofHome, 'project')
const originalCwd = process.cwd()

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

try {
  installFixture()
  mkdirSync(project, { recursive: true })
  writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({
    media: { enabled: true, root, serverPath },
  }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    imageModel: 'image-one',
    videoModel: 'video-one',
  }))
  const pipelinePath = join(project, 'landscape.pipeline.json')
  writeFileSync(pipelinePath, JSON.stringify({
    version: 1,
    name: 'Landscape',
    steps: [
      { id: 'draw', kind: 'generate', inputs: { prompt: 'a mountain lake', model: 'image-one', width: 512, height: 512 } },
    ],
  }))

  process.chdir(project)
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.js')
  setCwdState(project)
  setOriginalCwd(project)
  setProjectRoot(project)

  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
  const { decideToolPermission } = await import('../../src/permissions/rules/decision/engine.js')
  const { applyPermissionUpdate } = await import('../../src/permissions/rules/permissionUpdate.js')
  const { wireSafeMcpToolName } = await import('../../src/integrations/mcp-shapes/mcpToolNames.js')
  const { MEDIA_SERVER_NAME } = await import('../../src/integrations/media/settings.js')
  const { mediaGenerationKind } = await import('../../src/integrations/media/generation.js')
  const { PermissionRequest } = await import('../../src/permissions/cards/PermissionRequest.js')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
  const { AppStoreContext } = await import('../../src/screen/app-state/AppState.js')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
  const { createStore } = await import('../../src/platform/primitives/store.js')
  const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')

  const makeMediaTool = (toolName: 'image_generate' | 'video_generate' | 'pipeline_run') => ({
    name: wireSafeMcpToolName(MEDIA_SERVER_NAME, toolName),
    isMcp: true,
    mcpInfo: { serverName: MEDIA_SERVER_NAME, toolName },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    userFacingName: () => `${MEDIA_SERVER_NAME} - ${toolName} (MCP)`,
    renderToolUseMessage: (input: Record<string, unknown>) => JSON.stringify(input),
    checkPermissions: async () => ({ behavior: 'ask' as const, message: `Allow ${toolName}?` }),
  })

  const imageTool = makeMediaTool('image_generate')
  const videoTool = makeMediaTool('video_generate')
  const pipelineTool = makeMediaTool('pipeline_run')

  check('mediaGenerationKind routes image_generate, video_generate and pipeline_run',
    mediaGenerationKind(imageTool) === 'image' &&
    mediaGenerationKind(videoTool) === 'video' &&
    mediaGenerationKind(pipelineTool) === 'image',
  )

  const basePerm = getEmptyToolPermissionContext()
  const makeCtx = (perm = basePerm) => ({
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: perm }),
    setAppState: () => {},
    options: {},
  })

  const initialDecision = await decideToolPermission(imageTool as never, { model: 'image-one', prompt: 'red apple' }, makeCtx() as never)
  check('decideToolPermission asks for image_generate before any rule is added', initialDecision.decision.behavior === 'ask', JSON.stringify(initialDecision.decision))

  type CardOutcome = {
    allowed: Array<{ input: unknown; updates: unknown[]; feedback?: string }>
    confirmRejected: Array<string | undefined>
    cardRejected: number
    done: number
    frame: Awaited<ReturnType<typeof mountOffscreen>>
  }

  async function mountMediaCard(
    tool: ReturnType<typeof makeMediaTool>,
    input: Record<string, unknown>,
    readyNeedle: string,
    toolUseID: string,
  ): Promise<CardOutcome> {
    const allowed: Array<{ input: unknown; updates: unknown[]; feedback?: string }> = []
    const confirmRejected: Array<string | undefined> = []
    let cardRejected = 0
    let done = 0
    const ctx = makeCtx()
    const store = createStore(getDefaultAppState())
    const confirm = {
      tool,
      input,
      description: `Run ${tool.mcpInfo.toolName}`,
      toolUseContext: ctx,
      toolUseID,
      cwd: project,
      permissionResult: { behavior: 'ask' as const, message: 'Allow media generation?' },
      permissionPromptStartTimeMs: Date.now(),
      onUserInteraction() {},
      onAbort() {},
      async recheckPermission() {},
      onAllow(updatedInput: unknown, updates: unknown[], feedback?: string) {
        allowed.push({ input: updatedInput, updates, feedback })
      },
      onReject(feedback?: string) {
        confirmRejected.push(feedback)
      },
    }
    const tree = React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        AppStoreContext.Provider,
        { value: store as never },
        React.createElement(
          KeybindingSetup,
          null,
          React.createElement(PermissionRequest, {
            toolUseConfirm: confirm as never,
            toolUseContext: ctx as never,
            onDone: () => {
              done++
            },
            onReject: () => {
              cardRejected++
            },
            verbose: false,
            workerBadge: undefined,
          }),
        ),
      ),
    )
    const frame = await mountOffscreen(tree, 120, 30)
    const ready = await waitFor(() => frame.screen().includes(readyNeedle) && frame.screen().includes('Do you want to proceed?'), 5000)
    if (!ready) throw new Error(`Card ${toolUseID} never settled on "${readyNeedle}":\n${frame.screen()}`)
    await settle(60)
    return {
      get allowed() {
        return allowed
      },
      get confirmRejected() {
        return confirmRejected
      },
      get cardRejected() {
        return cardRejected
      },
      get done() {
        return done
      },
      frame,
    }
  }

  const imageInput = { model: 'image-one', prompt: 'a red apple on oak', width: 512, height: 512 }

  section('1. Local image card: Yes approves once with original input and no rule updates')
  const yesRun = await mountMediaCard(imageTool, imageInput, 'Prompt: a red apple on oak', 'media-img-yes')
  try {
    const screen = yesRun.frame.screen()
    check('image card paints Local image title, model, size, output and prompt',
      screen.includes('Local image') &&
      screen.includes('image-one') &&
      screen.includes('512×512 · 9 steps') &&
      screen.includes(`Output: ${join(project, 'media')}`) &&
      screen.includes('Prompt: a red apple on oak'),
      screen,
    )
    yesRun.frame.push(KEY.enter)
    const settled = await waitFor(() => yesRun.done === 1, 3000)
    check('Yes fires onAllow with exact input, empty updates, no feedback, and onDone without onReject',
      settled &&
      yesRun.allowed.length === 1 &&
      yesRun.allowed[0]!.input === imageInput &&
      yesRun.allowed[0]!.updates.length === 0 &&
      yesRun.allowed[0]!.feedback === undefined &&
      yesRun.cardRejected === 0 &&
      yesRun.confirmRejected.length === 0,
      JSON.stringify(yesRun.allowed),
    )
  } finally {
    yesRun.frame.unmount()
  }

  section('2. Local image card: Yes with Tab feedback carries trimmed instructions')
  const yesFbRun = await mountMediaCard(imageTool, imageInput, 'Prompt: a red apple on oak', 'media-img-yes-fb')
  try {
    yesFbRun.frame.push('\t')
    await settle(40)
    yesFbRun.frame.push('save as png next to the draft')
    await settle(40)
    yesFbRun.frame.push(KEY.enter)
    const settled = await waitFor(() => yesFbRun.done === 1, 3000)
    check('Yes + Tab feedback passes feedback to onAllow and closes cleanly',
      settled &&
      yesFbRun.allowed.length === 1 &&
      yesFbRun.allowed[0]!.feedback === 'save as png next to the draft' &&
      yesFbRun.cardRejected === 0,
      JSON.stringify(yesFbRun.allowed),
    )
  } finally {
    yesFbRun.frame.unmount()
  }

  section('3. Local image card: Yes, and don\'t ask again emits localSettings allow rule that clears future asks')
  const alwaysRun = await mountMediaCard(imageTool, imageInput, 'Prompt: a red apple on oak', 'media-img-always')
  try {
    alwaysRun.frame.push(KEY.down)
    await settle(40)
    alwaysRun.frame.push(KEY.enter)
    const settled = await waitFor(() => alwaysRun.done === 1, 3000)
    const updates = alwaysRun.allowed[0]?.updates as Array<{ type: string; behavior: string; destination: string; rules: Array<{ toolName: string }> }> | undefined
    check('second option emits addRules allow for imageTool in localSettings',
      settled &&
      alwaysRun.allowed.length === 1 &&
      updates?.length === 1 &&
      updates[0]!.type === 'addRules' &&
      updates[0]!.behavior === 'allow' &&
      updates[0]!.destination === 'localSettings' &&
      updates[0]!.rules[0]?.toolName === imageTool.name,
      JSON.stringify(updates),
    )
    const updatedPerm = applyPermissionUpdate(basePerm, updates![0] as never)
    const nextDecision = await decideToolPermission(imageTool as never, imageInput, makeCtx(updatedPerm) as never)
    check('applying emitted allow rule makes subsequent decideToolPermission allow image_generate',
      nextDecision.decision.behavior === 'allow',
      JSON.stringify(nextDecision.decision),
    )
    const videoStillAsks = await decideToolPermission(videoTool as never, { model: 'video-one', prompt: 'waves' }, makeCtx(updatedPerm) as never)
    check('emitted rule stays scoped to image_generate and video_generate still asks',
      videoStillAsks.decision.behavior === 'ask',
      JSON.stringify(videoStillAsks.decision),
    )
  } finally {
    alwaysRun.frame.unmount()
  }

  section('4. Local image card: No rejects without allowing, and No + Tab feedback carries user words')
  const noRun = await mountMediaCard(imageTool, imageInput, 'Prompt: a red apple on oak', 'media-img-no')
  try {
    noRun.frame.push(KEY.down)
    await settle(40)
    noRun.frame.push(KEY.down)
    await settle(40)
    noRun.frame.push(KEY.enter)
    const settled = await waitFor(() => noRun.done === 1, 3000)
    check('No fires onReject(undefined), card onReject and onDone without calling onAllow',
      settled &&
      noRun.allowed.length === 0 &&
      noRun.cardRejected === 1 &&
      noRun.confirmRejected.length === 1 &&
      noRun.confirmRejected[0] === undefined,
      JSON.stringify({ allowed: noRun.allowed, rejected: noRun.confirmRejected }),
    )
  } finally {
    noRun.frame.unmount()
  }

  const noFbRun = await mountMediaCard(imageTool, imageInput, 'Prompt: a red apple on oak', 'media-img-no-fb')
  try {
    noFbRun.frame.push(KEY.down)
    await settle(40)
    noFbRun.frame.push(KEY.down)
    await settle(40)
    noFbRun.frame.push('\t')
    await settle(40)
    noFbRun.frame.push('use warm lighting instead')
    await settle(40)
    noFbRun.frame.push(KEY.enter)
    const settled = await waitFor(() => noFbRun.done === 1, 3000)
    check('No + Tab feedback forwards trimmed rejection feedback and never allows',
      settled &&
      noFbRun.allowed.length === 0 &&
      noFbRun.cardRejected === 1 &&
      noFbRun.confirmRejected[0] === 'use warm lighting instead',
      JSON.stringify(noFbRun.confirmRejected),
    )
  } finally {
    noFbRun.frame.unmount()
  }

  section('5. Local image card: Esc cancels and rejects cleanly')
  const escRun = await mountMediaCard(imageTool, imageInput, 'Prompt: a red apple on oak', 'media-img-esc')
  try {
    escRun.frame.push(KEY.esc)
    const settled = await waitFor(() => escRun.done === 1, 3000)
    check('Esc triggers onReject and onDone with zero allows',
      settled &&
      escRun.allowed.length === 0 &&
      escRun.cardRejected === 1 &&
      escRun.confirmRejected.length === 1,
      JSON.stringify({ allowed: escRun.allowed, rejected: escRun.confirmRejected }),
    )
  } finally {
    escRun.frame.unmount()
  }

  section('6. Local video card and pipeline card answers + unknown model error card')
  const videoInput = { model: 'video-one', prompt: 'ocean waves at dawn', seconds: 4 }
  const videoRun = await mountMediaCard(videoTool, videoInput, 'Prompt: ocean waves at dawn', 'media-vid-esc')
  try {
    const screen = videoRun.frame.screen()
    check('video card paints Local video title, model, frame length and prompt',
      screen.includes('Local video') &&
      screen.includes('video-one') &&
      screen.includes('1280×704 · 20 steps · 4 s · 24 fps') &&
      screen.includes('Prompt: ocean waves at dawn'),
      screen,
    )
    videoRun.frame.push(KEY.esc)
    const settled = await waitFor(() => videoRun.done === 1, 3000)
    check('video card Esc rejects without allowing', settled && videoRun.allowed.length === 0 && videoRun.cardRejected === 1)
  } finally {
    videoRun.frame.unmount()
  }

  const pipelineInput = { pipeline: pipelinePath }
  const pipeRun = await mountMediaCard(pipelineTool, pipelineInput, 'Pipeline: Landscape · step draw', 'media-pipe-yes')
  try {
    const screen = pipeRun.frame.screen()
    check('pipeline card paints Local image title and pipeline step detail', screen.includes('Local image') && screen.includes('Pipeline: Landscape · step draw'), screen)
    pipeRun.frame.push(KEY.enter)
    const settled = await waitFor(() => pipeRun.done === 1, 3000)
    check('pipeline card Yes fires onAllow with exact pipeline input', settled && pipeRun.allowed.length === 1 && pipeRun.allowed[0]!.input === pipelineInput)
  } finally {
    pipeRun.frame.unmount()
  }

  const badModelRun = await mountMediaCard(imageTool, { model: 'absent-model', prompt: 'test' }, 'Choose the image model in /imagesetup.', 'media-bad-model')
  try {
    badModelRun.frame.push(KEY.esc)
    const settled = await waitFor(() => badModelRun.done === 1, 3000)
    check('unknown model paints /imagesetup guidance and Esc cancels cleanly', settled && badModelRun.allowed.length === 0 && badModelRun.cardRejected === 1)
  } finally {
    badModelRun.frame.unmount()
  }
} finally {
  process.chdir(originalCwd)
  removeProofHome()
}

console.log(failures === 0 ? '\nPASS media permission card answers' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
