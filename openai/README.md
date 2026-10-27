# OpenAI proof of concept

The Canvas implementation remains shared with the Claude Desktop extension. The same compiled stdio MCP server is connected to ChatGPT through Secure MCP Tunnel; an OpenAI plugin wrapper can then reference the registered ChatGPT connection.

This is a private development setup, not a public-plugin deployment. It keeps the Canvas MCP process and token on the local machine, but tool inputs and results still pass through ChatGPT when a tool is used.

## Repository layout

- `src/`, `test/`, and `dist/`: shared MCP server and Canvas behavior
- root `manifest.json`: Claude Desktop MCPB packaging
- `openai/canvas-lms/`: OpenAI plugin metadata and the future ChatGPT connection mapping
- `openai/evals/chatgpt-poc.md`: prompts for checking discovery, selection, confirmation, and privacy behavior

## 1. Verify the shared MCP server

From the repository root:

```bash
npm ci
npm run test:mcp-compat
```

The compatibility test starts the built server with a non-working test Canvas URL, completes MCP initialization, discovers all tools, calls the local version tool, and discovers the bundled MCP prompt. It does not contact a real Canvas instance.

## 2. Prepare the local server environment

Set these only in the shell that will run `tunnel-client`; do not add them to the repository:

```bash
export CANVAS_API_TOKEN="your Canvas API token"
export CANVAS_BASE_URL="https://your-school.instructure.com"
export CONTROL_PLANE_API_KEY="your OpenAI tunnel runtime key"
export OPENAI_TUNNEL_ID="tunnel_..."
```

Create the tunnel and runtime key in OpenAI Platform tunnel settings. The tunnel must be associated with the ChatGPT workspace in which the developer connection will be created.

## 3. Configure Secure MCP Tunnel

Install the current `tunnel-client` from OpenAI Platform tunnel settings or the latest official release. Then, from the repository root:

```bash
npm run build
canvas_repo="$(pwd)"
canvas_node="$(command -v node)"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile canvas-mcp-local \
  --tunnel-id "$OPENAI_TUNNEL_ID" \
  --mcp-command "$canvas_node $canvas_repo/dist/index.js"

tunnel-client doctor --profile canvas-mcp-local --explain
tunnel-client run --profile canvas-mcp-local
```

Keep `tunnel-client run` active while using the connection. It launches the existing stdio server and inherits the Canvas environment variables from the shell.

## 4. Register the connection in ChatGPT

1. In ChatGPT, enable **Settings → Security and login → Developer mode**.
2. Open the ChatGPT Plugins page and create a developer connection.
3. Choose **Tunnel**, then select the configured tunnel or enter `OPENAI_TUNNEL_ID`.
4. Name it **Canvas LMS (local)** and review the discovered tools before saving.
5. Start a new chat, enable the connection from the tools menu, and run the evaluation prompts.

Developer mode and tunnel access depend on the ChatGPT workspace and OpenAI Platform organization permissions.

## 5. Link the optional plugin wrapper

Direct developer-mode testing does not require the wrapper. After ChatGPT creates the MCP connection, its technical ID appears in the browser URL and starts with `plugin_asdk_app`.

To prepare the wrapper:

1. Copy `openai/canvas-lms/.app.json.example` to `openai/canvas-lms/.app.json`.
2. Replace the example ID with the real `plugin_asdk_app...` connection ID.
3. Add `"apps": "./.app.json"` to `openai/canvas-lms/.codex-plugin/plugin.json`.
4. Validate the plugin and add it to a local marketplace only when testing the complete installed-plugin experience.

The real `.app.json` is ignored because it identifies an account-specific developer connection. The tracked example keeps the shared repository reproducible without embedding that identity.

## Public deployment boundary

A public plugin cannot use this private tunnel. It requires a stable public HTTPS MCP endpoint using streamable HTTP and an MCP OAuth 2.1 flow. The Canvas tool implementations can remain shared; transport and authentication should be injected at server startup rather than copied into a second server.
