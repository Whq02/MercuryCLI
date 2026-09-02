// Extension-host test suite — runs INSIDE VS Code's extension
// host via `code --extensionTestsPath`. Asserts the packaged bridge
// activates and registers its full command surface.
'use strict'
const vscode = require('vscode')

module.exports.run = async function run() {
  // Trigger activation (activationEvents are lazy).
  await vscode.commands.executeCommand('mercury.refreshViews')
  const commands = await vscode.commands.getCommands(true)
  const required = [
    'mercury.openChat',
    'mercury.newSession',
    'mercury.resumeSession',
    'mercury.cancelTurn',
    'mercury.askSelection',
    'mercury.editSelection',
    'mercury.reviewLastTurn',
    'mercury.openArtifact',
    'mercury.showReviewComments',
    'mercury.openTerminal',
    'mercury.setMode',
    'mercury.refreshViews',
  ]
  const missing = required.filter(c => !commands.includes(c))
  if (missing.length > 0) {
    throw new Error(`extension host: missing commands: ${missing.join(', ')}`)
  }
  // The chat panel opens without throwing (no ACP server configured — the
  // panel itself must not depend on a live connection).
  await vscode.commands.executeCommand('mercury.openChat')
  console.log('MERCURY-HOST-TEST: all commands registered, chat panel opened')
}
