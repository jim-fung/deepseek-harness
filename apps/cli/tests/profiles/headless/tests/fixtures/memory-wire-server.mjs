/**
 * Deterministic supermemory.ai stand-in for the memory snapshot scenario:
 * records added documents in memory, serves one fixed profile, and answers
 * searches from the recorded set. Started and stopped by the snapshot test.
 */
import { createServer } from 'node:http'

export function startMemoryWireServer() {
  const documents = new Map()
  return new Promise((started) => {
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(chunks.join('')) : {}
        if (request.method === 'POST' && request.url === '/v3/documents') {
          const id = `doc_${documents.size + 1}`
          documents.set(id, { id, content: body.content })
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ documentId: id }))
          return
        }
        if (request.method === 'POST' && request.url === '/v4/search') {
          const hits = [...documents.values()].map(({ id, content }) => ({ documentId: id, content }))
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ memories: hits.slice(0, Number(body.limit ?? hits.length)) }))
          return
        }
        if (request.method === 'GET' && request.url === '/v4/profile') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ profile: 'Prefers pnpm workspaces. Keeps PRs small.' }))
          return
        }
        if (request.method === 'DELETE' && /^\/v3\/documents\/.+/.test(request.url ?? '')) {
          const id = decodeURIComponent(request.url.split('/').at(-1))
          documents.delete(id)
          response.statusCode = 204
          response.end()
          return
        }
        response.statusCode = 404
        response.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => started({ server, port: server.address().port }))
  })
}
