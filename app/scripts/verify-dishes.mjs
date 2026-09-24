// 数据质量校验报告（node scripts/verify-dishes.mjs）：
// 1) 菜品配方引用的原料是否全部存在；
// 2) 派生值与直录参考值对同一道菜的偏差（>25% 列为待复核）；
// 3) 直录库条目完整性（四大营养素齐全、来源链接存在）。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ingredients = JSON.parse(readFileSync(join(here, '../src/data/ingredients.json'), 'utf8')).ingredients
const dishes = JSON.parse(readFileSync(join(here, '../src/data/dishes.json'), 'utf8')).dishes
const ref = JSON.parse(readFileSync(join(here, '../src/data/dishes-reference.json'), 'utf8')).dishes

const ingById = new Map(ingredients.map((i) => [i.id, i]))
const norm = (s) => s.replace(/[（）()\s]/g, '')
const refByName = new Map()
for (const d of ref) {
  refByName.set(norm(d.name), d)
  for (const a of d.aliases) refByName.set(norm(a), d)
}

console.log(`原料 ${ingredients.length} 项（含待核对 ${ingredients.filter((i) => i.note?.includes('待核对')).length}）· 派生菜 ${dishes.length} 道 · 直录菜 ${ref.length} 道\n`)

let issues = 0
for (const d of dishes) {
  let sum = 0
  for (const line of d.recipe) {
    if (!ingById.has(line.ingredientId)) {
      console.log(`✗ 配方未知原料: ${d.name} → ${line.ingredientId}`)
      issues++
    } else {
      sum += line.grams
    }
  }
  if (sum === 0) { console.log(`✗ 配方总重为 0: ${d.name}`); issues++ }
}

let checked = 0
for (const d of dishes) {
  const names = [norm(d.name), ...d.aliases.map(norm)]
  const r = names.map((n) => refByName.get(n)).find(Boolean)
  if (!r) continue
  checked++
  const dev = (d === r ? 0 : Math.abs(r.per100g.calories - derived(d)) / Math.max(r.per100g.calories, 1)) * 100
  function derived(x) {
    // 重算派生每百克热量
    let cal = 0, total = 0
    for (const line of x.recipe) {
      const ing = ingById.get(line.ingredientId)
      if (!ing) continue
      cal += ing.per100g.calories * line.grams / 100
      total += line.grams
    }
    return total ? (cal / total) * 100 : 0
  }
  const mark = dev > 25 ? '⚠ 偏差大' : '✓'
  console.log(`${mark} ${d.name}: 派生≈${Math.round(derived(d))} vs 直录=${r.per100g.calories} (差 ${Math.round(dev)}%)`)
  if (dev > 25) issues++
}

for (const d of ref) {
  const p = d.per100g
  if (p.protein_g == null || p.fat_g == null || p.carbs_g == null || !d.source_url) {
    console.log(`✗ 直录条目不完整: ${d.name}`)
    issues++
  }
}

console.log(`\n与直录值可比对的派生菜 ${checked} 道；共发现 ${issues} 个待处理问题`)
