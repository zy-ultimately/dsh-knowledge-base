/**
 * Shared API contract between the host route family and the browser half.
 * Paths are exact webserver routes (see routes.ts).
 */

export const KB_API = {
  stats: '/api/dsh-kb/stats',
  list: '/api/dsh-kb/list',
  /** POST raw document bytes; filename in `?name=`. */
  upload: '/api/dsh-kb/upload',
  /** POST JSON { id }. */
  reparse: '/api/dsh-kb/reparse',
  /** POST JSON { id }. */
  delete: '/api/dsh-kb/delete',
  /** POST JSON { query, topK }. */
  search: '/api/dsh-kb/search',
  /** POST JSON { patch }. */
  config: '/api/dsh-kb/config',
} as const

export interface KbDocView {
  id: string
  name: string
  ext: string
  size: number
  uploadedAt: number
  status: 'parsing' | 'ready' | 'error'
  message: string
  chunkCount: number
  locs: string[]
}

export interface KbConfigView {
  enabled: boolean
  topK: number
  minScore: number
  chunkSize: number
  overlap: number
  storageDir: string
  maxContextChars: number
  maxUploadBytes: number
}

export interface KbStatsView {
  total: number
  chunks: number
  parsing: number
  errors: number
  storageDir: string
}

export interface KbHitView {
  doc: string
  location: string
  score: number
  text: string
}
