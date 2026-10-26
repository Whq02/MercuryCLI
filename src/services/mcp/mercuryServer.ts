import { AsyncLocalStorage } from 'node:async_hooks'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { serveStdio, type CallToolResult, type Transport } from './sdk.js'
import { z } from 'zod/v4'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import type { McpServerConfig } from './types.js'
import { renderTui } from './renderTuiTool.js'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import { listProjectLeases, projectLeaseHolder, releaseProjectLeases, takeProjectLeases, type LeaseHolder } from '../vulcan/engine/leases.js'

const invocationLeaseHolder = new AsyncLocalStorage<LeaseHolder>()

export function withMercuryLeaseHolder<T>(agentId: string | undefined, invoke: () => T): T {
  return invocationLeaseHolder.run(projectLeaseHolder(agentId), invoke)
}

function leaseHolder(): LeaseHolder {
  return invocationLeaseHolder.getStore() ?? projectLeaseHolder()
}

export const MERCURY_SERVER_NAME = 'mercury'

const MERCURY_SERVER_ENV = 'MERCURY_COORDINATION_MCP'

export function isMercuryServerEnabled(): boolean {
  if (flagEnv(MERCURY_SERVER_ENV) === '0') return false
  return true
}

export function isMercuryServer(name: string): boolean {
  return name === MERCURY_SERVER_NAME
}

export function mercuryServerConfig(): Record<string, McpServerConfig> {
  if (!isMercuryServerEnabled()) return {}
  return {
    [MERCURY_SERVER_NAME]: {
      type: 'stdio',
      command: process.execPath,
      args: ['--mercury-server-noop'],
    },
  }
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

function structuredJsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function projectRoot(): string {
  return getSessionProjectDir() ?? getOriginalCwd()
}

export async function createMercuryServer(): Promise<{
  connect: (transport: Transport) => Promise<void>
  close: () => Promise<void>
}> {
  const { McpServer } = await import('@modelcontextprotocol/server')

  const sdkServer = new McpServer(
    {
      name: MERCURY_SERVER_NAME,
      title: 'Mercury',
      version: typeof MACRO !== 'undefined' ? (MACRO.VERSION ?? '0') : '0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Mercury in-process tools: exact project file leases (take, list, release — another live holder is named and refused) ' +
        'and the TUI capture (render_tui). Prefer the lease tools over Bash when agents share files.',
    },
  )

  type ZodShape = Record<string, z.ZodType>
  type ShapeArgs<I extends ZodShape> = { [K in keyof I]: z.output<I[K]> }
  const server = {
    registerTool<I extends ZodShape>(
      name: string,
      config: {
        title: string
        description: string
        inputSchema?: I
        outputSchema?: ZodShape
        annotations?: Record<string, boolean>
      },
      handler: (args: ShapeArgs<I>) => Promise<CallToolResult>,
    ): void {
      const { inputSchema, outputSchema, ...rest } = config
      ;(
        sdkServer.registerTool as unknown as (
          name: string,
          config: unknown,
          handler: unknown,
        ) => void
      )(
        name,
        {
          ...rest,
          inputSchema: z.object(inputSchema ?? {}),
          ...(outputSchema ? { outputSchema: z.object(outputSchema) } : {}),
        },
        handler,
      )
    },
  }

  const holderShape = z.object({ sessionId: z.string(), agentId: z.string(), pid: z.number(), procStart: z.string() })
  const leaseShape = z.object({ path: z.string(), acquiredAt: z.string(), holder: holderShape })

  server.registerTool(
    'lease_take',
    {
      title: 'Take project file leases',
      description:
        'Take exact project-local file paths for the current session and agent. Another live holder is named and refused. ' +
        'Leases are released with lease_release or when the holder ends.',
      inputSchema: { paths: z.array(z.string()).min(1).describe('Exact project-relative file paths, not globs.') },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ paths }): Promise<CallToolResult> => {
      try {
        return jsonResult(await takeProjectLeases(projectRoot(), paths, leaseHolder()))
      } catch (e) {
        return errorResult(`lease_take failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'lease_release',
    {
      title: 'Release your file leases',
      description: 'Release the current holder’s project file leases: the named paths, or every lease it holds when none are named.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Exact project-relative file paths to release; omitted releases every lease the holder has.'),
      },
      outputSchema: {
        ok: z.boolean(),
        agentId: z.string().optional(),
        released: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ paths }): Promise<CallToolResult> => {
      try {
        const holder = leaseHolder()
        const result = await releaseProjectLeases(projectRoot(), holder, paths)
        return structuredJsonResult({ ok: true, agentId: holder.agentId, released: result.released.length > 0 })
      } catch (e) {
        return errorResult(`lease_release failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'lease_list',
    {
      title: 'List current file leases',
      description: 'List the exact project file leases with their session and agent holders.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        leases: z.array(leaseShape),
      },
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      try {
        return structuredJsonResult({ ok: true, leases: await listProjectLeases(projectRoot()) })
      } catch (e) {
        return errorResult(`lease_list failed: ${errorMessage(e)}`)
      }
    },
  )

  server.registerTool(
    'render_tui',
    {
      title: 'Render the Mercury TUI to a PNG image',
      description:
        'Capture the real Mercury TUI in a PTY and return it as a PNG image. ' +
        'Use to visually verify a UI/Ink change before claiming it works ' +
        '(Chat/Ink changes do not show in mercury run output). ' +
        'Args: scenario (default resume-2turn), cols (default 120), rows ' +
        '(default 44). Returns an inline image block.',
      inputSchema: {
        scenario: z.string().optional(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ scenario, cols, rows }): Promise<CallToolResult> =>
      renderTui({ scenario, cols, rows }),
  )

  logMCPDebug(MERCURY_SERVER_NAME, 'In-process mercury server constructed')

  let served: { close: () => Promise<void> } | null = null
  return {
    connect: async transport => {
      served = serveStdio(async () => sdkServer, { transport })
    },
    close: async () => {
      if (served !== null) await served.close()
      else await sdkServer.close()
    },
  }
}
