---
description: "Service Definition for the persistent-memory capability seam: owns the ctx.memory key as a MemoryRuntime service and delegates scope-typed operations to one active MemoryProvider."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

Service Definition for the persistent-memory capability seam: it owns the `ctx.memory` key as a `MemoryRuntime` service and delegates scope-typed operations to one active `MemoryProvider`. This package owns no storage; providers register into it (for example [`@deepseek-ai/dsh-memory-supermemory`](../memory-supermemory/README.md)) and consumers render results (for example [`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.md)).

## Table of Contents

- [Registration and delegation](#registration-and-delegation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="registration-and-delegation"></a>
## Registration and delegation

`registerMemoryProvider(provider)` makes the new provider active immediately: a later registration replaces the current one, and the returned disposer removes exactly that registration, restoring the provider it displaced. The active provider is always the most recently registered and not-yet-disposed one. An operation with no registered provider throws `MemoryError` code `MEMORY_NO_PROVIDER`.

| Operation | Request | Returns |
|---|---|---|
| `add` | scope and content | the stored `MemoryHit` with the provider-assigned id |
| `search` | scope, query, optional limit | matching hits, capped to `limit`; scopes never mix in one result |
| `remove` | a previously returned `MemoryHit.id` | nothing; deletes the stored memory |
| `profile` | nothing | the user-level profile text, or `''` when nothing is stored |

Scopes are discriminated by kind: `{ kind: 'global' }` addresses user-level memories and `{ kind: 'project'; id: string }` addresses one project partition. Project ids are derived by consumers — [`dsh-tool-memory`](../tool-memory/README.md) derives them from the process working directory — and never by providers; a provider receives the id and partitions storage behind it. A backend that cannot serve throws `MemoryError` code `MEMORY_PROVIDER_UNAVAILABLE`.

<a id="model-experience"></a>
## Model Experience

### Provider data surfaced by the consumer

#### What the model sees

`MemoryHit.content` texts and the `profile()` summary produced by the active provider, rendered only through [`dsh-tool-memory`](../tool-memory/README.md)'s `memory_save`, `memory_search`, and `memory_forget` tool outputs and its `memory-profile` recall section; this package registers no system-prompt section, tool, or other model-visible content.

#### Token effect

Zero direct; every token this seam carries enters a request through the consumer's tool outputs or recall section, sized by provider data and bounded by that consumer.

#### KV Cache effect

None; delegation changes no request prefix. Recall-section placement and provider-data changes belong to the consumer and the active provider.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Single active provider, deliberately** — a later registration replaces the earlier one without arbitration; multi-provider fan-out or precedence rules wait on a demonstrated requirement.
- **No event stream** — the seam emits no events, so recall content is observable only through the assembled prompt, not through a loggable stream.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package owns registration order and delegation only: provider behavior and storage belong to the registered provider package, and model-visible rendering belongs to the consumer package. The active-provider rule (latest registration wins; the disposer restores the displaced provider) is the whole lifecycle contract.

</details>
