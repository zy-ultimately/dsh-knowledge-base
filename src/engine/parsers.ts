/**
 * Document text parsers — pure JS, no external deps.
 * Each parser returns sections: [{ loc, text }] where loc is a human-readable
 * position ("第 3 页" / "段落 12" / "工作表 1" / "幻灯片 2" / "第 N 行" / "正文").
 * Ported 1:1 from the unit-tested implementation (23/23 assertions).
 */
import { inflateRaw } from './inflate.ts'
import { extractAll, extractMatching, requireZip } from './zip.ts'

export interface TextSection {
  loc: string
  text: string
}

// ---------- low-level helpers ----------

export function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
    return s
  }
}

function utf16be(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = ((bytes[i]! << 8) | bytes[i + 1]!) & 0xffff
    if (code >= 0xd800 && code <= 0xdbff && i + 3 < bytes.length) {
      const lo = ((bytes[i + 2]! << 8) | bytes[i + 3]!) & 0xffff
      s += String.fromCodePoint(((code - 0xd800) << 10) + (lo - 0xdc00) + 0x10000)
      i += 2
    } else s += String.fromCharCode(code)
  }
  return s
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function collapse(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return s
}

// ---------- plain text / markdown ----------
export function parsePlainText(bytes: Uint8Array): TextSection[] {
  return [{ loc: '全文', text: collapse(utf8(bytes)) }]
}

// ---------- CSV ----------
export function parseCsv(bytes: Uint8Array): TextSection[] {
  const text = utf8(bytes)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  const sections = rows.map((r, i) => ({ loc: `第 ${i + 1} 行`, text: r.join('\t').trim() }))
    .filter((s) => s.text.length > 0)
  return sections.length ? sections : [{ loc: '全文', text: '' }]
}

// ---------- HTML ----------
export function parseHtml(bytes: Uint8Array): TextSection[] {
  let s = utf8(bytes)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? ''
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/&copy;/g, '©').replace(/&reg;/g, '®')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  const body = collapse(xmlUnescape(s))
  const sections: TextSection[] = []
  if (title.trim()) sections.push({ loc: '标题', text: title.trim() })
  sections.push({ loc: '正文', text: body })
  return sections
}

// ---------- DOCX ----------
export function parseDocx(bytes: Uint8Array): TextSection[] {
  requireZip(bytes)
  const parts = extractAll(bytes, ['word/document.xml', 'word/document2.xml'])
  const xml = parts['word/document.xml'] ?? parts['word/document2.xml']
  if (!xml) throw new Error('DOCX 中未找到 word/document.xml')
  const doc = utf8(xml)
  const paras = doc.split(/<\/w:p>/)
  const sections: TextSection[] = []
  let buf = ''
  let paraNo = 0
  for (const p of paras) {
    let line = ''
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(p)) !== null) {
      if (m[0].startsWith('<w:t')) line += xmlUnescape(m[1]!)
      else line += m[0].startsWith('<w:tab') ? ' ' : '\n'
    }
    line = cleanText(line)
    if (!line) continue
    paraNo++
    buf += (buf ? '\n' : '') + line
    if (buf.length >= 1500) {
      sections.push({ loc: `段落 ${paraNo - buf.split('\n').length + 1}-${paraNo}`, text: collapse(buf) })
      buf = ''
    }
  }
  if (buf.trim()) sections.push({ loc: `段落 ${paraNo - buf.split('\n').length + 1}-${paraNo}`, text: collapse(buf) })
  if (sections.length === 0) throw new Error('DOCX 未提取到文本（可能为空文档）')
  return sections
}

// ---------- XLSX ----------
export function parseXlsx(bytes: Uint8Array): TextSection[] {
  requireZip(bytes)
  const parts = extractAll(bytes, ['xl/sharedStrings.xml'])
  const shared: string[] = []
  const ssXml = parts['xl/sharedStrings.xml'] ? utf8(parts['xl/sharedStrings.xml']) : ''
  const siRe = /<si>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = siRe.exec(ssXml)) !== null) {
    let s = ''
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<rPr>[\s\S]*?<\/rPr>/g
    let tm: RegExpExecArray | null
    while ((tm = tRe.exec(m[1]!)) !== null) if (tm[0].startsWith('<t')) s += xmlUnescape(tm[1]!)
    shared.push(cleanText(s))
  }
  const sheets = extractMatching(bytes, /^xl\/worksheets\/sheet\d+\.xml$/)
  if (sheets.length === 0) throw new Error('XLSX 中未找到工作表')
  sheets.sort((a, b) => parseInt((a.name.match(/sheet(\d+)/) ?? [0, 0])[1]!, 10) - parseInt((b.name.match(/sheet(\d+)/) ?? [0, 0])[1]!, 10))
  const sections: TextSection[] = []
  sheets.forEach((sheet, si) => {
    const xml = utf8(sheet.bytes)
    const rows = xml.split(/<\/row>/)
    const out: string[] = []
    for (const r of rows) {
      const cells: string[] = []
      const cRe = /<c(?:\s[^>]*)?>([\s\S]*?)<\/c>/g
      let cm: RegExpExecArray | null
      while ((cm = cRe.exec(r)) !== null) {
        const cellXml = cm[0]
        const attrs = (cellXml.match(/<c\s([^>]*)>/) ?? [1, ''])[1]!
        const tAttr = (attrs.match(/\bt="([^"]*)"/) ?? [1, ''])[1]!
        const v = (cellXml.match(/<v>([\s\S]*?)<\/v>/) ?? [1, ''])[1]!
        const inline = (cellXml.match(/<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/) ?? [1, ''])[1]!
        let val = ''
        if (tAttr === 's') val = shared[parseInt(v, 10)] ?? ''
        else if (tAttr === 'inlineStr') val = xmlUnescape(inline)
        else val = xmlUnescape(v)
        if (val !== undefined && val.trim()) cells.push(cleanText(val))
      }
      if (cells.length) out.push(cells.join('\t'))
    }
    if (out.length) sections.push({ loc: `工作表 ${si + 1}（${sheet.name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '')}）`, text: out.join('\n') })
  })
  if (sections.length === 0) throw new Error('XLSX 未提取到文本（可能为空工作簿）')
  return sections
}

