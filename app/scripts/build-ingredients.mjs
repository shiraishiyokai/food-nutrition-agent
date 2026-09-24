// 数据装配工具：ingredients.usda.json（USDA SR Legacy 实拉数据，含 fdc_id 溯源）
// + 中文映射与少量回退值 → 生成运行时单一数据文件 src/data/ingredients.json
// 用法：node scripts/build-ingredients.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const usda = JSON.parse(readFileSync(join(here, '../src/data/ingredients.usda.json'), 'utf8'))

// 中文名 + 来源标注；cfct 为《中国食物成分表》公开转引值（该表有版权，仅个别项自用引用，不再分发原始表）
const ZH = {
  'rice-cooked': { name: '米饭(熟)', note: 'USDA 中粒米煮熟；中国常见软硬度约116，可按自家米饭校准' },
  flour: { name: '小麦粉' },
  'noodles-cooked': { name: '面条(熟)', source: 'cfct-common', per100g: { calories: 110, protein_g: 3.9, fat_g: 0.4, carbs_g: 22.0 }, note: 'USDA 仅鸡蛋面(138)，中国家常清水面取成分表公开值' },
  starch: { name: '淀粉' },
  egg: { name: '鸡蛋' },
  tomato: { name: '番茄' },
  cucumber: { name: '黄瓜' },
  broccoli: { name: '西兰花' },
  lettuce: { name: '生菜' },
  cabbage: { name: '卷心菜' },
  'green-pepper': { name: '青椒' },
  potato: { name: '土豆' },
  carrot: { name: '胡萝卜' },
  'tofu-north': { name: '北豆腐(老豆腐)', note: 'USDA 老豆腐(144) 高于中国北豆腐常见值(约98)，豆腐类菜品建议优先校准' },
  'chicken-breast': { name: '鸡胸肉(熟)', note: 'USDA 熟烤值(165)，配方中鸡胸按熟重计' },
  'chicken-thigh': { name: '鸡腿肉(带皮,生)', note: 'USDA 带皮带肉(221)，美系鸡较肥，建议校准' },
  'pork-loin': { name: '猪里脊' },
  'pork-belly': { name: '五花肉' },
  'pork-mince': { name: '猪肉末(肥瘦)' },
  'pork-ribs': { name: '猪排骨' },
  beef: { name: '牛肉(瘦)' },
  'fish-strip': { name: '带鱼', source: 'cfct-common', per100g: { calories: 127, protein_g: 17.7, fat_g: 4.9, carbs_g: 3.1 }, note: 'USDA SR Legacy 无带鱼，取成分表公开值' },
  'fish-bass': { name: '鲈鱼' },
  shrimp: { name: '虾仁' },
  peanuts: { name: '花生仁' },
  oil: { name: '食用油' },
  sugar: { name: '白糖' },
  salt: { name: '盐', source: 'none', per100g: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } },
  soy: { name: '酱油' },
  starch2: null,
  cola: { name: '可乐' },
  milk: { name: '全脂牛奶' },
  soymilk: { name: '无糖豆浆' },
  apple: { name: '苹果' },
  banana: { name: '香蕉' },
  water: { name: '水', source: 'none', per100g: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } },
  // ── v3 扩充（D8）：USDA SR Legacy 实拉 ──
  shiitake: { name: '香菇(鲜)' },
  enoki: { name: '金针菇' },
  eggplant: { name: '茄子' },
  'snap-bean': { name: '四季豆' },
  celery: { name: '芹菜(西芹)' },
  spinach: { name: '菠菜' },
  'bok-choy': { name: '油菜(小白菜)' },
  'water-spinach': { name: '空心菜' },
  daikon: { name: '白萝卜' },
  pumpkin: { name: '南瓜' },
  'sweet-potato': { name: '红薯(生)' },
  'lotus-root': { name: '莲藕' },
  corn: { name: '甜玉米' },
  kelp: { name: '海带(鲜)' },
  'mung-sprout': { name: '绿豆芽' },
  squid: { name: '鱿鱼' },
  lamb: { name: '羊肉(瘦)', note: 'USDA 澳洲进口羊腿纯瘦值；中国山羊/绵羊有差异，建议校准' },
  duck: { name: '鸭肉(去皮)', note: 'USDA 鸭肉去皮值；带皮鸭肉(约240)更高，啤酒鸭等建议校准' },
  'chicken-wing': { name: '鸡翅(带皮,生)' },
  'pork-liver': { name: '猪肝(生)' },
  salmon: { name: '三文鱼(养殖)', note: 'USDA 大西洋养殖鲑；中国市售以养殖为主' },
  yogurt: { name: '全脂无糖酸奶' },
  'glutinous-rice': { name: '糯米(生)' },
  bread: { name: '白面包(吐司)' },
  'sesame-oil': { name: '香油(芝麻油)' },
  vinegar: { name: '醋', note: 'USDA 苹果醋(21)；中国酿造醋约31，用量小影响有限' },
  celtuce: { name: '莴笋' },
  edamame: { name: '毛豆(冷冻)' },
  millet: { name: '小米(生)' },
  oats: { name: '燕麦片(干)' },
  'mung-bean': { name: '绿豆(干)' },
}

