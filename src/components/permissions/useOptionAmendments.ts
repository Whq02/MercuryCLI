import { useCallback, useMemo, useState } from 'react'

type Amendment = { open: boolean; text: string }

type Amendments<Role extends string> = Record<Role, Amendment>

const CLOSED: Amendment = { open: false, text: '' }

const blank = (text: string): boolean => text.trim() === ''

function allClosed<Role extends string>(roles: readonly Role[]): Amendments<Role> {
  return Object.fromEntries(roles.map(role => [role, CLOSED])) as Amendments<Role>
}

function withRole<Role extends string>(
  amendments: Amendments<Role>,
  role: Role,
  change: (current: Amendment) => Amendment,
): Amendments<Role> {
  return { ...amendments, [role]: change(amendments[role]) }
}

export function useOptionAmendments<Role extends string>(roles: readonly Role[]) {
  const [amendments, setAmendments] = useState<Amendments<Role>>(() => allClosed(roles))

  const isRole = useCallback((option: string): option is Role => roles.includes(option as Role), [roles])

  const setText = useCallback(
    (role: Role, text: string) => setAmendments(current => withRole(current, role, amendment => ({ ...amendment, text }))),
    [],
  )

  const toggle = useCallback(
    (role: Role) =>
      setAmendments(current => withRole(current, role, amendment => ({ ...amendment, open: !amendment.open }))),
    [],
  )

  const collapseAwayFrom = useCallback(
    (kept: string) =>
      setAmendments(current =>
        roles.reduce((state, role) => {
          const { open, text } = state[role]
          const leaves = role !== kept && open && blank(text)
          return leaves ? withRole(state, role, amendment => ({ ...amendment, open: false })) : state
        }, current),
      ),
    [roles],
  )

  return useMemo(
    () => ({ amendments, isRole, setText, toggle, collapseAwayFrom }),
    [amendments, isRole, setText, toggle, collapseAwayFrom],
  )
}
