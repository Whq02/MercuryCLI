#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod/v4'

const modelsV1 = ['z-image-turbo', 'flux2-klein-4b']
const modelsV2 = [...modelsV1, 'qwen-image-21']
const stateFile = process.env.MCP_FIXTURE_STATE_FILE
const installedAtStart = stateFile !== undefined && existsSync(stateFile)

serveStdio(async () => {
  const server = new McpServer({ name: 'media-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
  const generateWith = models => ({
    description: 'Generate an image from a prompt.',
    inputSchema: z.object({ prompt: z.string(), model: z.enum(models).optional() }),
  })
  const generateHandler = async ({ prompt, model }) => ({ content: [{ type: 'text', text: `generated ${prompt} with ${model ?? modelsV1[0]}` }] })
  const registerModels = () =>
    server.registerTool(
      'media_models',
      { description: 'The installed models.', inputSchema: z.object({}) },
      async () => ({ content: [{ type: 'text', text: modelsV2.join(', ') }] }),
    )
  const generate = server.registerTool('image_generate', generateWith(installedAtStart ? modelsV2 : modelsV1), generateHandler)
  server.registerTool(
    'media_status',
    { description: 'The media runtime status.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: 'idle' }] }),
  )
  if (installedAtStart) registerModels()
  server.registerTool(
    'install_model',
    { description: 'Install a new model into the runtime; the tool list changes.', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => {
      if (stateFile !== undefined) writeFileSync(stateFile, name)
      if (!installedAtStart) {
        generate.update({ description: 'Generate an image from a prompt.', paramsSchema: z.object({ prompt: z.string(), model: z.enum(modelsV2).optional() }), callback: generateHandler })
        registerModels()
        server.sendToolListChanged()
      }
      return { content: [{ type: 'text', text: `installed ${name}` }] }
    },
  )
  return server
})
