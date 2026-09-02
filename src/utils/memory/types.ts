export const MEMORY_TYPE_VALUES = [
  'User',
  'Project',
  'Local',
  'Managed',
  'AutoMem',
  // Type-only widen to the pre-fold union: `false as boolean` keeps the
  // ternary's TYPE the union of both branches (so 'TeamMem' comparisons stay
  // legal in fork surfaces) while the RUNTIME value folds to [] exactly as
  // every dist shipped the same canonical form.
  ...((false as boolean) ? (['TeamMem'] as const) : []),
] as const

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number]
