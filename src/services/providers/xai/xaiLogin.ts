export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
export interface XaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export async function storeXaiApiKeyLogin(
  _key: string,
  _io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<XaiKeyLoginOutcome> {
  return {
    ok: false,
    stored: false,
    receipt: 'xAI key login is not wired in this tree (stub) — nothing was stored.',
  }
}
