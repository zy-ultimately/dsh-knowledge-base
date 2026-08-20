// ============================================================================
// 全局知识库插件 · 静态 Host 半边（引擎 + 静态 apply 生成）
// 引擎部分（inflate/zip/parsers/bm25/kb）已通过本地全部单测；apply 采用
// dsh 静态插件接口：webServer 路由（/api/dsh-kb/*，loopback-only）+ dsh-tools
// 模型工具 + systemPrompt 引导 + agent/pre-step 自动检索注入。
// 本文件为构建产物（手工生成，等价于 src/*.ts 的编译结果）。
// ============================================================================
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
// ============================================================================
// 引擎部分：DEFLATE / ZIP / 文档解析 / 分词分块 / BM25（全部纯 JS，无外部依赖）
// ============================================================================

// ------------------------- 1. DEFLATE（RFC 1951） --------------------------
const KB_LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const KB_LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const KB_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const KB_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const KB_CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const KB_FIXED_LIT = (() => {
  const a = new Array(288).fill(0);
  for (let s = 0; s < 144; s++) a[s] = 8;
  for (let s = 144; s < 256; s++) a[s] = 9;
  for (let s = 256; s < 280; s++) a[s] = 7;
  for (let s = 280; s < 288; s++) a[s] = 8;
  return a;
})();
const KB_FIXED_DIST = new Array(30).fill(5);

function kbBuildHuffman(lengths) {
  const counts = new Array(16).fill(0);
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > 0) { if (l > 15) throw new Error('inflate: code length exceeds 15'); counts[l]++; if (l > maxLen) maxLen = l; }
  }
  if (counts[0] === lengths.length) return { counts, symbols: [], maxLen: 0, empty: true };
  const symbols = [];
  for (let l = 1; l <= 15; l++) for (let s = 0; s < lengths.length; s++) if (lengths[s] === l) symbols.push(s);
  let left = 1;
  for (let l = 1; l <= 15; l++) { left <<= 1; left -= counts[l]; if (left < 0) throw new Error('inflate: over-subscribed Huffman code'); }
  return { counts, symbols, maxLen, empty: false };
}

function kbDecodeSymbol(br, table) {
  if (table.empty) throw new Error('inflate: empty Huffman code used');
  let code = 0, first = 0, index = 0;
  const { counts, symbols, maxLen } = table;
  for (let len = 1; len <= maxLen; len++) {
    code |= br.bit();
    const count = counts[len];
    if (code - first < count) return symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('inflate: invalid Huffman code');
}

function KB_BitReader(data) {
  this.data = data; this.pos = 0; this.buf = 0; this.bitCount = 0;
}
KB_BitReader.prototype.need = function (n) {
  while (this.bitCount < n) {
    if (this.pos >= this.data.length) throw new Error('inflate: input exhausted');
    this.buf = (this.buf | (this.data[this.pos++] << this.bitCount)) >>> 0;
    this.bitCount += 8;
  }
};
KB_BitReader.prototype.bit = function () { this.need(1); const b = this.buf & 1; this.buf >>>= 1; this.bitCount--; return b; };
KB_BitReader.prototype.bits = function (n) { this.need(n); const v = this.buf & ((1 << n) - 1); this.buf >>>= n; this.bitCount -= n; return v; };
KB_BitReader.prototype.align = function () { this.buf >>>= this.bitCount; this.bitCount = 0; };
KB_BitReader.prototype.byte = function () { return this.bits(8); };
KB_BitReader.prototype.u16le = function () { return this.bits(8) | (this.bits(8) << 8); };

function KB_OutBuffer() { this.chunks = []; this.size = 0; this.buf = new Uint8Array(1 << 16); this.len = 0; }
KB_OutBuffer.prototype.ensure = function (n) {
  if (this.len + n <= this.buf.length) return;
  let cap = this.buf.length; while (cap < this.len + n) cap *= 2;
  const next = new Uint8Array(cap); next.set(this.buf.subarray(0, this.len)); this.buf = next;
};
KB_OutBuffer.prototype.push = function (b) { this.ensure(1); this.buf[this.len++] = b; };
KB_OutBuffer.prototype.copy = function (dist, length) {
  if (dist > this.len) throw new Error('inflate: distance too far back');
  this.ensure(length);
  let src = this.len - dist;
  for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[src++];
};
KB_OutBuffer.prototype.finish = function () { return this.buf.slice(0, this.len); };

const KB_MAX_OUTPUT_BYTES = 256 * 1024 * 1024; // 256MB 安全上限：损坏流不得无限膨胀
function kbInflateRaw(input) {
  if (!(input instanceof Uint8Array)) throw new Error('inflate: expected Uint8Array');
  const br = new KB_BitReader(input);
  const out = new KB_OutBuffer();
  let final = false;
  const decodeBlock = (lit, dist) => {
    for (;;) {
      const sym = kbDecodeSymbol(br, lit);
      if (sym < 256) out.push(sym);
      else if (sym === 256) return;
      else {
        const li = sym - 257;
        if (li >= KB_LENGTH_BASE.length) throw new Error('inflate: invalid length symbol');
        const length = KB_LENGTH_BASE[li] + br.bits(KB_LENGTH_EXTRA[li]);
        const dsym = kbDecodeSymbol(br, dist);
        if (dsym >= KB_DIST_BASE.length) throw new Error('inflate: invalid distance symbol');
        out.copy(KB_DIST_BASE[dsym] + br.bits(KB_DIST_EXTRA[dsym]), length);
      }
    }
  };
  while (!final) {
    final = br.bit() === 1;
    if (out.len > KB_MAX_OUTPUT_BYTES) throw new Error('inflate: output exceeds safety cap');
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      const len = br.u16le(), nlen = br.u16le();
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch');
      for (let i = 0; i < len; i++) out.push(br.byte());
    } else if (type === 1) {
      decodeBlock(kbBuildHuffman(KB_FIXED_LIT), kbBuildHuffman(KB_FIXED_DIST));
    } else if (type === 2) {
      const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
      if (hlit > 286 || hdist > 30) throw new Error('inflate: dynamic block sizes out of range');
      const clens = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) clens[KB_CLEN_ORDER[i]] = br.bits(3);
      const clenTable = kbBuildHuffman(clens);
      const lens = [];
      while (lens.length < hlit + hdist) {
        const sym = kbDecodeSymbol(br, clenTable);
        if (sym < 16) lens.push(sym);
        else if (sym === 16) {
          if (lens.length === 0) throw new Error('inflate: repeat with no previous length');
          const rep = br.bits(2) + 3, prev = lens[lens.length - 1];
          for (let i = 0; i < rep; i++) lens.push(prev);
        } else if (sym === 17) { const rep = br.bits(3) + 3; for (let i = 0; i < rep; i++) lens.push(0); }
        else { const rep = br.bits(7) + 11; for (let i = 0; i < rep; i++) lens.push(0); }
      }
      if (lens.length !== hlit + hdist) throw new Error('inflate: dynamic code length overflow');
      const litLens = lens.slice(0, hlit), distLens = lens.slice(hlit);
      for (let i = 30; i < distLens.length; i++) if (distLens[i] !== 0) throw new Error('inflate: invalid distance code');
      decodeBlock(kbBuildHuffman(litLens), kbBuildHuffman(distLens));
    } else throw new Error('inflate: reserved block type');
  }
  return out.finish();
}

// PDF /FlateDecode 规范上是 zlib 包装 (RFC1950)：2 字节头 (CMF/FLG) + deflate 数据。
// 但部分生成器输出裸 raw deflate。自动检测：头字节符合 zlib 特征则跳过 2 字节；
// 若跳过后的 raw 解压失败（说明其实是裸 deflate），回退整段 raw 解压。
function kbInflateAuto(input) {
  if (!(input instanceof Uint8Array)) throw new Error('inflate: expected Uint8Array');
  const zlibHeader =
    input.length >= 2 &&
    (input[0] & 0x0f) === 8 &&
    ((input[0] << 8) | input[1]) % 31 === 0;
  if (zlibHeader) {
    try { return kbInflateRaw(input.subarray(2)); }
    catch (e) { /* 不是 zlib 包装，回退 raw */ }
  }
  return kbInflateRaw(input);
}

