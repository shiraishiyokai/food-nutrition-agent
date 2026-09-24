// 数据溯源工具：从 USDA FoodData Central SR Legacy CSV 数据集中
// 为 ingredients.json 的原料匹配权威数值（公有领域，可引用）。
// 用法：node scripts/fetch-usda.mjs <数据集解压目录> <输出文件>
// 每个原料按候选正则顺序匹配 SR Legacy 的 food.description，取第一个命中项，
// 提取 Energy(1008)/Protein(1003)/Fat(1004)/Carbs(1005) 四项每百克值。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dataDir, outFile] = process.argv.slice(2)
if (!dataDir || !outFile) {
  console.error('用法：node scripts/fetch-usda.mjs <数据集目录> <输出json>')
  process.exit(1)
}

// SR Legacy 营养素编号
const NUTRIENTS = { calories: '1008', protein_g: '1003', fat_g: '1004', carbs_g: '1005' }

// 原料 → 候选匹配规则（顺序即优先级；均针对生重，米饭/面条例外用熟重并标记）
const INGREDIENTS = {
  'rice-cooked': [/^Rice, white, medium-grain, enriched, cooked$/i],
  flour: [/^Wheat flour, white, all-purpose, enriched, bleached$/i, /^Wheat flour, white, all-purpose, enriched/i],
  'noodles-cooked': [/^Noodles, egg, cooked/i],
  egg: [/^Egg, whole, raw, fresh$/i],
  tomato: [/^Tomatoes, red, ripe, raw/i],
  cucumber: [/^Cucumber, with peel, raw$/i],
  broccoli: [/^Broccoli, raw$/i],
  lettuce: [/^Lettuce, green leaf, raw$/i, /^Lettuce, iceberg.*raw$/i],
  cabbage: [/^Cabbage, common.*raw$/i],
  'green-pepper': [/^Peppers, sweet, green, raw$/i],
  potato: [/^Potatoes, flesh and skin, raw$/i, /^Potatoes, raw, skin/i],
  carrot: [/^Carrots, raw$/i],
  'tofu-north': [/^Tofu, raw, firm, prepared with calcium sulfate/i, /^Tofu, firm/i],
  'chicken-breast': [/^Chicken, broilers or fryers, breast, meat only, cooked, roasted$/i],
  'chicken-thigh': [/^Chicken, broilers or fryers, thigh, meat and skin, raw$/i],
  'pork-loin': [/^Pork, fresh, loin, tenderloin, separable lean only, raw/i, /^Pork, fresh, loin, whole, separable lean and fat, raw/i],
  'pork-belly': [/^Pork, fresh, belly, raw$/i],
  'pork-mince': [/^Pork, fresh, ground/i, /Pork, fresh, composite of trimmed retail cuts.*lean and fat, raw/i],
  'pork-ribs': [/^Pork, fresh, spareribs, separable lean and fat, raw/i],
  beef: [/^Beef, tenderloin, separable lean only, boneless/i, /^Beef, composite of trimmed retail cuts, separable lean only/i, /^Beef, ground, 9[05]% lean/i],
  'fish-strip': [/hairtail/i],
  'fish-bass': [/^Fish, bass, striped, raw/i],
  shrimp: [/^Crustaceans, shrimp, raw$/i, /^Crustaceans, shrimp, mixed species, raw/i],
  peanuts: [/^Peanuts, all types, raw$/i],
  oil: [/^Oil, vegetable, (sunflower|canola|soybean)/i],
  sugar: [/^Sugars, granulated$/i],
  salt: [/^Salt, table$/i],
  soy: [/^Soy sauce made from soy and wheat \(shoyu\)$/i, /^Sauce, ready-to-serve, soy sauce/i],
  starch: [/^Cornstarch$/i],
  cola: [/^Beverages, carbonated, cola, regular$/i],
  milk: [/^Milk, whole, 3\.25% milkfat/i],
  soymilk: [/^Soymilk.*unsweetened/i],
  apple: [/^Apples, raw, with skin/i],
  banana: [/^Bananas, raw$/i],
  // ── v3 扩充（D8 数据源扩充）──
  shiitake: [/^Mushrooms, shiitake, raw$/i],
  enoki: [/^Mushrooms, enoki, raw$/i],
  eggplant: [/^Eggplant, raw$/i],
  'snap-bean': [/^Beans, snap, green, raw$/i, /^Beans, snap, green/i],
  celery: [/^Celery, raw$/i],
  spinach: [/^Spinach, raw$/i],
  'bok-choy': [/^Cabbage, chinese \(pak-choi\), raw$/i, /pak-choi\), raw$/i],
  'water-spinach': [/^Water convolvulus, ?raw$/i],
  chives: [/^Chives, chinese, raw$/i],
  daikon: [/^Radishes, oriental, raw$/i, /^Radishes, oriental/i],
  'winter-melon': [/^Gourds, waxgourd/i],
  pumpkin: [/^Pumpkin, raw$/i],
  'sweet-potato': [/^Sweet potato, raw, unprepared$/i, /^Sweet potato, raw/i],
  'lotus-root': [/^Lotus root, raw$/i],
  corn: [/^Corn, sweet, yellow, raw$/i],
  kelp: [/^Seaweed, kelp, raw$/i],
  'mung-sprout': [/^Mung beans, mature seeds, sprouted, raw$/i],
  squid: [/^Mollusks, squid, mixed species, raw$/i, /^Mollusks, squid/i],
  lamb: [/^Lamb, Australian, imported, fresh, leg, bottom, boneless, separable lean only/i, /^Lamb, Australian.*leg.*separable lean only/i],
  duck: [/^Duck, domesticated, meat only, raw$/i],
  'chicken-wing': [/^Chicken, broilers or fryers, wing, meat and skin, raw$/i],
  'pork-liver': [/^Pork, fresh, variety meats and by-products, liver, raw$/i],
  salmon: [/^Fish, salmon, Atlantic, farmed, raw$/i],
  yogurt: [/^Yogurt, plain, whole milk/i],
  'glutinous-rice': [/^Rice, white, glutinous, unenriched, uncooked$/i],
  bread: [/^Bread, white, commercially prepared/i],
  'sesame-oil': [/^Oil, sesame/i],
  vinegar: [/^Vinegar, cider$/i],
  celtuce: [/^Celtuce, raw$/i],
  edamame: [/^Edamame, frozen, unprepared$/i, /^Edamame/i],
  millet: [/^Millet, raw$/i],
  oats: [/^Cereals, oats, regular and quick, not fortified, dry$/i, /^Cereals, oats, instant, fortified, plain, dry$/i],
  'mung-bean': [/^Mung beans, mature seeds, raw$/i],
}

