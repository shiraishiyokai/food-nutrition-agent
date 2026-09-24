// 食材扩充（USDA FDC 官方 API 版）：为新增中式食材拉取 SR Legacy 权威值。
// 用法：node scripts/fetch-usda-api.mjs [输出文件]
// DEMO_KEY 限流约 30 次/小时：每食材 1 次请求、断点续采、超限即停（下小时重跑即可）。
// 请求结果经候选正则校验后采纳，避免搜索排名第一但描述不符的项。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_FILE = process.argv[2] ?? join(here, '../src/data/ingredients.usda2.json')
const API_KEY = process.env.USDA_API_KEY ?? 'DEMO_KEY'
const DELAY_MS = 1500

// id: 中文名 [查询词, 候选正则...]（顺序即优先级，全部锚定 SR Legacy 描述）
const WANTED = {
  shiitake: ['shiitake mushroom raw', [/^Mushrooms, shiitake, raw$/i]],
  enoki: ['enoki mushroom raw', [/^Mushrooms, enoki, raw$/i]],
  eggplant: ['eggplant raw', [/^Eggplant, raw$/i]],
  'snap-bean': ['snap beans green raw', [/^Beans, snap, green, raw$/i, /^Beans, snap, green/i]],
  celery: ['celery raw', [/^Celery, raw$/i]],
  spinach: ['spinach raw', [/^Spinach, raw$/i]],
  'bok-choy': ['pak choi raw', [/^Cabbage, chinese \(pak-choi\), raw$/i, /pak-choi.*raw$/i]],
  'water-spinach': ['water spinach raw', [/^Swamp cabbage, raw$/i, /water spinach.*raw$/i, /^Swamp cabbage/i]],
  chives: ['chinese chives raw', [/^Chives, chinese, raw$/i]],
  daikon: ['oriental radish raw', [/^Radishes, oriental, raw$/i, /^Radishes, oriental/i]],
  'winter-melon': ['waxgourd raw', [/^Gourds, waxgourd/i]],
  pumpkin: ['pumpkin raw', [/^Pumpkin, raw$/i]],
  'sweet-potato': ['sweet potato raw', [/^Sweet potato, raw, unprepared$/i, /^Sweet potato, raw/i]],
  'lotus-root': ['lotus root raw', [/^Lotus root, raw$/i]],
  corn: ['sweet corn yellow raw', [/^Corn, sweet, yellow, raw$/i]],
  kelp: ['kelp seaweed raw', [/^Seaweed, kelp, raw$/i]],
  'mung-sprout': ['mung bean sprouted raw', [/^Mung beans, mature seeds, sprouted, raw$/i]],
  squid: ['squid raw', [/^Mollusks, squid, mixed species, raw$/i, /^Mollusks, squid/i]],
  lamb: ['lamb leg lean raw', [/^Lamb, domestic, leg, separable lean only, raw/i, /^Lamb, domestic, leg.*lean only/i]],
  duck: ['duck meat only raw', [/^Duck, domesticated, meat only, raw$/i]],
  'chicken-wing': ['chicken wing raw', [/^Chicken, broilers or fryers, wing, meat and skin, raw$/i]],
  'pork-liver': ['pork liver raw', [/^Pork, fresh, liver, raw$/i]],
  salmon: ['atlantic salmon farmed raw', [/^Fish, salmon, Atlantic, farmed, raw$/i]],
  yogurt: ['yogurt plain whole milk', [/^Yogurt, plain, whole milk/i, /^Yogurt, Greek, plain, whole milk/i]],
  'glutinous-rice': ['glutinous white rice raw', [/^Rice, white, glutinous, raw$/i]],
  bread: ['white bread commercially prepared', [/^Bread, white, commercially prepared/i]],
  'sesame-oil': ['sesame oil', [/^Oil, sesame/i]],
  vinegar: ['cider vinegar', [/^Vinegar, cider$/i]],
  celtuce: ['celtuce raw', [/^Lettuce, celtuce.*raw$/i]],
  edamame: ['edamame frozen', [/^Edamame, frozen, unprepared$/i, /^Edamame/i]],
}

const NUTRIENTS = { calories: 'Energy', protein_g: 'Protein', fat_g: 'Total lipid (fat)', carbs_g: 'Carbohydrate, by difference' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function searchOne(query) {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${API_KEY}&query=${encodeURIComponent(query)}&dataType=${encodeURIComponent('SR Legacy')}&pageSize=25`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (res.status === 403 || res.status === 429) throw new Error(`RATE_LIMIT(${res.status})`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json.foods ?? []
}

async function main() {
  const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : { fetched_at: new Date().toISOString().slice(0, 10), dataset: 'USDA FDC SR Legacy (api)', ingredients: {} }
  let hit = 0
  for (const [id, [query, ...patterns]] of Object.entries(WANTED)) {
    if (prev.ingredients[id]) continue
    await sleep(DELAY_MS)
    let foods
    try {
      foods = await searchOne(query)
    } catch (e) {
      if (String(e.message).startsWith('RATE_LIMIT')) {
        console.log(`⏸ DEMO_KEY 限流，已完成 ${hit} 项；下个小时重跑续采`)
        break
      }
      console.log(`✗ ${id}: ${e.message}`)
      continue
    }
    const desc = (f) => f.description ?? ''
    const f = foods.find((x) => patterns.flat().some((p) => p.test(desc(x))))
    if (!f) {
      console.log(`✗ ${id}: 搜索结果无候选匹配（前3: ${foods.slice(0, 3).map(desc).join(' | ')}）`)
      continue
    }
    const per100g = { calories: null, protein_g: null, fat_g: null, carbs_g: null }
    for (const n of f.foodNutrients ?? []) {
      const name = n.nutrientName ?? ''
      if (name === NUTRIENTS.calories) per100g.calories = Math.round(Number(n.value))
      if (name === NUTRIENTS.protein_g) per100g.protein_g = Number(n.value)
      if (name === NUTRIENTS.fat_g) per100g.fat_g = Number(n.value)
      if (name === NUTRIENTS.carbs_g) per100g.carbs_g = Number(n.value)
    }
    if (per100g.calories == null) {
      console.log(`✗ ${id}: 无能量值 (${desc(f)})`)
      continue
    }
    prev.ingredients[id] = { usda_description: desc(f), fdc_id: f.fdcId, per100g }
    hit++
    console.log(`✓ ${id}: ${desc(f)} → ${per100g.calories} kcal`)
    writeFileSync(OUT_FILE, JSON.stringify(prev, null, 2))
  }
  writeFileSync(OUT_FILE, JSON.stringify(prev, null, 2))
  console.log(`\n本轮新增 ${hit} 项，累计 ${Object.keys(prev.ingredients).length}/${Object.keys(WANTED).length}`)
}

main()
