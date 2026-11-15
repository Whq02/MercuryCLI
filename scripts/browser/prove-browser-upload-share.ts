#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTool, check, finish, lead, ownerOf, permission, requireBrowser, run, section, serve, sessions } from './harness.ts'

process.env.NODE_ENV = 'test'
const bindings = await import('../../src/keybindings/useKeybinding.js')
mock.module('../../src/keybindings/useKeybinding.js', () => ({ ...bindings, useKeybinding: () => undefined, useKeybindings: () => undefined }))
const { BrowserPermissionRequest } = await import('../../src/components/permissions/BrowserPermissionRequest/BrowserPermissionRequest.js')
const { renderToString } = await import('../../src/utils/staticRender.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.js')
const { checkReadPermissionForTool } = await import('../../src/utils/permissions/filesystem.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { getPlatform } = await import('../../src/utils/platform.js')

await requireBrowser()

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-upload-share-proof-')))
const outside = join(dir, 'outside.txt')
writeFileSync(outside, 'a local file outside the session folder')
const A = await serve(0, (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>form</title><input id="one" type="file"><input id="many" type="file" multiple>')
})

const SHARE = String.raw`\\nohost.invalid\share\x.txt`
const SENTENCE = `${SHARE} may reach the remote host nohost.invalid over SMB/WebDAV; a UNC path can leak this machine's login — Mercury does not open it without explicit permission.`
const UNGRANTED = `Permission to read from ${outside} has not been granted.`
const LOUD = String.raw`\\nohost.invalid\share` + '\\' + 'x'.repeat(300) + '.txt'

const host = getPlatform()
async function asWindows<T>(read: () => Promise<T>): Promise<T> {
  getPlatform.cache.set(undefined, 'windows')
  try {
    return await read()
  } finally {
    getPlatform.cache.set(undefined, host)
  }
}

type Decision = { behavior: string; message?: string; decisionReason?: { type: string; reason?: string; operatorOnly?: boolean } }
async function judged(input: Record<string, unknown>, rules: { allow?: string[]; deny?: string[] } = {}): Promise<{ decision: Decision; decidedBy: string } | { threw: string }> {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: 'default' as never,
    alwaysAllowRules: rules.allow ? { session: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { session: rules.deny } : {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
  const appState = { toolPermissionContext }
  const engine = { ...lead, abortController: new AbortController(), getAppState: () => appState, setAppState: () => {}, messages: [], options: {} }
  try {
    const answer = await decideToolPermission(BrowserTool as never, input, engine as never)
    return { decision: answer.decision as Decision, decidedBy: String(answer.trace.decidedBy) }
  } catch (err) {
    return { threw: (err as Error).message }
  }
}
async function cardOf(input: Record<string, unknown>, decision: Decision, columns: number): Promise<string> {
  const state = createStore(getDefaultAppState())
  const context = { abortController: new AbortController(), getAppState: () => state.getState(), setAppState: () => {}, messages: [], options: {} }
  const confirm = { assistantMessage: { message: { id: 'card' } }, tool: BrowserTool, description: await BrowserTool.description(), input, toolUseContext: context, toolUseID: 'card', permissionResult: decision, permissionPromptStartTimeMs: 0, onUserInteraction() {}, onAbort() {}, onAllow() {}, onReject() {}, recheckPermission: async () => {} }
  const node = React.createElement(BrowserPermissionRequest, { toolUseConfirm: confirm as never, toolUseContext: context as never, onDone() {}, onReject() {}, verbose: false, workerBadge: undefined })
  const frame = await renderToString(React.createElement(AppStoreContext.Provider, { value: state as never }, node), columns)
  return frame.split('\n').map(line => line.replace(/^[│\s]+/, '').replace(/[│\s]+$/, '')).join(' ').replace(/\s+/g, ' ')
}
const words = (answer: Awaited<ReturnType<typeof judged>>): string => ('threw' in answer ? `THREW ${answer.threw}` : `${answer.decision.behavior} ${answer.decision.message ?? ''} [${answer.decidedBy}]`)

await run({ op: 'open', url: `${A.origin}/` })
sessions.approveWebOrigin(ownerOf(lead), `${A.origin}/`)

try {
  section('S0 controls (hold on the parent too)')
  {
    const local = await judged({ op: 'upload', selector: '#one', files: [outside] })
    check('a local file outside the session folder is asked about in Read’s sentence', !('threw' in local) && local.decision.behavior === 'ask' && local.decision.message === `Browser upload ${outside} to #one on ${A.origin} — ${UNGRANTED}`, words(local))
    const card = 'threw' in local ? '' : await cardOf({ op: 'upload', selector: '#one', files: [outside] }, local.decision, 200)
    check('and its card carries that sentence', card.includes(UNGRANTED), card)
    if (host !== 'windows') {
      const plain = await judged({ op: 'upload', selector: '#one', files: [SHARE] })
      check('where the host is not Windows that spelling is no share: nothing asks, as for Read', !('threw' in plain) && plain.decision.behavior === 'allow', words(plain))
    }
  }

  section('S1 a share path, as Read’s reader sees it on Windows')
  {
    const input = { op: 'upload', selector: '#one', files: [SHARE] }
    const asked = await asWindows(() => judged(input))
    check('[M05] the upload is asked about in the sentence of Read’s decision for that path', !('threw' in asked) && asked.decision.behavior === 'ask' && asked.decision.message === `Browser upload ${SHARE} to #one on ${A.origin} — ${SENTENCE}`, words(asked))
    const reads = await asWindows(async () => checkReadPermissionForTool({ name: 'Read', getPath: () => SHARE }, {}, getEmptyToolPermissionContext()))
    check('the sentence is Read’s own, word for word, and its reason is the operator’s to answer (holds on the parent too)', reads.behavior === 'ask' && reads.message === SENTENCE && JSON.stringify(reads.decisionReason) === JSON.stringify({ type: 'safetyCheck', reason: SENTENCE, operatorOnly: true }), `${reads.behavior} ${reads.message}`)
    check('the upload’s ask carries that same reason', !('threw' in asked) && JSON.stringify(asked.decision.decisionReason) === JSON.stringify({ type: 'safetyCheck', reason: SENTENCE, operatorOnly: true }), 'threw' in asked ? asked.threw : JSON.stringify(asked.decision.decisionReason))
    for (const columns of [80, 120]) {
      const card = 'threw' in asked || asked.decision.behavior !== 'ask' ? '' : await cardOf(input, asked.decision, columns)
      check(`the card says why it asks, whole, at ${columns} columns`, card.includes(`upload ${SHARE} → #one`) && card.includes(SENTENCE) && card.includes('Do you want to allow Mercury to drive this page?'), card)
    }
  }

  section('S2 the share is not looked up before the answer')
  {
    const direct = await asWindows(() => permission({ op: 'upload', selector: '#one', files: [LOUD] }).then(answer => `${answer.behavior} ${answer.message ?? ''}`, err => `THREW ${(err as Error).message}`))
    check('a share path whose lookup fails loudly is asked about and never looked up', direct.startsWith('ask Browser upload ') && direct.includes('may reach the remote host nohost.invalid over SMB/WebDAV'), direct.slice(0, 200) + ' … ' + direct.slice(-200))
    const engine = await asWindows(() => judged({ op: 'upload', selector: '#one', files: [LOUD] }))
    check('through the permission engine the ask keeps its reason (a check that throws leaves a card with none)', !('threw' in engine) && engine.decision.behavior === 'ask' && engine.decision.decisionReason?.type === 'safetyCheck' && (engine.decision.decisionReason.reason ?? '').includes('over SMB/WebDAV'), words(engine).slice(0, 300))
    const denied = await asWindows(() => judged({ op: 'upload', selector: '#one', files: ['//nohost.invalid/share/x.txt'] }, { deny: ['Read(//nohost.invalid/share/**)'] }))
    check('a deny rule for the share refuses the upload in the rule’s sentence, where the parent let it through to the lookup', !('threw' in denied) && denied.decision.behavior === 'deny' && (denied.decision.message ?? '').includes('Read(//nohost.invalid/share/**)'), words(denied).slice(0, 400))
  }

  section('S3 a list that holds a share path and a local file')
  {
    const input = { op: 'upload', selector: '#many', files: [SHARE, outside] }
    const asked = await asWindows(() => judged(input))
    check('the ask carries Read’s sentence for each of the two', !('threw' in asked) && asked.decision.behavior === 'ask' && asked.decision.message === `Browser upload 2 files to #many on ${A.origin} — ${SENTENCE}\n${UNGRANTED}`, words(asked))
    const card = 'threw' in asked || asked.decision.behavior !== 'ask' ? '' : await cardOf(input, asked.decision, 200)
    check('and so does its card', card.includes(SENTENCE) && card.includes(UNGRANTED), card)
  }
  if (process.platform !== 'win32') {
    mkdirSync(join(dir, 'nohost.invalid', 'share'), { recursive: true })
    writeFileSync(join(dir, 'nohost.invalid', 'share', 'x.txt'), 'a file whose path is spelled like a share')
    const named = `${dir}//nohost.invalid/share/x.txt`
    const first = join(dir, 'first.txt')
    const second = join(dir, 'second.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    const link = join(dir, 'link.txt')
    symlinkSync(first, link)
    const input = { op: 'upload', selector: '#many', files: [named, link] }
    const asked = await asWindows(() => permission(input))
    unlinkSync(link)
    symlinkSync(second, link)
    const swapped = await run(input)
    check('where two slashes inside a path are one: the local file of such a list is still held to what the check saw', asked.behavior === 'ask' && swapped.outcome === 'failed' && swapped.result.includes('link.txt is another file than the permission check saw'), `${asked.behavior} | ${swapped.result}`)
    await asWindows(() => permission(input))
    const sent = await run(input)
    check('and unchanged, the list is sent after the answer', sent.outcome === 'succeeded' && sent.result.startsWith('upload: #many holds 2 files — '), sent.result)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

await finish('prove-browser-upload-share')
