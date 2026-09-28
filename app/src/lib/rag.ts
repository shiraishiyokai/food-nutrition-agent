/** 配料表解读 RAG（D19）：三层检索——精确/别名（确定性，标签名是标准写法的主力）
 *  → 语义向量（embedding 余弦，抓「单甘酯→单硬脂酸甘油酯」这类换说法）
 *  → 关键词字符二元组兜底（无 Key/向量服务不可用时降级，保证功能不哑）。
 *  红线：知识库每条自带 source，检索只负责「找到该读哪条」，解释一律由被约束的模型
 *  引用条目生成；未命中的成分明确标「暂未收录」，任何环节都不猜。
 *  与营养库同一哲学：数值/事实在本地，模型只做被资料约束的转述。 */
import kbRaw from '../data/additives-kb.json'
import { EMBED_MODELS, getEmbedUrl } from '../ai/providers'
import { resolveEndpoint } from './native_http'

export interface KBEntry {
  id: string
  name: string
  aliases: string[]
  category: string
  fn: string
  safety: string
  level: '一般' | '留意'
  common: string
  source: string
}

export const KB_VERSION = (kbRaw as { version: string }).version
export const KB_ENTRIES: KBEntry[] = (kbRaw as { entries: KBEntry[] }).entries

export interface RagConfig {
  presetId: string
  baseUrl: string
  apiKey: string
}

export type MatchTier = 'exact' | 'semantic' | 'keyword'

export interface LabelHit {
  name: string
  /** null = 知识库未收录（卡片如实标出，不许猜） */
  entry: KBEntry | null
  matchType: MatchTier | null
  score: number
}

export interface RagResult {
  items: LabelHit[]
  stats: { total: number; exact: number; semantic: number; keyword: number; miss: number }
}

const norm = (s: string): string => s.replace(/[（）()\[\]【】\s·、，,]/g, '').toLowerCase()

// ─── 第一层：精确名/别名（标签上的成分名是标准写法，确定性命中是主力） ──

function matchExact(name: string): KBEntry | null {
  const t = norm(name)
  if (!t) return null
  return KB_ENTRIES.find((e) => norm(e.name) === t || e.aliases.some((a) => norm(a) === t)) ?? null
}

// ─── 第三层：关键词字符二元组兜底（零成本、离线） ───────────

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}

function dice(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

function keywordScore(query: string, e: KBEntry): number {
  const q = norm(query)
  let best = dice(q, norm(e.name))
  for (const a of e.aliases) best = Math.max(best, dice(q, norm(a)))
  best = Math.max(best, dice(q, norm(e.category)))
  // 查询串里完整包含条目名（如「无糖可乐里的三氯蔗糖」）≈ 确定命中；
  // 加权随名字长度递增——「三氯蔗糖」必须压过它的子串「蔗糖」（白砂糖别名）
  const boost = (n: string) => (n.length >= 2 && q.includes(n) ? 0.8 + 0.01 * Math.min(n.length, 15) : 0)
  best = Math.max(best, boost(norm(e.name)))
  for (const a of e.aliases) best = Math.max(best, boost(norm(a)))
  return best
}

// ─── 第二层：语义向量（懒构建 + localStorage 永久缓存） ─────

const EMB_CACHE_KEY = 'fna.rag.emb.v1'
const SEMANTIC_MIN = 0.72
const KEYWORD_MIN = 0.5

interface EmbCache {
  version: string
  model: string
  vectors: Record<string, number[]>
}

function entryEmbedText(e: KBEntry): string {
  return `${e.name}${e.aliases.length ? `（别名：${e.aliases.join('/')}）` : ''}：${e.category}，${e.fn}`
}

function embedSupported(cfg: RagConfig): boolean {
  return Boolean(EMBED_MODELS[cfg.presetId] && cfg.apiKey.trim() && cfg.baseUrl.trim())
}

async function embedText(text: string, cfg: RagConfig): Promise<number[]> {
  const model = EMBED_MODELS[cfg.presetId]
  const res = await fetch(resolveEndpoint(getEmbedUrl(cfg.baseUrl)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey.trim()}` },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
  const json = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding?: number[] }> }
  const vec = json.embedding ?? json.data?.[0]?.embedding
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('embedding 响应格式异常')
  return vec
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 首次使用时逐条向量化（45 条 × ~200ms ≈ 十几秒），结果永久缓存；库升级或换模型自动重建 */
async function ensureEntryEmbeddings(cfg: RagConfig): Promise<Record<string, number[]>> {
  const model = EMBED_MODELS[cfg.presetId]
  let cache: EmbCache | null = null
  try {
    cache = JSON.parse(localStorage.getItem(EMB_CACHE_KEY) ?? 'null') as EmbCache | null
  } catch {
    cache = null
  }
  if (cache && cache.version === KB_VERSION && cache.model === model) {
    const missing = KB_ENTRIES.some((e) => !cache!.vectors[e.id])
    if (!missing) return cache.vectors
  }
  const vectors: Record<string, number[]> = { ...(cache?.version === KB_VERSION ? cache.vectors : {}) }
  const chunk = 4
  for (let i = 0; i < KB_ENTRIES.length; i += chunk) {
    const batch = KB_ENTRIES.slice(i, i + chunk)
    // 串行小批，防限流；每批落盘一次，中断后从断点续（重新嵌入仍缺的条目即可）
    for (const e of batch) {
      if (vectors[e.id]) continue
      vectors[e.id] = await embedText(entryEmbedText(e), cfg)
    }
    localStorage.setItem(EMB_CACHE_KEY, JSON.stringify({ version: KB_VERSION, model, vectors }))
  }
  return vectors
}

// ─── 检索主入口 ─────────────────────────────────────────────

export async function retrieveOne(name: string, cfg: RagConfig): Promise<LabelHit> {
  const exact = matchExact(name)
  if (exact) return { name, entry: exact, matchType: 'exact', score: 1 }

  // 语义层：有 Key 且当前预设支持 embedding 才启用；失败自动落关键词
  if (embedSupported(cfg)) {
    try {
      const vectors = await ensureEntryEmbeddings(cfg)
      const qv = await embedText(name, cfg)
      let best: { e: KBEntry; score: number } | null = null
      for (const e of KB_ENTRIES) {
        const v = vectors[e.id]
        if (!v) continue
        const s = cosine(qv, v)
        if (!best || s > best.score) best = { e, score: s }
      }
      if (best && best.score >= SEMANTIC_MIN) return { name, entry: best.e, matchType: 'semantic', score: best.score }
    } catch {
      // 向量服务不可用 → 静默降级到关键词层
    }
  }

  let best: { e: KBEntry; score: number } | null = null
  for (const e of KB_ENTRIES) {
    const s = keywordScore(name, e)
    if (!best || s > best.score) best = { e, score: s }
  }
  if (best && best.score >= KEYWORD_MIN) return { name, entry: best.e, matchType: 'keyword', score: best.score }
  return { name, entry: null, matchType: null, score: 0 }
}

export async function retrieveAll(names: string[], cfg: RagConfig): Promise<RagResult> {
  const items: LabelHit[] = []
  for (const n of names.slice(0, 30)) items.push(await retrieveOne(n.trim(), cfg))
  const stats = { total: items.length, exact: 0, semantic: 0, keyword: 0, miss: 0 }
  for (const it of items) {
    if (!it.matchType) stats.miss++
    else stats[it.matchType]++
  }
  return { items, stats }
}
