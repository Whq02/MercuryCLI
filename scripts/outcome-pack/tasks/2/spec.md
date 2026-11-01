# 2 — Greeting command

Stratum: CLI.

Change only `greet.mjs`, a Node command. Exactly one argument is required. Trim JavaScript whitespace from that argument and normalize it to NFC. For a nonempty name, print exactly `hello, <name>\n` to stdout, nothing to stderr, and exit 0. With no argument, two or more arguments, or a name empty after trimming, print exactly `usage: greet <name>\n` to stderr, nothing to stdout, and exit 2. Names are data: preserve case, punctuation, internal spaces, leading hyphens and Unicode. Do not evaluate them as shell input. Any implementation satisfying this interface is permitted.

Leave `check.mjs` and `package.json` unchanged; `npm test` is the ordinary check. Independent acceptance observes stdout, stderr and exit code separately. No additional files or dependencies are needed.

Controls are unified patches against the committed seed with a/ and b/ prefixes, changing only greet.mjs. The fixture applies the patch through the built product's Read and Edit tools, checks through Bash, then settles. Acceptance reads delivered bytes and command effects, not the final answer. A later checked-byte change invalidates the old acceptance.