// ------------------------- 2. ZIP --------------------------
function kbU16(bytes, off) { return bytes[off] | (bytes[off + 1] << 8); }
function kbU32(bytes, off) { return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0; }
function kbU64low(bytes, off) { return kbU32(bytes, off); }
const KB_SIG_EOCD64 = 0x06064b50;
const KB_SIG_EOCD64_LOC = 0x07064b50;

// 嗅探文档魔数，给出可操作的错误提示
function kbSniffDoc(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (bytes.length >= 8 &&
      bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 &&
      bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) return 'ole';
  if (bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) return 'rtf';
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  return 'unknown';
}
function kbRequireZip(bytes) {
  const kind = kbSniffDoc(bytes);
  if (kind === 'zip') return;
  if (kind === 'ole') throw new Error('检测到旧版 Office 二进制格式（.doc/.xls/.ppt）。请用 Office/WPS 打开后“另存为” .docx/.xlsx/.pptx 再上传');
  if (kind === 'rtf') throw new Error('检测到 RTF 文本格式。请另存为 .docx 或 .txt 后再上传');
  if (kind === 'pdf') throw new Error('文件实际是 PDF，但扩展名是 Word/Excel/PPT。请使用正确的 .pdf 扩展名上传');
  throw new Error('文件不是有效的 ZIP 归档：可能已损坏、下载未完成，或扩展名与实际格式不符');
}

function kbZipEntries(data) {
  const min = Math.max(0, data.length - 22 - 65535);
  let eocd = -1;
  for (let i = data.length - 22; i >= min; i--) if (kbU32(data, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
  let count = kbU16(data, eocd + 10);
  let off = kbU32(data, eocd + 16);
  // ZIP64：通过 locator 定位 zip64 EOCD
  if (count === 0xffff || off === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && kbU32(data, loc) === KB_SIG_EOCD64_LOC) {
      const z64 = kbU32(data, loc + 8);
      if (kbU32(data, z64) === KB_SIG_EOCD64) {
        count = kbU32(data, z64 + 24); // 本盘条目数（64 位取低 32）
        off = kbU32(data, z64 + 48);   // 中央目录偏移（64 位取低 32）
      }
    }
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (kbU32(data, off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = kbU16(data, off + 10);
    let compSize = kbU32(data, off + 20);
    const nameLen = kbU16(data, off + 28), extraLen = kbU16(data, off + 30), commentLen = kbU16(data, off + 32);
    let localOffset = kbU32(data, off + 42);
    // ZIP64 extra field (0x0001) 覆盖 0xFFFFFFFF 的大小/偏移
    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = off + 46 + nameLen;
      const extraEnd = extraStart + extraLen;
      let p = extraStart;
      while (p + 4 <= extraEnd) {
        const tag = kbU16(data, p);
        const size = kbU16(data, p + 2);
        if (tag === 0x0001) {
          if (compSize === 0xffffffff && p + 12 <= extraEnd) compSize = kbU32(data, p + 12);
          if (localOffset === 0xffffffff && p + 20 <= extraEnd) localOffset = kbU32(data, p + 20);
          break;
        }
        p += 4 + size;
      }
    }
    let name = '';
    for (let j = 0; j < nameLen; j++) name += String.fromCharCode(data[off + 46 + j]);
    entries.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function kbZipRead(data, entry) {
  if (kbU32(data, entry.localOffset) !== 0x04034b50) throw new Error('ZIP 本地头损坏');
  const nameLen = kbU16(data, entry.localOffset + 26), extraLen = kbU16(data, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = data.subarray(start, start + entry.compSize);
  if (entry.method === 0) return new Uint8Array(raw);
  if (entry.method === 8) return kbInflateRaw(raw);
  throw new Error('不支持的压缩方式 ' + entry.method);
}
function kbZipExtractAll(data, names) {
  const entries = kbZipEntries(data);
  const wanted = new Set(names);
  const out = {};
  for (const e of entries) if (wanted.has(e.name)) out[e.name] = kbZipRead(data, e);
  return out;
}
function kbZipExtractMatching(data, pattern) {
  const entries = kbZipEntries(data);
  const out = [];
  for (const e of entries) if (pattern.test(e.name)) out.push({ name: e.name, bytes: kbZipRead(data, e) });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ------------------------- 3. 解析器 --------------------------
function kbUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  catch { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
}
function kbUtf16be(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    if (code >= 0xd800 && code <= 0xdbff && i + 3 < bytes.length) {
      const lo = (bytes[i + 2] << 8) | bytes[i + 3];
      s += String.fromCodePoint(((code - 0xd800) << 10) + (lo - 0xdc00) + 0x10000);
      i += 2;
    } else s += String.fromCharCode(code);
  }
  return s;
}
function kbXmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function kbCollapse(s) {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function kbClean(s) {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
function kbLatin1(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }

function kbParsePlainText(bytes) { return [{ loc: '全文', text: kbCollapse(kbUtf8(bytes)) }]; }

function kbParseCsv(bytes) {
  const text = kbUtf8(bytes);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const sections = rows.map((r, i) => ({ loc: '第 ' + (i + 1) + ' 行', text: r.join('\t').trim() })).filter((s) => s.text.length > 0);
  return sections.length ? sections : [{ loc: '全文', text: '' }];
}

function kbParseHtml(bytes) {
  let s = kbUtf8(bytes);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/&copy;/g, '©').replace(/&reg;/g, '®')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const body = kbCollapse(kbXmlUnescape(s));
  const sections = [];
  if (title.trim()) sections.push({ loc: '标题', text: title.trim() });
  sections.push({ loc: '正文', text: body });
  return sections;
}

function kbParseDocx(bytes) {
  kbRequireZip(bytes);
  const parts = kbZipExtractAll(bytes, ['word/document.xml', 'word/document2.xml']);
  const xml = parts['word/document.xml'] || parts['word/document2.xml'];
  if (!xml) throw new Error('DOCX 中未找到 word/document.xml');
  const doc = kbUtf8(xml);
  const paras = doc.split(/<\/w:p>/);
  const sections = [];
  let buf = '', paraNo = 0;
  for (const p of paras) {
    let line = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>/g;
    let m;
    while ((m = re.exec(p)) !== null) {
      if (m[0].startsWith('<w:t')) line += kbXmlUnescape(m[1]);
      else line += m[0].startsWith('<w:tab') ? ' ' : '\n';
    }
    line = kbClean(line);
    if (!line) continue;
    paraNo++;
    buf += (buf ? '\n' : '') + line;
    if (buf.length >= 1500) { sections.push({ loc: '段落 ' + (paraNo - buf.split('\n').length + 1) + '-' + paraNo, text: kbCollapse(buf) }); buf = ''; }
  }
  if (buf.trim()) sections.push({ loc: '段落 ' + (paraNo - buf.split('\n').length + 1) + '-' + paraNo, text: kbCollapse(buf) });
  if (sections.length === 0) throw new Error('DOCX 未提取到文本（可能为空文档）');
  return sections;
}

function kbParseXlsx(bytes) {
  kbRequireZip(bytes);
  const parts = kbZipExtractAll(bytes, ['xl/sharedStrings.xml']);
  const shared = [];
  const ssXml = parts['xl/sharedStrings.xml'] ? kbUtf8(parts['xl/sharedStrings.xml']) : '';
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(ssXml)) !== null) {
    let s = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<rPr>[\s\S]*?<\/rPr>/g;
    let tm;
    while ((tm = tRe.exec(m[1])) !== null) if (tm[0].startsWith('<t')) s += kbXmlUnescape(tm[1]);
    shared.push(kbClean(s));
  }
  const sheets = kbZipExtractMatching(bytes, /^xl\/worksheets\/sheet\d+\.xml$/);
  if (sheets.length === 0) throw new Error('XLSX 中未找到工作表');
  sheets.sort((a, b) => parseInt((a.name.match(/sheet(\d+)/) || [0, 0])[1], 10) - parseInt((b.name.match(/sheet(\d+)/) || [0, 0])[1], 10));
  const sections = [];
  sheets.forEach((sheet, si) => {
    const xml = kbUtf8(sheet.bytes);
    const rows = xml.split(/<\/row>/);
    const out = [];
    for (const r of rows) {
      const cells = [];
      const cRe = /<c(?:\s[^>]*)?>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(r)) !== null) {
        const cellXml = cm[0];
        const attrs = (cellXml.match(/<c\s([^>]*)>/) || [1, ''])[1];
        const tAttr = (attrs.match(/\bt="([^"]*)"/) || [1, ''])[1];
        const v = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [1, ''])[1];
        const inline = (cellXml.match(/<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/) || [1, ''])[1];
        let val = '';
        if (tAttr === 's') val = shared[parseInt(v, 10)] ?? '';
        else if (tAttr === 'inlineStr') val = kbXmlUnescape(inline);
        else val = kbXmlUnescape(v);
        if (val !== undefined && val.trim()) cells.push(kbClean(val));
      }
      if (cells.length) out.push(cells.join('\t'));
    }
    if (out.length) sections.push({ loc: '工作表 ' + (si + 1) + '（' + sheet.name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '') + '）', text: out.join('\n') });
  });
  if (sections.length === 0) throw new Error('XLSX 未提取到文本（可能为空工作簿）');
  return sections;
}

