/**
 * Browser-side API client for the /api/dsh-kb route family. The only data
 * access path the panel uses — plain fetch, same origin.
 */
import { KB_API, type KbConfigView, type KbDocView, type KbHitView, type KbStatsView } from '../protocol.ts'

export class KbApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KbApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new KbApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new KbApiError(message)
  }
  return body as T
}

/** The browser half's only data entry point. */
export class KbApi {
  async stats(): Promise<KbStatsView> {
    return readJson<KbStatsView>(await fetch(KB_API.stats))
  }

  async list(): Promise<{ docs: KbDocView[]; config: KbConfigView }> {
    return readJson<{ docs: KbDocView[]; config: KbConfigView }>(await fetch(KB_API.list))
  }

  /** Upload raw document bytes (filename travels in the query). */
  async upload(name: string, bytes: Uint8Array): Promise<KbDocView> {
    const response = await fetch(`${KB_API.upload}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    const body = await readJson<{ ok: boolean; doc: KbDocView }>(response)
    return body.doc
  }

  async reparse(id: string): Promise<{ ok: boolean }> {
    const response = await fetch(KB_API.reparse, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    return readJson<{ ok: boolean }>(response)
  }

  async delete(id: string): Promise<{ ok: boolean }> {
    const response = await fetch(KB_API.delete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    return readJson<{ ok: boolean }>(response)
  }

  async search(query: string, topK?: number): Promise<KbHitView[]> {
    const response = await fetch(KB_API.search, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, topK }),
    })
    const body = await readJson<{ hits: KbHitView[] }>(response)
    return body.hits
  }

  async setConfig(patch: Partial<KbConfigView>): Promise<{ ok: boolean; config: KbConfigView }> {
    const response = await fetch(KB_API.config, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    })
    return readJson<{ ok: boolean; config: KbConfigView }>(response)
  }
}
