/**
 * The knowledge-base engine: document lifecycle (upload / delete / reparse),
 * chunking + BM25 indexing, retrieval, and RAG context assembly.
 * Session-independent by construction — one engine per process, backed by the
 * shared KbStore.
 */
import { Bm25Index, type IndexChunk, type SearchHit } from './bm25.ts'
import { PARSERS, extToKind } from './parsers.ts'
import { chunkSection } from './tokenize.ts'
import {
  KbStore, clone, defaultConfig, type FsLike, type KbConfig, type KbDoc, type KbStateFile,
} from './store.ts'

export interface KbHit {
  docId: string
  docName: string
  ext: string
  loc: string
  score: number
  text: string
}

export interface KbStats {
  total: number
  chunks: number
  parsing: number
  errors: number
  storageDir: string
}

export interface KbDeps {
  fs: FsLike
  /** Workspace root (KB defaults to `<root>/.dsh-knowledge-base`). */
  workspaceRoot: string
  /** Per-call fs sandbox policy; defaults to workspace-write under workspaceRoot. */
  writePolicy?: WritePolicy
  /** Log sink. */
  log?: (message: string) => void
}

let seq = 0
function newId(prefix: string): string {
  seq++
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`
}

export class KnowledgeBase {
  private store: KbStore
  private state: KbStateFile = { version: 1, config: defaultConfig(), docs: {}, chunks: [] }
  private index = new Bm25Index()
  private jobs = new Map<string, Promise<void>>()
  private readonly log: (message: string) => void
  private booted = false
  private bootPromise: Promise<void>

  constructor(deps: KbDeps) {
    this.store = new KbStore(deps.fs)
    this.store.writePolicy = deps.writePolicy ?? { mode: 'workspace-write', workspaceRoot: deps.workspaceRoot }
    this.log = deps.log ?? (() => {})
    this.bootPromise = this.boot(deps.workspaceRoot)
  }

  private async boot(wsRoot: string): Promise<void> {
    try {
      this.state = await this.store.load(wsRoot)
      // Recover stale "parsing" docs: a previous process may have been killed
      // mid-parse (or hit the old parser hang) — mark them retryable.
      let stale = false
      for (const doc of Object.values(this.state.docs)) {
        if (doc.status === 'parsing') {
          doc.status = 'error'
          doc.message = '解析被中断，请点击“重新解析”'
          stale = true
        }
      }
      if (stale) await this.store.save(this.state, (e) => this.log(`kb: persist failed — ${String(e)}`))
      this.rebuildIndex()
      this.booted = true
      this.log(`kb: loaded from ${this.store.root}, docs=${Object.keys(this.state.docs).length}`)
    } catch (error) {
      this.log(`kb: boot failed — ${error instanceof Error ? error.message : String(error)}`)
      this.state = { version: 1, config: defaultConfig(), docs: {}, chunks: [] }
      this.booted = true
    }
  }

  /** Await initialization (handlers call this first). */
  ready(): Promise<void> {
    return this.bootPromise
  }

  get config(): KbConfig {
    return this.state.config
  }

  get root(): string {
    return this.store.root
  }

  private rebuildIndex(): void {
    const chunkList: IndexChunk[] = []
    for (const docId of Object.keys(this.state.docs)) {
      const doc = this.state.docs[docId]!
      for (const c of doc.chunks ?? []) chunkList.push({ id: c.id, docId, loc: c.loc, text: c.text })
    }
    this.state.chunks = chunkList
    this.index = new Bm25Index()
    this.index.build(chunkList)
  }

  listDocs(): Array<Omit<KbDoc, 'chunks'>> {
    return Object.values(this.state.docs)
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .map(({ chunks: _chunks, ...view }) => view)
  }

  getDoc(id: string): Omit<KbDoc, 'chunks'> | undefined {
    const doc = this.state.docs[id]
    if (!doc) return undefined
    const { chunks: _chunks, ...view } = doc
    return view
  }

  stats(): KbStats {
    const docs = Object.values(this.state.docs)
    let chunks = 0
    let parsing = 0
    let errors = 0
    for (const d of docs) {
      chunks += d.chunkCount ?? 0
      if (d.status === 'parsing') parsing++
      if (d.status === 'error') errors++
    }
    return { total: docs.length, chunks, parsing, errors, storageDir: this.store.root }
  }

  /** Validate + persist a raw upload, then kick off background parsing. */
  async upload(name: string, bytes: Uint8Array): Promise<Omit<KbDoc, 'chunks'>> {
    if (!name || !name.trim()) throw new Error('缺少文件名')
    const kind = extToKind(name)
    if (!kind) throw new Error(`不支持的文件格式（支持 pdf/docx/txt/md/xlsx/pptx/csv/html）`)
    if (bytes.length === 0) throw new Error('文件为空')
    const maxB = this.state.config.maxUploadBytes
    if (bytes.length > maxB) throw new Error(`文件超过大小上限 ${Math.round(maxB / 1024 / 1024)}MB`)
    const id = newId('doc')
    const doc: KbDoc = {
      id, name: name.trim(), ext: kind, size: bytes.length,
      uploadedAt: Date.now(), status: 'parsing', message: '', chunkCount: 0, locs: [], chunks: [],
    }
    this.state.docs[id] = doc
    await this.store.saveRaw(id, kind, bytes)
    await this.store.save(this.state, (e) => this.log(`kb: persist failed — ${String(e)}`))
    void this.reparse(id)
    return this.getDoc(id)!
  }

  /** Re-parse and re-index one document (background; status reflects progress). */
  async reparse(id: string): Promise<void> {
    const existing = this.jobs.get(id)
    if (existing) return existing
    const job = this.runParse(id).finally(() => this.jobs.delete(id))
    this.jobs.set(id, job)
    return job
  }

  private async runParse(id: string): Promise<void> {
    const doc = this.state.docs[id]
    if (!doc) return
    doc.status = 'parsing'
    doc.message = ''
    await this.store.save(this.state, (e) => this.log(`kb: persist failed — ${String(e)}`))
    try {
      const bytes = await this.store.readRaw(doc)
      const parser = PARSERS[doc.ext as keyof typeof PARSERS]
      if (!parser) throw new Error(`不支持的文件格式: .${doc.ext}`)
      const sections = parser(bytes)
      if (!sections || sections.length === 0) throw new Error('未提取到任何文本')
      const chunks: IndexChunk[] = []
      for (const sec of sections) {
        for (const c of chunkSection(sec, this.state.config.chunkSize, this.state.config.overlap)) {
          chunks.push({ id: newId('chunk'), docId: id, loc: sec.loc, text: c.text })
        }
      }
      if (chunks.length === 0) throw new Error('未提取到可索引的文本内容')
      doc.chunks = chunks
      doc.status = 'ready'
      doc.chunkCount = chunks.length
      doc.locs = [...new Set(chunks.map((c) => c.loc))].slice(0, 3)
      this.rebuildIndex()
    } catch (error) {
      doc.status = 'error'
      doc.message = error instanceof Error ? error.message : String(error)
    }
    await this.store.save(this.state, (e) => this.log(`kb: persist failed — ${String(e)}`))
  }

  /** Delete a document and rebuild the index. */
  async delete(id: string): Promise<void> {
    const doc = this.state.docs[id]
    if (!doc) throw new Error('文档不存在')
    delete this.state.docs[id]
    this.rebuildIndex()
    await this.store.save(this.state, (e) => this.log(`kb: persist failed — ${String(e)}`))
    await this.store.clearRaw(doc)
  }

  /** BM25 retrieval with score threshold. */
  search(text: string, topK?: number, minScore?: number): KbHit[] {
    const cfg = this.state.config
    const k = Math.min(topK ?? cfg.topK, 10)
    const min = minScore !== undefined ? minScore : cfg.minScore
    const hits: SearchHit[] = this.index.search(String(text), k)
    const out: KbHit[] = []
    for (const h of hits) {
      if (h.score < min) continue
      const doc = this.state.docs[h.docId]
      out.push({
        docId: h.docId,
        docName: doc?.name ?? h.docId,
        ext: doc?.ext ?? '',
        loc: h.loc,
        score: h.score,
        text: h.text,
      })
    }
    return out
  }

  /**
   * Build the model-facing retrieval context (injected as one user-role
   * "context" message in agent/pre-step, or returned by the tool).
   */
  buildContext(query: string, hits: KbHit[]): string {
    const cfg = this.state.config
    const lines: string[] = []
    lines.push(`【全局知识库检索】针对当前问题自动检索到 ${hits.length} 个相关片段，请优先依据这些片段回答；若片段不足以回答，请明确说明“知识库中信息不足”，再结合自身知识补充，不要编造。`)
    lines.push('')
    lines.push(`问题：${String(query).slice(0, 500)}`)
    lines.push('')
    let total = 0
    const max = cfg.maxContextChars
    hits.forEach((h, i) => {
      const src = `来源：知识库《${h.docName}》${h.loc && h.loc !== '全文' ? ` · ${h.loc}` : ''}`
      let t = h.text
      const budget = max - total - src.length - 12
      if (budget <= 0) return
      if (t.length > budget) t = t.slice(0, budget) + '…'
      total += t.length + src.length + 8
      lines.push(`片段 ${i + 1}（${src}）：`)
      lines.push(t)
      lines.push('')
    })
    lines.push('回答要求：若回答基于以上片段，请在回答末尾标注「来源：知识库《文档名》」；未使用片段的内容不要标注来源。')
    return lines.join('\n')
  }

  /** Apply a config patch (validated). Returns the new config. */
  async setConfig(patch: Record<string, unknown>): Promise<KbConfig> {
    const cfg = this.state.config
    const allowed = ['enabled', 'topK', 'minScore', 'chunkSize', 'overlap', 'storageDir', 'maxContextChars'] as const
    for (const k of allowed) {
      const v = patch[k]
      if (v === undefined) continue
      if (k === 'topK') cfg.topK = Math.max(1, Math.min(10, Number(v) || 4))
      else if (k === 'minScore') cfg.minScore = Math.max(0, Number(v) || 0)
      else if (k === 'chunkSize') cfg.chunkSize = Math.max(200, Math.min(4000, Number(v) || 600))
      else if (k === 'overlap') cfg.overlap = Math.max(0, Math.min(500, Number(v) || 80))
      else if (k === 'maxContextChars') cfg.maxContextChars = Math.max(500, Math.min(20000, Number(v) || 4000))
      else if (k === 'enabled') cfg.enabled = Boolean(v)
      else if (k === 'storageDir') cfg.storageDir = String(v ?? '').trim()
    }
    await this.store.save(this.state, (e) => this.log(`kb: persist failed — ${String(e)}`))
    return clone(cfg)
  }

  /** Current config snapshot (JSON-safe). */
  configView(): KbConfig {
    return clone(this.state.config)
  }
}