function kbParsePptx(bytes) {
  kbRequireZip(bytes);
  const slides = kbZipExtractMatching(bytes, /^ppt\/slides\/slide\d+\.xml$/);
  if (slides.length === 0) throw new Error('PPTX 中未找到幻灯片');
  slides.sort((a, b) => parseInt((a.name.match(/slide(\d+)/) || [0, 0])[1], 10) - parseInt((b.name.match(/slide(\d+)/) || [0, 0])[1], 10));
  const sections = [];
  slides.forEach((slide, si) => {
    const xml = kbUtf8(slide.bytes);
    const texts = [];
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = tRe.exec(xml)) !== null) texts.push(kbXmlUnescape(m[1]).trim());
    const joined = kbCollapse(texts.filter(Boolean).join('\n'));
    if (joined) sections.push({ loc: '幻灯片 ' + (si + 1), text: joined });
  });
  if (sections.length === 0) throw new Error('PPTX 未提取到文本');
  return sections;
}

function kbDecodePdfString(raw) {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return kbUtf16be(raw.subarray(2));
  let s = '';
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return s;
}

// 字符串版解码：raw 是原始字节的 latin1 串（避免热循环中每个字符串分配 TextEncoder）
function kbDecodePdfStringRaw(raw) {
  if (raw.length >= 2 && raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < raw.length; i += 2) {
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
      if (code >= 0xd800 && code <= 0xdbff && i + 3 < raw.length) {
        const lo = (raw.charCodeAt(i + 2) << 8) | raw.charCodeAt(i + 3);
        s += String.fromCodePoint(((code - 0xd800) << 10) + (lo - 0xdc00) + 0x10000);
        i += 2;
      } else s += String.fromCharCode(code);
    }
    return s;
  }
  return raw; // PDFDocEncoding ≈ latin1
}

// 解析 ToUnicode CMap（CID → Unicode 映射）。输入是解压后的 CMap 文本。
// 支持 bfchar（一对一）与 bfrange（数值式/数组式）。
function kbParseToUnicodeCMap(text) {
  const map = new Map();
  const bfcharRe = /(\d+)\s+beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfcharRe.exec(text)) !== null) {
    const block = m[2];
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let p;
    while ((p = pairRe.exec(block)) !== null) {
      map.set(parseInt(p[1], 16), String.fromCodePoint(parseInt(p[2], 16)));
    }
  }
  const bfrangeArrRe = /(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeArrRe.exec(text)) !== null) {
    const block = m[2];
    const arrRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    let a;
    while ((a = arrRe.exec(block)) !== null) {
      const lo = parseInt(a[1], 16), hi = parseInt(a[2], 16);
      const dsts = a[3].match(/<([0-9a-fA-F]+)>/g) || [];
      for (let i = 0; i <= hi - lo && i < dsts.length; i++) {
        map.set(lo + i, String.fromCodePoint(parseInt(dsts[i].slice(1, -1), 16)));
      }
    }
    const numRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>(?!\s*\[)/g;
    let n;
    while ((n = numRe.exec(block)) !== null) {
      const lo = parseInt(n[1], 16), hi = parseInt(n[2], 16);
      let dst = parseInt(n[3], 16);
      for (let c = lo; c <= hi; c++) { map.set(c, String.fromCodePoint(dst)); dst++; }
    }
  }
  return map;
}

