---
description: "Opt-in hosted-memory profile bundle for dsh: persistent memories stored at supermemory.ai, reachable from every session that enables the bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-supermemory

English | [中文](README.zh.md)

## Summary

The opt-in hosted-memory profile bundle: persistent memories stored at [supermemory.ai](https://supermemory.ai), reachable from every session that enables the bundle. [`cordis.patch.yml`](cordis.patch.yml) is the package's substance, declared by the `dsh.bundle.patch` manifest field; the patch inserts three rows over the base composition and modifies nothing already there, so profiles without this bundle are untouched. Without a key or with `api.supermemory.ai` unreachable, recall degrades to logged warnings while `memory_*` tool calls fail with structured `MemoryError` results.

## Table of Contents

- [Bundle composition](#bundle-composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="bundle-composition"></a>
## Bundle composition

| Row | Package | Contribution |
|---|---|---|
| `memory` | `@deepseek-ai/dsh-memory` | The `ctx.memory` seam ([README](../../memory/memory/README.md)). |
| `memory-provider` | `@deepseek-ai/dsh-memory-supermemory` | The supermemory.ai provider, configured with `containerTagPrefix: dsh` ([README](../../memory/memory-supermemory/README.md)). |
| `tool-memory` | `@deepseek-ai/dsh-tool-memory` | The memory tools, guidance section, and recall ([README](../../memory/tool-memory/README.md)). |

Enable it through the profile's bundle list; the patch applies after the base bundles it follows:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-supermemory"]
    }
  }
}
```

The provider row resolves the API key per operation (credentials service, launch environment, or the read-only Codex credentials file). Without a key or with `api.supermemory.ai` unreachable, recall degrades to logged warnings with the section omitted, while `memory_*` tool calls fail with structured `MemoryError` results.

<a id="model-experience"></a>
## Model Experience

### Composed memory context

#### What the model sees

Exactly what the inserted rows' packages register: [`dsh-tool-memory`](../../memory/tool-memory/README.md)'s `tool:memory` guidance section, its `memory_save`, `memory_search`, and `memory_forget` tools, and its `memory-profile` recall section; this bundle adds no model-visible content of its own.

#### Token effect

Zero direct; the composed rows own every token, as documented in their READMEs.

#### KV Cache effect

Adding or removing this bundle from a profile changes the composed request prefix from the next session on; the bundle itself owns no prefix mutation.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Requires a supermemory account and reachable `api.supermemory.ai`** — without a key every memory operation fails; during an outage recall degrades to logged warnings with the section omitted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle owns only the patch manifest and this documentation; every behavior it composes is owned by the three inserted rows' packages. Review feature changes there, and change this package only when the row set, row order, or provider configuration changes.

</details>
