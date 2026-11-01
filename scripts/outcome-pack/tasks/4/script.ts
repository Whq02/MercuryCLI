import { delayedCheck } from '../../ordering.ts'
import type { Change, Context } from '../../runtime.ts'

export async function script(ctx: Context, changes: Change[]): Promise<void> {
  await delayedCheck(ctx, changes)
}