// ---------- PPTX ----------
export function parsePptx(bytes: Uint8Array): TextSection[] {
  requireZip(bytes)
  const slides = extractMatching(bytes, /^ppt\/slides\/slide\d+\.xml$/)
  if (slides.length === 0) throw new Error('PPTX 中未找到幻灯片')
  slides.sort((a, b) => parseInt((a.name.match(/slide(\d+)/) ?? [0, 0])[1]!, 10) - parseInt((b.name.match(/slide(\d+)/) ?? [0, 0])[1]!, 10))
  const sections: TextSection[] = []
  slides.forEach((slide, si) => {
    const xml = utf8(slide.bytes)
    const texts: string[] = []
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
    let m: RegExpExecArray | null
    while ((m = tRe.exec(xml)) !== null) texts.push(xmlUnescape(m[1]!).trim())
    const joined = collapse(texts.filter(Boolean).join('\n'))
    if (joined) sections.push({ loc: `幻灯片 ${si + 1}`, text: joined })
  })
  if (sections.length === 0) throw new Error('PPTX 未提取到文本')
  return sections
}

// ---------- PDF ----------
function decodePdfString(raw: Uint8Array): string {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return utf16be(raw.subarray(2))
  let s = ''
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]!)
  return s
}

/** String-based decode: `raw` is a latin1 string of the raw bytes (avoids per-string TextEncoder allocations). */
function decodePdfStringRaw(raw: string): string {
  if (raw.length >= 2 && raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < raw.length; i += 2) {
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)
      if (code >= 0xd800 && code <= 0xdbff && i + 3 < raw.length) {
        const lo = (raw.charCodeAt(i + 2) << 8) | raw.charCodeAt(i + 3)
        s += String.fromCodePoint(((code - 0xd800) << 10) + (lo - 0xdc00) + 0x10000)
        i += 2
      } else s += String.fromCharCode(code)
    }
    return s
  }
  return raw // PDFDocEncoding ≈ latin1
}

