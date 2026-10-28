# Mercury as an MCP server

`mercury mcp-server` lets another agent run work in a Mercury project,
read session rows, send a message to a live session and search project memory.
It uses Mercury's SDK and the models and accounts configured in Mercury.
Model calls spend the same account usage as other Mercury sessions.

Start it from the project directory. The folder must already be trusted in
Mercury; open `mercury` there and accept the workspace trust question first.

## Local clients: stdio

Configure the client's MCP server command as `mercury`, with arguments
`["mcp-server"]`, and set its working directory to the project. For example,
run this from the project directory to add it to Codex:

```sh
codex mcp add mercury -- mercury mcp-server
```

The default transport is stdio. Standard output carries MCP messages; errors
go to standard error. The local client starts and stops the process.

Choose a model and permission mode at startup when needed:

```sh
mercury mcp-server --model <model-id> --mode default
```

Use a model id shown by Mercury's `/model` menu. Omitting `--model` uses
Mercury's configured model. `--effort` accepts Mercury's usual effort levels.

## Remote clients: Streamable HTTP

```sh
mercury mcp-server --transport http --port 8787
```

The endpoint is `http://127.0.0.1:8787/mcp`. The command prints a newly generated
bearer token once to standard error at startup. Every HTTP request, including
discovery, must carry `Authorization: Bearer <token>`.

For a token that survives restarts, create a private file outside the served
project, then pass its path. On macOS or Linux:

```sh
umask 077
mkdir -p "$HOME/.config"
openssl rand -hex 32 > "$HOME/.config/mercury-mcp.token"
mercury mcp-server --transport http --token-file "$HOME/.config/mercury-mcp.token"
```

The file must contain at least 32 token characters. On macOS and Linux its
permissions must exclude other users, such as mode `600`. The command does
not print a token read from a file. Keep the token in the client's secret
configuration, outside prompts and shared configuration files. Stop the
server and replace the file to rotate it.

HTTP listens on `127.0.0.1` unless `--bind <address>` explicitly selects another
address. Keep the loopback default when using a tunnel. The server checks
Host and Origin headers as well as the token.

## Give a bot the tunnel URL

With ngrok installed and signed in, start a tunnel in another terminal:

```sh
ngrok http 8787
```

Copy its HTTPS forwarding origin. If it is
`https://example.ngrok-free.app`, start Mercury with:

```sh
mercury mcp-server --transport http --port 8787 --origin https://example.ngrok-free.app
```

The bot's server URL is **`https://example.ngrok-free.app/mcp`**. Replace the
example origin with the one your tunnel assigned. Configure its bearer token
separately. Keep both processes running. `--origin` permits that public
origin without changing the loopback listen address.

A [Grok custom MCP connector](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)
can reach a public HTTPS server. Point its connector, or an authenticated MCP
client used by a [Grok Bot routine](https://docs.x.ai/grok-bot/skills-routines-and-automations),
at the tunnel URL. The calling client must send the bearer header. A routine
can request work with `mercury_run` and read later messages with
`mercury_session_rows`.

A [GPT dot uses installed plugins](https://learn.chatgpt.com/docs/dots/computers-and-apps.md).
Its MCP plugin would use the same tunnel URL. ChatGPT's hosted plugins
[expect OAuth 2.1](https://developers.openai.com/plugins/build/auth), so they
need an authentication gateway that validates that sign-in and forwards
requests with Mercury's bearer token. Mercury's server does not implement
that OAuth flow. A compatible local MCP client can use stdio or bearer HTTP
directly.

Neither bot has a public inbound conversation API today. Grok Bot's webhook
triggers start routines; they are separate from a conversation API. Mercury's
MCP server supplies the half we control: a bot calls Mercury's tools and
reads their results. Bot-side plugin installation, scheduling, authentication
and notifications remain with the bot's platform.

## Tools

The examples below are tool arguments. Session ids are UUIDs returned by
`mercury_run` or `mercury_sessions`.

### `mercury_run`

Run a prompt in a fresh session:

```json
{"prompt":"Explain this project's test setup.","title":"Test setup","mode":"default"}
```

Optional fields are `session_id`, `title`, `model` and `mode`. Supply
`session_id` to continue a saved session; use `mercury_send` if another
process already runs it. The result includes the session id, status and SDK
rows. A non-completed status remains a non-completed result.

### `mercury_session_rows`

```json
{"session_id":"00000000-0000-4000-8000-000000000001","limit":20}
```

Reads the last rows, with a default of 50 and a maximum of 200 per call.
`before` reads earlier rows; pass a returned `next_before` value to continue.
Sessions hosted by this server return SDK stream rows. Other saved sessions
return transcript rows, identified by `source`. A response keeps whole rows
within 100,000 characters. `oversized_row` identifies a row too large for that
response; its saved conversation is available through transcript resources.

### `mercury_sessions`

```json
{}
```

Lists saved sessions in this project with ids, modification times and live
status. A session in another project is outside this server's scope.

### `mercury_send`

```json
{"session_id":"00000000-0000-4000-8000-000000000001","sender":"review-bot","message":"Please inspect the failing parser test."}
```

Delivers a user-shaped message prefixed with its sender's name. The name is
attribution supplied by the authenticated caller. A successful response means
the session accepted the message; read its rows for the answer. Supply a
`message_id` UUID and reuse it when retrying the same delivery.

### `mercury_recall`

```json
{"query":"parser design","limit":10}
```

Searches project memory for pointers to facts and session notes. `limit` is
optional, defaults to 12 and cannot exceed 20. It does not write memory.

## Resources and permissions

MCP resource discovery lists the project's `mercury://` record kinds. Read
them using the same references as Inspect, for example
`mercury://transcript/session/<session-id>` or `mercury://project/current`.
Resources are read-only. File references must remain inside the project and
follow Mercury's file-read permission rules.

The server uses Mercury's saved permission mode, or `default` when none is
saved. Choose `--mode` at startup to select another. A tool's `mode` must
match the server's mode; it cannot raise permissions remotely. Sending a
message into an existing session does not change its mode, model or permission
rules. Session settings and policy still
apply to every tool call.

During `mercury_run`, permission requests use the SDK's normal permission
channel and appear as confirmation forms in an MCP host that supports them.
Only an explicit approval allows the pending action. A denial, cancellation
or host without permission forms grants nothing. A message sent with
`mercury_send` uses the live session's existing permission channel; an idle
session hosted by this server has no waiting call to answer a new permission
request, so that request is denied. Use `mercury_run` when you need to answer
its permission requests.

Stopping the server closes the SDK sessions it hosts. Their saved
conversations remain available for a later run. Sessions already hosted by
Mercury's background daemon keep their own lifetime.