// 极简 CSV 解析（处理引号内逗号）
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

function loadCsv(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  const header = parseCsvLine(lines[0])
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l)
    const row = {}
    header.forEach((h, i) => (row[h] = cells[i] ?? ''))
    return row
  })
}

const foods = loadCsv(join(dataDir, 'food.csv'))
console.log(`食物总数: ${foods.length}`)

const nutrientsByFdc = new Map()
for (const row of loadCsv(join(dataDir, 'food_nutrient.csv'))) {
  if (row.nutrient_id === '1008' || row.nutrient_id === '1003' || row.nutrient_id === '1004' || row.nutrient_id === '1005') {
    let arr = nutrientsByFdc.get(row.fdc_id)
    if (!arr) nutrientsByFdc.set(row.fdc_id, (arr = []))
    arr.push(row)
  }
}
console.log(`有目标营养素数据的食物: ${nutrientsByFdc.size}`)

const result = {}
const missing = []
for (const [id, patterns] of Object.entries(INGREDIENTS)) {
  let hit = null
  for (const p of patterns) {
    hit = foods.find((f) => p.test(f.description) && nutrientsByFdc.has(f.fdc_id))
    if (hit) break
  }
  if (!hit) { missing.push(id); continue }
  const values = { calories: null, protein_g: null, fat_g: null, carbs_g: null }
  for (const n of nutrientsByFdc.get(hit.fdc_id)) {
    if (n.nutrient_id === '1008') values.calories = Math.round(Number(n.amount))
    if (n.nutrient_id === '1003') values.protein_g = Number(n.amount)
    if (n.nutrient_id === '1004') values.fat_g = Number(n.amount)
    if (n.nutrient_id === '1005') values.carbs_g = Number(n.amount)
  }
  result[id] = {
    usda_description: hit.description,
    fdc_id: hit.fdc_id,
    per100g: values,
  }
}

writeFileSync(outFile, JSON.stringify({ fetched_at: '2026-09-22', dataset: 'USDA FDC SR Legacy 2018-04', ingredients: result }, null, 2))
console.log(`匹配成功: ${Object.keys(result).length}/${Object.keys(INGREDIENTS).length}`)
if (missing.length) console.log('未匹配（需回退中国食物成分表公开值）:', missing.join(', '))
