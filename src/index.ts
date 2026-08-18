/**
 * dsh-knowledge-base — host half. Mounts the global KB engine (pure-JS text
 * extraction + BM25 index persisted under the workspace), the /api/dsh-kb
 * route family, the knowledge_base_search model tool, a global system-prompt
 * guidance section, and the automatic retrieval hook that injects relevant
 * snippets into EVERY session (agent/pre-step, first step of a turn only).
 * The browser half (./client) renders the right-edge button + management
 * panel into the `shell.overlay` frame layer.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import z from 'schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KnowledgeBase } from './engine/kb.ts'
import { makeRoutes } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'knowledge-base'

/** Services required before the KB surfaces can mount. */
export const inject = ['fs', 'webServer', 'tools', 'systemPrompt', 'sandboxPolicy']

/** Plugin config (schema-validated by the loader). */
export interface Config {
  /** Master switch; when false nothing mounts. */
  enabled?: boolean
  /** When true, agents get the guidance section + search tool. */
  announceToAgent?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
})

const DEFAULT_ANNOUNCE = true

/** Order of the guidance section within the prompt. */
const SECTION_ORDER = 600

/** Model-facing guidance: retrieval behaviour + citation rule. */
export const KB_GUIDANCE = '系统已集成全局知识库：当用户问题与已上传文档相关时，系统会自动检索并将相关片段注入上下文（标注“【全局知识库检索】”）。若回答基于知识库片段，请在回答末尾标注「来源：知识库《文档名》」；若知识库中没有相关信息，请如实说明，不要编造来源。'

/** One text content block (the only render shape the KB tool emits). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Render retrieval hits for the model. */
function renderHits(hits: Array<{ doc: string; location: string; score: number; text: string }>): string {
  if (hits.length === 0) return '知识库中没有检索到相关内容。'
  return hits.map((h, i) =>
    `【${i + 1}】来源：知识库《${h.doc}》${h.location && h.location !== '全文' ? ` · ${h.location}` : ''}（相关度 ${h.score}）\n${h.text}`,
  ).join('\n\n')
}

/** Extract the plain text of a user message. */
function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: unknown }).text ?? '' : '')).join(' ')
  }
  return ''
}

/**
 * Mount the KB engine, routes, tool, guidance, and retrieval hook.
 * @param ctx - host plugin context carrying fs/webServer/tools/systemPrompt.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolve = (): Config => ({ announceToAgent: config?.announceToAgent ?? DEFAULT_ANNOUNCE, enabled: config?.enabled ?? true })
  if (!resolve().enabled) return

  // KB root prefers the LIVE session workspace (the deployment default
  // workspaceRoot is the process cwd and may differ from the session cwd).
  let wsRoot = ''
  try {
    const sessions = ctx.get('sessions') as { list?: () => Array<{ header?: { cwd?: string } }> } | undefined
    const withCwd = sessions?.list?.().find((s) => s.header?.cwd)
    if (withCwd?.header?.cwd) wsRoot = withCwd.header.cwd
  } catch {
    // ignore
  }
  // Desktop GUI host has no live session: read the real workspace directory
  // from $DSH_HOME/storages/workspace.json (maintained by dsh-workspace).
  if (!wsRoot) {
    try {
      const dshHome = process.env.DSH_HOME ?? ''
      if (dshHome) {
        const wsFile = join(dshHome, 'storages', 'workspace.json')
        if (existsSync(wsFile)) {
          const parsed = JSON.parse(readFileSync(wsFile, 'utf8')) as {
            tables?: { workspaces?: Record<string, { path?: string }> }
          }
          const tables = parsed?.tables?.workspaces
          if (tables) {
            for (const key of Object.keys(tables)) {
              const path = tables[key]?.path
              if (typeof path === 'string' && path) { wsRoot = path; break }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
  if (!wsRoot) {
    const sandbox = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined
    // Refuse the program install dir (desktop process.cwd) as a KB root.
    const candidate = sandbox?.workspaceRoot ?? ''
    const programDir = process.cwd()
    if (candidate && candidate !== programDir) wsRoot = candidate
  }
  if (!wsRoot) wsRoot = process.env.USERPROFILE ?? ''
  const kb = new KnowledgeBase({
    fs: ctx.fs as never,
    workspaceRoot: wsRoot,
    // dsh-fs-sandbox (this deployment) rejects writes whose per-call policy does not
    // cover the target — pass workspace-write rooted at the session workspace.
    writePolicy: { mode: 'workspace-write', workspaceRoot: wsRoot },
    log: (m) => console.log(m),
  })
  ctx.effect(() => () => { void kb.ready() }, 'kb: engine')

  // ---- REST routes (browser half data path) ----
  const routeDisposers = makeRoutes({ kb }).map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => { for (const dispose of routeDisposers.splice(0)) dispose() }, 'kb: routes')

  if (resolve().announceToAgent) {
    // ---- system-prompt guidance (global) ----
    ctx.effect(() => ctx.systemPrompt.section({ name: 'knowledge-base:guidance', order: SECTION_ORDER, text: KB_GUIDANCE }), 'kb: prompt section')

    // ---- model tool: explicit KB search ----
    const tool = defineTool({
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
        render: (_args, value: { hits?: Array<{ doc: string; location: string; score: number; text: string }> }) => text(renderHits(value.hits ?? [])),
      },
      async execute(args) {
        await kb.ready()
        const query = String(args.query ?? '')
        const hits = query.trim() ? kb.search(query, args.topK ?? kb.config.topK, 0) : []
        return {
          hits: hits.map((h) => ({ doc: h.docName, location: h.loc, score: Number(h.score.toFixed(3)), text: h.text.slice(0, 800) })),
        }
      },
    })
    ctx.effect(() => ctx.tools.register(tool), 'kb: tool')
  }

  // ---- automatic retrieval into every session ----
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (!kb.config.enabled) return next()
      if (!payload || !Array.isArray(payload.messages)) return next()
      // Inject only on the first step of a turn (user message); tool-result
      // follow-up steps are skipped so context is never duplicated.
      if (payload.step !== 1) return next()
      const text = payload.messages.map(messageText).filter(Boolean).join('\n')
      if (text.trim().length < 2) return next()
      const hits = kb.search(text, kb.config.topK, kb.config.minScore)
      if (hits.length === 0) return next()
      const contextText = kb.buildContext(text, hits)
      const msg = {
        id: `kb-retrieval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: contextText }],
        source: { kind: 'plugin' as const, plugin: 'knowledge-base', form: 'retrieval' },
      }
      return { kind: 'enter' as const, messages: [msg, ...payload.messages] }
    } catch (error) {
      console.error('kb: pre-step failed', error instanceof Error ? error.message : error)
      return next()
    }
  })
}
