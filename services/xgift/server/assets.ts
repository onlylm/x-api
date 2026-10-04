import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}
export function assets(directory: string) {
  const root = resolve(directory)
  return {
    async fetch(request: Request) {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 405 })
      let path: string
      try {
        path = decodeURIComponent(new URL(request.url).pathname)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (
        path.includes('\\') ||
        path.includes('\0') ||
        path.split('/').some((p) => p.startsWith('.') || p === '_headers')
      )
        return new Response(null, { status: 404 })
      let file = resolve(root, '.' + path)
      if (file !== root && !file.startsWith(root + sep))
        return new Response(null, { status: 404 })
      try {
        if (!(await stat(file)).isFile()) throw new Error('Not a file')
      } catch {
        if (
          extname(path) ||
          path.startsWith('/assets/') ||
          !request.headers.get('Accept')?.includes('text/html')
        )
          return new Response(null, { status: 404 })
        file = resolve(root, 'index.html')
      }
      const actual = await realpath(file)
      if (!actual.startsWith(root + sep))
        return new Response(null, { status: 404 })
      return new Response(
        request.method === 'HEAD' ? null : await readFile(actual),
        {
          headers: {
            'Content-Type':
              types[extname(actual)] ?? 'application/octet-stream',
            'Cache-Control': path.startsWith('/assets/')
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          },
        },
      )
    },
  }
}
