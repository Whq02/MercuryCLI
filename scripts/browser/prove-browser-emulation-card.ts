#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { BrowserTool, check, finish, pageOf, permission, requireBrowser, run, serve } from './harness.ts'

process.env.NODE_ENV = 'test'
const bindings = await import('../../src/keybindings/useKeybinding.js')
mock.module('../../src/keybindings/useKeybinding.js', () => ({ ...bindings, useKeybinding: () => undefined, useKeybindings: () => undefined }))
const select = await import('../../src/components/CustomSelect/select.js')
const ActualSelect = select.Select
let choose: ((value: string) => void) | undefined
mock.module('../../src/components/CustomSelect/select.js', () => ({ ...select, Select: (props: Record<string, unknown>) => { choose = props.onChange as typeof choose; return React.createElement(ActualSelect, props as never) } }))
const { BrowserPermissionRequest } = await import('../../src/components/permissions/BrowserPermissionRequest/BrowserPermissionRequest.js')
const { renderToString } = await import('../../src/utils/staticRender.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
await requireBrowser()
const A = await serve(27293, (_req, res) => res.end('<title>card</title>'))
const B = await serve(27294, (_req, res) => res.end('<title>other</title>'))
await run({ op: 'open', url: A.origin })
await pageOf().goto(B.origin)
const password = 'fixture-card-value'
for (const [name, emulation] of Object.entries({ headers: { headers: { 'x-card': 'yes' } }, credentials: { credentials: { username: 'reader', password } } })) {
  const input = { op: 'viewport', emulation }
  const decision = await permission(input)
  for (const columns of [80, 120]) {
    const state = createStore(getDefaultAppState())
    const context = { abortController: new AbortController(), getAppState: () => state.getState(), setAppState: () => {}, messages: [], options: {} }
    let writes: unknown[] = []
    const confirm = { assistantMessage: { message: { id: 'card' } }, tool: BrowserTool, description: decision.message, input, toolUseContext: context, toolUseID: 'card', permissionResult: decision, permissionPromptStartTimeMs: 0, onUserInteraction() {}, onAbort() {}, onAllow(_input: unknown, rules: unknown[]) { writes = rules }, onReject() {}, recheckPermission: async () => {} }
    const node = React.createElement(BrowserPermissionRequest, { toolUseConfirm: confirm as never, toolUseContext: context as never, onDone() {}, onReject() {}, verbose: false, workerBadge: undefined })
    const frame = await renderToString(React.createElement(AppStoreContext.Provider, { value: state as never }, node), columns)
    console.log(`\n${name} at ${columns} columns\n${frame}`)
    const words = frame.split('\n').map(line => line.replace(/^[│\s]+/, '').replace(/[│\s]+$/, '')).join(' ').replace(/\s+/g, ' ')
    check(`${name}/${columns}: the actual card carries the full approved subject`, words.includes(name === 'headers' ? 'extra headers sent on every request, including other origins' : 'basic credentials for reader'), words)
    check(`${name}/${columns}: origin and user stay intact, the password is in no cell`, frame.includes(B.origin) && !frame.includes(password) && (name !== 'credentials' || frame.includes('reader')))
    choose?.('yes-dont-ask-origin')
    check(`${name}/${columns}: always-allow writes the same exact origin rule`, JSON.stringify(writes) === JSON.stringify([{ type: 'addRules', rules: [{ toolName: 'Browser', ruleContent: `origin:${B.origin}` }], behavior: 'allow', destination: 'localSettings' }]), JSON.stringify(writes))
  }
}
await finish('prove-browser-emulation-card')
