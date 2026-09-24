#!/usr/bin/env bun

export {}

const key = process.env.ZAI_API_KEY?.trim()
if (!key) {
  process.stderr.write('ZAI_API_KEY is required; no request was sent.\n')
  process.exit(2)
}

const controller = new AbortController()
const deadline = setTimeout(() => controller.abort(), 30_000)
const redact = (value: string): string => value.split(key).join('[redacted]')

try {
  const response = await fetch('https://api.z.ai/api/coding/paas/v4/chat/completions', {
    method: 'POST',
    redirect: 'manual',
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1,
      stream: true,
    }),
  })
  for (const [name, value] of response.headers) {
    const hidden = /authorization|authenticate|cookie|secret|api[-_]?key|(?:^|[-_])token(?:$|[-_])|location/i.test(name)
    process.stdout.write(`${redact(name)}: ${JSON.stringify(hidden ? '[redacted]' : redact(value))}\n`)
  }
  process.exitCode = response.ok ? 0 : 1
  void response.body?.cancel().catch(() => {})
} catch {
  process.stderr.write('Header request failed or timed out; no retry was sent.\n')
  process.exitCode = 2
} finally {
  clearTimeout(deadline)
  controller.abort()
}
