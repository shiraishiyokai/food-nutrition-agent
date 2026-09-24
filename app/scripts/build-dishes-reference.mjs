// 直录轨数据装配：boohee-raw.json（精确命中）+ boohee-manual-map.json（人工核定映射）
// → src/data/dishes-reference.json（运行时直录参考值库，每条带来源链接）。
// 用法：node scripts/build-dishes-reference.mjs
// 人工核定映射格式（scripts/boohee-manual-map.json）：
//   { "醋溜白菜": { "code": "culiubaicai", "aliases": ["醋熘白菜"] } }   ← 采纳该候选
//   { "馄饨皮菜": null }                                                ← 明确拒绝，不进直录库
// 采纳的候选会重拉一次详情：复核 brand（品牌预包装拒绝）、取分量预设与完整字段。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RAW_FILE = join(here, '../src/data/boohee-raw.json')
const REFINE_FILE = join(here, 'boohee-refine-report.json')
const MAP_FILE = join(here, 'boohee-manual-map.json')
const RETRY_FILE = join(here, 'boohee-retry-result.json')
const OUT_FILE = join(here, '../src/data/dishes-reference.json')
const DELAY_MS = 380
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

function portionFromUnits(units, category) {
  const DEFAULTS = { 家常菜: 200, 蔬菜: 150, 凉菜: 100, 汤: 300, 蛋白类: 120, 主食: 250, 外食: 400, 饮品: 250, 水果: 200 }
  const presets = {}
  let typical = null
  let bestWeight = 0
  for (const u of units ?? []) {
    const w = num(u.weight)
    if (!w || w <= 0 || w > 800) continue
    presets[u.unit] = Math.round(w)
    if (w > bestWeight && w <= 600) {
      bestWeight = w
      typical = Math.round(w)
    }
  }
  return { typical: typical ?? DEFAULTS[category] ?? 150, presets }
}

async function main() {
  const raw = JSON.parse(readFileSync(RAW_FILE, 'utf8'))
  const refine = existsSync(REFINE_FILE) ? JSON.parse(readFileSync(REFINE_FILE, 'utf8')) : { candidates_by_q: {} }
  const manual = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : {}

  const dishes = []
  const problems = []

  // 1) 精确命中（首采时菜名完全一致）
  for (const it of raw.items) {
    if (it.review) continue // 精化流程处理
    const cal = num(it.calory)
    if (cal == null) { problems.push(`${it.q}: 无热量值`); continue }
    const portion = portionFromUnits(it.units, it.cat)
    dishes.push({
      id: `ref-${it.code}`,
      name: it.matched_name,
      aliases: it.q !== it.matched_name ? [it.q] : [],
      category: it.cat,
      per100g: { calories: Math.round(cal), protein_g: num(it.protein), fat_g: num(it.fat), carbs_g: num(it.carbohydrate) },
      sodium_mg: num(it.natrium),
      typical_portion_g: portion.typical,
      portion_presets: portion.presets,
      source: 'boohee',
      source_url: `https://food.boohee.com/fb/v1/foods/${it.code}`,
    })
  }

  // 2) 重试轮自动采纳（详情已在重试时复核过品牌，直接使用）
  if (existsSync(RETRY_FILE)) {
    const retry = JSON.parse(readFileSync(RETRY_FILE, 'utf8'))
    for (const it of retry.accepted) {
      const portion = portionFromUnits(it.units, it.cat)
      dishes.push({
        id: `ref-${it.code}`,
        name: it.matched_name,
        aliases: [it.q, ...(it.q !== it.matched_name ? [] : [])].filter((a) => a !== it.matched_name),
        category: it.cat,
        per100g: { calories: Math.round(num(it.calory)), protein_g: num(it.protein), fat_g: num(it.fat), carbs_g: num(it.carbohydrate) },
        sodium_mg: num(it.natrium),
        typical_portion_g: portion.typical,
        portion_presets: portion.presets,
        source: 'boohee',
        source_url: `https://food.boohee.com/fb/v1/foods/${it.code}`,
        note: `经变体词「${it.via}」匹配，菜名与搜索词完全一致`,
      })
      console.log(`✓(retry) ${it.q} → ${it.matched_name} ${Math.round(num(it.calory))}kcal`)
    }
  }

  // 3) 人工核定映射（review + misses）
  for (const [q, spec] of Object.entries(manual)) {
    if (spec === null) continue // 明确拒绝
    const cat = refine.candidates_by_q[q]?.cat ?? '家常菜'
    await sleep(DELAY_MS)
    const detail = await getJson(`https://food.boohee.com/fb/v1/foods/${spec.code}`)
    if (!detail?.code) { problems.push(`${q}: 详情获取失败 (${spec.code})`); continue }
    if (detail.brand) { problems.push(`${q}: 候选 ${detail.name} 为品牌预包装(${detail.brand})，已拒绝`); continue }
    const cal = num(detail.calory)
    if (cal == null) { problems.push(`${q}: 无热量值`); continue }
    const portion = portionFromUnits(detail.units, cat)
    dishes.push({
      id: `ref-${detail.code}`,
      name: detail.name,
      aliases: [q, ...(spec.aliases ?? [])].filter((a) => a !== detail.name),
      category: cat,
      per100g: { calories: Math.round(cal), protein_g: num(detail.protein), fat_g: num(detail.fat), carbs_g: num(detail.carbohydrate) },
      sodium_mg: num(detail.natrium),
      typical_portion_g: portion.typical,
      portion_presets: portion.presets,
      source: 'boohee',
      source_url: `https://food.boohee.com/fb/v1/foods/${detail.code}`,
      note: '菜名映射经人工核定',
    })
    console.log(`✓ ${q} → ${detail.name} (${detail.code}) ${Math.round(cal)}kcal`)
  }

  // 4) 去重（同 code 合并别名）与清洗
  const byId = new Map()
  for (const d of dishes) {
    const exist = byId.get(d.id)
    if (exist) {
      exist.aliases = [...new Set([...exist.aliases, ...d.aliases])]
      continue
    }
    if (d.per100g.calories < 5 || d.per100g.calories > 900) { problems.push(`${d.name}: 热量越界 ${d.per100g.calories}`); continue }
    byId.set(d.id, d)
  }
  const out = {
    version: 'v1-2026-09-24',
    _readme:
      '菜肴直录参考值库：数值逐菜实拉自薄荷食物库公开接口（专业营养机构测算值，非政府权威，菜肴级无政府权威数据源）。' +
      'source_url 为逐条溯源链接；人工核定映射见 scripts/boohee-manual-map.json。' +
      '运行时 lookup 顺序：个人校准 > 本直录库 > dishes.json 配方派生。',
    dishes: [...byId.values()],
  }
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2))
  console.log(`\n直录库共 ${out.dishes.length} 道` + (problems.length ? `；问题 ${problems.length} 项:\n${problems.join('\n')}` : ''))
}

main()
