// 全量爬取数据质检（用户要求：核对离谱数据）。规则全部可解释：
//  R1 能量自洽：cal 与 宏量推算(p*4+f*9+c*4) 偏差 >30% 且 >25 kcal → 可疑
//  R2 热量过高：>700 kcal/100g → 疑似油/酱类，不是组合餐食材
//  R3 空热量：热量>30 但三大宏量合计 <1 → 数值不可信
//  R4 非菜品：名字像调料/油脂（油|酱|调味…）
//  R5 与精选库重名 → 构建时自动排除（报告计数）
// 双用法：CLI 直跑出 quality-report.json；build-full-reference.mjs 复用 screenFoods。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function screenFoods(foods, curatedSet) {
  const issues = []
  const keep = {}
  let overlap = 0
  for (const f of foods) {
    const cal = Number(f.calory), p = Number(f.protein), ft = Number(f.fat), c = Number(f.carbohydrate)
    const problems = []
    if (curatedSet.has(f.name)) { overlap++; problems.push('与精选库重名(构建时自动排除)') }
    if (![cal, p, ft, c].every(Number.isFinite)) problems.push('营养素非数值')
    else {
      const macroKcal = p * 4 + ft * 9 + c * 4
      if (cal > 8 && Math.abs(cal - macroKcal) > Math.max(25, cal * 0.3))
        problems.push(`能量不自洽: cal=${cal} vs 宏量推算 ${Math.round(macroKcal)}`)
      if (cal > 700) problems.push(`热量过高 ${cal} kcal/100g（疑似油/酱）`)
      if (cal > 30 && p + ft + c < 1) problems.push('三大宏量几乎为0但热量高')
      if (/油$|酱$|酱料|调味|糖浆|蜂蜜|猪油|香油|辣油/.test(f.name)) problems.push('疑似调料/油脂，非菜品')
    }
    if (problems.length) issues.push({ name: f.name, cal: f.calory, protein: f.protein, fat: f.fat, carb: f.carbohydrate, problems })
    else keep[f.name] = f
  }
  return { keep, issues, overlap }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  const raw = JSON.parse(readFileSync(join(here, 'boohee-full-raw.json'), 'utf8'))
  const curated = new Set(
    JSON.parse(readFileSync(join(here, '../src/data/dishes-reference.json'), 'utf8')).dishes.flatMap((d) => [d.name, ...d.aliases]),
  )
  const { keep, issues, overlap } = screenFoods(Object.values(raw.foods), curated)
  const MEAT_RE = /肉|排骨|鸡腿|鸡翅|鸡|鸭|鱼|虾|蟹|牛|羊|排$|肝|腊肠|火腿|培根|蛋/
  const SOUP_RE = /汤|羹$/
  const STAPLE_RE = /饭$|炒饭|拌饭|面$|面条|炒面|拌面|米粉|米线|粥|馒头|包子|饺子|面包|吐司|意面|汉堡|三明治|饼$|薯|汤圆/
  const PROTEIN_RE = /鸡蛋|蛋羹|蒸蛋|水煮蛋|煎蛋|茶叶蛋|牛奶|酸奶|豆浆/
  const buckets = { 主食: 0, 荤菜: 0, 素菜: 0, 汤: 0, 蛋白: 0 }
  for (const f of Object.values(keep)) {
    const n = f.name
    if (SOUP_RE.test(n)) buckets['汤']++
    else if (STAPLE_RE.test(n)) buckets['主食']++
    else if (PROTEIN_RE.test(n)) buckets['蛋白']++
    else if (MEAT_RE.test(n)) buckets['荤菜']++
    else buckets['素菜']++
  }
  const report = {
    generated_at: new Date().toISOString(),
    crawled_at: raw.crawled_at,
    done_tokens: `${raw.done_tokens.length}/${raw.done_tokens.length}`,
    total: Object.keys(raw.foods).length,
    keep: Object.keys(keep).length,
    overlap_with_curated: overlap,
    issues: issues.length,
    issue_samples: issues.slice(0, 40),
    buckets_after_screen: buckets,
  }
  writeFileSync(join(here, 'quality-report.json'), JSON.stringify(report, null, 1))
  console.log(`总计 ${report.total} 条 | 通过 ${report.keep} | 问题 ${report.issues} | 与精选库重名 ${overlap}`)
  console.log('分桶(通过口径):', JSON.stringify(buckets))
  console.log('问题样例(前10):')
  for (const i of issues.slice(0, 10)) console.log(` - ${i.name}: ${i.problems.join('; ')}`)
}