// fontMaps: { 资源名: Map<cid, unicode> } — 由调用方按页面 Resources 构建。
// 内容流通过 `/FT8 209 Tf` 切换字体，hex 字符串按当前字体的 CID 映射解码。
function kbExtractPdfText(streamBytes, fontMaps) {
  const s = kbLatin1(streamBytes);
  const n = s.length;
  let out = '';
  let i = 0;
  let pending = '';
  let currentFont = '';
  let lastResName = '';
  const isAlpha = (cc) => (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
  const isOpChar = (cc) => (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 42 || cc === 39 || cc === 34;
  const isDigit7 = (cc) => cc >= 48 && cc <= 55;
  const flush = () => {
    if (pending) { const t = pending.trimEnd(); if (t) { out += t; out += '\n'; } pending = ''; }
  };
  while (i < n) {
    const cc = s.charCodeAt(i);
    if (cc === 40) { // '(' 字面字符串
      let depth = 1, raw = '';
      i++;
      while (i < n && depth > 0) {
        const ch = s.charCodeAt(i);
        if (ch === 92) { // '\'
          const nx = s.charCodeAt(i + 1);
          if (nx === 110) raw += '\n'; else if (nx === 114) raw += '\r'; else if (nx === 116) raw += '\t';
          else if (nx === 98) raw += '\b'; else if (nx === 102) raw += '\f';
          else if (nx === 40) raw += '('; else if (nx === 41) raw += ')'; else if (nx === 92) raw += '\\';
          else if (nx >= 48 && nx <= 55) {
            let oct = String.fromCharCode(nx); i++;
            if (i < n && isDigit7(s.charCodeAt(i))) { oct += String.fromCharCode(s.charCodeAt(i)); i++; if (i < n && isDigit7(s.charCodeAt(i))) { oct += String.fromCharCode(s.charCodeAt(i)); } }
            raw += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i--;
          }
          i++;
        } else if (ch === 40) { depth++; raw += '('; }
        else if (ch === 41) { depth--; if (depth > 0) raw += ')'; }
        else raw += String.fromCharCode(ch);
        i++;
      }
      pending += kbDecodePdfStringRaw(raw);
    } else if (cc === 60) { // '<' 十六进制字符串（跳过 '<<' 字典）
      if (s.charCodeAt(i + 1) === 60) { i += 2; continue; }
      i++;
      let hex = '';
      while (i < n && s.charCodeAt(i) !== 62) {
        const c = s.charCodeAt(i);
        if (c !== 32 && (c < 9 || c > 13)) hex += s[i];
        i++;
      }
      i++;
      const bytes2 = new Uint8Array(Math.floor(hex.length / 2));
      for (let k = 0; k < bytes2.length; k++) bytes2[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
      const cmap = currentFont && fontMaps && fontMaps[currentFont];
      if (cmap && bytes2.length > 0) {
        // CID 字体：每 2 字节一个 CID，查 ToUnicode 映射
        let hs = '';
        for (let k = 0; k + 1 < bytes2.length; k += 2) {
          const cid = (bytes2[k] << 8) | bytes2[k + 1];
          const ch = cmap.get(cid);
          hs += ch !== undefined ? ch : String.fromCharCode(cid);
        }
        if (bytes2.length % 2 === 1) hs += String.fromCharCode(bytes2[bytes2.length - 1]);
        pending += hs;
      } else {
        let hs = '';
        for (let k = 0; k < bytes2.length; k++) hs += String.fromCharCode(bytes2[k]);
        pending += kbDecodePdfStringRaw(hs);
      }
    } else if (cc === 47) { // '/' 资源名（如 /FT8）
      lastResName = '';
      i++;
      while (i < n && (/[A-Za-z0-9._-]/.test(s[i]))) { lastResName += s[i]; i++; }
    } else if (isAlpha(cc)) { // 操作符
      let op = '';
      while (i < n && isOpChar(s.charCodeAt(i))) { op += s[i]; i++; }
      if (op === 'Tf' && lastResName) currentFont = lastResName;
      // Tj/TJ/'/Td/TD 只是位置移动或连续文本：只累积不换行（兼容逐字布局的
      // WPS PDF —— 每字一个 Tj+TD，若逐字换行会把文本拆成单字行）；
      // 仅在文本块边界 T*/ET（及 BT）flush，得到完整段落。
      else if (op === 'T*' || op === 'ET' || op === 'BT') flush();
    } else i++;
  }
  if (pending) { const t = pending.trimEnd(); if (t) out += t; }
  return kbClean(out);
}

// 收集 PDF 中 `N 0 obj\n<number>\nendobj` 形式的简单对象（用于解析间接 /Length 引用）
function kbCollectObjectLengths(s) {
  const map = new Map();
  const re = /(\d+)\s+\d+\s+obj\s*\n\s*(\d+)\s*\n\s*endobj/g;
  let m;
  while ((m = re.exec(s)) !== null) map.set(parseInt(m[1], 10), parseInt(m[2], 10));
  return map;
}

// 从 '<<' 起点匹配闭合的 '>>'（处理嵌套字典），返回 dict 文本与闭合位置
function kbMatchDict(s, openAt) {
  let i = openAt + 2;
  let depth = 1;
  const start = i;
  while (i < s.length && depth > 0) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; }
    else if (s[i] === '>' && s[i + 1] === '>') { depth--; i += 2; }
    else i++;
  }
  if (depth !== 0) return null;
  return { dict: s.slice(start, i - 2), closeAfter: i };
}

function kbParsePdf(bytes) {
  const head = kbLatin1(bytes.subarray(0, 4096));
  if (/\/Encrypt\s/.test(head)) throw new Error('PDF 已加密，无法解析');
  const tail = kbLatin1(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(tail)) throw new Error('PDF 已加密，无法解析');
  const s = kbLatin1(bytes);

  // 第一遍：扫描全部对象（dict + 可选 stream），存为 Map<objNum, {dict, body}>
  const objects = new Map();
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = objRe.exec(s)) !== null) {
    const objNum = parseInt(m[1], 10);
    const dictOpen = s.indexOf('<<', objRe.lastIndex);
    if (dictOpen === -1) continue;
    const between = s.slice(objRe.lastIndex, dictOpen);
    if (!/^\s*$/.test(between)) continue; // obj 与 << 之间必须只有空白
    const dm = kbMatchDict(s, dictOpen);
    if (!dm) continue;
    const dict = dm.dict;
    let afterDict = dm.closeAfter;
    while (afterDict < s.length && (s[afterDict] === ' ' || s[afterDict] === '\r' || s[afterDict] === '\n' || s[afterDict] === '\t')) afterDict++;
    let body = null;
    if (s.startsWith('stream', afterDict)) {
      let dataStart = afterDict + 6;
      if (s[dataStart] === '\r') dataStart++;
      if (s[dataStart] === '\n') dataStart++;
      let end;
      const indirectLen = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
      if (indirectLen) {
        const v = kbCollectObjectLengths(s).get(parseInt(indirectLen[1], 10));
        end = v !== undefined ? Math.min(dataStart + v, s.length) : s.indexOf('endstream', dataStart);
      } else {
        const directLen = /\/Length\s+(\d+)\b/.exec(dict);
        end = directLen ? Math.min(dataStart + parseInt(directLen[1], 10), s.length) : s.indexOf('endstream', dataStart);
      }
      if (end === -1) end = s.length;
      while (end > dataStart && (s.charCodeAt(end - 1) === 10 || s.charCodeAt(end - 1) === 13)) end--;
      const bodyStr = s.slice(dataStart, end);
      body = new Uint8Array(bodyStr.length);
      for (let k = 0; k < bodyStr.length; k++) body[k] = bodyStr.charCodeAt(k) & 0xff;
      const endstreamAt = s.indexOf('endstream', end);
      objRe.lastIndex = endstreamAt === -1 ? end + 9 : endstreamAt + 9;
    }
    objects.set(objNum, { dict, body });
  }

  // 解码流：Flate（zlib 或 raw 自动检测）/ ASCIIHex / 原样
  function kbDecodeStream(obj) {
    if (!obj || !obj.body) return null;
    if (obj.dict.includes('/Image') || obj.dict.includes('/DCTDecode') || obj.dict.includes('/JPXDecode') || obj.dict.includes('/LZWDecode')) return null;
    const hasFlate = /\/FlateDecode|\/Fl\b/.test(obj.dict);
    const hasAsciiHex = /\/ASCIIHexDecode|\/AHx\b/.test(obj.dict);
    let raw;
    if (hasFlate) {
      try { raw = kbInflateAuto(obj.body); }
      catch (e) { return null; } // 无法解压的流跳过（不致命）
    } else if (hasAsciiHex) {
      let hex = '';
      for (let k = 0; k < obj.body.length; k++) { const ch = String.fromCharCode(obj.body[k]); if (ch === '>') break; if (ch.trim()) hex += ch; }
      raw = new Uint8Array(Math.floor(hex.length / 2));
      for (let k = 0; k < raw.length; k++) raw[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
    } else raw = obj.body;
    return raw;
  }

  // 字体对象（/Subtype /Type0 + /ToUnicode）→ CID 映射表
  const cidMaps = new Map(); // fontObjNum -> Map<cid, unicode>
  for (const [num, obj] of objects) {
    if (!obj.dict) continue;
    const toUniM = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
    if (!toUniM) continue;
    const cmapObj = objects.get(parseInt(toUniM[1], 10));
    if (!cmapObj || !cmapObj.body) continue;
    const raw = kbDecodeStream(cmapObj);
    if (!raw) continue;
    cidMaps.set(num, kbParseToUnicodeCMap(kbLatin1(raw)));
  }

  // 页面对象：/Type /Page + /Resources /Font（资源名→字体对象）+ /Contents
  const pages = [];
  for (const [num, obj] of objects) {
    if (!obj.dict) continue;
    if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) continue;
    const fonts = {};
    // 深度匹配 /Resources << ... >>（内部可能嵌套 ExtGState/Font dict）
    const resIdx = obj.dict.indexOf('/Resources');
    if (resIdx !== -1) {
      const resDictOpen = obj.dict.indexOf('<<', resIdx);
      if (resDictOpen !== -1) {
        const resDm = kbMatchDict(obj.dict, resDictOpen);
        if (resDm) {
          const fontIdx = resDm.dict.indexOf('/Font');
          if (fontIdx !== -1) {
            const fontDictOpen = resDm.dict.indexOf('<<', fontIdx);
            if (fontDictOpen !== -1) {
              const fontDm = kbMatchDict(resDm.dict, fontDictOpen);
              if (fontDm) {
                const fRe = /\/([A-Za-z0-9._-]+)\s+(\d+)\s+0\s+R/g;
                let fm;
                while ((fm = fRe.exec(fontDm.dict)) !== null) {
                  fonts[fm[1]] = parseInt(fm[2], 10);
                }
              }
            }
          }
        }
      }
    }
    const contents = [];
    const singleM = /\/Contents\s+(\d+)\s+0\s+R/.exec(obj.dict);
    const arrM = /\/Contents\s*\[([\s\S]*?)\]/.exec(obj.dict);
    if (singleM) contents.push(parseInt(singleM[1], 10));
    if (arrM) {
      const numRe = /(\d+)\s+0\s+R/g;
      let nm;
      while ((nm = numRe.exec(arrM[1])) !== null) contents.push(parseInt(nm[1], 10));
    }
    pages.push({ objNum: num, fonts, contents });
  }

  const sections = [];
  let pageNo = 0;
  for (const page of pages) {
    const fontMaps = {};
    for (const [resName, fontObjNum] of Object.entries(page.fonts)) {
      if (cidMaps.has(fontObjNum)) fontMaps[resName] = cidMaps.get(fontObjNum);
    }
    let pageText = '';
    for (const contentObjNum of page.contents) {
      const obj = objects.get(contentObjNum);
      if (!obj) continue;
      const raw = kbDecodeStream(obj);
      if (!raw) continue;
      pageText += kbExtractPdfText(raw, fontMaps);
    }
    if (pageText.trim()) { pageNo++; sections.push({ loc: '第 ' + pageNo + ' 页', text: pageText }); }
  }

  // 回退：无页面对象时扫描全部非字体/图片流（兼容非常规结构）
  if (sections.length === 0) {
    for (const [num, obj] of objects) {
      if (!obj || !obj.body) continue;
      if (obj.dict.includes('/Image') || obj.dict.includes('/FontFile') || obj.dict.includes('/Length1')) continue;
      const raw = kbDecodeStream(obj);
      if (!raw) continue;
      const text = kbExtractPdfText(raw, {});
      if (text.trim()) { pageNo++; sections.push({ loc: '第 ' + pageNo + ' 页', text }); }
    }
  }
  if (sections.length === 0) throw new Error('未从 PDF 提取到文本（可能是扫描件/图片型 PDF，或无文本层）');
  return sections;
}

