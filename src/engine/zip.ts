/**
 * Minimal ZIP reader (local file headers + EOCD + central directory).
 * Supports stored (0) and deflate (8) entries. No external deps.
 */
import { inflateRaw } from './inflate.ts'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50

function readU16(bytes: Uint8Array, off: number): number {
  return (bytes[off] ?? 0) | ((bytes[off + 1] ?? 0) << 8)
}
function readU32(bytes: Uint8Array, off: number): number {
  return (((bytes[off] ?? 0) | ((bytes[off + 1] ?? 0) << 8) | ((bytes[off + 2] ?? 0) << 16) | ((bytes[off + 3] ?? 0) << 24)) >>> 0)
}

/** Sniff the magic bytes of a document payload for clearer diagnostics. */
export function sniffDoc(bytes: Uint8Array): 'zip' | 'ole' | 'rtf' | 'pdf' | 'unknown' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip'
  if (bytes.length >= 8 &&
      bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 &&
      bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) return 'ole'
  if (bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) return 'rtf'
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'
  return 'unknown'
}

/** Require a ZIP payload for docx/xlsx/pptx, with actionable errors. */
export function requireZip(bytes: Uint8Array): void {
  const kind = sniffDoc(bytes)
  if (kind === 'zip') return
  if (kind === 'ole') throw new Error('检测到旧版 Office 二进制格式（.doc/.xls/.ppt）。请用 Office/WPS 打开后“另存为” .docx/.xlsx/.pptx 再上传')
  if (kind === 'rtf') throw new Error('检测到 RTF 文本格式。请另存为 .docx 或 .txt 后再上传')
  if (kind === 'pdf') throw new Error('文件实际是 PDF，但扩展名是 Word/Excel/PPT。请使用正确的 .pdf 扩展名上传')
  throw new Error('文件不是有效的 ZIP 归档：可能已损坏、下载未完成，或扩展名与实际格式不符')
}

export interface ZipEntry {
  name: string
  method: number
  compSize: number
  localOffset: number
}

/**
 * List central-directory entries. Supports stored (0) and deflate (8), plus
 * ZIP64 (EOCD64 locator + zip64 extra fields).
 */
export function listEntries(data: Uint8Array): ZipEntry[] {
  const min = Math.max(0, data.length - 22 - 65535)
  let eocd = -1
  for (let i = data.length - 22; i >= min; i--) {
    if (readU32(data, i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）')
  let count = readU16(data, eocd + 10)
  let off = readU32(data, eocd + 16)
  // ZIP64: locate the ZIP64 EOCD via its locator (20 bytes before EOCD).
  if (count === 0xffff || off === 0xffffffff) {
    const loc = eocd - 20
    if (loc >= 0 && readU32(data, loc) === SIG_EOCD64_LOC) {
      const z64 = readU32(data, loc + 8)
      if (readU32(data, z64) === SIG_EOCD64) {
        count = readU32(data, z64 + 24) // entries on this disk (low 32 of 64-bit)
        off = readU32(data, z64 + 48) // central directory offset (low 32 of 64-bit)
      }
    }
  }
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (readU32(data, off) !== SIG_CENTRAL) throw new Error('ZIP 中央目录损坏')
    const method = readU16(data, off + 10)
    let compSize = readU32(data, off + 20)
    const nameLen = readU16(data, off + 28)
    const extraLen = readU16(data, off + 30)
    const commentLen = readU16(data, off + 32)
    let localOffset = readU32(data, off + 42)
    // ZIP64 extra field (0x0001) overrides sizes/offset when they are 0xFFFFFFFF.
    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = off + 46 + nameLen
      const extraEnd = extraStart + extraLen
      let p = extraStart
      while (p + 4 <= extraEnd) {
        const tag = readU16(data, p)
        const size = readU16(data, p + 2)
        if (tag === 0x0001) {
          if (compSize === 0xffffffff && p + 12 <= extraEnd) compSize = readU32(data, p + 12)
          if (localOffset === 0xffffffff && p + 20 <= extraEnd) localOffset = readU32(data, p + 20)
          break
        }
        p += 4 + size
      }
    }
    let name = ''
    for (let j = 0; j < nameLen; j++) name += String.fromCharCode(data[off + 46 + j]!)
    entries.push({ name, method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Extract one entry's raw bytes. */
export function readEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  if (readU32(data, entry.localOffset) !== SIG_LOCAL) throw new Error(`ZIP 本地头损坏: ${entry.name}`)
  const nameLen = readU16(data, entry.localOffset + 26)
  const extraLen = readU16(data, entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = data.subarray(start, start + entry.compSize)
  if (entry.method === 0) return new Uint8Array(raw)
  if (entry.method === 8) return inflateRaw(raw)
  throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`)
}

/** Extract exact-name entries into a map. */
export function extractAll(data: Uint8Array, names: readonly string[]): Record<string, Uint8Array> {
  const wanted = new Set(names)
  const out: Record<string, Uint8Array> = {}
  for (const e of listEntries(data)) if (wanted.has(e.name)) out[e.name] = readEntry(data, e)
  return out
}

/** Extract entries whose name matches a regexp, sorted by name. */
export function extractMatching(data: Uint8Array, pattern: RegExp): Array<{ name: string; bytes: Uint8Array }> {
  const out: Array<{ name: string; bytes: Uint8Array }> = []
  for (const e of listEntries(data)) if (pattern.test(e.name)) out.push({ name: e.name, bytes: readEntry(data, e) })
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}
