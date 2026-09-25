// 薄荷科学官方 API 客户端（按需补库）：本地库未命中的菜 → 搜索（1 次调用，搜索即含每百克值+份量单位）
// → 永久缓存进本地库，此后零调用。文档：https://ai.boohee.com/docs/
// 免费档：7 个食物数据接口，50 次请求/天（每日重置）；高级 API（拍照识别等）不开放。
// 请求路径经 resolveEndpoint 解析：开发期走 Vite 代理；线上 web 与 APK 直连 api.boohee.com。
// 2026-09-25 实测官方支持浏览器跨域（预检放行 github.io 源 + x-api-key 头，实响应亦带 ACAO）；
// 旧结论「官方响应无 CORS 头」已失效，勿再据此加代理。

import { loadSettings } from './settings'
import { resolveEndpoint } from './native_http'
import type { DishNutrition } from './nutrition_db'

export interface BooheeUnit {
  unit_name?: string
  weight?: string
}

export interface BooheeFood {
  code: string
  name: string
  calories: number
  protein: number
  fat: number
  carbohydrate: number
  health_light?: number
  units?: BooheeUnit[]
}

type CacheEntry = BooheeFood & { _query?: string; cached_at: string }

const ENDPOINT = '/boohee/open-apis'
const CACHE_KEY = 'fna.boohee.cache.v1'
const MISS_KEY = 'fna.boohee.miss.v1'
const BUDGET_KEY = 'fna.boohee.budget.v1'
/**
 * 免费档 50 次请求/天（每日重置，控制台「注册可用」页注明）：
 * 每日软上限 45 次留余量；每次调用结果永久缓存，当天额度是白给的，用满不亏。
 */
const DAILY_LIMIT = 50
const SOFT_CAP = 45

const norm = (s: string) => s.replace(/[（）()\s·]/g, '').toLowerCase()

// ─── 每日调用预算（50 次/天，每日重置） ─────────────────────

export interface BudgetInfo {
  date: string
  used: number
  limit: number
  remaining: number
}

export function budgetInfo(): BudgetInfo {
  // 本地时区的「今天」（toISOString 是 UTC，会让 UTC+8 用户的额度到早上 8 点才重置）
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let used = 0
  try {
    const raw = JSON.parse(localStorage.getItem(BUDGET_KEY) ?? 'null') as BudgetInfo | null
    if (raw?.date === today) used = Number.isFinite(raw.used) ? raw.used : 0
  } catch {
    used = 0
  }
  return { date: today, used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used) }
}

function consume(n: number): void {
  const b = budgetInfo()
  localStorage.setItem(BUDGET_KEY, JSON.stringify({ date: b.date, used: b.used + n }))
}

// ─── 永久缓存（查到即入库，之后零调用） ─────────────────────

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, CacheEntry>
  } catch {
    return {}
  }
}

function writeCache(c: Record<string, CacheEntry>): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(c))
}

export function listCachedFoods(): CacheEntry[] {
  return Object.values(readCache())
}

