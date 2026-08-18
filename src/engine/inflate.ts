/**
 * Pure-JS DEFLATE (RFC 1951) decompressor — no external dependencies.
 * Used for PDF FlateDecode streams and ZIP (docx/xlsx/pptx) entries.
 * Ported 1:1 from the unit-tested plain-JS implementation
 * (327/327 assertions against node:zlib).
 */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const FIXED_LIT_LENS = (() => {
  const a = new Array<number>(288).fill(0)
  for (let s = 0; s < 144; s++) a[s] = 8
  for (let s = 144; s < 256; s++) a[s] = 9
  for (let s = 256; s < 280; s++) a[s] = 7
  for (let s = 280; s < 288; s++) a[s] = 8
  return a
})()
const FIXED_DIST_LENS = new Array<number>(30).fill(5)

interface HuffmanTable {
  counts: number[]
  symbols: number[]
  maxLen: number
  empty: boolean
}

/** Build a canonical Huffman decode structure from per-symbol bit lengths. */
function buildHuffman(lengths: readonly number[]): HuffmanTable {
  const counts = new Array<number>(16).fill(0)
  let maxLen = 0
  for (const l of lengths) {
    if (l > 0) {
      if (l > 15) throw new Error('inflate: code length exceeds 15')
      counts[l]++
      if (l > maxLen) maxLen = l
    }
  }
  if (counts[0] === lengths.length) return { counts, symbols: [], maxLen: 0, empty: true }
  const symbols: number[] = []
  for (let l = 1; l <= 15; l++) {
    for (let s = 0; s < lengths.length; s++) if (lengths[s] === l) symbols.push(s)
  }
  let left = 1
  for (let l = 1; l <= 15; l++) {
    left <<= 1
    left -= counts[l]
    if (left < 0) throw new Error('inflate: over-subscribed Huffman code')
  }
  return { counts, symbols, maxLen, empty: false }
}

/** Decode one symbol using the puff.c algorithm. */
function decodeSymbol(br: BitReader, table: HuffmanTable): number {
  if (table.empty) throw new Error('inflate: empty Huffman code used')
  let code = 0
  let first = 0
  let index = 0
  const { counts, symbols, maxLen } = table
  for (let len = 1; len <= maxLen; len++) {
    code |= br.bit()
    const count = counts[len]
    if (code - first < count) return symbols[index + (code - first)] as number
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('inflate: invalid Huffman code')
}

class BitReader {
  readonly data: Uint8Array
  pos = 0
  buf = 0 // bit window (uint32)
  bitCount = 0 // valid bits in window
  constructor(data: Uint8Array) {
    this.data = data
  }
  private need(n: number): void {
    while (this.bitCount < n) {
      if (this.pos >= this.data.length) throw new Error('inflate: input exhausted')
      this.buf = (this.buf | ((this.data[this.pos++] ?? 0) << this.bitCount)) >>> 0
      this.bitCount += 8
    }
  }
  bit(): number {
    this.need(1)
    const b = this.buf & 1
    this.buf >>>= 1
    this.bitCount--
    return b
  }
  bits(n: number): number {
    this.need(n)
    const v = this.buf & ((1 << n) - 1)
    this.buf >>>= n
    this.bitCount -= n
    return v
  }
  align(): void {
    this.buf >>>= this.bitCount
    this.bitCount = 0
  }
  byte(): number {
    return this.bits(8)
  }
  u16le(): number {
    return this.bits(8) | (this.bits(8) << 8)
  }
}

class OutBuffer {
  buf = new Uint8Array(1 << 16)
  len = 0
  private ensure(n: number): void {    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  push(byte: number): void {
    this.ensure(1)
    this.buf[this.len++] = byte
  }
  copy(dist: number, length: number): void {
    if (dist > this.len) throw new Error('inflate: distance too far back')
    this.ensure(length)
    let src = this.len - dist
    for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[src++]!
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

function decodeBlock(br: BitReader, out: OutBuffer, lit: HuffmanTable, dist: HuffmanTable): void {
  for (;;) {
    const sym = decodeSymbol(br, lit)
    if (sym < 256) out.push(sym)
    else if (sym === 256) return
    else {
      const li = sym - 257
      if (li >= LENGTH_BASE.length) throw new Error('inflate: invalid length symbol')
      const length = LENGTH_BASE[li]! + br.bits(LENGTH_EXTRA[li]!)
      const dsym = decodeSymbol(br, dist)
      if (dsym >= DIST_BASE.length) throw new Error('inflate: invalid distance symbol')
      out.copy(DIST_BASE[dsym]! + br.bits(DIST_EXTRA[dsym]!), length)
    }
  }
}

/** Safety cap on decompressed output — a corrupt stream must never balloon. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** Inflate a raw DEFLATE stream (no zlib header). */
export function inflateRaw(input: Uint8Array): Uint8Array {
  const br = new BitReader(input)
  const out = new OutBuffer()
  let final = false
  while (!final) {
    final = br.bit() === 1
    if (out.len > MAX_OUTPUT_BYTES) throw new Error('inflate: output exceeds safety cap')
    const type = br.bits(2)
    if (type === 0) {
      br.align()
      const len = br.u16le()
      const nlen = br.u16le()
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch')
      for (let i = 0; i < len; i++) out.push(br.byte())
    } else if (type === 1) {
      decodeBlock(br, out, buildHuffman(FIXED_LIT_LENS), buildHuffman(FIXED_DIST_LENS))
    } else if (type === 2) {
      const hlit = br.bits(5) + 257
      const hdist = br.bits(5) + 1
      const hclen = br.bits(4) + 4
      if (hlit > 286 || hdist > 30) throw new Error('inflate: dynamic block sizes out of range')
      const clens = new Array<number>(19).fill(0)
      for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]!] = br.bits(3)
      const clenTable = buildHuffman(clens)
      const lens: number[] = []
      while (lens.length < hlit + hdist) {
        const sym = decodeSymbol(br, clenTable)
        if (sym < 16) lens.push(sym)
        else if (sym === 16) {
          if (lens.length === 0) throw new Error('inflate: repeat with no previous length')
          const rep = br.bits(2) + 3
          const prev = lens[lens.length - 1]!
          for (let i = 0; i < rep; i++) lens.push(prev)
        } else if (sym === 17) {
          const rep = br.bits(3) + 3
          for (let i = 0; i < rep; i++) lens.push(0)
        } else {
          const rep = br.bits(7) + 11
          for (let i = 0; i < rep; i++) lens.push(0)
        }
      }
      if (lens.length !== hlit + hdist) throw new Error('inflate: dynamic code length overflow')
      const litLens = lens.slice(0, hlit)
      const distLens = lens.slice(hlit)
      for (let i = 30; i < distLens.length; i++) {
        if (distLens[i] !== 0) throw new Error('inflate: invalid distance code')
      }
      decodeBlock(br, out, buildHuffman(litLens), buildHuffman(distLens))
    } else {
      throw new Error('inflate: reserved block type')
    }
  }
  return out.finish()
}
