import { request as httpsRequest } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

/** Fixed X API/exit checks; card provider traffic always uses the server IP. */
export async function proxyFetch(
  target: string,
  headers: Record<string, string>,
  proxy: Record<string, unknown>,
  init?: { method?: string; body?: string },
) {
  const url = new URL(target)
  if (
    url.protocol !== 'https:' ||
    !['x.com', 'ipinfo.io'].includes(url.hostname)
  )
    throw new Error('Unsupported proxy target')
  if (!['http', 'socks5'].includes(String(proxy.protocol)))
    throw new Error('Unsupported proxy protocol')
  const endpoint = new URL(
    `${proxy.protocol === 'socks5' ? 'socks5h' : 'http'}://${proxy.host}:${proxy.port}`,
  )
  endpoint.username = String(proxy.username ?? '')
  endpoint.password = String(proxy.password ?? '')
  const agent =
    proxy.protocol === 'socks5'
      ? new SocksProxyAgent(endpoint, { timeout: 20000 })
      : new HttpsProxyAgent(endpoint, { timeout: 20000 })
  try {
    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        { agent, headers, method: init?.method ?? 'GET', signal: AbortSignal.timeout(20000) },
        (response) => {
          const chunks: Buffer[] = []
          let length = 0
          response.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > 262144) {
              response.destroy()
              reject(new Error('Proxy response too large'))
              return
            }
            chunks.push(chunk)
          })
          response.on('error', () => reject(new Error('Proxy response failed')))
          response.on('end', () => {
            const h = new Headers()
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                h.set(key, Array.isArray(value) ? value.join(', ') : value)
            const status = response.statusCode ?? 502
            resolve(
              new Response(
                [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
                { status, headers: h },
              ),
            )
          })
        },
      )
      req.on('error', () => reject(new Error('Proxy connection failed')))
      req.end(init?.body)
    })
  } finally {
    agent.destroy()
  }
}