function markMiss(name: string): void {
  let m: Record<string, boolean> = {}
  try {
    m = JSON.parse(localStorage.getItem(MISS_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    m = {}
  }
  m[norm(name)] = true
  localStorage.setItem(MISS_KEY, JSON.stringify(m))
}

function isMiss(name: string): boolean {
  let m: Record<string, boolean> = {}
  try {
    m = JSON.parse(localStorage.getItem(MISS_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    m = {}
  }
  return m[norm(name)] === true
}

// ─── 候选挑选：过滤品牌货，精确 > 包含，名字长度最接近 ───────

export function pickBestFood(target: string, foods: BooheeFood[]): BooheeFood | null {
  const t = norm(target)
  const generic = foods.filter((f) => !f.name.includes(' ') && norm(f.name).length <= t.length + 3)
  const exact = generic.find((f) => norm(f.name) === t)
  if (exact) return exact
  const near = generic.filter((f) => {
    const n = norm(f.name)
    return n.includes(t) || t.includes(n)
  })
  if (near.length === 0) return null
  near.sort((a, b) => Math.abs(norm(a.name).length - t.length) - Math.abs(norm(b.name).length - t.length))
  return near[0]
}

// ─── 请求 ───────────────────────────────────────────────────

interface SearchResponseData {
  foods?: Array<{
    code?: string
    name?: string
    calories?: number
    protein?: number
    fat?: number
    carbohydrate?: number
    health_light?: number
    units?: BooheeUnit[]
  }>
}

async function booheeFetch(path: string): Promise<SearchResponseData> {
  const apiKey = loadSettings().booheeApiKey.trim()
  if (!apiKey) throw new Error('未配置薄荷科学 API Key')
  const res = await fetch(resolveEndpoint(`${ENDPOINT}${path}`), {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  })
  if (res.status === 401 || res.status === 403) throw new Error('Key 无效或无权限（检查控制台）')
  if (res.status === 429) throw new Error('触发调用频率限制，请明天再试')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { code?: number; message?: string; data?: SearchResponseData }
  if (json.code !== 0) throw new Error(`接口错误: ${json.message ?? '未知'}`)
  return json.data ?? {}
}

export async function searchFood(keyword: string): Promise<BooheeFood[]> {
  const data = await booheeFetch(
    `/v1/food/search?keyword=${encodeURIComponent(keyword)}&per_page=20&with_units=true`,
  )
  return (data.foods ?? [])
    .filter(
      (f): f is BooheeFood =>
        typeof f.code === 'string' &&
        typeof f.name === 'string' &&
        Number.isFinite(f.calories) &&
        Number.isFinite(f.protein) &&
        Number.isFinite(f.fat) &&
        Number.isFinite(f.carbohydrate),
    )
    .filter((f) => f.calories >= 3 && f.calories <= 900)
}

/**
 * 按需补库主入口：缓存命中直接返回（零调用）；未命中则搜索（1 次调用）。
 * 预算耗尽或当日已确认无此菜时返回 null（不抛错，调用方可静默跳过）。
 */
export async function enrichLookup(name: string): Promise<BooheeFood | null> {
  if (!name || norm(name).length < 2 || name.includes('未知')) return null // 无效名不浪费额度
  const cached = listCachedFoods().find((f) => norm(f.name) === norm(name) || norm(f._query ?? '') === norm(name))
  if (cached) return cached
  if (isMiss(name)) return null
  const budget = budgetInfo()
  if (budget.used >= SOFT_CAP) return null

  const foods = await searchFood(name)
  consume(1)
  const pick = pickBestFood(name, foods)
  if (!pick) {
    markMiss(name)
    return null
  }
  const cache = readCache()
  cache[norm(pick.name)] = { ...pick, _query: name, cached_at: new Date().toISOString().slice(0, 10) }
  writeCache(cache)
  return cache[norm(pick.name)]
}

// ─── 转成本地库条目（origin=reference，永久生效） ────────────

export function toDishNutrition(entry: BooheeFood & { _query?: string }): DishNutrition {
  const presets: Record<string, number> = {}
  let typical = 0
  for (const u of entry.units ?? []) {
    const grams = Math.round(Number(u.weight) || 0)
    const unit = (u.unit_name ?? '').trim()
    if (!unit || grams < 5 || grams > 800) continue
    presets[unit] = grams
    if (grams > typical && grams <= 600) typical = grams
  }
  if (!typical) typical = 150
  const name = entry.name
  return {
    id: `booheeapi-${entry.code}`,
    name,
    aliases: entry._query && entry._query !== name ? [entry._query] : [],
    per100g: {
      calories: Math.round(entry.calories),
      protein_g: entry.protein,
      fat_g: entry.fat,
      carbs_g: entry.carbohydrate,
    },
    typical_portion_g: typical,
    portion_presets: presets,
    category: '家常菜',
    origin: 'reference',
    recipe: [],
    source_url: 'https://ai.boohee.com',
    note: '薄荷科学 API 按需获取（已永久缓存）',
  }
}
