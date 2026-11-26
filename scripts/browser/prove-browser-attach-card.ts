#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { removeScratch } from '../lib/removeScratch.ts'
import { BrowserTool, ROOT, check, finish, lead, ownerOf, permission, requireBrowser, run, section, serve } from './harness.ts'
import type { Tool, ToolUseContext } from '../../src/tools/kit/tool.js'
import type { PermissionDecision } from '../../src/permissions/rules/permissionResult.js'
import type { ToolUseConfirm } from '../../src/permissions/cards/PermissionRequest.js'
import type { Input as BrowserInput } from '../../src/tools/browser/BrowserTool.js'

process.env.NODE_ENV = 'test'
const bindings = await import('../../src/screen/keys/useKeybinding.js')
mock.module('../../src/screen/keys/useKeybinding.js', () => ({ ...bindings, useKeybinding: () => undefined, useKeybindings: () => undefined }))
const { BrowserPermissionRequest } = await import('../../src/permissions/cards/browser/BrowserPermissionRequest.js')
const { renderToString } = await import('../../src/screen/renderer/staticRender.js')
const { AppStoreContext } = await import('../../src/screen/app-state/AppState.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createStore } = await import('../../src/platform/primitives/store.js')
const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.js')
const { resolveBrowser } = await import(join(ROOT, 'src/integrations/browser/browserResolver.ts'))

await requireBrowser()

const siteA = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>Site A</title><body><button id="btn">Go</button></body>')
})
const siteB = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>Site B</title><body><p>Origin B</p></body>')
})

const descCtx = {
  isNonInteractiveSession: false,
  toolPermissionContext: getEmptyToolPermissionContext(),
  tools: [] as Tool[],
}

