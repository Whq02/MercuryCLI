'use strict'
// ============================================================================
//  Activates the extension under the vscode stub and drives it from stdin —
//  the prover's hands inside the "editor". Lines in:
//    select      → the operator selects lines 3-4 of the active file
//    mention     → the operator runs Mercury: Send Selection to the Terminal
//    save        → the operator saves the right side of the open diff
//    deactivate  → the window closes
//  JSON lines out: ready · env · diff · deactivated · error.
// ============================================================================

const Module = require('node:module')
const path = require('node:path')
const readline = require('node:readline')
const { makeStub, Position, Selection } = require('./vscode-stub.cjs')

const extensionPath = process.argv[2]
const workspacePath = process.env.MERCURY_STUB_WORKSPACE || process.cwd()
const { vscode, context, state, emitters, editor } = makeStub({
  workspacePath,
  activeFile: path.join(workspacePath, 'stub.ts'),
})

const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode
  return originalLoad.call(this, request, ...rest)
}

const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)

let lastDiff = null
state.onExecute = (name, args) => {
  if (name === 'vscode.diff') {
    lastDiff = { left: args[0], right: args[1], title: args[2] }
    emit({ event: 'diff', title: args[2], left: String(args[0]), right: String(args[1]) })
  }
}
state.onEnv = (name, value) => emit({ event: 'env', name, value })

const ext = require(extensionPath)
if (typeof ext.activate !== 'function' || typeof ext.deactivate !== 'function') {
  emit({ event: 'error', message: 'MISSING activate/deactivate' })
  process.exit(1)
}
ext.activate(context)
emit({ event: 'ready', registered: state.registered, subscriptions: context.subscriptions.length })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const command = line.trim()
  try {
    if (command === 'select') {
      editor.selection = new Selection(new Position(2, 0), new Position(3, 5))
      vscode.window.activeTextEditor = editor
      emitters.selection.fire({ textEditor: editor, selections: [editor.selection] })
    } else if (command === 'mention') {
      const fn = state.commandFns.get('mercury.mentionInTerminal')
      if (fn) fn()
    } else if (command === 'save') {
      const provider = state.fsProviders.get('mercury-diff')
      if (!provider || !lastDiff) {
        emit({ event: 'error', message: 'no diff open to save' })
        return
      }
      provider.writeFile(lastDiff.right, Buffer.from('operator edited\n', 'utf8'))
    } else if (command === 'deactivate') {
      ext.deactivate()
      for (const d of context.subscriptions) {
        try {
          d.dispose()
        } catch {
          /* stub disposables */
        }
      }
      emit({ event: 'deactivated' })
      setTimeout(() => process.exit(0), 100)
    }
  } catch (e) {
    emit({ event: 'error', message: e.message })
  }
})
