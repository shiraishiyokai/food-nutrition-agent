// 菜肴直录轨采集：从薄荷食物库公开接口逐菜拉取每百克营养值（带 code 可溯源）。
// 用法：node scripts/fetch-boohee.mjs
// 输入：scripts/boohee-dish-list.json（q=查询名, cat=类别）
// 输出：src/data/boohee-raw.json（原始详情全量保留，人工抽验 review 项）
// 特性：断点续采（已有 q 跳过）、每条落盘、命中校验（菜名不符标记 review，不静默采纳）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LIST_FILE = join(here, 'boohee-dish-list.json')
const OUT_FILE = join(here, '../src/data/boohee-raw.json')
const DELAY_MS = 400
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
      if (res.status === 429) {
        console.log('  429 限流，等待 10s 重试…')
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
      console.log(`  请求失败: ${e.message}`)
      return null
    }
  }
  return null
}

function pickCandidate(query, foods) {
  if (!Array.isArray(foods) || foods.length === 0) return null
  const q = query.replace(/\s/g, '')
  const exact = foods.find((f) => f.name === q && !f.brand)
  if (exact) return { food: exact, review: false }
  const near = foods.filter((f) => !f.brand && (f.name.includes(q) || q.includes(f.name)))
  if (near.length > 0) {
    // 取名字长度最接近的（避免"红烧"匹配到"红烧牛肉面"这类过泛项）
    near.sort((a, b) => Math.abs(a.name.length - q.length) - Math.abs(b.name.length - q.length))
    return { food: near[0], review: true }
  }
  return null
}

async function main() {
  const list = JSON.parse(readFileSync(LIST_FILE, 'utf8')).dishes
  // 按 q 去重
  const seen = new Set()
  const items = list.filter((d) => (seen.has(d.q) ? false : (seen.add(d.q), true)))
  console.log(`清单共 ${items.length} 道菜（去重后）`)

  const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : null
  const done = new Set(prev?.items?.map((i) => i.q) ?? [])
  const hits = prev?.items ?? []
  const misses = prev?.misses ?? []
  const skipped = prev?.skipped ?? []
  console.log(`已完成 ${done.size}，续采 ${items.length - done.size}`)

  for (const { q, cat } of items) {
    if (done.has(q)) continue
    await sleep(DELAY_MS)

    const search = await getJson(`https://food.boohee.com/fb/v1/foods/search?q=${encodeURIComponent(q)}&page=1&order=asc`)
    const pick = search ? pickCandidate(q, search.foods) : null
    if (!pick) {
      misses.push(q)
      console.log(`✗ ${q}: 无匹配`)
      writeFileSync(OUT_FILE, JSON.stringify({ fetched_at: new Date().toISOString().slice(0, 10), items: hits, misses, skipped }, null, 2))
      continue
    }
    const { food, review } = pick
    await sleep(DELAY_MS)

    const detail = await getJson(`https://food.boohee.com/fb/v1/foods/${food.code}`)
    if (!detail || !detail.code) {
      skipped.push({ q, reason: 'detail_failed', code: food.code })
      console.log(`✗ ${q}: 详情获取失败 (${food.code})`)
      writeFileSync(OUT_FILE, JSON.stringify({ fetched_at: new Date().toISOString().slice(0, 10), items: hits, misses, skipped }, null, 2))
      continue
    }

    hits.push({
      q,
      cat,
      review,
      matched_name: detail.name,
      code: detail.code,
      boohee_id: detail.id,
      calory: detail.calory,
      protein: detail.protein,
      fat: detail.fat,
      carbohydrate: detail.carbohydrate,
      fiber_dietary: detail.fiber_dietary,
      natrium: detail.natrium,
      health_light: detail.health_light,
      units: detail.units,
      source_url: `https://food.boohee.com/fb/view_detail_${detail.code}`,
    })
    console.log(`✓ ${q} → ${detail.name} (${detail.code}) ${detail.calory}kcal${review ? ' [需复核]' : ''}`)
    writeFileSync(OUT_FILE, JSON.stringify({ fetched_at: new Date().toISOString().slice(0, 10), items: hits, misses, skipped }, null, 2))
  }

  console.log(`\n采集完成: 命中 ${hits.length} · 无匹配 ${misses.length} · 失败 ${skipped.length}`)
  if (misses.length) console.log('无匹配:', misses.join('、'))
  const reviewList = hits.filter((h) => h.review)
  if (reviewList.length) console.log('需人工复核（名称非精确匹配）:', reviewList.map((h) => `${h.q}→${h.matched_name}`).join('、'))
}

main()
