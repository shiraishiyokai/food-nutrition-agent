// 薄荷全库枚举采集：按通用词翻页枚举搜索接口，覆盖全库家常菜条目（不再按菜名清单逐个猜）。
// 用法：node scripts/crawl-boohee-full.mjs
// 采纳规则（自动、批量）：菜名纯中文且长度合理 && 详情 uploader 与 brand 均为空（过滤品牌/用户上传）
//   && 四大营养素齐全 && 热量在 5~900 kcal/100g。
// 特性：按名字去重、断点续采、逐步落盘（boohee-full-raw.json），供 build-full-reference 合并。
// 限速 500ms/请求；预计 40 词 × ~10 页 + 数千次详情，约 1 小时。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_FILE = join(here, 'boohee-full-raw.json')
const DELAY_MS = 1200
const MAX_PAGES = 15
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

// 枚举用通用词：主料 × 烹饪法 × 品类（覆盖家常菜/汤/主食/凉菜）
const TOKENS = [
  '鸡', '鸡蛋', '牛肉', '羊肉', '猪肉', '排骨', '鱼', '虾', '豆腐', '土豆',
  '茄子', '豆角', '白菜', '青菜', '菠菜', '芹菜', '藕', '冬瓜', '南瓜', '萝卜',
  '木耳', '香菇', '粉丝', '炒面', '炒饭', '米粉', '汤', '粥', '饭', '饺子',
  '包子', '饼', '红烧', '清蒸', '水煮', '干煸', '鱼香', '糖醋', '宫保', '麻辣',
  '酸辣', '家常', '凉拌', '爆炒', '炖', '焖', '煎', '烤', '煲', '烩',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  // 429 容忍：等 90s 重试同请求，最多 3 次；仍失败抛出限流信号（当前词不标记完成）
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (res.status === 429) {
        console.log('  429 限流，等 90s…')
        await sleep(90000)
        continue
      }
      if (!res.ok) return null
      return await res.json()
    } catch {
      await sleep(3000)
    }
  }
  throw new Error('THROTTLED')
}

const isPureChinese = (s) => /^[一-龥]{2,10}$/.test(s)
const BLOCKLIST = ['半成品', '冷冻', '速冻', '即食', '料理包', '预制']

async function main() {
  const db = existsSync(OUT_FILE)
    ? JSON.parse(readFileSync(OUT_FILE, 'utf8'))
    : { crawled_at: new Date().toISOString().slice(0, 10), foods: {}, done_tokens: [] }
  const save = () => writeFileSync(OUT_FILE, JSON.stringify(db, null, 1))
  console.log(`已有 ${Object.keys(db.foods).length} 条，已完成词 ${db.done_tokens.length}`)

  for (const token of TOKENS) {
    if (db.done_tokens.includes(token)) continue
    let throttled = false
    for (let page = 1; page <= MAX_PAGES && !throttled; page++) {
      await sleep(DELAY_MS)
      let search
      try {
        search = await getJson(`https://food.boohee.com/fb/v1/foods/search?q=${encodeURIComponent(token)}&page=${page}&order=asc`)
      } catch {
        throttled = true
        break
      }
      const foods = search?.foods ?? []
      if (foods.length === 0) break
      let newOnes = 0
      for (const f of foods) {
        if (!isPureChinese(f.name)) continue
        if (BLOCKLIST.some((b) => f.name.includes(b))) continue
        if (db.foods[f.name]) continue
        await sleep(DELAY_MS)
        let detail
        try {
          detail = await getJson(`https://food.boohee.com/fb/v1/foods/${f.code}`)
        } catch {
          throttled = true
          break
        }
        if (!detail?.code || detail.brand || detail.uploader) continue
        const cal = Number(detail.calory)
        const p = Number(detail.protein), fat = Number(detail.fat), carb = Number(detail.carbohydrate)
        if (![cal, p, fat, carb].every((v) => Number.isFinite(v))) continue
        if (cal < 5 || cal > 900) continue
        db.foods[f.name] = {
          name: detail.name, code: detail.code,
          calory: detail.calory, protein: detail.protein, fat: detail.fat, carbohydrate: detail.carbohydrate,
          natrium: detail.natrium, units: detail.units, health_light: detail.health_light,
          via: token, source_url: `https://food.boohee.com/fb/view_detail_${detail.code}`,
        }
        newOnes++
      }
      save()
      if (newOnes === 0 && page >= (search?.total_pages ?? 1)) break
      if (page >= (search?.total_pages ?? 1)) break
    }
    if (!throttled) {
      db.done_tokens.push(token)
      save()
      console.log(`【${token}】完成，累计 ${Object.keys(db.foods).length} 条`)
    } else {
      save()
      console.log(`⏸【${token}】因限流中止（未标记完成），下次重跑续采`)
      break
    }
  }
  save()
  console.log(`\n本次结束：共 ${Object.keys(db.foods).length} 条，完成词 ${db.done_tokens.length}/${TOKENS.length}`)
}

main()
