# @querylens/mcp

QueryLens's engine as a [Model Context Protocol](https://modelcontextprotocol.io) server. Your coding assistant can run
a SQL query against the toy engine, read its step-by-step trace, and ask which buffer policy keeps a page. Nothing
leaves your machine: the server runs the engine locally, over stdio.

Add it to an MCP-capable client, for example:

```json
{
  "mcpServers": {
    "querylens": {
      "command": "npx",
      "args": ["-y", "@querylens/mcp"]
    }
  }
}
```

It runs the same engine as the website, and its numbers are true to this engine, not to PostgreSQL, MySQL or any
production system.

## Stability

This is a `0.x` release. The tool names and their arguments may change between minor versions; pin an exact version
in the client configuration if a workflow depends on them.

## Licence

MIT. See `LICENSE`.
