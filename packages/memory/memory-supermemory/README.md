# @deepseek-ai/dsh-memory-supermemory

English | [中文](README.zh.md)

A [supermemory.ai](https://supermemory.ai)-backed `MemoryProvider` for the harness [memory capability seam](../memory/README.md) (`ctx.memory`). This is an implementation package: a function plugin (`inject: ['memory']`) that registers provider `memory-provider:supermemory` into the seam owned by [`@deepseek-ai/dsh-memory`](../memory/README.md); it registers no model-facing tool (that is [`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.md)).

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `SUPERMEMORY_API_KEY` | Credential reference naming the environment variable that carries the API key. |
| `baseURL` | `https://api.supermemory.ai` | Endpoint base; the `/v3/documents`, `/v4/search`, and `/v4/profile` paths are appended. |
| `containerTagPrefix` | `dsh` | Prefix for the container tags that partition scopes remotely. |

The API key resolves at each operation and is never cached: the credentials service resolves the reference when mounted, otherwise the launch environment variable supplies it, and the read-only `~/.codex/supermemory/credentials.json` (the Codex plugin's login file, never written by dsh) is the final fallback. When no source yields a usable key, the operation throws `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE` naming every consulted source; a session boots without touching the network or the secret store.

## Remote mapping

Scope identity travels entirely in container tags, the only partition the remote API offers: `global` maps to `<prefix>-global` and `project` to `<prefix>-project-<slug>`, where the slug keeps the project id's ASCII alphanumerics lowercased and joined by single hyphens (`unnamed` when nothing survives). `add` posts one document to `/v3/documents`; `search` posts to `/v4/search` and keeps documents carrying both id and content; `remove` deletes `/v3/documents/<id>` and treats HTTP 404 as success; `profile` reads `/v4/profile`. Any other non-2xx response throws `MEMORY_PROVIDER_UNAVAILABLE`; an add response without a document id throws `MEMORY_REQUEST_INVALID`.

## Model Experience

### Provider data surfaced by the consumer

#### What the model sees

Stored and retrieved texts produced by `memory-provider:supermemory` — `MemoryHit.content` values and the `/v4/profile` summary — rendered only through [`dsh-tool-memory`](../tool-memory/README.md)'s tools and recall section; this provider registers no system-prompt section or tool of its own.

#### Token effect

Zero direct; tokens enter requests only through the consumer, sized by remote search hits and the profile summary.

#### KV Cache effect

None; the provider changes no request prefix. A changed remote profile alters the consumer's recall section from the next assembly on.

## Known Limitations and Deferred Work

- **Wire shapes are unpinned externally** — the vendor request and response fields are owned by [`src/client.ts`](src/client.ts) with the self-skipping real-API e2e (`tests/supermemory.e2e.ts`) as the drift alarm; nothing outside the package may depend on them.
- **Project slugs can collide** — slugification drops case and separators, so paths differing only by case or separator characters address one shared remote container.
- **The Codex credentials file is never written** — dsh reads it as a fallback and leaves login, logout, and refresh to the Codex plugin.