const KB_PARSERS = {
  pdf: kbParsePdf, docx: kbParseDocx, xlsx: kbParseXlsx, pptx: kbParsePptx,
  csv: kbParseCsv, html: kbParseHtml, txt: kbParsePlainText, md: kbParsePlainText,
};
const KB_EXT_ALIAS = { markdown: 'md', text: 'txt', htm: 'html', doc: 'docx', xls: 'xlsx', ppt: 'pptx' };

// ------------------------- 4. 分词 / 分块 / BM25 --------------------------
const KB_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KB_STOP = new Set([
  '的','了','在','是','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','与','及','或','等','对','从','于','并','而','为','之','其','被','把','个','们','吗','呢','吧','啊','中','里','我们','你们','他们','这个','那个','这些','那些','可以','进行','通过','以及','但是','如果','因为','所以','然后','关于','对于','按照','根据','应该','需要','必须','可能','相关','内容','文档','文件','知识','库','请','问','什么','怎么','如何','为什么','多少','是否','如何申请',
  'the','a','an','and','or','but','of','to','in','on','at','for','with','by','from','is','are','was','were','be','been','it','this','that','these','those','as','do','does','did','have','has','had','not','no','yes','you','your','we','our','they','their','i','he','she','will','would','can','could','should','may','might','about','into','over','under','than','then','there','here','what','which','who','whom','when','where','why','how'
]);

function kbTokenize(text) {
  const tokens = [];
  const s = String(text).toLowerCase();
  const n = s.length;
  let i = 0;
  const isCJK = (cc) => (cc >= 0x3400 && cc <= 0x4dbf) || (cc >= 0x4e00 && cc <= 0x9fff) || (cc >= 0xf900 && cc <= 0xfaff);
  const isWord = (cc) => (cc >= 48 && cc <= 57) || (cc >= 97 && cc <= 122);
  while (i < n) {
    const cc = s.charCodeAt(i);
    if (isCJK(cc)) {
      let j = i;
      const run = [];
      while (j < n && isCJK(s.charCodeAt(j))) { run.push(s[j]); j++; }
      if (run.length === 1) tokens.push(run[0]);
      else for (let k = 0; k + 1 < run.length; k++) tokens.push(run[k] + run[k + 1]);
      i = j;
    } else if (isWord(cc)) {
      let j = i;
      while (j < n && isWord(s.charCodeAt(j))) j++;
      const word = s.slice(i, j);
      if (word.length >= 2 || /^[0-9]+$/.test(word)) tokens.push(word);
      i = j;
    } else i++;
  }
  return tokens.filter((t) => !KB_STOP.has(t));
}

function kbChunkSection(section, chunkSize, overlap) {
  chunkSize = chunkSize || 600;
  overlap = overlap || 80;
  if (overlap >= chunkSize) overlap = Math.floor(chunkSize / 2);
  const paras = section.text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paras.length === 0) return [];
  const chunks = [];
  let buf = '', startPara = 1, paraIdx = 0;
  for (const p of paras) {
    paraIdx++;
    if (buf && buf.length + p.length + 1 > chunkSize && buf.length >= chunkSize / 2) {
      chunks.push({ text: buf, from: startPara, to: paraIdx - 1 });
      buf = buf.slice(-overlap);
      startPara = paraIdx;
    }
    buf = buf ? buf + '\n' + p : p;
  }
  if (buf.trim()) chunks.push({ text: buf, from: startPara, to: paraIdx });
  const out = [];
  for (const ch of chunks) {
    if (ch.text.length <= chunkSize * 1.5) { out.push(ch); continue; }
    let t = ch.text;
    while (t.length > chunkSize) {
      let cut = t.lastIndexOf('\n', chunkSize);
      if (cut < chunkSize / 2) cut = t.lastIndexOf(' ', chunkSize);
      if (cut < chunkSize / 2) cut = chunkSize;
      out.push({ text: t.slice(0, cut).trim(), from: ch.from, to: ch.to });
      t = t.slice(Math.max(0, cut - overlap)).trim();
    }
    if (t.trim()) out.push({ text: t.trim(), from: ch.from, to: ch.to });
  }
  return out.filter((c) => c.text.length > 0);
}

function kbBm25Index() {
  this.chunks = [];
  this.postings = new Map();
  this.docLen = [];
  this.totalTokens = 0;
  this.avgLen = 0;
  this.k1 = 1.5;
  this.b = 0.75;
  this.ready = false;
}
kbBm25Index.prototype.build = function (chunks) {
  this.chunks = chunks;
  this.postings = new Map();
  this.docLen = [];
  this.totalTokens = 0;
  for (let i = 0; i < chunks.length; i++) {
    const tokens = kbTokenize(chunks[i].text);
    this.docLen[i] = tokens.length;
    this.totalTokens += tokens.length;
    const seen = new Map();
    for (const t of tokens) seen.set(t, (seen.get(t) || 0) + 1);
    for (const [t, tf] of seen) {
      let p = this.postings.get(t);
      if (!p) { p = new Map(); this.postings.set(t, p); }
      p.set(i, tf);
    }
  }
  this.avgLen = this.chunks.length ? this.totalTokens / this.chunks.length : 0;
  this.ready = true;
};
kbBm25Index.prototype.toJSON = function () {
  const postings = {};
  for (const [term, p] of this.postings) { postings[term] = {}; for (const [idx, tf] of p) postings[term][idx] = tf; }
  return { chunks: this.chunks, docLen: this.docLen, totalTokens: this.totalTokens, avgLen: this.avgLen, postings };
};
kbBm25Index.fromJSON = function (data) {
  const idx = new kbBm25Index();
  idx.chunks = data.chunks || [];
  idx.docLen = data.docLen || [];
  idx.totalTokens = data.totalTokens || 0;
  idx.avgLen = data.avgLen || 0;
  idx.postings = new Map();
  for (const term of Object.keys(data.postings || {})) {
    const p = new Map();
    for (const k of Object.keys(data.postings[term])) p.set(Number(k), data.postings[term][k]);
    idx.postings.set(term, p);
  }
  idx.ready = idx.chunks.length > 0;
  return idx;
};
kbBm25Index.prototype.search = function (query, topK) {
  topK = topK || 5;
  if (!this.ready || this.chunks.length === 0) return [];
  const terms = kbTokenize(query);
  if (terms.length === 0) return [];
  const n = this.chunks.length;
  const avgLen = this.avgLen || 1;
  const scores = new Map();
  const matchedTerms = new Map();
  const uniqueTerms = [...new Set(terms)];
  for (const term of uniqueTerms) {
    const post = this.postings.get(term);
    if (!post) continue;
    const df = post.size;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [idx, tf] of post) {
      const len = this.docLen[idx] || 1;
      const score = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (len / avgLen))));
      scores.set(idx, (scores.get(idx) || 0) + score);
      let mt = matchedTerms.get(idx);
      if (!mt) { mt = new Set(); matchedTerms.set(idx, mt); }
      mt.add(term);
    }
  }
  if (scores.size === 0) return [];
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  const results = [];
  for (const [idx, score] of ranked) {
    const chunk = this.chunks[idx];
    const text = chunk.text.toLowerCase();
    let bonus = 0;
    for (let k = 0; k + 1 < terms.length; k++) {
      if (KB_CJK.test(terms[k][0]) && KB_CJK.test(terms[k + 1][0]) && text.includes(terms[k] + terms[k + 1])) bonus += 0.5;
    }
    results.push({ chunkIdx: idx, chunkId: chunk.id, docId: chunk.docId, loc: chunk.loc, score: score + bonus, matchedTerms: matchedTerms.get(idx).size, text: chunk.text });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
};

