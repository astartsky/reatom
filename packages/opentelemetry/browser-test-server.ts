import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import type { TestProject } from 'vitest/node'

export interface CollectorRequest {
  method: string
  path: string
  origin: string | undefined
  contentType: string | undefined
  requestedMethod: string | undefined
  requestedHeaders: string | undefined
}

export interface CollectorRecord {
  body: string
  json: unknown
  utf8Bytes: number
}

export interface CollectorState {
  options: number
  posts: number
  acceptedPosts: number
  held: number
  requests: CollectorRequest[]
  records: CollectorRecord[]
  errors: string[]
}

declare module 'vitest' {
  export interface ProvidedContext {
    otelCollectorUrl: string
  }
}

export default async function setup(project: TestProject) {
  let holding = false
  const held = new Set<ServerResponse>()
  const state: Omit<CollectorState, 'held'> = {
    options: 0,
    posts: 0,
    acceptedPosts: 0,
    requests: [],
    records: [],
    errors: [],
  }
  const release = () => {
    holding = false
    for (const response of held) response.end('{}')
    held.clear()
  }
  const allowCors = (response: ServerResponse) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'content-type')
    response.setHeader('Access-Control-Max-Age', '0')
    response.setHeader('Cache-Control', 'no-store')
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const control = path.startsWith('/control/')
    const collector = /^\/collector\/(allow|deny)\/[^/]+\/v1\/traces$/.test(
      path,
    )
    const denied = path.startsWith('/collector/deny/')
    if (control || (collector && !denied)) allowCors(response)
    response.setHeader('Content-Type', 'application/json')

    if (collector) {
      state.requests.push({
        method: request.method ?? '',
        path,
        origin: request.headers.origin,
        contentType: request.headers['content-type'],
        requestedMethod: request.headers['access-control-request-method'],
        requestedHeaders: request.headers['access-control-request-headers'],
      })
    }
    if (request.method === 'OPTIONS') {
      if (collector) state.options++
      response.statusCode = denied ? 403 : 204
      response.end()
      return
    }
    if (control) {
      if (request.method === 'POST' && path === '/control/reset') {
        if (held.size) throw new Error('Cannot reset with held responses')
        holding = false
        state.options = state.posts = state.acceptedPosts = 0
        state.requests = []
        state.records = []
        state.errors = []
      } else if (request.method === 'POST' && path === '/control/hold') {
        holding = true
      } else if (request.method === 'POST' && path === '/control/release') {
        release()
      } else if (request.method !== 'GET' || path !== '/control/state') {
        response.statusCode = 404
      }
      response.end(JSON.stringify({ ...state, held: held.size }))
      return
    }
    if (!collector || request.method !== 'POST') {
      response.statusCode = 404
      response.end('{}')
      return
    }

    state.posts++
    if (denied) {
      response.statusCode = 403
      response.end('{}')
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 1024 * 1024) throw new Error('Synthetic payload exceeds 1 MiB')
      chunks.push(bytes)
    }
    const bytes = Buffer.concat(chunks)
    const body = bytes.toString('utf8')
    state.records.push({
      body,
      json: JSON.parse(body),
      utf8Bytes: bytes.length,
    })
    state.acceptedPosts++
    if (holding) {
      held.add(response)
      response.once('close', () => held.delete(response))
    } else {
      response.end('{}')
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      state.errors.push(String(error))
      response.statusCode = 500
      response.end('{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const url = `http://127.0.0.1:${address.port}`
  project.provide('otelCollectorUrl', url)
  console.info(`[browser synthetic collector] listening ${url}`)

  return async () => {
    release()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
    server.removeAllListeners()
    console.info('[browser synthetic collector] closed all owned connections')
  }
}
