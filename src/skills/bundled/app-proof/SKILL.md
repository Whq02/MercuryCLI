---
name: app-proof
description: Use when proving a web journey with Mercury's Browser and Service tools. Not for unit tests.
argument-hint: "<url or start command> [journey]"
---
# App proof

Turn the requested journey into a starting state, actions and an observable result. Include a failure case; an HTTP 200 is not proof of a working page.

Use `Service` for a server you start: declare readiness, `wait`, then inspect `logs` if it fails. Mercury's `Browser` tool is the default driver; never hand-roll a headless-Chrome harness. Check `status`; a missing browser needs consented `provision`, not a substitute driver.

Open the target and read `extract` with `mode:"tree"` before acting. Respect origin consent; credentials go through `secretRef`, never plain text. Wait for the result's data, not just a heading, then capture it. Check a narrow viewport and read `console` on failure.

For uploads, multiple tabs or iframe actions beyond Browser's scope, extend the project's existing test suite. A permission refusal is not an escape hatch.

Report each journey's expected and observed result with its screenshot or test output. Separate application failures, unavailable tooling and untested paths.
