import { join } from 'node:path'
import { ollamaRootOf } from './setupDetect.js'
import { readJson, rec, resolveSetupIo, seconds, shellArgv, str, type ResolvedSetupIo } from './setupIo.js'
import { SETUP_SERVE_LOG, SETUP_START_POLL_MS, type OllamaInstallFound, type SetupIo, type StartPlan, type StartResult } from './setupTypes.js'

export async function readOllamaVersion(root: string, seam: SetupIo = {}): Promise<string | undefined> {
  const io = resolveSetupIo(seam)
  return str(rec(await readJson(io, `${root}/api/version`))?.version)
}

function serveLogPath(io: ResolvedSetupIo): string {
  return join(io.configHome, ...SETUP_SERVE_LOG.split('/'))
}

function quoted(path: string): string {
  return /[\s"'\\$`]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path
}

export async function planStart(found: OllamaInstallFound, seam: SetupIo = {}): Promise<StartPlan> {
  const io = resolveSetupIo(seam)
  const root = ollamaRootOf(io.env) ?? 'http://127.0.0.1:11434'
  const waitUrl = `${root}/api/version`
  const alreadyUp = await readOllamaVersion(root, seam)
  const up = alreadyUp !== undefined ? { alreadyUp: `Ollama ${alreadyUp}` } : {}
  const wait = `then GET ${waitUrl} until it answers (60 s at most)`
  const detached = (argv: string[], words: string): StartPlan => {
    const logPath = serveLogPath(io)
    return {
      form: found.found,
      command: `${argv.map(quoted).join(' ')} (detached, log ${logPath})`,
      argv,
      says: [words, `the server runs on after Mercury exits; its output goes to ${logPath}`, wait],
      needsSudo: false,
      detached: true,
      logPath,
      root,
      waitUrl,
      ...up,
    }
  }
  switch (found.found) {
    case 'app':
      return { form: 'app', command: 'open -a Ollama', argv: ['open', '-a', 'Ollama'], says: ['opens the Ollama app; it serves on 11434 from the menu bar', wait], needsSudo: false, detached: false, root, waitUrl, ...up }
    case 'brew': {
      const brew = await io.which('brew')
      if (brew) {
        return { form: 'brew', command: 'brew services start ollama', argv: [brew, 'services', 'start', 'ollama'], says: ['starts the Homebrew service now and at login (its plist under ~/Library/LaunchAgents)', wait], needsSudo: false, detached: false, root, waitUrl, ...up }
      }
      return detached([found.where || 'ollama', 'serve'], 'brew is not on PATH, so the binary is started directly')
    }
    case 'systemd':
      return { form: 'systemd', command: 'sudo systemctl start ollama', argv: ['sudo', 'systemctl', 'start', 'ollama'], says: ['starts the ollama systemd service; sudo asks for your password in the terminal that runs it', wait], needsSudo: true, detached: false, root, waitUrl, ...up }
    case 'windows': {
      const exe = found.where || 'ollama app.exe'
      return { form: 'windows', command: `start "" "${exe}"`, argv: shellArgv('win32', `start "" "${exe}"`), says: ['starts the Ollama app; it serves on 11434 from the tray', wait], needsSudo: false, detached: false, root, waitUrl, ...up }
    }
    case 'path':
      return detached([found.where || 'ollama', 'serve'], `starts ${found.where || 'ollama'} serve as its own process`)
    case 'none':
      return { form: 'none', command: '', argv: [], says: ['ollama is not installed; step 2b installs it'], needsSudo: false, detached: false, root, waitUrl, ...up }
  }
}

export async function waitForOllama(root: string, seam: SetupIo = {}, onWait?: (line: string) => void): Promise<StartResult> {
  const io = resolveSetupIo(seam)
  const started = io.now()
  for (;;) {
    const version = await readOllamaVersion(root, seam)
    const waitedMs = io.now() - started
    if (version !== undefined) {
      return { rc: 0, lastLine: `{"version":"${version}"}`, up: true, version, waitedMs, words: `Ollama ${version} answers at ${root} after ${seconds(waitedMs)}` }
    }
    if (waitedMs >= io.startWaitMs || io.signal?.aborted === true) {
      return { rc: 1, lastLine: `no answer from GET ${root}/api/version`, up: false, waitedMs, words: `no answer from ${root}/api/version after ${seconds(waitedMs)}` }
    }
    onWait?.(`waiting for GET ${root}/api/version · ${seconds(waitedMs)}`)
    await io.sleep(SETUP_START_POLL_MS)
  }
}

export async function startServer(plan: StartPlan, seam: SetupIo = {}, onWait?: (line: string) => void): Promise<StartResult> {
  const io = resolveSetupIo(seam)
  if (plan.argv.length === 0) {
    return { rc: 1, lastLine: 'nothing to start: ollama was not found', up: false, waitedMs: 0, words: 'nothing to start: ollama was not found' }
  }
  const ran = await io.exec(plan.argv[0]!, plan.argv.slice(1), { ...(plan.detached ? { detached: true } : {}), ...(plan.logPath ? { logPath: plan.logPath } : {}), timeoutMs: io.startWaitMs })
  if (ran.rc !== 0) {
    return { rc: ran.rc, lastLine: ran.lastLine, up: false, waitedMs: 0, words: `${plan.command} failed: rc ${ran.rc}${ran.lastLine ? ` · ${ran.lastLine}` : ''}` }
  }
  const waited = await waitForOllama(plan.root, seam, onWait)
  return { ...waited, rc: waited.up ? 0 : 1, lastLine: waited.up ? waited.lastLine : `${plan.command}: rc 0${ran.lastLine ? ` · ${ran.lastLine}` : ''} · ${waited.lastLine}` }
}
