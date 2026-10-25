import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { arch, homedir, totalmem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { registerManagedLlmHost } from '../llmHost/index.js'
import type { HostBox } from './boxes.js'
import { psQuote, shQuote } from './boxExecution.js'
import { boxServiceRunning, controlBoxService, installBoxService, readBoxService, writeBoxService, type BoxServiceRecord } from './boxService.js'
import { hostRunner, sshArguments, type HostRunner } from './ssh.js'

function boxTunnelHome(box: HostBox): HostBox {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  return { name: 'link-' + createHash('sha256').update(box.name).digest('hex').slice(0, 20), kind: 'this-computer', os, home: homedir(), arch: arch(), uid: process.getuid?.(), memoryGb: totalmem() / 1024 ** 3, unifiedMemory: os === 'darwin' && arch() === 'arm64', gpus: [], engines: [], bankPaths: [], discoveredAt: new Date().toISOString() }
}
function boxTunnelScript(box: HostBox, record: BoxServiceRecord, local: HostBox): string {
  if (!box.target || !record.localPort) throw new Error('A remote computer and a local tunnel port are required.')
  const args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', '127.0.0.1:' + record.localPort + ':127.0.0.1:' + record.port, ...sshArguments(box.target)]
  return local.os === 'windows' ? "$ErrorActionPreference='Stop'\n& ssh.exe " + args.map(arg => psQuote(arg.replaceAll('"', '\\"'))).join(' ') + '\nexit $LASTEXITCODE\n' : 'exec ssh ' + args.map(shQuote).join(' ') + '\n'
}
export async function registerBoxServer(box: HostBox, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal, tunnelHome?: HostBox): Promise<string> {
  const record = readBoxService(box.name)
  if (!record || record.state !== 'running') throw new Error('Start the computer’s engine before registering it.')
  if (box.target) {
    const local = tunnelHome ?? boxTunnelHome(box)
    if (!record.localPort) record.localPort = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)) }) })
    writeBoxService(record)
    await installBoxService(local, boxTunnelScript(box, record, local), runner, signal)
  }
  const baseUrl = 'http://127.0.0.1:' + (box.target ? record.localPort : record.port) + '/v1'
  const deadline = Date.now() + 20_000
  for (;;) {
    try { const response = await fetch(baseUrl + '/models', { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error' }); await response.body?.cancel(); if (response.ok) break } catch { signal.throwIfAborted() }
    if (Date.now() >= deadline) throw new Error('The private tunnel did not answer; mercury host logs ' + box.name)
    await delay(100, undefined, { signal })
  }
  const model = await registerManagedLlmHost('box-' + box.name, baseUrl, record.engine, record.model, record.baseUrl, signal)
  record.baseUrl = baseUrl; writeBoxService(record)
  return model
}
export async function stopBoxTunnel(box: HostBox, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal, uninstall = false, tunnelHome?: HostBox): Promise<void> {
  if (!box.target || !readBoxService(box.name)?.localPort) return
  const local = tunnelHome ?? boxTunnelHome(box)
  await controlBoxService(local, uninstall ? 'uninstall' : 'stop', runner, signal)
  if (await boxServiceRunning(local, runner, signal)) throw new Error('The tunnel service is still running.')
}
