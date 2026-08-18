/**
 * BM25 keyword index over text chunks — pure JS, no deps.
 * Ported 1:1 from the unit-tested implementation (9/9 assertions, including
 * JSON round-trip persistence).
 */
import { tokenize } from './tokenize.ts'

export interface IndexChunk {
  id: string
  docId: string
  loc: string
  text: string
}

export interface SearchHit {
  chunkIdx: number
  chunkId: string
  docId: string
  loc: string
  score: number
  matchedTerms: number
  text: string
}

interface SerializedIndex {
  chunks: IndexChunk[]
  docLen: number[]
  totalTokens: number
  avgLen: number
  postings: Record<string, Record<string, number>>
}

export class Bm25Index {
  chunks: IndexChunk[] = []
  private postings = new Map<string, Map<number, number>>()
  private docLen: number[] = []
  private totalTokens = 0
  private avgLen = 0
  readonly k1 = 1.5
  readonly b = 0.75
  ready = false

  build(chunks: IndexChunk[]): void {
    this.chunks = chunks
    this.postings = new Map()
    this.docLen = []
    this.totalTokens = 0
    for (let i = 0; i < chunks.length; i++) {
      const tokens = tokenize(chunks[i]!.text)
      this.docLen[i] = tokens.length
      this.totalTokens += tokens.length
      const seen = new Map<string, number>()
      for (const t of tokens) seen.set(t, (seen.get(t) ?? 0) + 1)
      for (const [t, tf] of seen) {
        let p = this.postings.get(t)
        if (!p) { p = new Map(); this.postings.set(t, p) }
        p.set(i, tf)
      }
    }
    this.avgLen = this.chunks.length ? this.totalTokens / this.chunks.length : 0
    this.ready = true
  }

  toJSON(): SerializedIndex {
    const postings: Record<string, Record<string, number>> = {}
    for (const [term, p] of this.postings) {
      postings[term] = {}
      for (const [idx, tf] of p) postings[term]![idx] = tf
    }
    return { chunks: this.chunks, docLen: this.docLen, totalTokens: this.totalTokens, avgLen: this.avgLen, postings }
  }

  static fromJSON(data: SerializedIndex): Bm25Index {
    const idx = new Bm25Index()
    idx.chunks = data.chunks ?? []
    idx.docLen = data.docLen ?? []
    idx.totalTokens = data.totalTokens ?? 0
    idx.avgLen = data.avgLen ?? 0
    idx.postings = new Map()
    for (const term of Object.keys(data.postings ?? {})) {
      const p = new Map<number, number>()
      for (const k of Object.keys(data.postings[term]!)) p.set(Number(k), data.postings[term]![k]!)
      idx.postings.set(term, p)
    }
    idx.ready = idx.chunks.length > 0
    return idx
  }

  search(query: string, topK = 5): SearchHit[] {
    if (!this.ready || this.chunks.length === 0) return []
    const terms = tokenize(query)
    if (terms.length === 0) return []
    const n = this.chunks.length
    const avgLen = this.avgLen || 1
    const scores = new Map<number, number>()
    const matchedTerms = new Map<number, Set<string>>()
    for (const term of new Set(terms)) {
      const post = this.postings.get(term)
      if (!post) continue
      const df = post.size
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (const [idx, tf] of post) {
        const len = this.docLen[idx] ?? 1
        const score = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (len / avgLen))))
        scores.set(idx, (scores.get(idx) ?? 0) + score)
        let mt = matchedTerms.get(idx)
        if (!mt) { mt = new Set(); matchedTerms.set(idx, mt) }
        mt.add(term)
      }
    }
    if (scores.size === 0) return []
    const ranked = [...scores.entries()].sort((a, b) => b[1]! - a[1]!).slice(0, topK)
    const results: SearchHit[] = []
    for (const [idx, score] of ranked) {
      const chunk = this.chunks[idx]!
      const text = chunk.text.toLowerCase()
      let bonus = 0
      for (let k = 0; k + 1 < terms.length; k++) {
        if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(terms[k]![0]!) && /[\u3400-\u4dbf\u4e00-\u9fff]/.test(terms[k + 1]![0]!) && text.includes(terms[k]! + terms[k + 1]!)) bonus += 0.5
      }
      results.push({
        chunkIdx: idx,
        chunkId: chunk.id,
        docId: chunk.docId,
        loc: chunk.loc,
        score: score + bonus,
        matchedTerms: matchedTerms.get(idx)?.size ?? 0,
        text: chunk.text,
      })
    }
    results.sort((a, b) => b.score - a.score)
    return results
  }
}
