import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import worker from '../src/index.ts'
import type { Env } from '../src/core.ts'

export function server(env: Env, publicOrigin: string) {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/')
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin')
  return createServer(
    { maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 15000 },
    async (incoming, outgoing) => {
      try {
        if (
          incoming.headers.host !== origin.host ||
          !incoming.url?.startsWith('/') ||
          incoming.url.startsWith('//')
        ) {
          outgoing.writeHead(421).end()
          return
        }
        const headers = new Headers()
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (
            value === undefined ||
            [
              'cf-connecting-ip',
              'x-real-ip',
              'x-forwarded-for',
              'x-forwarded-proto',
            ].includes(key)
          )
            continue
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        // Nginx overwrites X-Real-IP; this listener is bound to loopback only.
        headers.set(
          'CF-Connecting-IP',
          String(
            incoming.headers['x-real-ip'] ??
              incoming.socket.remoteAddress ??
              'local',
          ),
        )
        const method = incoming.method ?? 'GET'
        const init: RequestInit & { duplex?: 'half' } = { method, headers }
        if (!['GET', 'HEAD'].includes(method)) {
          init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
          init.duplex = 'half'
        }
        const result = await worker.fetch(
          new Request(origin.origin + incoming.url, init),
          env,
        )
        outgoing.writeHead(result.status, Object.fromEntries(result.headers))
        if (!result.body || method === 'HEAD') {
          outgoing.end()
          return
        }
        await pipeline(Readable.fromWeb(result.body as never), outgoing)
      } catch {
        if (!outgoing.headersSent)
          outgoing
            .writeHead(503, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            })
            .end(
              '{"error":{"code":"service_unavailable","message":"服务暂时不可用。"}}',
            )
        else outgoing.destroy()
      }
    },
  )
}