// ------------------------- 5. 知识库引擎 --------------------------
const KB_DEFAULT_CONFIG = {
  enabled: true,        // 自动检索开关
  topK: 4,              // 注入片段数
  minScore: 0.5,        // 最低相关分
  chunkSize: 600,       // 分块字符数
  overlap: 80,          // 分块重叠
  storageDir: '',       // 存储目录（空 = 工作区下 .dsh-knowledge-base）
  maxContextChars: 4000, // 注入上下文最大字符数
  maxUploadBytes: 20 * 1024 * 1024, // 单文件上限
};
let kbState = null;      // { version, config, docs, chunks, indexJSON }
let kbIndex = null;      // kbBm25Index 实例
let kbRoot = null;       // 存储目录
let kbSaveChain = Promise.resolve();
const kbJobs = new Map(); // id -> Promise
let kbSeq = 0;
let kbYield = () => Promise.resolve(); // 大文档解析时让出事件循环（apply 中注入）
// 每次 fs 写入的沙箱策略：以会话工作区（或用户配置的 storageDir）为可写根。
// 本部署的 ctx.fs 是 dsh-fs-sandbox：不传策略时按“部署默认根”（进程 cwd）判可写，
// 会把会话工作区内的写入误判为越界而拒绝（上传失败的根因）。
let kbWritePolicy = () => ({ mode: 'workspace-write', workspaceRoot: '' });

function kbJoin(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}
function kbExtOf(name) {
  const m = /\.([^.]+)$/.exec(String(name || '').toLowerCase());
  return m ? m[1] : '';
}
function kbFmtTime(ts) {
  try {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return String(ts); }
}
function kbFmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
const KB_B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// 字节精确 base64（latin1 安全）：宿主内置 btoa/atob 是 UTF-8 语义的，
// 会把二进制的高位字节按 UTF-8 处理（无效序列 → U+FFFD → 截断成 0xFD），
// 这是之前上传文件被破坏、解析报“ZIP 中央目录损坏”的根因。
function kbBytesToB64(bytes) {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += KB_B64_ALPHABET[b0 >> 2];
    out += KB_B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? KB_B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < n ? KB_B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}
function kbB64ToBytes(b64) {
  const s = String(b64).replace(/\s+/g, '');
  const len = s.length;
  const bytes = new Uint8Array(Math.floor((len + 3) / 4) * 3);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    let v;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 71;
    else if (c >= 48 && c <= 57) v = c + 4;
    else if (c === 43) v = 62;
    else if (c === 47) v = 63;
    else if (c === 61) break;
    else continue;
    acc = ((acc << 6) | v) >>> 0;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, o);
}
function kbNewId(prefix) {
  kbSeq++;
  return `${prefix}-${Date.now().toString(36)}-${kbSeq}-${Math.random().toString(36).slice(2, 8)}`;
}
function kbClone(obj) { return JSON.parse(JSON.stringify(obj)); }

async function kbLoad(fsSvc, wsRoot) {
  // 先读默认位置（工作区 .dsh-knowledge-base），若其中配置了 storageDir 则再从该目录读取
  const defaultRoot = wsRoot ? kbJoin(wsRoot, '.dsh-knowledge-base') : '.dsh-knowledge-base';
  let data = null;
  let root = defaultRoot;
  try {
    const t = await fsSvc.resolve(kbJoin(defaultRoot, 'kb.json'));
    const text = await fsSvc.readText(t);
    if (text) data = JSON.parse(text);
  } catch (e) { data = null; }
  if (data && data.config && data.config.storageDir) {
    const configured = String(data.config.storageDir).trim();
    if (configured && configured !== defaultRoot) {
      root = configured;
      try {
        const t = await fsSvc.resolve(kbJoin(root, 'kb.json'));
        const text = await fsSvc.readText(t);
        if (text) data = JSON.parse(text);
      } catch (e) { /* 保留首次读取结果 */ }
    }
  }
  kbRoot = root;
  if (data && data.version === 1) {
    kbState = {
      version: 1,
      config: Object.assign({}, KB_DEFAULT_CONFIG, data.config || {}),
      docs: data.docs || {},
      chunks: data.chunks || [],
    };
  } else {
    kbState = { version: 1, config: kbClone(KB_DEFAULT_CONFIG), docs: {}, chunks: [] };
  }
  // 恢复残留的“解析中”状态：上次进程可能因解析器问题卡死/中断，标为可重试
  let stale = false;
  for (const d of Object.values(kbState.docs)) {
    if (d.status === 'parsing') {
      d.status = 'error';
      d.message = '解析被中断，请点击“重新解析”';
      stale = true;
    }
  }
  if (stale) kbPersist(fsSvc);
  kbIndex = new kbBm25Index();
  kbIndex.build(kbState.chunks.map((c, i) => ({ ...c, id: c.id || 'chunk-' + i })));
  return kbState;
}

function kbPersist(fsSvc) {
  const snapshot = kbState;
  const payload = JSON.stringify({
    version: 1,
    config: snapshot.config,
    docs: snapshot.docs,
    chunks: snapshot.chunks,
  });
  kbSaveChain = kbSaveChain.then(async () => {
    try {
      const target = await fsSvc.resolve(kbJoin(kbRoot, 'kb.json'));
      await fsSvc.writeText(target, payload, undefined, undefined, kbWritePolicy());
    } catch (e) { console.error('kb: persist failed', e && e.message ? e.message : e); }
  });
  return kbSaveChain;
}

async function kbSaveRaw(fsSvc, docId, ext, bytes) {
  const target = await fsSvc.resolve(kbJoin(kbRoot, 'raw', docId + '.' + ext + '.b64'));
  await fsSvc.writeText(target, kbBytesToB64(bytes), undefined, undefined, kbWritePolicy());
}

async function kbReadRaw(fsSvc, doc) {
  const target = await fsSvc.resolve(kbJoin(kbRoot, 'raw', doc.id + '.' + doc.ext + '.b64'));
  const text = await fsSvc.readText(target);
  return kbB64ToBytes(text);
}

function kbRebuildIndex() {
  const chunkList = [];
  for (const docId of Object.keys(kbState.docs)) {
    const doc = kbState.docs[docId];
    for (const c of doc.chunks || []) chunkList.push({ id: c.id, docId, loc: c.loc, text: c.text });
  }
  kbState.chunks = chunkList;
  kbIndex = new kbBm25Index();
  kbIndex.build(chunkList);
}

async function kbParseDocument(fsSvc, doc) {
  const bytes = await kbReadRaw(fsSvc, doc);
  const parser = KB_PARSERS[doc.ext];
  if (!parser) throw new Error('不支持的文件格式: .' + doc.ext);
  const sections = parser(bytes);
  if (!sections || sections.length === 0) throw new Error('未提取到任何文本');
  const chunks = [];
  for (const sec of sections) {
    for (const c of kbChunkSection(sec, kbState.config.chunkSize, kbState.config.overlap)) {
      chunks.push({ id: kbNewId('chunk'), loc: sec.loc, text: c.text });
    }
    await kbYield(); // 每段让出事件循环，避免大文档解析时阻塞 UI
  }
  if (chunks.length === 0) throw new Error('未提取到可索引的文本内容');
  return chunks;
}

async function kbReindexDoc(fsSvc, docId, docName, ext) {
  const job = (async () => {
    const doc = { id: docId, name: docName, ext };
    try {
      doc.chunks = await kbParseDocument(fsSvc, doc);
      if (kbState.docs[docId]) {
        kbState.docs[docId].chunks = doc.chunks;
        kbState.docs[docId].status = 'ready';
        kbState.docs[docId].message = '';
        kbState.docs[docId].chunkCount = doc.chunks.length;
        const locs = [...new Set(doc.chunks.map((c) => c.loc))].slice(0, 3);
        kbState.docs[docId].locs = locs;
      }
      kbRebuildIndex();
      await kbPersist(fsSvc);
    } catch (e) {
      if (kbState.docs[docId]) {
        kbState.docs[docId].status = 'error';
        kbState.docs[docId].message = e && e.message ? e.message : String(e);
      }
      await kbPersist(fsSvc);
    } finally {
      kbJobs.delete(docId);
    }
  })();
  kbJobs.set(docId, job);
  return job;
}

