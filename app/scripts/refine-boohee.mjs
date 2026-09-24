// 直录轨精化：对首采未命中(reviews/misses)的菜重搜 + 预检品牌，生成候选报告供人工核定。
// 用法：node scripts/refine-boohee.mjs
// 输出：scripts/boohee-refine-report.json —— 每个待定菜名的候选（含 brand、热量），人工核定后
//       写 scripts/boohee-manual-map.json（q→code），再跑 build-dishes-reference.mjs 生成正式数据。
// 断点续采；已采精确命中的菜另由 audit 步骤复查品牌（brand 字段仅详情接口返回）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RAW_FILE = join(here, '../src/data/boohee-raw.json')
const OUT_FILE = join(here, 'boohee-refine-report.json')
const DELAY_MS = 380
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
      if (res.status === 429) {
        await sleep(10000)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      if (attempt === 0) {
        await sleep(2000)
        continue
      }
      console.log(`  请求失败: ${url} ${e.message}`)
      return null
    }
  }
  return null
}

/** 候选名是否"像"通用菜名（过滤明显品牌前缀/后缀变体，最终仍由人工核定） */
function looksGeneric(name, q) {
  if (name.includes(' ')) return false // 含空格多为"品牌 菜名"
  if (name.length > q.length + 3) return false // 后缀过长多为变体/制品
  return true
}

async function main() {
  const raw = JSON.parse(readFileSync(RAW_FILE, 'utf8'))
  const doneCodes = new Set(raw.items.filter((i) => !i.review).map((i) => i.code))
  const pending = [
    ...raw.items.filter((i) => i.review).map((i) => ({ q: i.q, cat: i.cat })),
    ...raw.misses.map((q) => ({ q, cat: (JSON.parse(readFileSync(join(here, 'boohee-dish-list.json'), 'utf8')).dishes.find((d) => d.q === q) ?? {}).cat ?? '家常菜' })),
  ]
  const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : { candidates_by_q: {} }
  console.log(`待精化 ${pending.length} 项，已完成 ${Object.keys(prev.candidates_by_q).length}`)

  for (const { q, cat } of pending) {
    if (prev.candidates_by_q[q]) continue
    await sleep(DELAY_MS)
    const search = await getJson(`https://food.boohee.com/fb/v1/foods/search?q=${encodeURIComponent(q)}&page=1&order=asc`)
    const foods = (search?.foods ?? []).filter((f) => !doneCodes.has(f.code))
    const narrowed = foods.filter((f) => looksGeneric(f.name, q)).slice(0, 4)
    const candidates = []
    for (const f of narrowed) {
      await sleep(DELAY_MS)
      const detail = await getJson(`https://food.boohee.com/fb/v1/foods/${f.code}`)
      if (!detail?.code) continue
      if (detail.brand) continue // 品牌预包装：直接排除
      candidates.push({
        name: detail.name,
        code: detail.code,
        calory: Number(detail.calory),
        protein: Number(detail.protein),
        fat: Number(detail.fat),
        carbohydrate: Number(detail.carbohydrate),
        units: (detail.units ?? []).map((u) => `${u.unit}${u.unit_name ? '/' + u.unit_name : ''}`).join('、'),
      })
    }
    prev.candidates_by_q[q] = { cat, candidates }
    console.log(`✓ ${q}: ${candidates.length} 个有效候选${candidates.length ? ' → ' + candidates.map((c) => `${c.name}(${c.calory})`).join(' | ') : ''}`)
    writeFileSync(OUT_FILE, JSON.stringify(prev, null, 2))
  }
  console.log('精化完成 → scripts/boohee-refine-report.json')
}

main()
