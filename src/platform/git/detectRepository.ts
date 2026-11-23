import { getCwd } from '../files/cwd.js'
import { logForDebugging } from '../logs/debugLog.js'
import { execFileNoThrowWithCwd } from '../processes/execFileNoThrow.js'
import { gitExe, getRemoteUrl, redactGitRemoteCredentials } from './git.js'
import { logError } from '../logs/errorLog.js'

type ParsedRepository = {
  host: string
  owner: string
  name: string
}

const PUBLIC_GIT_HOST = 'github.com'

const repositoryCache = new Map<string, ParsedRepository>()

function repository(host: string, port: string, owner: string, name: string): ParsedRepository | null {
  if (!/\.[A-Za-z]+$/.test(host)) return null
  return { host: host + port, owner, name: name.length > 4 && name.endsWith('.git') ? name.slice(0, -4) : name }
}
export function parseGitRemote(input: string): ParsedRepository | null {
  const remote = input.trim()
  const scp = /^git@([^/@:]+):([^/]+)\/([^/]+)$/.exec(remote)
  if (scp) return repository(scp[1]!, '', scp[2]!, scp[3]!)
  const url = /^(https?|ssh|git):\/\/(?:[^/@]+@)?([^/@:]+)(:\d+)?\/([^/]+)\/([^/]+)$/.exec(remote)
  if (!url) return null
  return repository(url[2]!, url[1]!.startsWith('http') ? url[3] ?? '' : '', url[4]!, url[5]!)
}

export async function detectCurrentRepository(): Promise<string | null> {
  try {
    const cwd = getCwd()
    let parsed = repositoryCache.get(cwd)
    if (!parsed) {
      let remote = await getRemoteUrl()
      if (!remote) {
        const { stdout, code } = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'remote.origin.url'], { cwd, preserveOutputOnError: false })
        if (code === 0) remote = stdout.trim()
      }
      const displayed = remote ? redactGitRemoteCredentials(remote) : 'none'
      logForDebugging(`detectRepository: remote url = ${displayed}`)
      if (!remote) {
        logForDebugging('detectRepository: no remote url found')
        return null
      }
      const found = parseGitRemote(remote)
      logForDebugging(`detectRepository: parsed ${displayed} → ${found ? `${found.host}/${found.owner}/${found.name}` : 'null'}`)
      if (!found) return null
      parsed = found
      repositoryCache.set(cwd, parsed)
    }
    return parsed.host === PUBLIC_GIT_HOST ? `${parsed.owner}/${parsed.name}` : null
  } catch (error) {
    logError(error)
    return null
  }
}