function kbSearch(text, topK, minScore) {
  if (!kbIndex || !kbState) return [];
  const cfg = kbState.config;
  const k = topK || cfg.topK || 4;
  const min = minScore !== undefined ? minScore : cfg.minScore;
  const hits = kbIndex.search(String(text), Math.min(k, 10));
  const out = [];
  for (const h of hits) {
    if (h.score < min) continue;
    const doc = kbState.docs[h.docId];
    out.push({ docId: h.docId, docName: doc ? doc.name : h.docId, ext: doc ? doc.ext : '', loc: h.loc, score: h.score, text: h.text });
  }
  return out;
}

function kbBuildContext(query, hits, cfg) {
  const lines = [];
  lines.push('【全局知识库检索】针对当前问题自动检索到 ' + hits.length + ' 个相关片段，请优先依据这些片段回答；若片段不足以回答，请明确说明“知识库中信息不足”，再结合自身知识补充，不要编造。');
  lines.push('');
  lines.push('问题：' + String(query).slice(0, 500));
  lines.push('');
  let total = 0;
  const max = cfg.maxContextChars || 4000;
  hits.forEach((h, i) => {
    const src = '来源：知识库《' + h.docName + '》' + (h.loc && h.loc !== '全文' ? ' · ' + h.loc : '');
    let t = h.text;
    const budget = max - total - src.length - 12;
    if (budget <= 0) return;
    if (t.length > budget) t = t.slice(0, budget) + '…';
    total += t.length + src.length + 8;
    lines.push('片段 ' + (i + 1) + '（' + src + '）：');
    lines.push(t);
    lines.push('');
  });
  lines.push('回答要求：若回答基于以上片段，请在回答末尾标注「来源：知识库《文档名》」；未使用片段的内容不要标注来源。');
  return lines.join('\n');
}

function kbDocView(doc) {
  return {
    id: doc.id, name: doc.name, ext: doc.ext, size: doc.size,
    uploadedAt: doc.uploadedAt, status: doc.status, message: doc.message || '',
    chunkCount: doc.chunkCount || 0, locs: doc.locs || [],
  };
}

function kbStats() {
  const docs = kbState ? Object.values(kbState.docs) : [];
  let chunks = 0, parsing = 0, errors = 0;
  for (const d of docs) {
    chunks += d.chunkCount || 0;
    if (d.status === 'parsing') parsing++;
    if (d.status === 'error') errors++;
  }
  return { total: docs.length, chunks, parsing, errors, storageDir: kbRoot };
}



// ------------------------- 6. 静态插件导出 --------------------------
export const name = 'knowledge-base';
export const inject = ['fs', 'webServer', 'tools', 'systemPrompt', 'sandboxPolicy'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
});

