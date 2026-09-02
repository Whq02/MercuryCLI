#!/usr/bin/env node

import { createInterface } from 'node:readline'

const out = line => process.stdout.write(`${JSON.stringify(line)}\n`)
const SESSION_ID = 'fake-seat-session-0001'
let announced = false

const rl = createInterface({ input: process.stdin })
rl.on('line', raw => {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    out({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          commands: [{ name: 'fake', description: 'a fixture command' }],
          agents: [],
          models: [{ id: 'fake-model' }],
        },
      },
    })
    return
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    out({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: {} },
    })
    return
  }
  if (msg.type === 'user') {
    if (!announced) {
      announced = true
      out({ type: 'system', subtype: 'init', session_id: SESSION_ID, tools: [], model: 'fake-model' })
    }
    out({
      type: 'assistant',
      session_id: SESSION_ID,
      message: {
        id: `msg_fake_${Date.now()}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'acknowledged' }],
      },
    })
  }
})