function extractPdfText(streamBytes: Uint8Array): string {
  const s = latin1(streamBytes)
  const n = s.length
  let out = ''
  let i = 0
  let pending = ''
  const isAlpha = (cc: number): boolean => (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
  const isOpChar = (cc: number): boolean => (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 42 || cc === 39 || cc === 34
  const isDigit7 = (cc: number): boolean => cc >= 48 && cc <= 55
  const flush = (): void => {
    if (pending) { const t = pending.trimEnd(); if (t) { out += t; out += '\n' } pending = '' }
  }
  while (i < n) {
    const cc = s.charCodeAt(i)
    if (cc === 40) { // '(' literal string
      let depth = 1
      let raw = ''
      i++
      while (i < n && depth > 0) {
        const ch = s.charCodeAt(i)
        if (ch === 92) { // '\'
          const nx = s.charCodeAt(i + 1)
          if (nx === 110) raw += '\n'
          else if (nx === 114) raw += '\r'
          else if (nx === 116) raw += '\t'
          else if (nx === 98) raw += '\b'
          else if (nx === 102) raw += '\f'
          else if (nx === 40) raw += '('
          else if (nx === 41) raw += ')'
          else if (nx === 92) raw += '\\'
          else if (nx >= 48 && nx <= 55) {
            let oct = String.fromCharCode(nx)
            i++
            if (i < n && isDigit7(s.charCodeAt(i))) { oct += String.fromCharCode(s.charCodeAt(i)); i++; if (i < n && isDigit7(s.charCodeAt(i))) { oct += String.fromCharCode(s.charCodeAt(i)) } }
            raw += String.fromCharCode(parseInt(oct, 8) & 0xff)
            i--
          }
          i++
        } else if (ch === 40) { depth++; raw += '(' }
        else if (ch === 41) { depth--; if (depth > 0) raw += ')' }
        else raw += String.fromCharCode(ch)
        i++
      }
      pending += decodePdfStringRaw(raw)
    } else if (cc === 60) { // '<' hex string (skip '<<' dicts)
      if (s.charCodeAt(i + 1) === 60) { i += 2; continue }
      i++
      let hex = ''
      while (i < n && s.charCodeAt(i) !== 62) {
        const c = s.charCodeAt(i)
        if (c !== 32 && (c < 9 || c > 13)) hex += s[i]
        i++
      }
      i++
      const bytes2 = new Uint8Array(Math.floor(hex.length / 2))
      for (let k = 0; k < bytes2.length; k++) bytes2[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16)
      let hs = ''
      for (let k = 0; k < bytes2.length; k++) hs += String.fromCharCode(bytes2[k]!)
      pending += decodePdfStringRaw(hs)
    } else if (isAlpha(cc)) { // operator
      let op = ''
      while (i < n && isOpChar(s.charCodeAt(i))) { op += s[i]; i++ }
      if (op === 'Tj' || op === "'" || op === 'TJ' || op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET') flush()
    } else i++
  }
  if (pending) { const t = pending.trimEnd(); if (t) out += t }
  return cleanText(out)
}

export function parsePdf(bytes: Uint8Array): TextSection[] {
  const head = latin1(bytes.subarray(0, 4096))
  if (/\/Encrypt\s/.test(head)) throw new Error('PDF 已加密，无法解析')
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 4096)))
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(tail)) throw new Error('PDF 已加密，无法解析')
  const s = latin1(bytes)
  const sections: TextSection[] = []
  let pageNo = 0
  // Locate streams by object (`N 0 obj <<dict>> stream\n <body> endstream`) and slice
  // by /Length when present — compressed bytes can contain the literal "endstream"
  // sequence, and regex-based truncation used to feed a partial deflate stream into
  // the inflater (which now throws on exhausted input instead of hanging).
  const objRe = /(\d+)\s+\d+\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = objRe.exec(s)) !== null) {
    const dict = m[2] ?? ''
    if (dict.includes('/Image') || dict.includes('/DCTDecode') || dict.includes('/JPXDecode') || dict.includes('/LZWDecode')) continue
    const hasFlate = /\/FlateDecode|\/Fl\b/.test(dict)
    const hasAsciiHex = /\/ASCIIHexDecode|\/AHx\b/.test(dict)
    const start = objRe.lastIndex // data start (right after 'stream\n')
    let end: number
    const indirectLen = /\/Length\s+\d+\s+\d+\s+R/.test(dict)
    const directLen = /\/Length\s+(\d+)\b/.exec(dict)
    if (!indirectLen && directLen !== null) {
      end = Math.min(start + parseInt(directLen[1]!, 10), s.length)
    } else {
      const es = s.indexOf('endstream', start)
      end = es === -1 ? s.length : es
      while (end > start && (s.charCodeAt(end - 1) === 10 || s.charCodeAt(end - 1) === 13)) end--
    }
    const body = s.slice(start, end)
    objRe.lastIndex = end
    const bodyBytes = new Uint8Array(body.length)
    for (let k = 0; k < body.length; k++) bodyBytes[k] = body.charCodeAt(k) & 0xff
    let raw: Uint8Array
    if (hasFlate) {
      try { raw = inflateRaw(bodyBytes) } catch { continue } // undecompressible stream: skip, not fatal
    } else if (hasAsciiHex) {
      let hex = ''
      for (let k = 0; k < bodyBytes.length; k++) {
        const ch = String.fromCharCode(bodyBytes[k]!)
        if (ch === '>') break
        if (ch.trim()) hex += ch
      }
      raw = new Uint8Array(Math.floor(hex.length / 2))
      for (let k = 0; k < raw.length; k++) raw[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16)
    } else raw = bodyBytes
    const text = extractPdfText(raw)
    if (text.length > 0) { pageNo++; sections.push({ loc: `第 ${pageNo} 页`, text }) }
  }
  if (sections.length === 0) throw new Error('未从 PDF 提取到文本（可能是扫描件/图片型 PDF，或无文本层）')
  return sections
}

// ---------- registry ----------
export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'html' | 'txt' | 'md'

export const PARSERS: Record<DocumentKind, (bytes: Uint8Array) => TextSection[]> = {
  pdf: parsePdf,
  docx: parseDocx,
  xlsx: parseXlsx,
  pptx: parsePptx,
  csv: parseCsv,
  html: parseHtml,
  txt: parsePlainText,
  md: parsePlainText,
}

export const EXT_ALIAS: Record<string, DocumentKind> = {
  markdown: 'md', text: 'txt', htm: 'html', doc: 'docx', xls: 'xlsx', ppt: 'pptx',
}

/** Resolve a filename's extension to a supported DocumentKind (or undefined). */
export function extToKind(name: string): DocumentKind | undefined {
  const m = /\.([^.]+)$/.exec(String(name || '').toLowerCase())
  if (!m) return undefined
  const ext = m[1]!
  return (EXT_ALIAS[ext] ?? ext) as DocumentKind | undefined
}
