# What a package can bring with it

An `openmaus.package` describes a team: its bots, rooms, playbooks, paused
routines, and skills. It can also declare the **workspace capabilities**
those bots need in order to do what the package claims — the tool servers
they call and the skill catalogs their skills come from.

Without this, importing a package produced bots that referred to tools the
workspace did not have, and the recipient had to reconstruct them by reading
the description.

## What a package carries — and what it never carries

Capabilities travel as **definitions**. A package holds the command or URL
and the **names** of the variables and headers a server reads. It never
holds a value, a token, or a header's contents: a format that could carry a
secret is a format that leaks one.

```yaml
mcpServers:
  - transport: stdio
    name: tickets
    reason: Reads the tracker so the triage bot can quote a ticket.
    command: npx
    args: ["-y", "@acme/tickets-mcp"]
    envKeys: [TICKETS_TOKEN]          # the NAME; never the token
  - transport: http
    name: docs
    reason: Looks up the internal handbook.
    type: http                        # http | sse
    url: https://docs.acme.test/mcp   # https only
    headerKeys: [Authorization]       # the NAME; never the header

catalogs:
  - id: acme
    name: Acme skills
    url: https://acme.example/skills.json
```

- a server `name` follows the workspace's own rule (1–32 lowercase letters,
  digits, `_` or `-`, starting with a letter), so a package cannot declare a
  server the workspace would then refuse to store;
- `envKeys` must look like environment variable names, which is what makes
  `NOTES_TOKEN=secret` a validation error rather than a leak;
- at most 20 servers and 10 catalogs per package.

## What installing does

| declaration | result |
| --- | --- |
| a new MCP server | written to `mcpServers` with empty values and **`enabled: false`** |
| a name already configured | **left exactly as it is**, and reported as skipped |
| the workspace already at its server cap | skipped, and reported |
| a new catalog | appended to `marketplaces` |
| a catalog id already listed | left as it is |

An MCP server lands off because the values are the person's to supply: they
fill them in through the normal settings flow and switch the server on. A
package never replaces a server someone configured — the secrets in it are
theirs.

Catalogs are pointers, so adding one grants nothing; see
[skill catalogs](./skill-catalogs.md).

The import response reports what happened, so the install screen can say
what is now waiting for values:

```json
{ "capabilities": { "mcpServers": ["tickets", "docs"], "catalogs": ["acme"], "skipped": ["notes"] } }
```

## Exporting

`POST /api/teams/export` with `format: "package"` includes the workspace's
MCP servers (through `portableMcpServers`, which keeps key names and drops
every value) and its configured catalogs. Disabled servers are exported too:
a definition is still worth sharing.

The shareable Markdown gets a **Tool servers (MCP)** section and a **Skill
catalogs** section, each saying plainly that the file carries names only and
that servers arrive off.

Implementation: schema in `server/bot-package.ts`, export in
`server/package-export.ts`, install in the `/api/teams/import` handler in
`server/index.ts`.
