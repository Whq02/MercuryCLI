'use strict'

const Module = require('node:module')
const path = require('node:path')
const { makeStub } = require('./vscode-stub.cjs')

const extensionPath = process.argv[2]
const workspacePath = process.env.MERCURY_STUB_WORKSPACE || process.cwd()
const { vscode, context, state } = makeStub({ workspacePath, activeFile: path.join(workspacePath, 'stub.ts') })

const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode
  return originalLoad.call(this, request, ...rest)
}

const ext = require(extensionPath)
if (typeof ext.activate !== 'function' || typeof ext.deactivate !== 'function') {
  console.error('MISSING activate/deactivate')
  process.exit(1)
}
ext.activate(context)
setTimeout(() => {
  ext.deactivate()
  for (const d of context.subscriptions) {
    try {
      d.dispose()
    } catch {
    }
  }
  console.log(JSON.stringify({ registered: state.registered, subscriptions: context.subscriptions.length }))
  setTimeout(() => process.exit(0), 50)
}, 300)
