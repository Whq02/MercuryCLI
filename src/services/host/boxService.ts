import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { hostDirectory } from './store.js'
import { boxNameSchema, type HostBox } from './boxes.js'
import { boxJoin, psQuote, runBoxScript, shQuote, writeBoxFile } from './boxExecution.js'
import type { HostRunner } from './ssh.js'

export interface BoxServiceRecord {
  name: string; recipe: string; model: string; engine: 'ollama' | 'llamacpp'; destination: string; bank: boolean
  port: number; localPort?: number; baseUrl?: string; unit: string; script: string; log: string
  state: 'starting' | 'running' | 'stopped' | 'failed' | 'uninstalled'; error?: string
  contextPerSlot?: number; tokensPerSecond?: number; rateKind?: 'whole-turn' | 'generation'
}
const recordPath = (name: string): string => {
  boxNameSchema.parse(name)
  const dir = join(hostDirectory(), 'services'); mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, name + '.json')
}
export function readBoxService(name: string): BoxServiceRecord | undefined {
  try { return JSON.parse(readFileSync(recordPath(name), 'utf8')) as BoxServiceRecord } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export function writeBoxService(record: BoxServiceRecord): void { durableAtomicPublishSync(recordPath(record.name), JSON.stringify(record) + '\n', { mode: 0o600 }) }
const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const unitQuote = (text: string): string => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"'
export const boxServiceLabel = (name: string): string => 'ai.mercury-cli.host.' + boxNameSchema.parse(name)
export const boxServiceLifetimeWords = (box: HostBox): string => 'runs while you are logged in on ' + box.name + ' and returns at login after a reboot' + (box.os === 'linux' ? '; loginctl enable-linger keeps it running without a login' : '')
export function boxServiceFiles(box: HostBox, name = box.name): { unit: string; script: string; log: string } {
  const dir = boxJoin(box, box.home, '.local', 'share', 'mercury-host', name)
  const label = boxServiceLabel(name)
  return { script: boxJoin(box, dir, box.os === 'windows' ? 'engine.ps1' : 'engine.sh'), log: boxJoin(box, dir, 'engine.log'), unit: box.os === 'darwin' ? boxJoin(box, box.home, 'Library', 'LaunchAgents', label + '.plist') : box.os === 'linux' ? boxJoin(box, box.home, '.config', 'systemd', 'user', label + '.service') : boxJoin(box, dir, 'task.xml') }
}
export function boxServiceDocument(box: HostBox, name = box.name): string {
  const files = boxServiceFiles(box, name)
  const label = boxServiceLabel(name)
  if (box.os === 'darwin') return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>' + label + '</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>' + xml(files.script) + '</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>' + xml(files.log) + '</string><key>StandardErrorPath</key><string>' + xml(files.log) + '</string></dict></plist>\n'
  if (box.os === 'linux') return '[Unit]\nDescription=Mercury model host ' + name + '\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=/bin/sh ' + unitQuote(files.script) + '\nRestart=on-failure\nRestartSec=10\nStandardOutput=append:' + files.log.replaceAll('%', '%%') + '\nStandardError=append:' + files.log.replaceAll('%', '%%') + '\n\n[Install]\nWantedBy=default.target\n'
  return '<?xml version="1.0"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>4</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>99</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File &quot;' + xml(files.script) + '&quot;</Arguments></Exec></Actions></Task>\n'
}
export function boxServiceCommand(box: HostBox, action: 'start' | 'stop' | 'status' | 'uninstall', name = box.name): string {
  const label = boxServiceLabel(name)
  const files = boxServiceFiles(box, name)
  if (box.os === 'darwin') {
    if (box.uid === undefined) throw new Error('The macOS login user id was not discovered.')
    const domain = 'gui/' + box.uid
    const target = shQuote(domain + '/' + label)
    if (action === 'status') return 'if launchctl print ' + target + ' 2>/dev/null | grep -q "state = running"; then echo running; else echo stopped; fi'
    if (action === 'start') return 'launchctl enable ' + target + '; if launchctl print ' + target + ' >/dev/null 2>&1; then launchctl kickstart -k ' + target + '; else launchctl bootstrap ' + shQuote(domain) + ' ' + shQuote(files.unit) + '; fi'
    return 'launchctl disable ' + target + '; if launchctl print ' + target + ' >/dev/null 2>&1; then launchctl bootout ' + target + '; fi' + (action === 'uninstall' ? '; rm -f ' + shQuote(files.unit) + ' ' + shQuote(files.script) : '')
  }
  if (box.os === 'linux') {
    const unit = shQuote(label + '.service')
    if (action === 'status') return 'if systemctl --user is-active --quiet ' + unit + '; then echo running; else echo stopped; fi'
    if (action === 'start') return 'systemctl --user daemon-reload; systemctl --user enable ' + unit + '; systemctl --user restart ' + unit
    return 'systemctl --user disable --now ' + unit + (action === 'uninstall' ? '; rm -f ' + shQuote(files.unit) + ' ' + shQuote(files.script) + '; systemctl --user daemon-reload' : '')
  }
  const task = psQuote(label)
  if (action === 'status') return '$task=Get-ScheduledTask -TaskName ' + task + ' -ErrorAction SilentlyContinue; if ($task -and $task.State -eq "Running") { "running" } else { "stopped" }'
  if (action === 'start') return '$task=Get-ScheduledTask -TaskName ' + task + ' -ErrorAction SilentlyContinue; if ($task) { Stop-ScheduledTask -TaskName ' + task + ' }; Register-ScheduledTask -TaskName ' + task + ' -Xml (Get-Content -LiteralPath ' + psQuote(files.unit) + ' -Raw -Encoding UTF8) -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -Force | Out-Null; Enable-ScheduledTask -TaskName ' + task + ' | Out-Null; Start-ScheduledTask -TaskName ' + task
  return '$task=Get-ScheduledTask -TaskName ' + task + ' -ErrorAction SilentlyContinue; if ($task) { Stop-ScheduledTask -TaskName ' + task + '; Disable-ScheduledTask -TaskName ' + task + ' | Out-Null' + (action === 'uninstall' ? '; Unregister-ScheduledTask -TaskName ' + task + ' -Confirm:$false' : '') + ' }' + (action === 'uninstall' ? '; Remove-Item -LiteralPath ' + psQuote(files.unit) + ',' + psQuote(files.script) + ' -ErrorAction SilentlyContinue' : '')
}
export async function installBoxService(box: HostBox, script: string, runner: HostRunner, signal: AbortSignal, name = box.name): Promise<void> {
  const files = boxServiceFiles(box, name)
  await writeBoxFile(box, files.script, box.os === 'windows' ? '\uFEFF' + script : script, runner, signal)
  await writeBoxFile(box, files.unit, boxServiceDocument(box, name), runner, signal)
  await runBoxScript(box, boxServiceCommand(box, 'start', name), runner, signal)
}
export async function controlBoxService(box: HostBox, action: 'start' | 'stop' | 'uninstall', runner: HostRunner, signal: AbortSignal, name = box.name): Promise<void> {
  await runBoxScript(box, boxServiceCommand(box, action, name), runner, signal)
}
export async function boxServiceRunning(box: HostBox, runner: HostRunner, signal: AbortSignal, name = box.name): Promise<boolean> {
  const answer = (await runBoxScript(box, boxServiceCommand(box, 'status', name), runner, signal)).trim()
  if (answer !== 'running' && answer !== 'stopped') throw new Error('The service manager did not report its state.')
  return answer === 'running'
}

export function boxEndpointNotice(name: string, baseUrl: string, unreachable = false): string | undefined {
  if (!name.startsWith('box-') || !boxNameSchema.safeParse(name.slice(4)).success) return
  let record: BoxServiceRecord | undefined
  try { record = readBoxService(name.slice(4)) } catch { return }
  if (!record || record.baseUrl !== baseUrl) return
  if (record.state === 'stopped' || record.state === 'uninstalled') return 'box ' + record.name + ' · engine stopped — /llmhost starts it'
  if (record.state === 'starting') return 'box ' + record.name + ' · engine starting — /llmhost shows progress'
  if (record.state === 'failed' || unreachable) return 'box ' + record.name + ' · engine unreachable — /llmhost checks it'
}
export function noteBoxTurn(name: string, baseUrl: string, model: string, tokens: number, elapsedMs: number): void {
  if (!name.startsWith('box-') || !boxNameSchema.safeParse(name.slice(4)).success || !Number.isFinite(tokens) || tokens <= 0 || elapsedMs <= 0) return
  const record = readBoxService(name.slice(4))
  if (!record || record.baseUrl !== baseUrl || record.model !== model) return
  record.tokensPerSecond = tokens / (elapsedMs / 1000)
  record.rateKind = 'whole-turn'
  writeBoxService(record)
}
