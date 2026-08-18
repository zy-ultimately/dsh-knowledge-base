/**
 * fs-backed persistence for the knowledge base.
 *
 * Layout under the KB root:
 *   kb.json              — version, config, docs (with chunks), flat chunk list
 *   raw/<docId>.<ext>.b64 — uploaded document bytes, base64 text
 *
 * The `ctx.fs` service (dsh-fs) writes atomically and creates parent
 * directories on demand; there is no delete API, so removed raw files are
 * overwritten with an empty string to release space.
 */
import type { IndexChunk } from './bm25.ts'

export interface KbConfig {
  /** Master switch for automatic retrieval. */
  enabled: boolean
  /** Number of snippets injected / returned. */
  topK: number
  /** Minimum BM25 score for a hit to be kept. */
  minScore: number
  /** Chunk size in characters. */
  chunkSize: number
  /** Chunk overlap in characters. */
  overlap: number
  /** Storage dir override (empty = workspace default). */
  storageDir: string
  /** Cap on the injected context in characters. */
  maxContextChars: number
  /** Cap on a single upload in bytes. */
  maxUploadBytes: number
}

export interface KbDoc {
  id: string
  name: string
  ext: string
  size: number
  uploadedAt: number
  status: 'parsing' | 'ready' | 'error'
  message: string
  chunkCount: number
  locs: string[]
  chunks: IndexChunk[]
}

export interface KbStateFile {
  version: 1
  config: KbConfig
  docs: Record<string, KbDoc>
  chunks: IndexChunk[]
}

/** Structural face of the dsh `fs` service we consume (kept minimal on purpose). */
export interface FsTarget {
  targetKey: string
  displayPath: string
}
/** Per-call sandbox policy passed to every fs write (dsh-fs-sandbox enforces it). */
export interface WritePolicy {
  mode: 'workspace-write' | 'read-only' | 'danger-full-access'
  workspaceRoot: string
}
export interface FsLike {
  resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>
  readText(target: FsTarget): Promise<string>
  writeText(target: FsTarget, content: string, expected?: unknown, signal?: unknown, sandboxPolicy?: WritePolicy): Promise<unknown>
}

export function defaultConfig(): KbConfig {
  return {
    enabled: true,
    topK: 4,
    minScore: 0.5,
    chunkSize: 600,
    overlap: 80,
    storageDir: '',
    maxContextChars: 4000,
    maxUploadBytes: 20 * 1024 * 1024,
  }
}

export function joinPath(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/')
}

export function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T
}

/** Serially-ordered writer: every mutation awaits the previous one. */
export class KbStore {
  private fs: FsLike
  root = ''
  private saveChain: Promise<void> = Promise.resolve()
  /** Per-call sandbox policy (dsh-fs-sandbox denies writes without one that covers the target). */
  writePolicy: WritePolicy = { mode: 'workspace-write', workspaceRoot: '' }

  constructor(fs: FsLike) {
    this.fs = fs
  }

  /**
   * Load state. Reads the workspace default root first; if that file's config
   * points at a custom storageDir, re-reads from there.
   */
  async load(wsRoot: string): Promise<KbStateFile> {
    const defaultRoot = wsRoot ? joinPath(wsRoot, '.dsh-knowledge-base') : '.dsh-knowledge-base'
    let data: KbStateFile | null = null
    let root = defaultRoot
    try {
      const text = await this.fs.readText(await this.fs.resolve(joinPath(defaultRoot, 'kb.json')))
      if (text) data = JSON.parse(text) as KbStateFile
    } catch {
      data = null
    }
    if (data?.config?.storageDir) {
      const configured = String(data.config.storageDir).trim()
      if (configured && configured !== defaultRoot) {
        root = configured
        try {
          const text = await this.fs.readText(await this.fs.resolve(joinPath(root, 'kb.json')))
          if (text) data = JSON.parse(text) as KbStateFile
        } catch {
          // keep the first read
        }
      }
    }
    this.root = root
    if (data?.version === 1) {
      return {
        version: 1,
        config: { ...defaultConfig(), ...(data.config ?? {}) },
        docs: data.docs ?? {},
        chunks: data.chunks ?? [],
      }
    }
    return { version: 1, config: defaultConfig(), docs: {}, chunks: [] }
  }

  /** Persist a full snapshot (serialized; failures are logged, never thrown). */
  save(state: KbStateFile, onError?: (error: unknown) => void): Promise<void> {
    const payload = JSON.stringify(state)
    this.saveChain = this.saveChain.then(async () => {
      try {
        await this.fs.writeText(await this.fs.resolve(joinPath(this.root, 'kb.json')), payload, undefined, undefined, this.writePolicy)
      } catch (error) {
        onError?.(error)
      }
    })
    return this.saveChain
  }

  async saveRaw(docId: string, ext: string, bytes: Uint8Array): Promise<void> {
    await this.fs.writeText(
      await this.fs.resolve(joinPath(this.root, 'raw', `${docId}.${ext}.b64`)),
      bytesToBase64(bytes),
      undefined,
      undefined,
      this.writePolicy,
    )
  }

  async readRaw(doc: Pick<KbDoc, 'id' | 'ext'>): Promise<Uint8Array> {
    const text = await this.fs.readText(await this.fs.resolve(joinPath(this.root, 'raw', `${doc.id}.${doc.ext}.b64`)))
    return base64ToBytes(text)
  }

  /** Release a removed document's raw file (really delete it; the sandboxed fs service has no unlink, so use Node rm on the resolved targetKey). */
  async clearRaw(doc: Pick<KbDoc, 'id' | 'ext'>): Promise<void> {
    try {
      const target = await this.fs.resolve(joinPath(this.root, 'raw', `${doc.id}.${doc.ext}.b64`))
      const key = typeof target === 'object' && target !== null && 'targetKey' in target ? (target as { targetKey: string }).targetKey : target
      const { rmSync } = await import('node:fs')
      rmSync(String(key), { force: true })
    } catch {
      // non-fatal
    }
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Node Buffer is byte-exact (the dynamic-host btoa is UTF-8 flavored and corrupts binary).
  return Buffer.from(bytes).toString('base64')
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(String(b64), 'base64'))
}
