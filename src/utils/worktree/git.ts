import { gitExe } from '../git.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { subprocessEnv } from '../subprocessEnv.js'

function noPromptEnv(): NodeJS.ProcessEnv {
  return { ...subprocessEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
}

export async function runGit(
  args: string[],
  cwd: string,
  options?: { suppressPrompts?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    cwd,
    ...(options?.suppressPrompts ? { env: noPromptEnv(), stdin: 'ignore' as const } : {}),
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}
