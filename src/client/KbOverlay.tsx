/**
 * Knowledge-base management panel — a centered modal floating window
 * (same DSW-token style as the settings dialog), toggled by the left-sidebar
 * entry row (see index.ts). Upload / list / delete / reparse / config all
 * go through the /api/dsh-kb REST family.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KbApi } from './api.ts'
import type { KbConfigView, KbDocView } from '../protocol.ts'
import styles from './kb.module.css'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const STATUS_META: Record<string, [string, string]> = {
  ready: ['已就绪', styles.dshKbChipReady],
  parsing: ['解析中…', styles.dshKbChipParsing],
  error: ['解析失败', styles.dshKbChipError],
}

function StatusChip({ status }: { status: KbDocView['status'] }): React.ReactElement {
  const [label, cls] = STATUS_META[status] ?? [status, '']
  return <span className={`${styles.dshKbChip} ${cls}`}>{label}</span>
}

function DocRow({ doc, onDelete, onReparse }: { doc: KbDocView; onDelete: (doc: KbDocView) => void; onReparse: (doc: KbDocView) => void }): React.ReactElement {
  const [confirm, setConfirm] = useState(false)
  const locs = Array.isArray(doc.locs) && doc.locs.length > 0 ? doc.locs.join('、') : ''
  return (
    <div className={styles.dshKbDoc}>
      <div className={styles.dshKbDocTop}>
        <span className={styles.dshKbDocName} title={doc.name}>{doc.name}</span>
        <StatusChip status={doc.status} />
      </div>
      <div className={styles.dshKbDocMeta}>
        <span>.{doc.ext}</span>
        <span>{fmtSize(doc.size)}</span>
        <span>{fmtTime(doc.uploadedAt)}</span>
        {doc.status === 'ready' && <span>{doc.chunkCount} 段</span>}
        {doc.status === 'ready' && locs && <span>{locs}</span>}
      </div>
      {doc.status === 'error' && <div className={styles.dshKbErrmsg}>错误：{doc.message || '解析失败'}</div>}
      <div className={styles.dshKbActions}>
        {(doc.status === 'ready' || doc.status === 'error') && (
          <button className={styles.dshKbBtn} onClick={() => onReparse(doc)}>重新解析</button>
        )}
        <button
          className={`${styles.dshKbBtn} ${styles.dshKbBtnDanger}`}
          onClick={() => {
            if (confirm) { setConfirm(false); onDelete(doc) } else setConfirm(true)
          }}
        >
          {confirm ? '确认删除？' : '删除'}
        </button>
      </div>
    </div>
  )
}

function ConfigSection({ config, onApply }: { config: KbConfigView | null; onApply: (patch: Partial<KbConfigView>) => void }): React.ReactElement {
  const [topK, setTopK] = useState(config?.topK ?? 4)
  const [minScore, setMinScore] = useState(config?.minScore ?? 0.5)
  const [dir, setDir] = useState(config?.storageDir ?? '')
  useEffect(() => {
    if (config) {
      setTopK(config.topK)
      setMinScore(config.minScore)
      setDir(config.storageDir ?? '')
    }
  }, [config])
  return (
    <div className={styles.dshKbCfg}>
      <div className={styles.dshKbCfgRow}>
        <label>注入片段数 topK</label>
        <select className={styles.dshKbInput} value={topK} onChange={(e) => setTopK(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 8].map((v) => <option key={v} value={v}>{v} 段</option>)}
        </select>
      </div>
      <div className={styles.dshKbCfgRow}>
        <label>最低相关分</label>
        <input className={styles.dshKbInput} type="number" min={0} step={0.1} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
      </div>
      <div className={styles.dshKbCfgRow}>
        <label title="留空 = 工作区下 .dsh-knowledge-base（全局共享、重启保留）；可改为机器级绝对路径">存储目录</label>
        <input className={styles.dshKbInput} style={{ width: 150 }} value={dir} placeholder="工作区默认" onChange={(e) => setDir(e.target.value)} />
      </div>
      <div>
        <button className={styles.dshKbBtn} onClick={() => onApply({ topK, minScore, storageDir: dir.trim() })}>保存配置</button>
      </div>
    </div>
  )
}

export interface KbOverlayProps {
  api: KbApi
}

/** The centered modal panel. Toggled by the sidebar entry via `dsh-kb-toggle`. */
export function KbOverlay({ api }: KbOverlayProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [docs, setDocs] = useState<KbDocView[]>([])
  const [config, setConfig] = useState<KbConfigView | null>(null)
  const [stats, setStats] = useState({ total: 0, parsing: 0, chunks: 0, errors: 0 })
  const [notice, setNotice] = useState('')
  const [noticeErr, setNoticeErr] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sidebar entry toggles via window event; Esc closes.
  useEffect(() => {
    const onToggle = () => setOpen((o) => !o)
    const onClose = () => setOpen(false)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('dsh-kb-toggle', onToggle)
    window.addEventListener('dsh-kb-close', onClose)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('dsh-kb-toggle', onToggle)
      window.removeEventListener('dsh-kb-close', onClose)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Sync the sidebar entry highlight with panel open state.
  useEffect(() => {
    const entry = document.querySelector('[data-dsh-kb-entry]')
    if (entry) {
      if (open) entry.setAttribute('data-active', 'true')
      else entry.removeAttribute('data-active')
    }
  }, [open])

  const refresh = useCallback(async () => {
    try {
      const s = await api.stats()
      // stats() returns the stats object directly (no ok field)
      setStats({ total: s.total || 0, parsing: s.parsing || 0, chunks: s.chunks || 0, errors: s.errors || 0 })
      const l = await api.list()
      // list() returns { docs, config } directly (no ok field)
      setDocs(l.docs || [])
      if (l.config) setConfig(l.config)
    } catch {
      // host not ready — silent
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  // Poll while the panel is open; when parsing finishes, refresh and clear the "parsing" notice.
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(async () => {
      try {
        const s = await api.stats()
        setStats({ total: s.total || 0, parsing: s.parsing || 0, chunks: s.chunks || 0, errors: s.errors || 0 })
        if (s.parsing === 0) {
          const l = await api.list()
          setDocs(l.docs || [])
          if (l.config) setConfig(l.config)
          setNotice((prev) => (/正在(?:重新)?解析/.test(prev) ? '' : prev))
        }
      } catch { /* ignore */ }
    }, 1200)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const flash = (msg: string, isErr = false): void => { setNotice(msg); setNoticeErr(isErr) }

  const onPick = async (ev: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(ev.target.files ?? [])
    ev.target.value = ''
    if (files.length === 0) return
    setBusy(true)
    try {
      let done = 0
      let failed = 0
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const doc = await api.upload(file.name, bytes)
          // upload() returns the doc object (has id); success = uploaded
          if (doc && doc.id) done++
          else { failed++; flash(`上传失败 ${file.name}：${(doc as unknown as { error?: string }).error || '未知错误'}`, true) }
        } catch (error) {
          failed++
          flash(`上传异常 ${file.name}：${error instanceof Error ? error.message : String(error)}`, true)
        }
      }
      if (done > 0) flash(`已上传 ${done} 个文档，正在解析…`)
      if (failed > 0 && done === 0) flash('上传失败，请检查格式与大小', true)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (doc: KbDocView): Promise<void> => {
    try {
      const res = await api.delete(doc.id)
      if (res && res.ok) flash(`已删除《${doc.name}》`)
      else flash(`删除失败：${(res as unknown as { error?: string }).error || '未知错误'}`, true)
      await refresh() // refresh on both success and failure
    } catch (error) {
      flash(`删除失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  const onReparse = async (doc: KbDocView): Promise<void> => {
    try {
      const res = await api.reparse(doc.id)
      if (res && res.ok) { flash(`正在重新解析《${doc.name}》…`); await refresh() }
      else flash(`重新解析失败：${(res as unknown as { error?: string }).error || '未知错误'}`, true)
    } catch (error) {
      flash(`重新解析失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  const onApplyConfig = async (patch: Partial<KbConfigView>): Promise<void> => {
    try {
      const res = await api.setConfig(patch)
      if (res && res.ok) { setConfig(res.config); flash('配置已保存') }
      else flash(`保存配置失败：${(res as unknown as { error?: string }).error || '未知错误'}`, true)
    } catch (error) {
      flash(`保存配置失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  /** Master switch: toggling 启用知识库 persists immediately and gates retrieval/tool/upload. */
  const onToggleEnabled = async (next: boolean): Promise<void> => {
    const res = await api.setConfig({ enabled: next })
    if (res && res.ok) {
      setConfig(res.config)
      flash(next ? '知识库已启用' : '知识库已停用')
    } else {
      flash(`切换失败：${(res as unknown as { error?: string }).error || '未知错误'}`, true)
    }
  }

  const enabled = config?.enabled ?? true

  return (
    <>
      {open && (
        <div className={styles.dshKbOverlay} role="presentation">
          <div className={styles.dshKbMask} aria-hidden="true" onClick={() => setOpen(false)} />
          <div className={styles.dshKbPanel} role="dialog" aria-modal="true" aria-label="全局知识库">
            <div className={styles.dshKbHeader}>
              <span className={styles.dshKbTitle}>
                全局知识库
                <span className={styles.dshKbCount}>{stats.total} 个文档 · {stats.chunks} 个片段</span>
              </span>
              <span className={styles.dshKbHeaderRight}>
                <label className={styles.dshKbMaster}>
                  <span className={styles.dshKbMasterLabel}>{enabled ? '已启用' : '已停用'}</span>
                  <span className={styles.dshKbToggle}>
                    <input type="checkbox" checked={enabled} onChange={(e) => void onToggleEnabled(e.target.checked)} />
                    <span />
                  </span>
                </label>
                <button className={styles.dshKbClose} onClick={() => setOpen(false)} title="收起" aria-label="关闭">✕</button>
              </span>
            </div>
            <div className={styles.dshKbBody}>
              {!enabled && (
                <div className={styles.dshKbDisabled}>知识库已停用：自动检索与搜索工具已关闭，上传文档需先启用。</div>
              )}
              <div
                className={`${styles.dshKbUpload} ${busy ? styles.dshKbUploadBusy : ''} ${!enabled ? styles.dshKbUploadDisabled : ''}`}
                onClick={() => { if (enabled) inputRef.current?.click(); else flash('请先启用知识库', true) }}
              >
                <div>{busy ? '上传中…' : enabled ? '上传文档' : '已停用 · 点击启用后上传'}</div>
                <div className={styles.dshKbUploadHint}>支持 PDF / Word / Excel / PPT / TXT / MD / CSV / HTML，单文件 ≤ 20MB，可多选</div>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  accept=".pdf,.docx,.txt,.md,.xlsx,.pptx,.csv,.html"
                  onChange={(e) => void onPick(e)}
                />
              </div>
              {notice && <div className={`${styles.dshKbNotice} ${noticeErr ? styles.dshKbNoticeErr : ''}`}>{notice}</div>}
              {docs.length === 0 && (
                <div className={styles.dshKbEmpty}>知识库为空。上传文档后，任何会话提问时都会自动检索相关内容。</div>
              )}
              {docs.map((d) => <DocRow key={d.id} doc={d} onDelete={(x) => void onDelete(x)} onReparse={(x) => void onReparse(x)} />)}
              <ConfigSection config={config} onApply={(patch) => void onApplyConfig(patch)} />
            </div>
            <div className={styles.dshKbFooter}>
              <span>数据全局共享 · 重启保留 · 存储：{stats.storageDir || '…'}</span>
              <span>{stats.errors > 0 ? `${stats.errors} 个解析失败` : ''}</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
