import { writeSync } from 'node:fs'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { failCli, type RootOptions } from './cli.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export function refuseSwallowedPrompt({ opts, prompt, runMode, inputFormat, mainThreadAgentDefinition, cliName }: {
  opts: RootOptions
  prompt: string | AsyncIterable<string> | undefined
  runMode: boolean
  inputFormat: string
  mainThreadAgentDefinition: AgentDefinition | undefined
  cliName: string
}): void {
  if (
    (runMode || !process.stdout.isTTY) &&
    prompt === undefined &&
    !opts.resume &&
    !opts.continue &&
    !opts.pr &&
    inputFormat !== 'rows' &&
    mainThreadAgentDefinition?.initialPrompt == null
  ) {
    const variadicCandidates: Array<[string, unknown]> = [
      ['--allowed-tools', opts.allowedTools],
      ['--block-tools', opts.blockTools],
      ['--toolset', opts.toolset],
      ['--mcp', opts.mcp],
      ['--provider-preview', opts.providerPreview],
    ]
    const multi = variadicCandidates.filter(
      (pair): pair is [string, string[]] => Array.isArray(pair[1]) && pair[1].length >= 2,
    )
    const lastArgvToken = process.argv[process.argv.length - 1]
    const swallower =
      multi.find(([, values]) => values[values.length - 1] === lastArgvToken) ?? multi[0]
    if (swallower) {
      const [flag, values] = swallower
      const lastValue = values[values.length - 1] ?? ''
      failCli(
        `No prompt reached run, and the list flag ${flag} captured ${values.length} values — ` +
          `its last value ${JSON.stringify(lastValue)} may have been meant as the prompt ` +
          `(a variadic flag consumes every following bare argument). ` +
          `Put the prompt before the flag, or end the list with -- : ` +
          `${cliName} run ${flag} "..." -- "your prompt". ` +
          `If every value really is a list entry, provide the prompt via stdin or as a positional argument.`,
      )
    }
  }
}

export function refuseEmptyRunPrompt(opts: RootOptions, prompt: string | AsyncIterable<string> | undefined, runMode: boolean, inputFormat: string): void {
  if (runMode && inputFormat === 'text' && (prompt === undefined || (typeof prompt === 'string' && !prompt.trim())) && !opts.resume && !opts.continue && !opts.pr) {
    const debugFilter = typeof opts.debug === 'string' && /\s/.test(opts.debug.trim()) ? opts.debug : null
    const usage = debugFilter !== null
      ? `No prompt reached run: --debug took ${JSON.stringify(debugFilter)} as its category filter. Put the prompt before --debug, or use -d: mercury run ${JSON.stringify(debugFilter)} --debug`
      : 'Usage: mercury run "<prompt>" or pipe a prompt to mercury run -'
    if (process.stdin.isTTY) {
      writeSync(2, `${usage}\n`)
      process.exit(2)
    }
    failCli(usage)
  }
}

export async function* readStdinChunks(): AsyncIterable<string> {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) yield chunk as string
}

export async function* noStdinChunks(): AsyncIterable<string> {}

export function readStdinWithPeek(timeoutMs: number): Promise<string | null> {
  return new Promise(resolvePeek => {
    const chunks: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const armSilence = (): void => {
      if (timeoutMs < 0) return
      if (timer !== undefined) stopTimeout(timer)
      timer = startTimeout(() => finish(null), timeoutMs)
    }
    const onData = (chunk: string): void => {
      chunks.push(chunk)
      armSilence()
    }
    const finish = (empty: string | null): void => {
      if (timer !== undefined) stopTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      resolvePeek(chunks.length > 0 ? chunks.join('') : empty)
    }
    const onEnd = (): void => finish('')
    const onError = (): void => finish(null)
    armSilence()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
  })
}
