// 直录轨第三轮：对前两轮仍未解决的菜，用同义词/去前缀变体词重试。
// 用法：node scripts/retry-boohee.mjs
// 采纳规则收紧为：搜索结果菜名与变体词完全一致 && 详情非品牌 && code 未被占用。
// 输出：scripts/boohee-retry-result.json { accepted: [...完整详情], failed: [q...] }
// failed 的菜进入人工核对清单（给用户网址）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RAW_FILE = join(here, '../src/data/boohee-raw.json')
const REFINE_FILE = join(here, 'boohee-refine-report.json')
const OUT_FILE = join(here, 'boohee-retry-result.json')
const DELAY_MS = 420
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (res.status === 429) {
        await sleep(8000)
        continue
      }
      if (!res.ok) return null
      return await res.json()
    } catch {
      await sleep(1500)
    }
  }
  return null
}

// 同义词表：q → 变体查询词（按优先级）
const SYNONYMS = {
  西红柿鸡蛋汤: ['番茄蛋汤', '西红柿蛋汤'],
  醋溜白菜: ['醋熘白菜', '醋溜大白菜'],
  手撕包菜: ['炝炒包菜', '炒包菜'],
  白菜炖豆腐: ['白菜豆腐汤', '炖白菜豆腐'],
  猪肉炖粉条: ['猪肉粉条'],
  红烧冬瓜: ['烧冬瓜'],
  清炒西葫芦: ['炒西葫芦'],
  蒜蓉西兰花: ['蒜蓉菜花', '清炒西兰花'],
  蒜蓉空心菜: ['空心菜'],
  清炒油菜: ['炒油菜', '油菜'],
  白灼菜心: ['菜心'],
  上汤娃娃菜: ['娃娃菜'],
  清炒菠菜: ['菠菜'],
  蒜蓉油麦菜: ['油麦菜'],
  清炒豆芽: ['豆芽'],
  蒜蓉金针菇: ['金针菇'],
  蚝油生菜: ['生菜'],
  清炒山药: ['山药'],
  清炒莴笋: ['莴笋'],
  凉拌木耳: ['木耳'],
  凉拌海带丝: ['海带丝'],
  凉拌腐竹: ['腐竹'],
  水煮毛豆: ['毛豆'],
  冬瓜排骨汤: ['冬瓜汤'],
  莲藕排骨汤: ['莲藕汤', '藕汤'],
  萝卜排骨汤: ['萝卜汤'],
  鲫鱼豆腐汤: ['鲫鱼汤'],
  冬瓜丸子汤: ['丸子汤'],
  海带豆腐汤: ['海带汤'],
  汤圆: ['元宵'],
  豆腐脑: ['豆腐花'],
  小米粥: ['小米粥'],
  八宝粥: ['腊八粥'],
  皮蛋瘦肉粥: ['瘦粥'],
  燕麦粥: ['麦片粥'],
  咖喱饭: ['咖喱鸡肉饭'],
  卤肉饭: ['台湾卤肉饭'],
  煲仔饭: ['腊味煲仔饭'],
  红烧鱼块: ['红烧鱼'],
  清蒸龙利鱼: ['龙利鱼'],
  香煎三文鱼: ['煎三文鱼'],
  蒜蓉粉丝蒸虾: ['蒜蓉蒸虾'],
  爆炒鱿鱼: ['炒鱿鱼'],
  爆炒猪肝: ['炒猪肝'],
  红烧茄子: ['烧茄子'],
  干煸四季豆: ['干煸豆角'],
  虎皮青椒: ['虎皮辣椒'],
  芹菜炒肉丝: ['芹菜炒肉'],
  芹菜炒香干: ['芹菜豆干'],
  蒜苔炒肉: ['蒜薹炒肉', '蒜苗炒肉'],
  洋葱炒肉: ['洋葱肉丝'],
  韭菜炒鸡蛋: ['韭菜炒蛋', '韭菜鸡蛋'],
  苦瓜炒蛋: ['苦瓜炒鸡蛋'],
  萝卜炖牛腩: ['萝卜牛腩', '牛腩汤'],
  葱爆羊肉: ['葱爆肉'],
  清炒藕片: ['炒藕片'],
  干锅土豆片: ['干锅土豆'],
  番茄菜花: ['菜花', '花菜'],
  干锅菜花: ['干锅花菜'],
  肉末豆腐: ['豆腐'],
  炸酱面: ['老北京炸酱面'],
  过桥米线: ['米线'],
  凉皮: ['凉皮'],
  肉夹馍: ['肉夹馍'],
  馄饨: ['鲜肉馄饨', '菜肉馄饨'],
  锅贴: ['煎饺'],
  葱油饼: ['葱油饼'],
  烧麦: ['烧卖', '糯米烧卖'],
  方便面: ['泡面', '煮方便面'],
  羊肉串: ['烤羊肉串'],
  汉堡: ['牛肉汉堡', '汉堡包'],
  披萨: ['披萨', '比萨'],
  意大利面: ['番茄意大利面'],
  三明治: ['三明治'],
  螺蛳粉: ['螺蛳粉'],
  板栗烧鸡: ['栗子鸡', '板栗烧鸡'],
  酱牛肉: ['酱牛肉'],
  红烧狮子头: ['狮子头', '红烧狮子头'],
  梅菜扣肉: ['梅菜扣肉'],
  粉蒸肉: ['粉蒸肉'],
  木须肉: ['木樨肉', '木须肉'],
  番茄牛腩: ['番茄炖牛腩', '西红柿牛腩'],
  咖喱鸡: ['咖喱鸡块', '咖喱鸡肉'],
  鱼香茄子: ['鱼香茄子'],
  红烧鸡翅: ['红烧鸡翅'],
  红烧猪蹄: ['红烧猪蹄'],
  紫菜蛋花汤: ['紫菜汤', '蛋花汤'],
  玉米排骨汤: ['玉米排骨汤'],
  疙瘩汤: ['疙瘩汤'],
  凉拌黄瓜: ['凉拌黄瓜'],
  烤红薯: ['烤红薯'],
  大拌菜: ['大拌菜', '凉拌大拌菜'],
  红烧黄花鱼: ['红烧黄花鱼'],
  虾仁滑蛋: ['虾仁滑蛋'],
  桃子: ['桃'],
  白切鸡: ['白切鸡'],
}

