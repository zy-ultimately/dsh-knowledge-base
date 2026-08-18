import { describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { inflateRaw } from '../src/engine/inflate.ts'

function rnd(n: number, seed: number): Uint8Array {
  let s = seed >>> 0
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}

describe('inflateRaw (pure JS DEFLATE)', () => {
  it('round-trips stored blocks (level 0)', () => {
    for (const n of [0, 1, 10, 1000, 65535, 70000]) {
      const input = rnd(n, 42)
      const out = inflateRaw(zlib.deflateRawSync(input, { level: 0 }))
      expect(out).toEqual(input)
    }
  })

  it('round-trips fixed-Huffman blocks (level 1)', () => {
    for (const n of [0, 1, 100, 5000, 50000]) {
      const input = rnd(n, 7)
      expect(inflateRaw(zlib.deflateRawSync(input, { level: 1 }))).toEqual(input)
    }
  })

  it('round-trips dynamic-Huffman blocks (default level)', () => {
    for (const n of [0, 1, 100, 1000, 65535, 200000]) {
      const input = rnd(n, 1234)
      expect(inflateRaw(zlib.deflateRawSync(input))).toEqual(input)
    }
  })

  it('round-trips compressible CJK text', () => {
    let text = ''
    const base = 'The quick brown fox jumps over the lazy dog. 知识库测试文档，年假申请流程。\n'
    while (text.length < 200000) text += base
    const input = new TextEncoder().encode(text)
    expect(inflateRaw(zlib.deflateRawSync(input))).toEqual(input)
  })

  it('rejects corrupt input', () => {
    expect(() => inflateRaw(new Uint8Array([0x00]))).toThrow()
    expect(() => inflateRaw(new Uint8Array([0x05, 0x00, 0x01, 0x02]))).toThrow()
  })
})
