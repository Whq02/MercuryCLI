;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const mode = process.argv[2]
const { enableConfigs } = await import('../../../src/utils/config.ts')
enableConfigs()
const oauth = await import('../../../src/services/providers/nous/nousOauth.ts')
if (mode === 'refresh') {
  const before = oauth.nousStoredTokens()
  let error: string | undefined
  let after: Awaited<ReturnType<typeof oauth.refreshNousTokens>>
  try {
    after = await oauth.refreshNousTokens(undefined, true)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  console.log(JSON.stringify({ beforeRefresh: before?.refreshToken, afterRefresh: after?.refreshToken, afterAccess: after?.accessToken, stored: oauth.nousStoredTokens()?.refreshToken, error }))
} else {
  const { resolveProviderUsability } = await import('../../../src/services/providers/providerUsability.ts')
  const { resolveNousAccount } = await import('../../../src/services/providers/nous/nousAccounts.ts')
  const { getNousAvailability } = await import('../../../src/services/providers/nous/nousCatalogue.ts')
  const { deriveFamilySlotGroups } = await import('../../../src/services/providers/accountSlots.ts')
  const refusal = oauth.nousSigninRefusal()
  const lane = resolveProviderUsability().nous
  const slot = deriveFamilySlotGroups().flatMap(group => group.slots).find(s => s.id === 'nous:signin')
  console.log(JSON.stringify({ refusal: refusal ? { status: refusal.status, code: refusal.code } : null, account: resolveNousAccount(), usable: lane.usable, blockers: lane.blockers, availability: getNousAvailability(), slotNote: slot?.stateNote, slotSignedIn: slot?.signedIn }))
}
