/**
 * Tokenizer (latin words + CJK bigrams), stopword list, and chunking.
 * Ported 1:1 from the unit-tested implementation.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** Small bilingual stopword set — over-matching is safe for BM25. */
const STOP = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '与', '及', '或', '等', '对', '从', '于', '并', '而', '为', '之', '其', '被', '把', '个', '们', '吗', '呢', '吧', '啊', '中', '里', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '可以', '进行', '通过', '以及', '但是', '如果', '因为', '所以', '然后', '关于', '对于', '按照', '根据', '应该', '需要', '必须', '可能', '相关', '内容', '文档', '文件', '知识', '库', '请', '问', '什么', '怎么', '如何', '为什么', '多少', '是否', '如何申请',
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'as', 'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'he', 'she', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'about', 'into', 'over', 'under', 'than', 'then', 'there', 'here', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
])

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const s = String(text).toLowerCase()
  const n = s.length
  let i = 0
  const isCJK = (cc: number): boolean => (cc >= 0x3400 && cc <= 0x4dbf) || (cc >= 0x4e00 && cc <= 0x9fff) || (cc >= 0xf900 && cc <= 0xfaff)
  const isWord = (cc: number): boolean => (cc >= 48 && cc <= 57) || (cc >= 97 && cc <= 122)
  while (i < n) {
    const cc = s.charCodeAt(i)
    if (isCJK(cc)) {
      let j = i
      const run: string[] = []
      while (j < n && isCJK(s.charCodeAt(j))) { run.push(s[j]!); j++ }
      if (run.length === 1) tokens.push(run[0]!)
      else for (let k = 0; k + 1 < run.length; k++) tokens.push(run[k]! + run[k + 1]!)
      i = j
    } else if (isWord(cc)) {
      let j = i
      while (j < n && isWord(s.charCodeAt(j))) j++
      const word = s.slice(i, j)
      if (word.length >= 2 || /^[0-9]+$/.test(word)) tokens.push(word)
      i = j
    } else i++
  }
  return tokens.filter((t) => !STOP.has(t))
}

export interface ChunkCandidate {
  text: string
  from: number
  to: number
}

/**
 * Split one section's text into overlapping chunks, preferring paragraph
 * boundaries. `chunkSize`/`overlap` in characters.
 */
export function chunkSection(section: { text: string }, chunkSize = 600, overlap = 80): ChunkCandidate[] {
  if (overlap >= chunkSize) overlap = Math.floor(chunkSize / 2)
  const paras = section.text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  if (paras.length === 0) return []
  const chunks: ChunkCandidate[] = []
  let buf = ''
  let startPara = 1
  let paraIdx = 0
  for (const p of paras) {
    paraIdx++
    if (buf && buf.length + p.length + 1 > chunkSize && buf.length >= chunkSize / 2) {
      chunks.push({ text: buf, from: startPara, to: paraIdx - 1 })
      buf = buf.slice(-overlap)
      startPara = paraIdx
    }
    buf = buf ? buf + '\n' + p : p
  }
  if (buf.trim()) chunks.push({ text: buf, from: startPara, to: paraIdx })
  const out: ChunkCandidate[] = []
  for (const ch of chunks) {
    if (ch.text.length <= chunkSize * 1.5) { out.push(ch); continue }
    let t = ch.text
    while (t.length > chunkSize) {
      let cut = t.lastIndexOf('\n', chunkSize)
      if (cut < chunkSize / 2) cut = t.lastIndexOf(' ', chunkSize)
      if (cut < chunkSize / 2) cut = chunkSize
      out.push({ text: t.slice(0, cut).trim(), from: ch.from, to: ch.to })
      t = t.slice(Math.max(0, cut - overlap)).trim()
    }
    if (t.trim()) out.push({ text: t.trim(), from: ch.from, to: ch.to })
  }
  return out.filter((c) => c.text.length > 0)
}
