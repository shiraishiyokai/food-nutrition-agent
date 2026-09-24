// 全量枚举库装配：boohee-full-raw.json（枚举爬取，自动过滤）→ src/data/dishes-reference-full.json
// 用法：node scripts/build-full-reference.mjs
// 类别由菜名启发式推断（仅用于未命中时的类目均值兜底，不参与精确值计算）。

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const full = JSON.parse(readFileSync(join(here, 'boohee-full-raw.json'), 'utf8'))
// 排除精选库已收录的名字（精选库数值经过核定，优先级更高）
const curated = new Set(
  JSON.parse(readFileSync(join(here, '../src/data/dishes-reference.json'), 'utf8'))
    .dishes.flatMap((d) => [d.name, ...d.aliases]),
)

function categoryOf(name) {
  if (/汤|羹$/.test(name)) return '汤'
  if (/粥|饭|面|粉|饺|包子|馒头|饼|卷|粽|汤圆|馄饨|馍|米线|面包|三明治|汉堡|披萨/.test(name)) return '主食'
  if (/^凉拌|拍|沙拉/.test(name)) return '凉菜'
  if (/奶茶|咖啡|汁|奶昔|可乐|雪碧|酸奶|豆浆|牛奶|茶$/.test(name)) return '饮品'
  return '家常菜'
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

function portionFromUnits(units) {
  let typical = null
  let best = 0
  const presets = {}
  for (const u of units ?? []) {
    const w = num(u.weight)
    if (!w || w <= 0 || w > 800) continue
    presets[u.unit] = Math.round(w)
    if (w > best && w <= 600) {
      best = w
      typical = Math.round(w)
    }
  }
  return { typical: typical ?? 200, presets }
}

const dishes = []
for (const food of Object.values(full.foods)) {
  if (curated.has(food.name)) continue
  const portion = portionFromUnits(food.units)
  dishes.push({
    id: `reffull-${food.code}`,
    name: food.name,
    aliases: [],
    category: categoryOf(food.name),
    per100g: { calories: Math.round(num(food.calory)), protein_g: num(food.protein), fat_g: num(food.fat), carbs_g: num(food.carbohydrate) },
    sodium_mg: num(food.natrium),
    typical_portion_g: portion.typical,
    portion_presets: portion.presets,
    source: 'boohee-bulk',
    source_url: food.source_url,
    note: '批量枚举采集（品牌/用户上传已过滤，未经逐条核定）',
  })
}

dishes.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
const out = {
  version: `bulk-${full.crawled_at}`,
  _readme:
    '全量枚举参考库：按通用词翻页枚举薄荷食物库搜索接口自动采集，uploader/brand 为空（非品牌非用户上传）、营养素齐全才收录；' +
    '未逐条人工核定，抽样核对与用户校准兜底。查找优先级低于精选核定库 dishes-reference.json。',
  dishes,
}
writeFileSync(join(here, '../src/data/dishes-reference-full.json'), JSON.stringify(out, null, 1))
console.log(`全量库 ${dishes.length} 道（排除精选库同名 ${Object.keys(full.foods).length - dishes.length} 条）→ dishes-reference-full.json`)
console.log('类别分布:', dishes.reduce((m, d) => ((m[d.category] = (m[d.category] ?? 0) + 1), m), {}))
