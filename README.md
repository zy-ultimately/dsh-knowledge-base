# dsh-knowledge-base — 全局知识库插件（DeepSeek Harness）

在 DSH 聊天界面集成一个**全局知识库**：上传 PDF / Word / Excel / PPT / TXT / MD / CSV / HTML 文档后，系统自动解析并建立索引；**任意会话**提问时自动检索相关片段注入模型上下文，模型基于片段回答并标注「来源：知识库《文档名》」。

- **零外部依赖**：文档解析（含 PDF FlateDecode 与 ZIP deflate）与 BM25 检索全部为纯 JS 实现，不需要安装 pdfplumber / mammoth / faiss / chromadb 等任何东西。
- **全局唯一、与会话解耦**：数据落在磁盘目录（默认工作区 `.dsh-knowledge-base/`，可配置为机器级绝对路径），所有会话共享，重启不丢失。
- **双机制检索**：① `agent/pre-step` 瀑布钩子——每个会话每轮首个用户消息自动检索并注入；② `knowledge_base_search` 模型工具——模型可显式检索。
- **可独立开关**：不动会话列表、消息发送等任何核心功能；`enabled: false` 时整体卸载。

---

## 1. 目录结构

```
knowledge-base-plugin/
├── package.json               # 插件清单：dsh.bundle.patch + dsh.client（web 平台）
├── cordis.patch.yml           # Host 组合补丁：把插件行插入 profile roster
├── tsconfig.json / tsconfig.build.json
├── LICENSE
├── README.md
├── src/
│   ├── index.ts               # Host 入口：apply() 挂载引擎/路由/工具/提示/检索钩子
│   ├── protocol.ts            # 前后端共享类型与 /api/dsh-kb/* 路径
│   ├── routes.ts              # REST 路由族（loopback 保护，原始字节上传）
│   ├── engine/
│   │   ├── inflate.ts         # 纯 JS DEFLATE(RFC1951) 解压（327 项单测）
│   │   ├── zip.ts             # 最小 ZIP 读取（stored + deflate）
│   │   ├── parsers.ts         # pdf/docx/xlsx/pptx/csv/html/txt/md 文本提取（23 项单测）
│   │   ├── tokenize.ts        # CJK 二元组 + 英文分词、停用词、分块
│   │   ├── bm25.ts            # BM25 关键词索引 + 持久化 JSON（9 项单测）
│   │   ├── store.ts           # fs 持久化：kb.json + raw/*.b64（原子写、串行化）
│   │   └── kb.ts              # 引擎：上传/删除/重解析/检索/上下文组装/配置
│   └── client/
│       ├── index.ts           # Client 入口：注册 shell.overlay 占用者 + 左侧边栏入口
│       ├── api.ts             # fetch 客户端（/api/dsh-kb/*）
│       ├── KbOverlay.tsx      # 居中悬浮窗面板（上传/列表/删除/重解析/配置）
│       └── kb.module.css
└── tests/
    ├── helpers.ts             # 内存生成 docx/pdf/zip 夹具
    ├── inflate.test.ts        # inflate 单测
    ├── parsers.test.ts        # 解析器单测
    ├── bm25.test.ts           # 索引单测
    └── kb.test.ts             # 引擎端到端（上传→解析→检索→持久化→删除）
```

## 2. 快速体验（动态插件，无需安装）

当前会话里已通过 Cordis 动态插件机制直接运行了同一套代码（plugin `knw-1`，Host + Client 双半）：

1. 聊天界面**左侧边栏**会出现 📚 知识库入口（与任务看板同款图标行）。
2. 点击入口弹出**居中悬浮窗**（与设置弹窗同款样式）：上传文档 → 自动解析（PDF/Word/Excel/PPT/TXT/MD/CSV/HTML，单文件 ≤ 20MB，可多选）→ 列表显示名称/格式/大小/时间/解析状态（已就绪/解析中/解析失败+原因）→ 支持「重新解析」「删除」（两步确认）。
3. 面板内可配置：自动检索开关、注入片段数 topK、最低相关分、存储目录。
4. 新建任意会话提问，如「年假怎么请」→ 系统自动检索并注入片段，回答末尾标注「来源：知识库《文档名》」。

> 动态插件随进程生命周期存活；重启 DSH 后需要重新 `cordis_run`（或按第 3 节安装为静态插件以永久生效、全会话可用）。

