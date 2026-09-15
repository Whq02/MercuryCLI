---
name: app-proof
description: Use when proving web app journeys with Mercury's Browser tool or checking APIs. Not for unit tests.
argument-hint: "<url or start command> [journey]"
---
# App proof

## Prepare
- Start persistent processes with the Service tool; use Bash for finite commands.
- Use Service readiness conditions and `wait`; inspect ordered `logs` on failure.
- Define success, failure and narrow-screen journeys with observable results.
- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Probe status/title/forms/links with `node "${MERCURY_SKILL_DIR}/scripts/app_probe.mjs" page <url>`; use `wait <url> --timeout-ms 60000` for an HTTP probe, or `--self-test` to test the helper.
- Treat probe error-text matches as hints, not application failures.

## Drive
- Mercury's `Browser` tool is the default driver; never hand-roll a headless-Chrome harness.
- Check `op:"status"`; if unavailable, request consented `op:"provision"`.
- Open the URL; obtain approval for each origin.
- Read `op:"extract" mode:"tree"`; copy its `aria/` selectors.
- Drive `type`, `click`, `waitFor`, then `screenshot` with a journey label.
- Use `state:"hidden"` to wait for disappearance; inspect named deadlines, disabled targets or occluders before retrying.
- Read Browser `console` when a page misbehaves.
- Fill test-account credentials through operator-registered `secretRef`, with separate secret/origin consent; never pass credentials as `text`.
- Extend an existing Playwright suite; use Playwright for multi-page, upload or iframe journeys beyond Browser's scope.

## Verify
- Assert API status, response shape and a negative case.
- Use Test for supported frameworks or declared runner profiles, not arbitrary browser scripts.
- Restart after rebuilds; confirm the expected version and test count.
- Wait for loaded data, not early text.
- Report driven journeys, passes, exact failed observables, exclusions and screenshots.

## Sources
Checked: 2026-09-15. [Mercury tools](https://github.com/Whq02/MercuryCLI/tree/fc81e29e4129a56b1bfb3beca9819ebfb29875f9/src/tools), [Playwright](https://playwright.dev/docs/intro).
