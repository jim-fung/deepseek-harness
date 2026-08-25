# Agent Note: Review-driven wire, framing, and decode hardening

Status: implemented

English | [中文](2026-08-24-review-hardening-pass.zh.md)

## Problem

A whole-repository review found four defects that sit exactly where no gate watches, plus two model-facing trust gaps:

- `dsh-sdk-jsonrpc-server` double-cast request params to their TypeScript types, so a mismatched or hostile client produced opaque `-32603` failures or sessions keyed by arbitrary values.
- `dsh-mcp-client` registered an external server's advertised `inputSchema` verbatim into every provider request while guarding only its output schema; one schema using unsupported vocabulary could break or steer requests far from the causing server.
- Both subprocess output collectors (`subprocess-local`, `subprocess-e2b`) decoded byte-trimmed windows with bare `toString('utf8')`, so a multibyte character split across incremental reads rendered as U+FFFD — model-visible corruption for non-ASCII output.
- `pluginInventory.list` published deployment-wide module names and enabled/failed state at trusted-host authority while the equally reconnaissance-grade `agentPreset.read` was pinned loopback.
- Skill bodies were embedded verbatim inside the `<skill_content>` wrapper while project directories are default skill roots, so a repository-supplied skill file could forge wrapper or `<system-reminder>` blocks in the prompt.
- Hand-maintained maps had drifted from reality: compiler-face docs named `api/remotes` as the only split package although `api/gateway` and `client/connection` also split, and the package group table omitted `mcp/` and `runtime-diagnostics/` (the latter without a group README).

## Decision

Wire validation lands at the boundary that owns the wire shape. The SDK server validates `initialize` and `session/prompt` params before any handler state changes and rejects them with a typed `InvalidParamsError`; the shared transport forwards a numeric `code` from a thrown handler value onto the error frame, so clients see `-32602` instead of generic `-32603`. Content blocks are checked at their envelope (array of objects with string `type`) — per-type field validation stays with the message factory.

MCP input schemas must satisfy the same enforced JSON Schema subset as outputs. An unsupported input schema has no safe fallback — registering degraded parameters would silently change how the model calls the tool — so exactly that tool is skipped with an error log naming the server and tool; siblings register normally.

Output decoding carries cross-read state: each collector holds a streaming `TextDecoder` plus the byte offset consumed through it. A forward read at exactly that offset feeds only unconsumed bytes with `{ stream: true }`, completing split sequences on the read that finishes them; backward re-reads and lossy reads decode freshly from the requested offset, where a cut inside a sequence may render one U+FFFD. The seam contract documents this.

Privileged-method pinning stays authoritative in `PRIVILEGED_METHODS`; `pluginInventory.list` joined it because publishing the deployment's plugin inventory is the same reconnaissance class as reading a preset composition.

Skill rendering escapes the opening angle bracket of wrapper-vocabulary tags (`skill_content`, `skill_instructions`, `skill_resources`, `system-reminder`) case-insensitively as `&lt;`, leaving every other body byte unchanged: an escaped sequence cannot reproduce the literal framing, while ordinary markup such as `<code>` passes through.

Docs were corrected against the tree: all three split packages are named, the aggregate table lists the leaves they reference, the group table gained `mcp/` and `runtime-diagnostics/`, and `runtime-diagnostics/` received a group README. The `packages/README.md` budget rose 994 → 1007 for the two mandated rows.

## Alternatives considered

**Zod schemas per SDK method (apiproxy style).** Rejected for now: the server's three methods have flat param shapes, and hand validators keep the package free of a new runtime dependency while matching the ACP bridge's precedent.

**Fall back to an unconstrained schema for unsupported MCP inputs.** Rejected: silent degradation moves failures away from the causing server and changes model behavior without a signal. Skipping one tool is loud and bounded.

**Decode output once at stream end.** Rejected: consumers poll incrementally during long-running commands; deferring correct text until exit reintroduces the corruption window the fix removes.

**Escape all `<` in skill bodies.** Rejected: skills legitimately contain markup and code samples; narrowing the escape to wrapper vocabulary keeps bodies faithful while closing the forgery path.

## Consequences

SDK clients can now branch on `-32602`; deployments that relied on lenient params (absent fields defaulting) must send complete params — none of the shipped clients relied on this. An MCP server advertising an unrepresentable schema loses exactly that tool until fixed upstream. Non-ASCII subprocess output is byte-faithful across reads; readers that re-read earlier offsets get fresh decodes and cannot share streaming state. Loopback-only `pluginInventory.list` narrows what a LAN client can enumerate. Skill bodies containing literal framing tokens render visibly escaped in prompts — a model-visible change bounded to those tokens. The two pre-existing maxTokens rejection tests moved from the handler contract to the wire contract with the `-32602` message.