## 3. 安装为静态插件（永久、跨会话、随 DSH 启动自动加载）

本包与 `@linxin666/dsh-ssh` 同构（npm 包 + `dsh.bundle.patch` + `dsh.client`），无需改动 DSH 源码：

```bash
# 1) 构建（需联网安装 devDependencies）
cd knowledge-base-plugin
pnpm install
pnpm build                 # 产出 lib/（tsc 类型 + tsdown bundle）

# 2) 挂载到 profile（示例：web profile；桌面版用 desktop profile）
dsh plugin --profile web add link:/path/to/knowledge-base-plugin
#    等价于：在 profile 的 node_modules 建立 @linxin666/dsh-knowledge-base 符号链接，
#    并把 cordis.patch.yml 的 insert 行合入 ~/.dsh/cordis.patch.yml

# 3) 重启 DSH（或热重载 profile），左侧边栏出现知识库入口
```

配置项（在 composition 中覆盖）：

```yaml
- id: knowledge-base
  name: '@linxin666/dsh-knowledge-base'
  config:
    enabled: true          # 总开关
    announceToAgent: true  # 是否给 agent 注入提示段 + knowledge_base_search 工具
```

## 4. 数据与配置

| 项 | 说明 |
|---|---|
| 存储根目录 | 默认 `<session workspace>/.dsh-knowledge-base/`（启动时从会话工作区或 `$DSH_HOME/storages/workspace.json` 解析真实工作区；跨工作区会话共享）；在面板「存储目录」填入机器级绝对路径并保存即迁移（含 raw 文件） |
| 数据文件 | `kb.json`（配置 + 文档元数据 + 分块 + 索引，原子写、串行化）；`raw/<id>.<ext>.b64`（原始字节，删除时清空） |
| 检索 | BM25（k1=1.5, b=0.75）+ CJK 二元组 + 短语加分；`minScore` 过滤；可扩展 embedding（在 `kb.search` 处替换为混合检索即可） |
| 自动注入 | `agent/pre-step` 第一步骤：仅首个用户消息注入一次；`source.kind='plugin'` 使消息在聊天中以「上下文」节点呈现，不冒充用户发言 |
| 上限 | 单文件 20MB（可配 `maxUploadBytes`）、注入上下文 ≤ 4000 字符（`maxContextChars`） |

## 5. 安全与边界

- 上传/解析/检索全部在**本机**进行；`/api/dsh-kb/*` 仅回环地址可访问（loopback 护栏）。
- 解析为纯 JS 文本层提取：文本型 PDF 可提取（含 FlateDecode、UTF-16BE 中文），**扫描件/图片型 PDF、加密 PDF** 会给出明确错误提示；docx/xlsx/pptx 提取文本与单元格/幻灯片文本，不保留格式与公式结果。
- 删除后 `raw` 文件被清空（dsh fs 无 unlink，占用空间已释放）。
- 知识库默认按工作区共享；如需跨工作区全局，设置 `storageDir` 为共享绝对路径。

## 6. 验收测试点

1. **UI 入口**：任意会话左侧边栏出现 📚 知识库入口；点击弹出居中悬浮窗，不遮挡输入框，可收起/展开（Esc / 点遮罩 / ✕）。
2. **上传解析**：分别上传 pdf / docx / xlsx / pptx / txt / md / csv / html，全部显示「已就绪」并带片段数与位置（页/段落/工作表/幻灯片）；上传加密 PDF 显示「解析失败 + 原因」。
3. **列表操作**：删除（两步确认）后列表与角标即时更新；「重新解析」后状态流转 解析中→已就绪。
4. **自动检索**：新建会话提问「年假怎么请」，回答基于知识库内容且末尾标注「来源：知识库《文档名》」；提问无关内容（如「今天天气」）不注入、正常回答。
5. **全局共享**：在会话 A 上传的文档，会话 B 立即可见、可检索。
6. **持久化**：重启 DSH 后文档列表与检索结果保持不变。
7. **开关隔离**：面板关闭「自动检索」后提问不再注入；插件 `enabled:false`/卸载后聊天功能完全不受影响。
8. **工程测试**：`pnpm test`（vitest：inflate 327、parsers 23、bm25 9、引擎端到端全部通过）。

## 7. 引擎单测速览

```bash
cd knowledge-base-plugin && pnpm test
# tests/kb.test.ts 覆盖：上传→解析→索引→检索（相关/无关）→跨实例持久化→删除
```