// 本轮已人工核定采纳（refine 候选 / 主采集 review 匹配），不再重试
const RESOLVED = new Set([
  '油焖大虾', '香菇滑鸡', '肉末茄子', '地三鲜', '蚂蚁上树', '香菇油菜', '糖醋里脊', '煮玉米',
  '拍黄瓜', '口水鸡', '老醋花生', '鸡汤', '肠粉', '蜜汁叉烧', '卤蛋', '咸鸭蛋', '鹌鹑蛋', '酸奶', '奶茶',
  '炸带鱼', '白切鸡', '粽子', '拿铁咖啡',
])

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

/** 去前缀变体（清炒X→X 等已在同义词表，这里是兜底生成器） */
function stripVariants(q) {
  const out = []
  for (const p of ['清炒', '蒜蓉', '白灼', '凉拌', '上汤', '干锅', '蒜泥']) {
    if (q.startsWith(p) && q.length > p.length + 1) out.push(q.slice(p.length))
  }
  return out
}

async function main() {
  const raw = JSON.parse(readFileSync(RAW_FILE, 'utf8'))
  const refine = JSON.parse(readFileSync(REFINE_FILE, 'utf8'))
  const usedCodes = new Set(raw.items.filter((i) => !i.review).map((i) => i.code))
  const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : null

  // 待解决 = review 命中 + misses − 已核定
  const pending = new Map()
  for (const it of raw.items) if (it.review && !RESOLVED.has(it.q)) pending.set(it.q, it.cat)
  for (const q of raw.misses) if (!RESOLVED.has(q)) pending.set(q, refine.candidates_by_q[q]?.cat ?? '家常菜')

  const accepted = prev?.accepted ?? []
  const failed = prev?.failed ?? []
  const doneQ = new Set([...accepted.map((a) => a.q), ...failed])
  console.log(`待重试 ${pending.size}，已完成 ${doneQ.size}`)

  for (const [q, cat] of pending) {
    if (doneQ.has(q)) continue
    const variants = [...(SYNONYMS[q] ?? []), ...stripVariants(q)]
    if (variants.length === 0) {
      failed.push(q)
      writeFileSync(OUT_FILE, JSON.stringify({ accepted, failed }, null, 2))
      continue
    }
    let ok = false
    for (const v of variants) {
      await sleep(DELAY_MS)
      const search = await getJson(`https://food.boohee.com/fb/v1/foods/search?q=${encodeURIComponent(v)}&page=1&order=asc`)
      const exact = (search?.foods ?? []).find((f) => f.name === v && !usedCodes.has(f.code))
      if (!exact) continue
      await sleep(DELAY_MS)
      const detail = await getJson(`https://food.boohee.com/fb/v1/foods/${exact.code}`)
      if (!detail?.code || detail.brand) continue
      if (num(detail.calory) == null) continue
      usedCodes.add(detail.code)
      accepted.push({
        q, cat, code: detail.code, matched_name: detail.name,
        calory: detail.calory, protein: detail.protein, fat: detail.fat, carbohydrate: detail.carbohydrate,
        natrium: detail.natrium, units: detail.units, via: v,
        source_url: `https://food.boohee.com/fb/view_detail_${detail.code}`,
      })
      console.log(`✓ ${q} via「${v}」→ ${detail.name} ${detail.calory}kcal`)
      writeFileSync(OUT_FILE, JSON.stringify({ accepted, failed }, null, 2))
      ok = true
      break
    }
    if (!ok) {
      failed.push(q)
      console.log(`✗ ${q}: ${variants.join('/') || '(无变体)'} 均无精确命中`)
      writeFileSync(OUT_FILE, JSON.stringify({ accepted, failed }, null, 2))
    }
  }
  console.log(`\n重试完成：自动采纳 ${accepted.length}，仍失败 ${failed.length}`)
  console.log('失败清单:', failed.join('、'))
}

main()
