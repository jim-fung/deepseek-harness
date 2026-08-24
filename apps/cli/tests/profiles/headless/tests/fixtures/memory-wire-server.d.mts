/**
 * Type declarations for `./memory-wire-server.mjs`: the plain-JS fixture
 * carries no inline types, and strict mode rejects an untyped import.
 */
import type { Server } from 'node:http'

/** The running wire server: its handle and the port it bound on 127.0.0.1. */
export interface MemoryWireServer {
  /** The `node:http` server; close it through `server.close()`. */
  readonly server: Server
  /** The ephemeral port the server accepted on. */
  readonly port: number
}

/**
 * Start the deterministic supermemory.ai stand-in on an ephemeral 127.0.0.1
 * port.
 * @returns the running server and its port once `listen` completes.
 */
export function startMemoryWireServer(): Promise<MemoryWireServer>
