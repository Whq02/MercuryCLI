import { realpathSync, statSync, accessSync, constants as fsConstants } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { memoize } from 'lodash-es'

import { whichSync } from '../which.js'

export const gitExe = memoize((): string => {
  const executable = whichSync('git') ?? 'git'
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const developer = process.env.DEVELOPER_DIR?.trim()
  const directories = developer ? [developer] : ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']
  if (!developer) {
    try { directories.unshift(realpathSync('/var/db/xcode_select_link')) } catch {}
  }
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue
    const candidate = join(directory.endsWith('.app') ? join(directory, 'Contents/Developer') : directory, 'usr/bin/git')
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return executable
})
