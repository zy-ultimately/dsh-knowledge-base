/**
 * The /api/dsh-kb route family: stats, list, upload (raw bytes), reparse,
 * delete, search, and config. Every route carries a loopback-only trust fence
 * — these endpoints read/write a shared knowledge base, so LAN-exposed dsh
 * web deployments must not serve them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { KnowledgeBase } from './engine/kb.ts'
import { KB_API, type KbHitView } from './protocol.ts'

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024
/** Cap on a raw upload body (mirrors the engine's maxUploadBytes). */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** Loopback-only fence: only localhost may touch the KB endpoints. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_UPLOAD_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Route family dependencies. */
export interface KbRoutesDeps {
  kb: KnowledgeBase
}

/** Build every /api/dsh-kb route. */
export function makeRoutes(deps: KbRoutesDeps): WebRoute[] {
  const { kb } = deps

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: KB_API.stats,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await kb.ready()
        writeJson(res, 200, kb.stats())
      },
    },
    {
      kind: 'exact',
      path: KB_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await kb.ready()
        writeJson(res, 200, { docs: kb.listDocs(), config: kb.configView() })
      },
    },
    {
      kind: 'exact',
      path: KB_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await kb.ready()
        const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? ''
        const body = await readRawBody(req)
        if (body === undefined) {
          writeJson(res, 413, { error: '文件过大或读取失败（上限 20MB）' })
          return
        }
        try {
          const doc = await kb.upload(name, new Uint8Array(body))
          writeJson(res, 200, { ok: true, doc })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: KB_API.reparse,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await kb.ready()
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (!id) { writeJson(res, 400, { error: '缺少 id' }); return }
        void kb.reparse(id)
        writeJson(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: KB_API.delete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await kb.ready()
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        try {
          await kb.delete(id)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: KB_API.search,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await kb.ready()
        const body = await readJsonBody(req)
        const query = typeof body?.query === 'string' ? body.query : ''
        const topK = typeof body?.topK === 'number' ? body.topK : undefined
        const hits: KbHitView[] = kb.search(query, topK, 0).map((h) => ({
          doc: h.docName,
          location: h.loc,
          score: Number(h.score.toFixed(3)),
          text: h.text.slice(0, 800),
        }))
        writeJson(res, 200, { hits })
      },
    },
    {
      kind: 'exact',
      path: KB_API.config,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        await kb.ready()
        const body = await readJsonBody(req)
        const patch = body?.patch
        if (typeof patch !== 'object' || patch === null) { writeJson(res, 400, { error: '缺少 patch' }); return }
        try {
          const config = await kb.setConfig(patch as Record<string, unknown>)
          writeJson(res, 200, { ok: true, config })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
  return routes
}
