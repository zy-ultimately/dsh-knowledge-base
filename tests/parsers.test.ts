import { describe, expect, it } from 'vitest'
import { buildDocx, buildPdf, buildZip, str } from './helpers.ts'
import { parseCsv, parseDocx, parseHtml, parsePdf, parsePlainText, parsePptx, parseXlsx } from '../src/engine/parsers.ts'

const all = (sections: Array<{ loc: string; text: string }>): string => sections.map((s) => s.text).join('\n')

describe('document parsers', () => {
  it('docx extracts paragraphs (Chinese)', () => {
    const sections = parseDocx(buildDocx([
      '公司考勤管理制度',
      '第一条 员工每天上下班需打卡，迟到超过 30 分钟按半天事假处理。',
      '第二条 年假申请：入职满一年员工每年享有 5 天年假。',
    ]))
    const text = all(sections)
    expect(text).toContain('公司考勤管理制度')
    expect(text).toContain('年假申请')
    expect(/段落/.test(sections[0]!.loc)).toBe(true)
  })

  it('xlsx resolves shared strings and numbers', () => {
    const ss = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
      '<si><t>姓名</t></si><si><t>部门</t></si><si><t>年假剩余天数</t></si><si><t>张伟</t></si></sst>'
    const sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>技术部</v></c><c r="C2"><v>7</v></c></row>' +
      '</sheetData></worksheet>'
    const sections = parseXlsx(buildZip([
      { name: 'xl/sharedStrings.xml', data: str(ss) },
      { name: 'xl/worksheets/sheet1.xml', data: str(sheet) },
    ]))
    const text = all(sections)
    expect(text).toContain('姓名')
    expect(text).toContain('张伟')
    expect(text).toContain('技术部')
    expect(text).toContain('7')
  })

  it('pptx extracts per-slide text', () => {
    const slide = (title: string): string =>
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const sections = parsePptx(buildZip([
      { name: 'ppt/slides/slide1.xml', data: str(slide('第一章 考勤打卡')) },
      { name: 'ppt/slides/slide2.xml', data: str(slide('第二章 年假规则')) },
    ]))
    expect(sections).toHaveLength(2)
    expect(all(sections)).toContain('第二章')
    expect(sections[0]!.loc).toBe('幻灯片 1')
  })

  it('pdf extracts latin + UTF-16BE Chinese text with page locations', () => {
    const sections = parsePdf(buildPdf(['公司考勤制度', '年假申请流程：入职满一年享有 5 天年假。']))
    const text = all(sections)
    expect(sections).toHaveLength(2)
    expect(text).toContain('公司考勤制度')
    expect(text).toContain('年假申请流程')
    expect(sections[0]!.loc).toBe('第 1 页')
    expect(sections[1]!.loc).toBe('第 2 页')
  })

  it('rejects encrypted PDFs', () => {
    const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R /Encrypt 9 0 R /Size 4 >>\n%%EOF'
    expect(() => parsePdf(new Uint8Array(Buffer.from(pdf, 'latin1')))).toThrow(/加密/)
  })

  it('parses csv / html / plain text', () => {
    expect(all(parseCsv(str('姓名,部门\n张伟,技术部')))).toContain('张伟')
    const html = all(parseHtml(str('<html><head><title>公司政策</title></head><body><h1>考勤制度</h1><p>迟到按事假处理</p></body></html>')))
    expect(html).toContain('公司政策')
    expect(html).toContain('考勤制度')
    expect(all(parsePlainText(str('纯文本内容')))).toContain('纯文本')
  })
})