const KB_API = {
  stats: '/api/dsh-kb/stats',
  list: '/api/dsh-kb/list',
  upload: '/api/dsh-kb/upload',
  reparse: '/api/dsh-kb/reparse',
  delete: '/api/dsh-kb/delete',
  search: '/api/dsh-kb/search',
  config: '/api/dsh-kb/config',
};
const KB_GUIDANCE = '系统已集成全局知识库：当用户问题与已上传文档相关时，系统会自动检索并将相关片段注入上下文（标注“【全局知识库检索】”）。若回答基于知识库片段，请在回答末尾标注「来源：知识库《文档名》」；若知识库中没有相关信息，请如实说明，不要编造来源。';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch { return undefined; }
}
async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function apply(ctx, config) {
  const fsSvc = ctx.fs;
  const sp = ctx.systemPrompt;
  const toolsSvc = ctx.tools;
  kbYield = () => Promise.resolve();

  // 根目录固定在启动时确定（会话工作区或配置的 storageDir），绝不随 agent 重定位
  let ws = '';
  try {
    const sessionsSvc = ctx.get('sessions');
    if (sessionsSvc && typeof sessionsSvc.list === 'function') {
      const live = sessionsSvc.list() || [];
      const withCwd = live.find((s) => s && s.header && s.header.cwd);
      if (withCwd) ws = withCwd.header.cwd;
    }
  } catch (e) { /* ignore */ }
  // 桌面 GUI 的 host 主进程没有活跃会话、也没有 workspace 服务：
  // 改从 DSH_HOME/storages/workspace.json（host 一定可读）读取真实工作区目录。
  // 该文件由 dsh-workspace 维护，tables.workspaces.<id>.path 是工作区真实路径。
  if (!ws) {
    try {
      const dshHome = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || '';
      if (dshHome) {
        const wsFile = pathJoin(dshHome, 'storages', 'workspace.json');
        if (existsSync(wsFile)) {
          const parsed = JSON.parse(readFileSync(wsFile, 'utf8'));
          const tables = parsed && parsed.tables && parsed.tables.workspaces;
          if (tables) {
            for (const key of Object.keys(tables)) {
              const rec = tables[key];
              if (rec && typeof rec.path === 'string' && rec.path) { ws = rec.path; break; }
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
  if (!ws) {
    const sandbox = ctx.get('sandboxPolicy');
    // 兜底：拒绝把知识库建在程序安装目录（桌面部署的 process.cwd）
    const candidate = sandbox && sandbox.workspaceRoot ? sandbox.workspaceRoot : '';
    const programDir = typeof process !== 'undefined' && process.cwd ? process.cwd() : '';
    if (candidate && candidate !== programDir) ws = candidate;
    else ws = '';
  }
  // 仍无可用根：退回用户主目录（机器级稳定位置）
  if (!ws) {
    ws = (typeof process !== 'undefined' && process.env && process.env.USERPROFILE) || '';
  }
  kbWritePolicy = () => {
    const dir = (kbState && kbState.config && kbState.config.storageDir) || '';
    return { mode: 'workspace-write', workspaceRoot: dir || ws || '' };
  };
  const boot = (async () => {
    try {
      await kbLoad(fsSvc, ws);
      console.log('kb: loaded from ' + kbRoot + ', docs=' + (kbState ? Object.keys(kbState.docs).length : 0));
    } catch (e) {
      console.error('kb: boot failed', e && e.message ? e.message : e);
      if (!kbState) kbState = { version: 1, config: kbClone(KB_DEFAULT_CONFIG), docs: {}, chunks: [] };
    }
  })();

  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return false; }
    if (req.method !== method) { writeJson(res, 405, { error: 'method not allowed' }); return false; }
    return true;
  };

  const routes = [
    { kind: 'exact', path: KB_API.stats, handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return;
      await boot;
      writeJson(res, 200, kbStats());
    }},
    { kind: 'exact', path: KB_API.list, handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return;
      await boot;
      const docs = Object.values(kbState.docs).sort((a, b) => b.uploadedAt - a.uploadedAt).map(kbDocView);
      writeJson(res, 200, { docs, config: kbClone(kbState.config) });
    }},
    { kind: 'exact', path: KB_API.upload, handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      await boot;
      if (!kbState.config.enabled) { writeJson(res, 400, { error: '知识库已停用，请先启用后再上传' }); return; }
      const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '';
      const body = await readRawBody(req);
      if (body === undefined) { writeJson(res, 413, { error: '文件过大或读取失败（上限 20MB）' }); return; }
      try {
        const ext = kbExtOf(name);
        const realExt = KB_EXT_ALIAS[ext] || ext;
        if (!KB_PARSERS[realExt]) throw new Error('不支持的文件格式: .' + ext + '（支持 pdf/docx/txt/md/xlsx/pptx/csv/html）');
        if (body.length === 0) throw new Error('文件为空');
        const maxB = kbState.config.maxUploadBytes || 20 * 1024 * 1024;
        if (body.length > maxB) throw new Error('文件超过大小上限 ' + kbFmtSize(maxB));
        const bytes = new Uint8Array(body);
        const id = kbNewId('doc');
        const doc = {
          id, name: name.trim(), ext: realExt, size: bytes.length,
          uploadedAt: Date.now(), status: 'parsing', message: '', chunkCount: 0, locs: [],
        };
        kbState.docs[id] = doc;
        await kbSaveRaw(fsSvc, id, realExt, bytes);
        await kbPersist(fsSvc);
        kbReindexDoc(fsSvc, id, doc.name, realExt); // 后台解析
        writeJson(res, 200, { ok: true, doc: kbDocView(doc) });
      } catch (e) {
        writeJson(res, 400, { error: e && e.message ? e.message : String(e) });
      }
    }},
    { kind: 'exact', path: KB_API.reparse, handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      await boot;
      const body = await readJsonBody(req);
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!id) { writeJson(res, 400, { error: '缺少 id' }); return; }
      const doc = kbState.docs[id];
      if (!doc) { writeJson(res, 400, { error: '文档不存在' }); return; }
      doc.status = 'parsing';
      doc.message = '';
      await kbPersist(fsSvc);
      kbReindexDoc(fsSvc, doc.id, doc.name, doc.ext);
      writeJson(res, 200, { ok: true });
    }},
    { kind: 'exact', path: KB_API.delete, handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      await boot;
      const body = await readJsonBody(req);
      const id = typeof body?.id === 'string' ? body.id : '';
      const doc = kbState.docs[id];
      if (!doc) { writeJson(res, 400, { error: '文档不存在' }); return; }
      delete kbState.docs[id];
      kbRebuildIndex();
      await kbPersist(fsSvc);
      try {
        // 真正删除 raw 文件（而非清空）：fsSvc 无 unlink，宿主进程内直接用 Node rm 删除
        const target = await fsSvc.resolve(kbJoin(kbRoot, 'raw', doc.id + '.' + doc.ext + '.b64'));
        const key = typeof target === 'object' && target !== null && 'targetKey' in target ? target.targetKey : target;
        rmSync(String(key), { force: true });
      } catch (e) { /* ignore */ }
      writeJson(res, 200, { ok: true });
    }},
    { kind: 'exact', path: KB_API.search, handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      await boot;
      const body = await readJsonBody(req);
      const q = typeof body?.query === 'string' ? body.query : '';
      const topK = typeof body?.topK === 'number' ? body.topK : undefined;
      const hits = q.trim() ? kbSearch(q, topK || kbState.config.topK, 0) : [];
      writeJson(res, 200, { hits: hits.map((h) => ({ doc: h.docName, loc: h.loc, score: Number(h.score.toFixed(3)), text: h.text.slice(0, 800) })) });
    }},
    { kind: 'exact', path: KB_API.config, handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      await boot;
      const body = await readJsonBody(req);
      const patch = body?.patch;
      if (typeof patch !== 'object' || patch === null) { writeJson(res, 400, { error: '缺少 patch' }); return; }
      const oldDir = kbState.config.storageDir;
      const allowed = ['enabled', 'topK', 'minScore', 'chunkSize', 'overlap', 'storageDir', 'maxContextChars'];
      for (const k of allowed) {
        if (patch[k] !== undefined) {
          if (k === 'topK') kbState.config.topK = Math.max(1, Math.min(10, Number(patch[k]) || 4));
          else if (k === 'minScore') kbState.config.minScore = Math.max(0, Number(patch[k]) || 0);
          else if (k === 'chunkSize') kbState.config.chunkSize = Math.max(200, Math.min(4000, Number(patch[k]) || 600));
          else if (k === 'overlap') kbState.config.overlap = Math.max(0, Math.min(500, Number(patch[k]) || 80));
          else if (k === 'maxContextChars') kbState.config.maxContextChars = Math.max(500, Math.min(20000, Number(patch[k]) || 4000));
          else if (k === 'enabled') kbState.config.enabled = Boolean(patch[k]);
          else if (k === 'storageDir') kbState.config.storageDir = String(patch[k] || '').trim();
        }
      }
      await kbPersist(fsSvc);
      if (kbState.config.storageDir !== oldDir) {
        const newRoot = kbState.config.storageDir ? kbState.config.storageDir : kbJoin(ws, '.dsh-knowledge-base');
        if (newRoot !== kbRoot) {
          const oldRoot = kbRoot;
          try {
            for (const id of Object.keys(kbState.docs)) {
              const d = kbState.docs[id];
              const t = await fsSvc.resolve(kbJoin(oldRoot, 'raw', d.id + '.' + d.ext + '.b64'));
              const text = await fsSvc.readText(t);
              const nt = await fsSvc.resolve(kbJoin(newRoot, 'raw', d.id + '.' + d.ext + '.b64'));
              await fsSvc.writeText(nt, text, undefined, undefined, kbWritePolicy());
            }
            const src = await fsSvc.resolve(kbJoin(oldRoot, 'kb.json'));
            const text = await fsSvc.readText(src);
            const dst = await fsSvc.resolve(kbJoin(newRoot, 'kb.json'));
            await fsSvc.writeText(dst, text, undefined, undefined, kbWritePolicy());
            kbRoot = newRoot;
            console.log('kb: storage migrated to', newRoot);
          } catch (e) {
            writeJson(res, 400, { error: '目录迁移失败：' + (e && e.message ? e.message : e) });
            return;
          }
        }
      }
      writeJson(res, 200, { ok: true, config: kbClone(kbState.config) });
    }},
  ];

  // 路由注册（ctx.effect 生命周期）
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => { for (const d of disposers) d(); };
  }, 'kb: routes');

  const resolveConfig = () => ({
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
  });

  if (resolveConfig().enabled) {
    if (resolveConfig().announceToAgent) {
      ctx.effect(() => ctx.systemPrompt.section({ name: 'knowledge-base:guidance', order: 600, text: KB_GUIDANCE }), 'kb: prompt section');

      // 模型工具：显式检索
      const kbTool = defineTool({
        name: 'knowledge_base_search',
        description: '检索全局知识库（用户已上传的制度、手册、说明书、报告等文档）。当用户问题可能涉及这些文档内容时，先调用本工具检索最相关的片段，再结合片段回答；返回结果含来源（文档名+位置）与相关度。',
        parameters: {
          query: { type: 'string', required: true, description: '检索关键词或完整问题，用自然语言即可' },
          topK: { type: 'integer', description: '返回的片段数量，默认 4' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hits: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    doc: { type: 'string', required: true },
                    location: { type: 'string', required: true },
                    score: { type: 'number', required: true },
                    text: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          render(_args, value) {
            const hits = (value && Array.isArray(value.hits) ? value.hits : []);
            const text = hits.length === 0
              ? '知识库中没有检索到相关内容。'
              : hits.map((h, i) => '【' + (i + 1) + '】来源：知识库《' + h.doc + '》' + (h.location && h.location !== '全文' ? ' · ' + h.location : '') + '（相关度 ' + h.score + '）\n' + h.text).join('\n\n');
            return [{ type: 'text', text }];
          },
        },
        async execute(args) {
          await boot;
          if (!kbState.config.enabled) return { hits: [] };
          const q = String(args && args.query || '');
          const hits = q.trim() ? kbSearch(q, args && args.topK || kbState.config.topK, 0) : [];
          return {
            hits: hits.map((h) => ({ doc: h.docName, location: h.loc, score: Number(h.score.toFixed(3)), text: h.text.slice(0, 800) })),
          };
        },
      });
      ctx.effect(() => ctx.tools.register(kbTool), 'kb: tool');
    }

    // 自动检索注入（任意会话、任意问题）
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (!kbState || !kbState.config || !kbState.config.enabled) return next();
        if (!payload || !Array.isArray(payload.messages)) return next();
        if (payload.step !== 1) return next();
        const text = payload.messages
          .map((m) => {
            if (!m || typeof m !== 'object') return '';
            const content = m.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ');
            return '';
          })
          .filter(Boolean)
          .join('\n');
        if (text.trim().length < 2) return next();
        const hits = kbSearch(text, kbState.config.topK, kbState.config.minScore);
        if (hits.length === 0) return next();
        const ctxText = kbBuildContext(text, hits, kbState.config);
        const msg = {
          id: 'kb-retrieval-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text: ctxText }],
          source: { kind: 'plugin', plugin: 'knowledge-base', form: 'retrieval' },
        };
        return { kind: 'enter', messages: [msg, ...payload.messages] };
      } catch (e) {
        console.error('kb: pre-step failed', e && e.message ? e.message : e);
        return next();
      }
    });
  }
}
