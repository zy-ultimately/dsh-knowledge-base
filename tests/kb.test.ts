import { describe, expect, it } from 'vitest'
import { KnowledgeBase } from '../src/engine/kb.ts'
import type { FsLike, FsTarget } from '../src/engine/store.ts'
import { LEAVE_DOCX } from './helpers.ts'

/** In-memory FsLike fake (dsh-fs surface we consume). */
class MemFs implements FsLike {
  files = new Map<string, string>()
  async resolve(path: string): Promise<FsTarget> {
    return { targetKey: path, displayPath: path }
  }
  async readText(target: FsTarget): Promise<string> {
    const value = this.files.get(target.targetKey)
    if (value === undefined) throw new Error(`ENOENT: ${target.targetKey}`)
    return value
  }
  async writeText(target: FsTarget, content: string): Promise<unknown> {
    this.files.set(target.targetKey, content)
    return {}
  }
}

describe('KnowledgeBase engine', () => {
  it('uploads, parses, indexes, and retrieves across restarts', async () => {
    const fs = new MemFs()
    const kb = new KnowledgeBase({ fs, workspaceRoot: 'ws' })
    await kb.ready()

    // upload
    const doc = await kb.upload('公司考勤制度.docx', LEAVE_DOCX)
    expect(doc.status).toBe('parsing')
    await kb.reparse(doc.id) // wait for the background job
    expect(kb.getDoc(doc.id)?.status).toBe('ready')
    expect(kb.getDoc(doc.id)?.chunkCount).toBeGreaterThan(0)

    // retrieve
    const hits = kb.search('年假怎么申请', 4, 0.5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.docName).toContain('考勤制度')
    expect(hits[0]!.text).toContain('年假')

    // unrelated → no hits above threshold
    expect(kb.search('量子物理 夸克', 4, 1)).toHaveLength(0)

    // persistence: a second engine instance over the same fs sees the doc
    const kb2 = new KnowledgeBase({ fs, workspaceRoot: 'ws' })
    await kb2.ready()
    expect(kb2.stats().total).toBe(1)
    const hits2 = kb2.search('调休', 3, 0)
    expect(hits2.length).toBeGreaterThan(0)

    // delete
    await kb2.delete(doc.id)
    expect(kb2.stats().total).toBe(0)
    expect(kb2.search('年假', 3)).toHaveLength(0)
  })

  it('rejects unsupported formats and empty files', async () => {
    const kb = new KnowledgeBase({ fs: new MemFs(), workspaceRoot: 'ws' })
    await kb.ready()
    await expect(kb.upload('a.zip', new Uint8Array([1, 2, 3]))).rejects.toThrow(/不支持的文件格式/)
    await expect(kb.upload('b.docx', new Uint8Array(0))).rejects.toThrow(/文件为空/)
  })

  it('builds a citable retrieval context', async () => {
    const fs = new MemFs()
    const kb = new KnowledgeBase({ fs, workspaceRoot: 'ws' })
    await kb.ready()
    const doc = await kb.upload('制度.docx', LEAVE_DOCX)
    await kb.reparse(doc.id)
    const hits = kb.search('年假', 2, 0)
    const ctx = kb.buildContext('年假怎么请？', hits)
    expect(ctx).toContain('【全局知识库检索】')
    expect(ctx).toContain('来源：知识库《制度.docx》')
    expect(ctx).toContain('回答要求')
  })
})
