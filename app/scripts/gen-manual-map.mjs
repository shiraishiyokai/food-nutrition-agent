// 人工核定映射生成：从我核定的（菜名→目标菜名）清单出发，到 refine 报告和主采集原始数据里
// 找 code，写出 boohee-manual-map.json（build-dishes-reference.mjs 消费，会再拉详情做品牌复核）。
// 用法：node scripts/gen-manual-map.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const raw = JSON.parse(readFileSync(join(here, '../src/data/boohee-raw.json'), 'utf8'))
const refine = JSON.parse(readFileSync(join(here, 'boohee-refine-report.json'), 'utf8'))

// 核定结果：q → 目标菜名（我逐条看过候选）
const DECISIONS = {
  // 来自 refine 候选（通用名精确候选）
  油焖大虾: '油焖大虾',
  香菇滑鸡: '香菇滑鸡',
  肉末茄子: '肉末茄子',
  地三鲜: '地三鲜',
  蚂蚁上树: '蚂蚁上树',
  香菇油菜: '蚝油香菇油菜',
  糖醋里脊: '糖醋里脊',
  煮玉米: '煮玉米',
  拍黄瓜: '拍黄瓜',
  口水鸡: '口水鸡',
  老醋花生: '老醋花生',
  鸡汤: '鸡汤',
  肠粉: '肠粉',
  蜜汁叉烧: '蜜汁叉烧',
  卤蛋: '卤蛋',
  咸鸭蛋: '咸鸭蛋(煮)',
  鹌鹑蛋: '鹌鹑蛋',
  酸奶: '酸奶',
  奶茶: '奶茶',
  // 来自主采集 review 匹配（菜名形态变体，语义等同）
  炸带鱼: '干炸带鱼',
  白切鸡: '白切鸡腿',
  粽子: '白粽子',
  拿铁咖啡: '冰拿铁咖啡',
}

const map = {}
const problems = []

for (const [q, target] of Object.entries(DECISIONS)) {
  // 先找 refine 候选
  const cands = refine.candidates_by_q[q]?.candidates ?? []
  let hit = cands.find((c) => c.name === target)
  // 再找主采集 review 匹配
  if (!hit) {
    const r = raw.items.find((it) => it.q === q && it.matched_name === target)
    if (r) hit = { code: r.code, name: r.matched_name }
  }
  if (hit) {
    map[q] = { code: hit.code, aliases: [] }
  } else {
    problems.push(`${q} → ${target}: 两处来源均未找到该 code`)
  }
}

writeFileSync(join(here, 'boohee-manual-map.json'), JSON.stringify(map, null, 2))
console.log(`核定映射 ${Object.keys(map).length} 条已写入 boohee-manual-map.json`)
if (problems.length) console.log('问题:\n' + problems.join('\n'))