async function renderCard(
  input: BrowserInput,
  decision: PermissionDecision,
  columns: number,
  descriptionOverride?: string,
): Promise<string> {
  const store = createStore(getDefaultAppState())
  const context: ToolUseContext = {
    options: {
      commands: [],
      debug: false,
      verbose: false,
      engineModel: 'test',
      tools: [],
      mcpClients: [],
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    startTurn: () => {
      throw new Error('no turn loop in card proof')
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    getAppState: () => store.getState(),
    setAppState: () => {},
    messages: [],
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
  }
  const description = descriptionOverride ?? (await BrowserTool.description(input, descCtx))
  const confirm: ToolUseConfirm = {
    assistantMessage: createAssistantMessage({
      content: [{ type: 'tool_use', id: 'card', name: 'Browser', input }],
    }),
    tool: BrowserTool,
    description,
    input,
    toolUseContext: context,
    toolUseID: 'card',
    permissionResult: decision,
    permissionPromptStartTimeMs: 0,
    onUserInteraction() {},
    onAbort() {},
    onAllow() {},
    onReject() {},
    recheckPermission: async () => {},
  }
  const node = React.createElement(BrowserPermissionRequest, {
    toolUseConfirm: confirm,
    toolUseContext: context,
    onDone() {},
    onReject() {},
    verbose: false,
  })
  return renderToString(React.createElement(AppStoreContext.Provider, { value: store }, node), columns)
}

const flatten = (frame: string): string =>
  frame
    .split('\n')
    .map(line => line.replace(/^[│\s]+/, '').replace(/[│\s]+$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')

const resolved = resolveBrowser()
if (resolved.state !== 'ok') throw new Error(`no browser: ${resolved.note}`)

const profile = mkdtempSync(join(tmpdir(), 'mercury-attach-card-'))
const flags = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--use-mock-keychain', '--password-store=basic', '--no-default-browser-check', 'about:blank']
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox')
const fixtureBrowser: ChildProcess = spawn(resolved.executablePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] })
const socket = await new Promise<string>((done, fail) => {
  let seen = ''
  const lapse = setTimeout(() => fail(new Error(`fixture browser did not print DevTools URL: ${seen.slice(-400)}`)), 30_000)
  fixtureBrowser.stderr?.on('data', (chunk: Buffer) => {
    seen += chunk.toString('utf8')
    const hit = /DevTools listening on (ws:\/\/\S+)/.exec(seen)
    if (hit === null) return
    clearTimeout(lapse)
    done(hit[1]!)
  })
  fixtureBrowser.once('exit', code => fail(new Error(`fixture browser exited (${code}): ${seen.slice(-400)}`)))
})
const endpoint = `http://127.0.0.1:${new URL(socket).port}`
const desk = await puppeteer.connect({ browserWSEndpoint: socket, defaultViewport: null })
const pageA = await desk.newPage()
await pageA.goto(`${siteA.origin}/`)

const captures: string[] = []
const isolatedOwner = { agentId: 'isolated-card-owner' }

try {
  section('S1 op:attach description and attach permission card never claim headless Chrome for Testing')
  {
    const attachInput: BrowserInput = { op: 'attach', endpoint }
    const attachDesc = await BrowserTool.description(attachInput, descCtx)
    check('BrowserTool.description(op:attach) describes joining user browser without headless Chrome for Testing', !attachDesc.includes('headless') && !attachDesc.includes('Chrome for Testing') && attachDesc.toLowerCase().includes('chromium'), attachDesc)
    const attachDecision = (await permission(attachInput, lead)) as PermissionDecision
    check('attach permission check asks with safetyCheck', attachDecision.behavior === 'ask', JSON.stringify(attachDecision))
    for (const columns of [80, 120]) {
      const frame = await renderCard(attachInput, attachDecision, columns)
      captures.push(`=== attach (${columns}) ===\n${frame}`)
      const flat = flatten(frame)
      check(`attach/${columns}: titled Browser attach with endpoint and user-browser scope`, flat.includes('Browser attach') && flat.includes(`attach ${endpoint}`) && flat.includes('your own browser, signed in as you') && flat.includes('Attach Mercury to this browser?'), flat)
      check(`attach/${columns}: does not show headless Chrome for Testing`, !flat.includes('Chrome for Testing') && !flat.includes('headless'), flat)
    }
  }

  section('S2 attached-session ask cards (open, extract, click) never open with headless Chrome for Testing')
  {
    const joined = await run({ op: 'attach', endpoint }, lead)
    const tabA = /^\s*(tab-\d+): /.exec(joined.result.split('\n').find(line => line.includes(siteA.origin)) ?? '')?.[1] ?? 'tab-missing'
    check('attached to fixture browser and found tabA', joined.outcome === 'succeeded' && tabA.startsWith('tab-'), joined.result)

    for (const [label, input] of [
      ['attached-open', { op: 'open', url: `${siteB.origin}/page` } satisfies BrowserInput],
      ['attached-extract', { op: 'extract', tab: tabA } satisfies BrowserInput],
      ['attached-click', { op: 'click', tab: tabA, selector: '#btn' } satisfies BrowserInput],
    ] as const) {
      const decision = (await permission(input, lead)) as PermissionDecision
      check(`${label}: permission check asks for unapproved origin in attached browser`, decision.behavior === 'ask', JSON.stringify(decision))
      for (const columns of [80, 120]) {
        const frame = await renderCard(input, decision, columns)
        captures.push(`=== ${label} (${columns}) ===\n${frame}`)
        const flat = flatten(frame)
        check(`${label}/${columns}: does not show headless Chrome for Testing`, !flat.includes('Chrome for Testing') && !flat.includes('headless'), flat)
        check(`${label}/${columns}: keeps your-own-browser explanation and question`, flat.includes('your own browser, signed in as you') && flat.includes('Do you want to allow Mercury to drive this page?') && !flat.includes("don't ask again"), flat)
      }
    }
  }

  section('S3 independent isolated-launch description and cards stay accurate and unchanged')
  {
    const openInput: BrowserInput = { op: 'open', url: `${siteA.origin}/` }
    const defaultDesc = await BrowserTool.description(openInput, descCtx)
    check('isolated open description still leads with headless Chrome for Testing', defaultDesc.startsWith('Drive a headless Chrome for Testing from the managed cache') && defaultDesc.includes('installed browsers are never launched'), defaultDesc)

    const isolatedDecision = (await permission(openInput, isolatedOwner)) as PermissionDecision
    const isolatedFrame = await renderCard(openInput, isolatedDecision, 120)
    captures.push(`=== isolated-open (120) ===\n${isolatedFrame}`)
    const isolatedFlat = flatten(isolatedFrame)
    check('isolated open card keeps origin approval scope and standing rule option', isolatedDecision.behavior === 'ask' && isolatedFlat.includes(`${siteA.origin} for this session`) && isolatedFlat.includes(`don't ask again for ${siteA.origin}`), isolatedFlat)

    const emulInput: BrowserInput = { op: 'viewport', emulation: { headers: { 'x-test': '1' } } }
    const emulDecision: PermissionDecision = {
      behavior: 'ask',
      message: `Browser viewport on ${siteB.origin} with extra headers sent on every request, including other origins — reached by navigation, not yet approved this session`,
      decisionReason: { type: 'safetyCheck', reason: `${siteB.origin} was reached by navigation, not requested by the operator`, operatorOnly: true },
    }
    const emulFrame = await renderCard(emulInput, emulDecision, 120, emulDecision.message)
    const emulFlat = flatten(emulFrame)
    check('isolated emulation card still renders its explicit description', emulFlat.includes('extra headers sent on every request, including other origins'), emulFlat)
  }

  if (process.env.CAPTURE_OUT) {
    writeFileSync(process.env.CAPTURE_OUT, `${captures.join('\n\n')}\n`, 'utf8')
  }
} finally {
  await desk.disconnect().catch(() => undefined)
  if (fixtureBrowser.exitCode === null) fixtureBrowser.kill('SIGKILL')
  try {
    removeScratch(profile, { maxRetries: 20, retryDelayMs: 150 })
  } catch (error) {
    console.log(`  profile left at ${profile}: ${String(error)}`)
  }
}

await finish('prove-browser-attach-card', [lead, isolatedOwner])
