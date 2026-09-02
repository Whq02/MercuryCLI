'use strict'
const vscode = require('vscode')

module.exports.run = async function run() {
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
  await vscode.commands.executeCommand('mercury.openChat')
  console.log('MERCURY-HOST-TEST: all commands registered, chat panel opened')
}
