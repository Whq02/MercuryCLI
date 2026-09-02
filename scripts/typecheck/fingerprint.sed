# Fingerprint normalization — the SINGLE source of truth for what makes two tsc
# diagnostics "the same" for the ratchet (used by run-all.sh and regen-baseline.sh).
# A fingerprint must be invariant under things that churn between runs but don't
# change the actual problem, or the gate flakes RED on noise.

# 1. drop the (line,col) position — edits above a diagnostic shouldn't churn it.
s/\(([0-9]+),([0-9]+)\)//

# 2. TS2460 "declares 'X' locally, but it is exported as 'Y'": the 'Y' is whichever
#    colliding re-export TS resolves first — resolution-order-dependent, varies run
#    to run (e.g. agentSdkTypes barrel: 'SDKControlRequest' one run, 'Settings' the
#    next) for the SAME ambiguity. Normalize the exported-as name.
s/but it is exported as '[^']*'/but it is exported as '~'/

# 3. `typeof import("<abs path>")` embeds an absolute path, which differs between a
#    worktree agent's run and the main-repo baseline. Normalize the path so worktree
#    self-checks compare apples-to-apples against the committed baseline.
s/typeof import\("[^"]*"\)/typeof import("~")/g

# 4. Long union prints elide the tail as "... N more ..."; N shifts when any member
#    is added/removed elsewhere, churning unrelated diagnostics. Normalize the count.
s/\.\.\. [0-9]+ more \.\.\./... ~ more .../g
