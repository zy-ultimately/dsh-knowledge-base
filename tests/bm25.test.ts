import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/engine/bm25.ts'
import { chunkSection, tokenize } from '../src/engine/tokenize.ts'

const chunks = [
  { id: 'c1', docId: 'd1', loc: '第 1 页', text: '员工每天上下班需打卡，迟到超过 30 分钟按半天事假处理。' },
  { id: 'c2', docId: 'd1', loc: '第 2 页', text: '年假申请：入职满一年员工每年享有 5 天年假，需提前 3 个工作日申请。' },
  { id: 'c3', docId: 'd2', loc: '幻灯片 1', text: '上班时间 9:00-18:00，弹性半小时。' },
  { id: 'c4', docId: 'd3', loc: '工作表 1', text: '姓名 张伟 部门 技术部 年假剩余 7 天' },
  { id: 'c5', docId: 'd4', loc: '全文', text: 'The annual leave policy requires advance application. 加班可调休。' },
]

describe('tokenize + chunkSection', () => {
  it('emits CJK bigrams and latin words', () => {
    const tokens = tokenize('年假怎么申请？Annual leave')
    expect(tokens).toContain('年假')
    expect(tokens).toContain('annual')
    expect(tokens).toContain('leave')
  })

  it('chunks long text with overlap', () => {
    const text = Array.from({ length: 60 }, (_, i) => `这是第 ${i + 1} 段内容，关于年假与调休的说明。`).join('\n')
    const out = chunkSection({ text }, 300, 60)
    expect(out.length).toBeGreaterThan(1)
    expect(out[0]!.text.length).toBeLessThanOrEqual(500)
  })
})

describe('Bm25Index', () => {
  it('ranks the leave clause for a leave query', () => {
    const idx = new Bm25Index()
    idx.build(chunks)
    const hits = idx.search('年假 怎么 申请', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.docId).toBe('d1')
    expect(hits[0]!.text).toContain('年假申请')
  })

  it('ranks attendance clauses for an attendance query', () => {
    const idx = new Bm25Index()
    idx.build(chunks)
    const hits = idx.search('迟到 打卡 考勤', 5)
    expect(hits[0]!.docId).toBe('d1')
  })

  it('returns nothing for unrelated queries', () => {
    const idx = new Bm25Index()
    idx.build(chunks)
    const hits = idx.search('量子物理 夸克 弦论', 5)
    expect(hits.length === 0 || hits[0]!.score < 0.5).toBe(true)
  })

  it('survives JSON persistence round-trip', () => {
    const idx = new Bm25Index()
    idx.build(chunks)
    const restored = Bm25Index.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())))
    const a = idx.search('调休', 3).map((h) => [h.docId, h.loc, h.score])
    const b = restored.search('调休', 3).map((h) => [h.docId, h.loc, h.score])
    expect(b).toEqual(a)
  })
})
