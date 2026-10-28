# Mercury as an MCP server

`mercury mcp-server` lets another agent submit outside reports, read session
rows and search project memory. It uses Mercury's SDK and configured model
accounts. Model calls spend the same account usage as other Mercury sessions.
Start it from a project folder already trusted in Mercury.

A client is treated as nothing but outside reports, in every context, so it
cannot be used to prompt Mercury. It is never the operator: it cannot start
work, answer as the operator, override a standby, wait or stop, run a slash
command, or approve a permission request. A delivered report does not wake an
idle session. Its text is untrusted, including any commands or tool syntax.
The screen shows **Outside report from {sender}**, with the body below it.
When allowed to run, a client can only open or continue its own report-reading
sessions; it cannot enter an operator's session.

## Client tokens and reach

Keep a private JSON file outside the served project. Each client has its own
name and bearer token. For example:

```json
{
  "clients": [
    {
      "name": "review-bot",
      "token": "<unique random token, at least 32 characters>",
      "run": true,
      "send": ["lead", "coordinator", "00000000-0000-4000-8000-000000000001"]
    },
    {
      "name": "status-bot",
      "token": "<a different random token, at least 32 characters>",
      "run": false,
      "send": ["lead"]
    }
  ]
}
```

Replace the example tokens and session id. `openssl rand -hex 32` generates a
suitable token. On macOS and Linux, protect the file with `chmod 600`.
Names and tokens must be unique. Keep tokens in client secret configuration,
not in prompts or shared files. Restart the server after changing the file.

`run` defaults to `false`; `send` defaults to an empty list. A session UUID
allows reports to that session only. `lead` resolves to the session that
started the server when it can be identified, or the id passed with `--lead`.
`coordinator` requires `--coordinator`. An unresolved role refuses startup.
The client cannot choose these role bindings or claim another sender's name.
Creating a session does not add it to the client's send list.

## Local clients: stdio

```sh
mercury mcp-server --token-file "$HOME/.config/mercury-mcp.json" --client review-bot
```

Configure the MCP client's command as `mercury`, pass those arguments, and set
its working directory to the project. `--client` selects a name from the
file; with one client it may be omitted. The local client starts and stops the
process. Standard output carries MCP messages; errors go to standard error.
The name a client declares in the MCP handshake does not change its reach.

For Codex, run from the project directory:

```sh
codex mcp add mercury -- mercury mcp-server --token-file "$HOME/.config/mercury-mcp.json" --client review-bot
```

## Remote clients: Streamable HTTP

```sh
mercury mcp-server --transport http --port 8787 --token-file "$HOME/.config/mercury-mcp.json" --lead SESSION_ID --coordinator COORDINATOR_ID
```

Replace the role ids with the sessions you intend to receive reports.
The endpoint is `http://127.0.0.1:8787/mcp`. Every HTTP request, including
discovery, must carry `Authorization: Bearer <that client's token>`.
The command never prints tokens read from a file.

Without `--token-file`, HTTP generates and prints one bearer token to standard
error at startup. This default client is named `mcp-client` and has no run or
send grant. Use a token file to give a client reach. Stdio without a file has
the same empty reach.

HTTP listens on `127.0.0.1` unless `--bind` explicitly selects another address.
The server checks Host and Origin headers as well as the token.

## Models and permissions

`--model` chooses a model shown by Mercury's `/model` menu; omitting it uses
Mercury's configured model. `--effort` accepts Mercury's usual effort levels.

`--max-mode` sets the permission ceiling for client-owned sessions. Its words
are `default`, `dontAsk`, `implement`, `sovereign`, `flow` and `apollo`. Omitted,
it uses the normal headless mode resolution. A requested mode cannot exceed
the ceiling; modes that cannot be safely ordered must match it. An existing
client session keeps its mode. Permission requests are denied; they are never
sent to the outside client for approval. Mercury's policy still applies.

## Tools

All tool arguments reject unknown fields. Session ids are UUIDs.

- **`mercury_run`**: `prompt` contains an outside report. Optional fields:
  `session_id`, `title`, `model`, `mode`. With a run grant, Mercury reads the
  report in a fresh client-owned session, or continues a session previously
  created by that same named client. The result includes its client name,
  session id, status and SDK rows. Ownership survives server restarts.
- **`mercury_session_rows`**: `session_id`, optional `limit` (1–200; default
  50) and `before`. Reads rows from a client-owned session or a send target.
  `next_before` pages backwards. `source` distinguishes SDK stream rows from
  saved transcript rows. Whole rows fit within 100,000 characters;
  `oversized_row` identifies a row too large for a response.
- **`mercury_sessions`**: `{}` lists saved project sessions within the
  client's reach. Client-owned sessions carry the client's name.
- **`mercury_send`**: `session_id`, `sender`, `message`, optional `message_id`.
  The sender must equal the authenticated client's name and the target must
  be on its send list. Reuse a `message_id` UUID when retrying the same
  delivery. Acceptance means the outside report is queued, and says nothing about
  whether work started. The session reads it at a normal reading boundary.
- **`mercury_recall`**: `query`, optional `limit` (1–20; default 12). Searches
  project memory for pointers. It never writes memory.

Read-only resources use Inspect's `mercury://` references. File resources stay
inside the project and follow file-read permission rules. Transcript reads
are limited to sessions within the client's reach.

## Give a bot the tunnel URL

With ngrok installed and signed in, start a tunnel in another terminal:

```sh
ngrok http 8787
```

If its forwarding origin is `https://example.ngrok-free.app`, start Mercury
with `--origin https://example.ngrok-free.app` in addition to the HTTP command
above. The bot's server URL is **`https://example.ngrok-free.app/mcp`**. Use the
origin your tunnel assigned, configure the client's token separately and keep
both processes running. Keep Mercury's loopback listen address.

A [Grok custom MCP connector](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)
or an authenticated MCP client used by a
[Grok Bot routine](https://docs.x.ai/grok-bot/skills-routines-and-automations)
can submit reports at that URL. It must send its own bearer header.

A [GPT dot uses installed plugins](https://learn.chatgpt.com/docs/dots/computers-and-apps.md).
ChatGPT's hosted plugins [expect OAuth 2.1](https://developers.openai.com/plugins/build/auth),
so they need an authentication gateway that validates that sign-in and
forwards requests with the correct client's Mercury token. This server does
not implement that OAuth flow.

Neither bot has a public inbound conversation API today. Grok Bot's webhook
triggers start routines; they are separate from a conversation API. Mercury
supplies the receiving half. Bot-side installation, scheduling, authentication
and notifications remain with the bot's platform.

Stopping the server closes its client-owned SDK sessions. Their saved
conversations remain. Sessions hosted by Mercury's daemon keep their own
lifetime; a report never restarts a stopped session.