// USDA 无对应项：《中国食物成分表》公开转引值（自用引用）。note 一律带「待核对」，
// 首次核对原书后移除标记。这些值主要服务于用户配方覆盖（说用料时算数值），命中直录轨的菜不依赖它们。
const CFCT_HAND = {
  chives: { name: '韭菜', per100g: { calories: 26, protein_g: 2.4, fat_g: 0.4, carbs_g: 4.6 } },
  'winter-melon': { name: '冬瓜', per100g: { calories: 12, protein_g: 0.4, fat_g: 0.2, carbs_g: 2.6 } },
  laver: { name: '紫菜(干)', per100g: { calories: 250, protein_g: 26.7, fat_g: 1.1, carbs_g: 44.1 } },
  'cloud-ear': { name: '木耳(水发)', per100g: { calories: 27, protein_g: 1.5, fat_g: 0.2, carbs_g: 6.0 } },
  'white-fungus': { name: '银耳(干)', per100g: { calories: 200, protein_g: 10.0, fat_g: 1.4, carbs_g: 48.2 } },
  'tofu-dried': { name: '香干(豆腐干)', per100g: { calories: 147, protein_g: 16.2, fat_g: 4.6, carbs_g: 9.0 } },
  fuzhu: { name: '腐竹(干)', per100g: { calories: 459, protein_g: 44.6, fat_g: 21.7, carbs_g: 11.2 } },
  'sweet-bean-sauce': { name: '甜面酱', per100g: { calories: 136, protein_g: 4.8, fat_g: 0.6, carbs_g: 29.7 } },
  'broad-bean-paste': { name: '豆瓣酱', per100g: { calories: 181, protein_g: 13.6, fat_g: 6.8, carbs_g: 17.1 } },
  'garlic-scape': { name: '蒜苔', per100g: { calories: 61, protein_g: 2.0, fat_g: 0.1, carbs_g: 15.4 } },
  'yellow-croaker': { name: '黄花鱼', per100g: { calories: 97, protein_g: 17.7, fat_g: 2.5, carbs_g: 0.8 } },
  pickle: { name: '酸菜', per100g: { calories: 15, protein_g: 1.4, fat_g: 0.1, carbs_g: 2.4 } },
}
delete ZH.starch2

const ingredients = []
for (const [id, zh] of Object.entries(ZH)) {
  const u = usda.ingredients[id]
  const source = zh.source ?? (u ? 'usda-sr-legacy' : 'unknown')
  const per100g = zh.per100g ?? u?.per100g
  if (!per100g) { console.error(`缺数值: ${id}`); process.exit(1) }
  ingredients.push({
    id,
    name: zh.name,
    per100g,
    source,
    ref: source === 'usda-sr-legacy' ? `fdc_id:${u.fdc_id}` : (zh.note ?? ''),
    note: zh.note ?? '',
  })
}
for (const [id, cfct] of Object.entries(CFCT_HAND)) {
  if (ingredients.some((i) => i.id === id)) continue
  ingredients.push({
    id,
    name: cfct.name,
    per100g: cfct.per100g,
    source: 'cfct-common',
    ref: '《中国食物成分表》公开转引值（待核对原书）',
    note: '成分表公开转引值，待核对原书后移除标记',
  })
}

const out = {
  version: 'v3-2026-09-24',
  _readme:
    '原料级营养库（两段式架构第二段的数据源）。数值为每 100 克可食部。' +
    'usda-sr-legacy = USDA FoodData Central SR Legacy 2018-04（公有领域，ref 为 fdc_id 可溯源，由 scripts/fetch-usda.mjs 自动匹配）；' +
    'cfct-common = 《中国食物成分表》公开转引值（自用引用，note 带「待核对」者需对照原书后确认）；none = 零热量项。' +
    '菜品配方见 dishes.json，营养数值在运行时由 配方×原料值 计算得出；菜肴直录参考值见 dishes-reference.json。',
  ingredients,
}
writeFileSync(join(here, '../src/data/ingredients.json'), JSON.stringify(out, null, 2))
console.log(`已生成 ${ingredients.length} 项原料: usda=${ingredients.filter((i) => i.source === 'usda-sr-legacy').length}, cfct=${ingredients.filter((i) => i.source === 'cfct-common').length}, none=${ingredients.filter((i) => i.source === 'none').length}`)
