# Agent Note: Advisory cwd hint on revision probes

Status: implemented

English | [中文](2026-08-25-revision-probe-cwd-hint.zh.md)

## Problem

Every revision-freshness probe (`PersistenceBackend.readStoredRevision`) resolved the session id by scanning every project directory under the root — one `readdir` of the root plus roughly eight filesystem probes per project — although the probing caller, the coordinator validating a cached preparation, already holds the stored header's `cwd`, and preparation's identity validation has already bound that cwd to the artifact path. The JSONL layout is deterministic given (root, cwd, id), so the scan re-derives a fact the caller already knows.

These probes sit on hot paths: cached `inspect()` freshness re-checks behind every session-query tool hit and subagent child listing, apiproxy cold adoption, cold-load `commitPrepared`, and twice per fresh-session boot. A shared root with many projects paid the full scan on each hit.

## Decision

`PersistenceBackend.readStoredRevision` gained an optional trailing `hint?: StoredRevisionHint` parameter carrying `{ cwd }`. Trailing position (after `signal`) keeps every existing implementer source-compatible: implementations that ignore the hint need no change.

The JSONL backend stats `logPath(root, cwd, id)` first and returns that stat-derived revision on hit; a hinted ENOENT — wrong or moved cwd — falls back to the unchanged full `findLog` scan, so cross-cwd discovery semantics are preserved wherever callers rely on them. The SQLite backend accepts and ignores the hint: one database keys sessions by id, so its row lookup was already direct.

The coordinator threads the hint from the single choke point `isPreparedSourceCurrent`, which covers both probe callers (the `inspect()` freshness re-check and cold-load `commitPrepared`). The create-collision probe in `createCore`, `loadStored` itself, and `seedMatchesPersisted` deliberately keep the full scan: finding an artifact under ANY storage scope must block creation or drive adoption, and a preparation's cwd is unknown before the artifact is read.

No path memoization was added: after the coordinator threads the hint, the only hintless revision reads are tests, so a positive id-to-path cache would add invalidation surface for no reachable caller.

The hint is advisory by contract: a backend must resolve the id identically without it, a miss falls back to full discovery, and no correctness may depend on the hint being right.

## Alternatives considered

**Memoize id to path from successful `findLog`/`listArtifacts` resolutions.** A positive-only cache validated by stat on use still pays one stat per probe and adds shared mutable state plus invalidation reasoning across backends; the hint supplies the authoritative cwd directly, so the cache buys nothing on the hot path.

**Extend `loadStored` with the same hint.** `loadStored` callers either do not know the cwd yet (the cold read that discovers the artifact) or must NOT trust one scope (the create-collision probe and seed matching, where an artifact under any scope changes the outcome). No `loadStored` caller has an authoritative cwd, so the parameter would be dead.

**Pass a bare `cwd: string | undefined` instead of a `StoredRevisionHint` interface.** A named interface gives the advisory contract one JSDoc home at the seam and lets a future advisory field arrive without reshaping every signature.

## Consequences

A freshness probe with a correct cwd — the common case, because the stored header owns the artifact location — costs one `stat` instead of a root scan, and session-query hits, subagent listings, apiproxy adoption, and session boots stop scaling with the number of projects sharing a root. A wrong or moved cwd costs one extra ENOENT stat before the unchanged scan.

A hinted hit skips the duplicate-id and opposite-encoding checks the scan performs. Encoding stays guarded by the once-per-backend `ensureRootEncoding` check, and duplicate ids across project directories still reject on every full scan (`load`, `list`, create-collision), so in a duplicated-id state a hinted probe reports the hinted artifact's revision instead of throwing immediately and the loud rejection surfaces at the next full read. Freshness outcomes are otherwise identical with and without the hint, and durability behavior is unchanged.

## Testing

The JSONL spec pins the hinted hit (the full scan is never invoked while a second project directory holds another session), the hinted miss (fallback scan still resolves the artifact under its actual project directory), and the pre-existing cross-cwd create-collision test keeps guarding the full-scan creation probe. The coordinator spec records received hints on the controlled backend and asserts every preparation freshness probe carries the stored header's cwd.
