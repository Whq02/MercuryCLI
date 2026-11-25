interface TokenGrant {
  path: string
  refreshToken: string
  form: Record<string, string>
  headers: Record<string, string>
}

interface RotatingTokenServer {
  readonly base: string
  readonly grants: TokenGrant[]
  live: string | undefined
  status: number
  rotates: boolean
  hold(): () => void
  stop(): void
}

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
}

export function rotatingTokenServer(first: string): RotatingTokenServer {
  const spent = new Set<string>()
  let held: Promise<void> | undefined
  let serial = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const form = Object.fromEntries(new URLSearchParams(await request.text()).entries())
      if (form.grant_type !== 'refresh_token') return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
      const presented = form.refresh_token ?? ''
      stand.grants.push({ path: new URL(request.url).pathname, refreshToken: presented, form, headers: Object.fromEntries(request.headers.entries()) })
      if (held) await held
      if (stand.status !== 200) return Response.json({ error: 'temporarily_unavailable', error_description: 'the stand-in token server is told to fail' }, { status: stand.status })
      if (spent.has(presented)) {
        stand.live = undefined
        return Response.json({ error: 'invalid_grant', error_description: 'refresh token used twice; the grant is revoked' }, { status: 400 })
      }
      if (presented !== stand.live) return Response.json({ error: 'invalid_grant', error_description: 'unknown refresh token' }, { status: 400 })
      serial += 1
      if (stand.rotates) {
        spent.add(presented)
        stand.live = `rt-${serial}`
      }
      return Response.json({
        token_type: 'Bearer',
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, serial }),
        id_token: jwt({ email: 'stand-in@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-stand-in', chatgpt_plan_type: 'plus' } }),
        expires_in: 3600,
        ...(stand.rotates ? { refresh_token: stand.live } : {}),
      })
    },
  })
  const stand: RotatingTokenServer = {
    base: `http://127.0.0.1:${server.port}`,
    grants: [],
    live: first,
    status: 200,
    rotates: true,
    hold() {
      let release: () => void = () => {}
      held = new Promise<void>(resolve => { release = resolve })
      return () => {
        held = undefined
        release()
      }
    },
    stop() {
      void server.stop(true)
    },
  }
  return stand
}
