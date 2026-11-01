import { drive, patchScript, type Change, type Context } from '../../runtime.ts'

export async function script(ctx: Context, changes: Change[]): Promise<void> {
  await drive(ctx, patchScript(ctx, changes))
}
