// ============================================================================
// 全局知识库插件 · 静态 Client 半边（浏览器）
// UI：左侧边栏入口 + 通用悬浮窗（与设置弹窗同款样式，无 emoji）。
// 数据层：fetch('/api/dsh-kb/*')；轮询用 window.setInterval。
// 本文件为构建产物（等价于 src/client 的编译结果）。
// ============================================================================
window.__ModuleLoader__.load({
  id: '@zy-ultimately/dsh-knowledge-base',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const KB_API = {
      stats: '/api/dsh-kb/stats',
      list: '/api/dsh-kb/list',
      upload: '/api/dsh-kb/upload',
      reparse: '/api/dsh-kb/reparse',
      delete: '/api/dsh-kb/delete',
      search: '/api/dsh-kb/search',
      config: '/api/dsh-kb/config',
    };

    const React = require('react');

    class KbApiError extends Error {
      constructor(message) { super(message); this.name = 'KbApiError'; }
    }
    async function readJson(response) {
      let body;
      try { body = await response.json(); }
      catch { throw new KbApiError('HTTP ' + response.status + ': invalid JSON response'); }
      if (!response.ok) {
        throw new KbApiError(typeof body === 'object' && body !== null && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status);
      }
      return body;
    }
    // 浏览器端 base64 -> bytes（Node Buffer 不可用；用 atob + Uint8Array，字节精确）
    function b64ToBytes(b64) {
      const bin = atob(String(b64).replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      return bytes;
    }
    class KbApi {
      async stats() { return readJson(await fetch(KB_API.stats)); }
      async list() { return readJson(await fetch(KB_API.list)); }
      async upload(name, b64) {
        const bytes = b64ToBytes(b64);
        const response = await fetch(KB_API.upload + '?name=' + encodeURIComponent(name), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        });
        const body = await readJson(response);
        return body.doc;
      }
      async reparse(id) {
        const response = await fetch(KB_API.reparse, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        return readJson(response); // host 返回 { ok: true }
      }
      async delete(id) {
        const response = await fetch(KB_API.delete, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        return readJson(response); // host 返回 { ok: true }
      }
      async setConfig(patch) {
        const response = await fetch(KB_API.config, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch }),
        });
        return readJson(response); // host 返回 { ok: true, config }
      }
    }

    const inject = ['slots'];

    const kbApi = new KbApi();

    function apply(ctx) {

    const { useState, useEffect, useRef, useCallback } = React;

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify("@zy-ultimately/dsh-knowledge-base/KbOverlay.css") + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@zy-ultimately/dsh-knowledge-base';
        tag.dataset.pluginCss = "@zy-ultimately/dsh-knowledge-base/KbOverlay.css";
        tag.textContent = `
.dsh-kb-entry{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 12px;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;white-space:nowrap}
.dsh-kb-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
.dsh-kb-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-kb-entryIcon{display:inline-flex;align-items:center;justify-content:center;flex:none}
.dsh-kb-entryLabel{overflow:hidden;text-overflow:ellipsis}
[data-dsh-frame][data-sidebar-collapsed] .dsh-kb-entry{justify-content:center;padding:0;width:100%}
[data-dsh-frame][data-sidebar-collapsed] .dsh-kb-entryLabel{display:none}
.dsh-kb-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.dsh-kb-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}
.dsh-kb-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:760px;max-width:calc(100vw - 48px);height:min(720px,100vh - 48px);box-shadow:var(--dsw-shadow-lv3);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:24px;display:flex;flex-direction:column;position:relative;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.dsh-kb-header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;gap:8px;height:54px;padding:20px 14px 8px 10px;display:flex}
.dsh-kb-title{font-size:16px;font-weight:500;line-height:24px;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}
.dsh-kb-count{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsh-kb-header-right{display:flex;align-items:center;gap:8px}
.dsh-kb-master{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.dsh-kb-master-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-kb-disabled{font-size:12px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-warning-soft);color:var(--dsw-alias-warning)}
.dsh-kb-upload.disabled{opacity:.55;cursor:not-allowed}
.dsh-kb-upload.disabled:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.dsh-kb-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsh-kb-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-kb-body{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.dsh-kb-upload{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px;text-align:center;cursor:pointer;color:var(--dsw-alias-label-secondary);transition:all .15s}
.dsh-kb-upload:hover{border-color:var(--dsw-alias-accent);color:var(--dsw-alias-accent);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-kb-upload.busy{opacity:.5;pointer-events:none}
.dsh-kb-upload-hint{font-size:11px;margin-top:4px;color:var(--dsw-alias-label-tertiary)}
.dsh-kb-notice{font-size:12px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-accent-soft);color:var(--dsw-alias-accent)}
.dsh-kb-notice.err{background:var(--dsw-alias-danger-soft);color:var(--dsw-alias-danger)}
.dsh-kb-doc{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 10px;display:flex;flex-direction:column;gap:5px}
.dsh-kb-doc-top{display:flex;align-items:center;gap:7px}
.dsh-kb-doc-name{flex:1;font-weight:500;word-break:break-all;line-height:1.25}
.dsh-kb-doc-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.dsh-kb-chip{font-size:10px;padding:1px 7px;border-radius:9px;white-space:nowrap}
.dsh-kb-chip-ready{background:var(--dsw-alias-success-soft);color:var(--dsw-alias-success)}
.dsh-kb-chip-parsing{background:var(--dsw-alias-warning-soft);color:var(--dsw-alias-warning)}
.dsh-kb-chip-error{background:var(--dsw-alias-danger-soft);color:var(--dsw-alias-danger)}
.dsh-kb-errmsg{font-size:11px;color:var(--dsw-alias-danger);word-break:break-all}
.dsh-kb-actions{display:flex;gap:6px;margin-top:2px}
.dsh-kb-btn{font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;color:inherit}
.dsh-kb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-kb-btn.danger:hover{background:var(--dsw-alias-danger-soft);border-color:var(--dsw-alias-danger);color:var(--dsw-alias-danger)}
.dsh-kb-btn:disabled{opacity:.45;cursor:not-allowed}
.dsh-kb-cfg{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.dsh-kb-cfg-row{display:flex;align-items:center;gap:8px;font-size:12px}
.dsh-kb-cfg-row label{flex:1}
.dsh-kb-input{font-size:12px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit;width:74px}
.dsh-kb-toggle{position:relative;width:34px;height:18px;flex:none}
.dsh-kb-toggle input{opacity:0;width:0;height:0}
.dsh-kb-toggle span{position:absolute;inset:0;background:var(--dsw-alias-border-l3);border-radius:9px;transition:.15s;cursor:pointer}
.dsh-kb-toggle span:before{content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;background:var(--dsw-alias-bg-base);border-radius:50%;transition:.15s}
.dsh-kb-toggle input:checked+span{background:var(--dsw-alias-accent)}
.dsh-kb-toggle input:checked+span:before{transform:translateX(16px)}
.dsh-kb-footer{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;justify-content:space-between;align-items:center;gap:8px}
.dsh-kb-empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:18px 8px;font-size:12px}
`;
        document.head.appendChild(tag);
      }

    // ---------- 工具函数 ----------
    function fmtSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    }
    function fmtTime(ts) {
      try {
        const d = new Date(ts);
        const p = (x) => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch { return String(ts); }
    }
    function fileToB64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const bytes = new Uint8Array(reader.result);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            resolve(btoa(bin));
          } catch (e) { reject(new Error('编码失败：' + (e && e.message ? e.message : e))); }
        };
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsArrayBuffer(file);
      });
    }

    // ---------- 状态徽章 ----------
    function StatusChip({ status }) {
      const map = { ready: ['已就绪', 'dsh-kb-chip-ready'], parsing: ['解析中…', 'dsh-kb-chip-parsing'], error: ['解析失败', 'dsh-kb-chip-error'] };
      const [label, cls] = map[status] || [status, ''];
      return React.createElement('span', { className: 'dsh-kb-chip ' + cls }, label);
    }

    // ---------- 文档行 ----------
    function DocRow({ doc, onDelete, onReparse }) {
      const [confirm, setConfirm] = useState(false);
      const locs = Array.isArray(doc.locs) && doc.locs.length ? doc.locs.join('、') : '';
      return React.createElement('div', { className: 'dsh-kb-doc' },
        React.createElement('div', { className: 'dsh-kb-doc-top' },
          React.createElement('span', { className: 'dsh-kb-doc-name', title: doc.name }, doc.name),
          React.createElement(StatusChip, { status: doc.status })
        ),
        React.createElement('div', { className: 'dsh-kb-doc-meta' },
          React.createElement('span', null, '.' + doc.ext),
          React.createElement('span', null, fmtSize(doc.size)),
          React.createElement('span', null, fmtTime(doc.uploadedAt)),
          doc.status === 'ready' && React.createElement('span', null, doc.chunkCount + ' 段'),
          doc.status === 'ready' && locs && React.createElement('span', null, locs)
        ),
        doc.status === 'error' && React.createElement('div', { className: 'dsh-kb-errmsg' }, '错误：' + (doc.message || '解析失败')),
        React.createElement('div', { className: 'dsh-kb-actions' },
          (doc.status === 'ready' || doc.status === 'error') &&
            React.createElement('button', { className: 'dsh-kb-btn', onClick: () => onReparse(doc) }, '重新解析'),
          React.createElement('button', {
            className: 'dsh-kb-btn danger',
            onClick: () => {
              if (confirm) { setConfirm(false); onDelete(doc); }
              else setConfirm(true);
            },
          }, confirm ? '确认删除？' : '删除')
        )
      );
    }

    // ---------- 配置区 ----------
    function ConfigSection({ config, onApply }) {
      const [topK, setTopK] = useState(config ? config.topK : 4);
      const [minScore, setMinScore] = useState(config ? config.minScore : 0.5);
      const [dir, setDir] = useState(config ? config.storageDir || '' : '');
      useEffect(() => {
        if (config) { setTopK(config.topK); setMinScore(config.minScore); setDir(config.storageDir || ''); }
      }, [config]);
      const apply = () => onApply({ topK: Number(topK), minScore: Number(minScore), storageDir: dir.trim() });
      return React.createElement('div', { className: 'dsh-kb-cfg' },
        React.createElement('div', { className: 'dsh-kb-cfg-row' },
          React.createElement('label', null, '注入片段数 topK'),
          React.createElement('select', { className: 'dsh-kb-input', style: { width: 74 }, value: topK, onChange: (e) => setTopK(e.target.value) },
            [1, 2, 3, 4, 5, 6, 8].map((v) => React.createElement('option', { key: v, value: v }, v + ' 段'))
          )
        ),
        React.createElement('div', { className: 'dsh-kb-cfg-row' },
          React.createElement('label', null, '最低相关分'),
          React.createElement('input', { className: 'dsh-kb-input', type: 'number', min: 0, step: 0.1, value: minScore, onChange: (e) => setMinScore(e.target.value) })
        ),
        React.createElement('div', { className: 'dsh-kb-cfg-row' },
          React.createElement('label', { title: '留空 = 工作区下 .dsh-knowledge-base（全局共享、重启保留）；可改为机器级绝对路径' }, '存储目录'),
          React.createElement('input', { className: 'dsh-kb-input', style: { width: 150 }, value: dir, placeholder: '工作区默认', onChange: (e) => setDir(e.target.value) })
        ),
        React.createElement('div', null,
          React.createElement('button', { className: 'dsh-kb-btn', onClick: apply }, '保存配置')
        )
      );
    }

    // ---------- 主组件：滑出面板（入口在左侧边栏，见 apply 中的 DOM 注入） ----------
    function KbOverlay() {
      const [open, setOpen] = useState(false);
      const [docs, setDocs] = useState([]);
      const [config, setConfig] = useState(null);
      const [stats, setStats] = useState({ total: 0, parsing: 0, chunks: 0, errors: 0 });
      const [notice, setNotice] = useState('');
      const [noticeErr, setNoticeErr] = useState(false);
      const [busy, setBusy] = useState(false);
      const inputRef = useRef(null);
      const openRef = useRef(false);
      openRef.current = open;

      // 侧边栏入口按钮 → 切换事件（DOM 注入按钮 dispatch dsh-kb-toggle）
      useEffect(() => {
        const onToggle = () => setOpen((o) => !o);
        const onClose = () => setOpen(false);
        const onKeyDown = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('dsh-kb-toggle', onToggle);
        window.addEventListener('dsh-kb-close', onClose);
        window.addEventListener('keydown', onKeyDown);
        return () => {
          window.removeEventListener('dsh-kb-toggle', onToggle);
          window.removeEventListener('dsh-kb-close', onClose);
          window.removeEventListener('keydown', onKeyDown);
        };
      }, []);

      // 面板开合同步侧边栏入口高亮（data-dsh-kb-entry 上的 data-active）
      useEffect(() => {
        const entry = document.querySelector('[data-dsh-kb-entry]');
        if (entry) {
          if (open) entry.setAttribute('data-active', 'true');
          else entry.removeAttribute('data-active');
        }
      }, [open]);

      const refresh = useCallback(async () => {
        try {
          const s = await kbApi.stats();
          // kbApi.stats 直接返回统计对象（无 ok 字段），成功即应用
          setStats({ total: s.total || 0, parsing: s.parsing || 0, chunks: s.chunks || 0, errors: s.errors || 0 });
          const l = await kbApi.list();
          // kbApi.list 直接返回 { docs, config }（无 ok 字段）
          setDocs(l.docs || []);
          if (l.config) setConfig(l.config);
        } catch (e) { /* 宿主未就绪时静默 */ }
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      // 轮询解析状态：仅面板打开且存在解析任务时（timer 服务，随插件卸载自动清理）
      useEffect(() => {
        if (!open) return;
        const timerId = window.setInterval(async () => { 
          try {
            const s = await kbApi.stats();
            setStats({ total: s.total || 0, parsing: s.parsing || 0, chunks: s.chunks || 0, errors: s.errors || 0 });
            if (s.parsing === 0) {
              const l = await kbApi.list();
              setDocs(l.docs || []);
              if (l.config) setConfig(l.config);
              // 解析全部完成：清除“正在解析/正在重新解析…”提示（若当前提示为解析进行中）
              setNotice((prev) => (prev && /正在(?:重新)?解析/.test(prev) ? '' : prev));
            }
          } catch (e) { /* ignore */ }
         }, 1200);
        return () => window.clearInterval(timerId);
      }, [open, refresh]);

      const flash = (msg, isErr) => { setNotice(msg); setNoticeErr(!!isErr); };

      const onPick = async (ev) => {
        const files = Array.from(ev.target.files || []);
        ev.target.value = '';
        if (!files.length) return;
        setBusy(true);
        try {
          let done = 0, failed = 0;
          for (const f of files) {
            try {
              const b64 = await fileToB64(f);
              const doc = await kbApi.upload(f.name, b64);
              // kbApi.upload 返回文档对象（含 id），成功即认为上传完成
              if (doc && doc.id) done++;
              else { failed++; flash('上传失败 ' + f.name + '：' + (doc && doc.error || '未知错误'), true); }
            } catch (e) { failed++; flash('上传异常 ' + f.name + '：' + (e && e.message ? e.message : e), true); }
          }
          if (done > 0) flash('已上传 ' + done + ' 个文档，正在解析…', false);
          if (failed > 0 && done === 0) flash('上传失败，请检查格式与大小', true);
          await refresh();
        } finally { setBusy(false); }
      };

      const onDelete = async (doc) => {
        const res = await kbApi.delete((doc).id);
        if (res && res.ok) flash('已删除《' + doc.name + '》', false);
        else flash('删除失败：' + (res && res.error || '未知错误'), true);
        await refresh(); // 无论成败都刷新列表，避免残留过期条目
      };

      const onReparse = async (doc) => {
        const res = await kbApi.reparse((doc).id);
        if (res && res.ok) { flash('正在重新解析《' + doc.name + '》…', false); refresh(); }
        else flash('重新解析失败：' + (res && res.error || '未知错误'), true);
      };

      const onApplyConfig = async (patch) => {
        const res = await kbApi.setConfig(patch);
        if (res && res.ok) { setConfig(res.config); flash('配置已保存', false); }
        else flash('保存配置失败：' + (res && res.error || '未知错误'), true);
      };

      // 总开关：点击「启用知识库」立即持久化，并联动关闭自动检索/工具/上传
      const onToggleEnabled = async (next) => {
        const res = await kbApi.setConfig({ enabled: next });
        if (res && res.ok) { setConfig(res.config); flash(next ? '知识库已启用' : '知识库已停用', false); }
        else flash('切换失败：' + (res && res.error || '未知错误'), true);
      };

      const enabled = config ? config.enabled !== false : true;

      return React.createElement(React.Fragment, null,
        // 面板：通用悬浮窗（居中模态，与设置弹窗同款）
        open && React.createElement('div', { className: 'dsh-kb-overlay', role: 'presentation' },
          React.createElement('div', { className: 'dsh-kb-mask', 'aria-hidden': 'true', onClick: () => setOpen(false) }),
          React.createElement('div', { className: 'dsh-kb-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '全局知识库' },
            React.createElement('div', { className: 'dsh-kb-header' },
              React.createElement('span', { className: 'dsh-kb-title' }, '全局知识库',
                React.createElement('span', { className: 'dsh-kb-count' }, stats.total + ' 个文档 · ' + stats.chunks + ' 个片段')
              ),
              React.createElement('span', { className: 'dsh-kb-header-right' },
                React.createElement('label', { className: 'dsh-kb-master' },
                  React.createElement('span', { className: 'dsh-kb-master-label' }, enabled ? '已启用' : '已停用'),
                  React.createElement('span', { className: 'dsh-kb-toggle' },
                    React.createElement('input', { type: 'checkbox', checked: enabled, onChange: (e) => onToggleEnabled(e.target.checked) }),
                    React.createElement('span', null)
                  )
                ),
                React.createElement('button', { className: 'dsh-kb-close', onClick: () => setOpen(false), title: '收起', 'aria-label': '关闭' }, '✕')
              )
            ),
            React.createElement('div', { className: 'dsh-kb-body' },
            !enabled && React.createElement('div', { className: 'dsh-kb-disabled' },
              '知识库已停用：自动检索与搜索工具已关闭，上传文档需先启用。'
            ),
            React.createElement('div', {
              className: 'dsh-kb-upload' + (busy ? ' busy' : '') + (!enabled ? ' disabled' : ''),
              onClick: () => { if (enabled) inputRef.current && inputRef.current.click(); else flash('请先启用知识库', true); },
            },
              React.createElement('div', null, busy ? '上传中…' : (enabled ? '上传文档' : '已停用 · 点击启用后上传')),
              React.createElement('div', { className: 'dsh-kb-upload-hint' }, '支持 PDF / Word / Excel / PPT / TXT / MD / CSV / HTML，单文件 ≤ 20MB，可多选'),
              React.createElement('input', {
                ref: inputRef, type: 'file', multiple: true, style: { display: 'none' },
                accept: '.pdf,.docx,.txt,.md,.xlsx,.pptx,.csv,.html',
                onChange: onPick,
              })
            ),
            notice && React.createElement('div', { className: 'dsh-kb-notice' + (noticeErr ? ' err' : '') }, notice),
            docs.length === 0 && React.createElement('div', { className: 'dsh-kb-empty' },
              '知识库为空。上传文档后，任何会话提问时都会自动检索相关内容。'
            ),
            docs.map((d) => React.createElement(DocRow, { key: d.id, doc: d, onDelete, onReparse })),
            React.createElement(ConfigSection, { config, onApply: onApplyConfig })
            ),
          React.createElement('div', { className: 'dsh-kb-footer' },
            React.createElement('span', null, '数据全局共享 · 重启保留 · 存储：' + (stats.storageDir || '…')),
            React.createElement('span', null, stats.errors > 0 ? stats.errors + ' 个解析失败' : '')
          )
          )
        )
      );
    }

    // ---------- 注册到帧级悬浮层 ----------
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'knowledge-base', order: 90, label: '知识库' },
      () => React.createElement(KbOverlay)
    ));

    // ---------- 左侧边栏入口（与任务看板同款 UI：DOM 注入 + 自愈重插） ----------
    const KB_ENTRY_SELECTOR = '[data-dsh-kb-entry]';
    const KB_ENTRY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9v11h-9A1.5 1.5 0 0 0 2 14.5z"/><path d="M2 3.5v11M5 5.5h5M5 8h5"/></svg>';

    function kbSidebarRoot() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
      return logoOwner ?? (column.firstElementChild || undefined);
    }
    function kbNewSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (const child of root.children) {
        if (child.tagName === 'BUTTON') return child;
      }
      return undefined;
    }
    function kbCreateEntry() {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.dataset.dshKbEntry = '';
      entry.className = 'dsh-kb-entry';
      entry.setAttribute('aria-label', '知识库');
      entry.innerHTML = '<span class="dsh-kb-entryIcon">' + KB_ENTRY_ICON + '</span><span class="dsh-kb-entryLabel">知识库</span>';
      entry.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('dsh-kb-toggle'));
      });
      return entry;
    }
    function kbPlaceEntry(root, entry) {
      const button = kbNewSessionButton(root);
      if (button === undefined) return false;
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]');
        const base = (row !== null && row.parentElement === root) ? row : button;
        // 与其他侧边栏插件入口（任务看板 / SSH）同家族排序，避免随机换位
        const family = Array.from(root.children).filter(
          (el) => el instanceof HTMLElement && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-kb-entry]'),
        );
        let anchor;
        const kbIndex = family.findIndex((el) => el.matches(KB_ENTRY_SELECTOR));
        if (kbIndex !== -1) {
          // 已存在：保持原位
          return true;
        }
        if (family.length > 0) {
          anchor = family[family.length - 1].nextElementSibling;
        } else {
          anchor = base.nextElementSibling;
        }
        root.insertBefore(entry, anchor);
      }
      return true;
    }
    function mountKbSidebarEntry() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(KB_ENTRY_SELECTOR) !== null) return () => {};
      const entry = kbCreateEntry();
      let root;
      let placed = false;

      const tryPlace = () => {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (placed) {
          if (document.body.contains(entry)) return;
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        root = root ?? kbSidebarRoot();
        if (root === undefined) return;
        placed = kbPlaceEntry(root, entry);
        if (placed) rootObserver.observe(root, { childList: true, subtree: true });
      };

      const waitObserver = new MutationObserver(() => { tryPlace(); });
      waitObserver.observe(document.body, { childList: true, subtree: true });

      const rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false;
          tryPlace();
          return;
        }
        if (!root.contains(entry)) {
          placed = kbPlaceEntry(root, entry);
        }
      });

      tryPlace();

      return () => {
        waitObserver.disconnect();
        rootObserver.disconnect();
        entry.remove();
      };
    }
    const kbEntryDisposer = mountKbSidebarEntry();
    ctx.effect(() => () => { kbEntryDisposer(); }, 'kb: sidebar entry');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
