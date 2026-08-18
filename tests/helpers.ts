/**
 * Test fixture helpers: build real (deflated) ZIP files, DOCX/PDF binaries
 * used by the parser and engine tests. Kept in the package so the suite is
 * self-contained — no binary fixtures in the repo.
 */
import zlib from 'node:zlib'

export function str(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
function u16(v: number): Uint8Array { return Uint8Array.of(v & 0xff, (v >> 8) & 0xff) }
function u32(v: number): Uint8Array { return Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff) }

/** Build a ZIP with deflated (8) entries — mirrors real office files. */
export function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = str(e.name)
    const comp = zlib.deflateRawSync(e.data, { level: 6 })
    const local = new Uint8Array(30 + name.length + comp.length)
    local.set(u32(0x04034b50), 0)
    local.set(u16(20), 4)        // version needed
    local.set(u16(0x0800), 6)    // flags: UTF-8 names
    local.set(u16(8), 8)         // method: deflate
    local.set(u32(0), 14)        // crc (unused by our reader)
    local.set(u32(comp.length), 18)
    local.set(u32(e.data.length), 22)
    local.set(u16(name.length), 26)
    local.set(u16(0), 28)
    local.set(name, 30)
    local.set(comp, 30 + name.length)
    localParts.push(local)
    const cen = new Uint8Array(46 + name.length)
    cen.set(u32(0x02014b50), 0)
    cen.set(u16(20), 4)          // version made by
    cen.set(u16(20), 6)          // version needed
    cen.set(u16(0x0800), 8)      // flags
    cen.set(u16(8), 10)          // method
    cen.set(u32(0), 16)          // crc
    cen.set(u32(comp.length), 20)
    cen.set(u32(e.data.length), 24)
    cen.set(u16(name.length), 28)
    cen.set(u16(0), 30)          // extra len
    cen.set(u16(0), 32)          // comment len
    cen.set(u16(0), 34)          // disk start
    cen.set(u16(0), 36)          // internal attrs
    cen.set(u32(0), 38)          // external attrs
    cen.set(u32(offset), 42)     // local header offset
    cen.set(name, 46)
    centralParts.push(cen)
    offset += local.length
  }
  const central = Buffer.concat(centralParts.map((b) => Buffer.from(b)))
  const eocd = new Uint8Array(22)
  eocd.set(u32(0x06054b50), 0)
  eocd.set(u16(0), 4)
  eocd.set(u16(0), 6)
  eocd.set(u16(entries.length), 8)
  eocd.set(u16(entries.length), 10)
  eocd.set(u32(central.length), 12)
  eocd.set(u32(offset), 16)
  eocd.set(u16(0), 20)
  return new Uint8Array(Buffer.concat([...localParts.map((b) => Buffer.from(b)), central, Buffer.from(eocd)]))
}

/** Build a minimal DOCX with the given paragraphs. */
export function buildDocx(paragraphs: string[]): Uint8Array {
  const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>'
  return buildZip([{ name: 'word/document.xml', data: str(xml) }])
}

/** Build a minimal two-page PDF with FlateDecode content streams. */
export function buildPdf(pages: string[]): Uint8Array {
  const enc = (text: string): string => {
    const bytes: number[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      if (cp > 0xffff) {
        const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800
        const lo = ((cp - 0x10000) % 0x400) + 0xdc00
        bytes.push((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)
      } else bytes.push((cp >> 8) & 0xff, cp & 0xff)
    }
    return '<FEFF' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>'
  }
  const contents = pages.map((p) => `BT /F1 12 Tf 72 740 Td ${enc(p)} Tj ET`)
  const streams = contents.map((c) => zlib.deflateRawSync(str(c)))
  const streamObj = (id: number, data: Buffer): string => `${id} 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream\nendobj\n`
  const kids = pages.map((_, i) => `${i + 3} 0 R`).join(' ')
  const pageObjs = pages.map((_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${i + 5} 0 R /Resources << /Font << /F1 ${pages.length + 5} 0 R >> >> >> endobj\n`).join('')
  const streamObjs = streams.map((s, i) => streamObj(i + 5, s)).join('')
  const pdf = '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages.length} >> endobj\n` +
    pageObjs +
    streamObjs +
    `${pages.length + 5} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n` +
    `trailer << /Root 1 0 R /Size ${pages.length + 6} >>\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

/** The attendance/leave DOCX used across tests. */
export const LEAVE_DOCX = buildDocx([
  '公司考勤管理制度',
  '第一条 员工每天上下班需打卡，迟到超过 30 分钟按半天事假处理。',
  '第二条 年假申请：入职满一年员工每年享有 5 天年假，需提前 3 个工作日申请。',
  '第三条 加班可调休，调休需在 6 个月内使用完毕。',
])
