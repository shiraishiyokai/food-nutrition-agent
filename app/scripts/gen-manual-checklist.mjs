// 人工核对清单生成：重试轮仍失败的菜 → notes/boohee-manual-checklist.md
// 给用户在浏览器里人工核对；找到的菜把 view_detail_{code} 地址填回来即可入库。
// 用法：node scripts/gen-manual-checklist.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const retry = JSON.parse(readFileSync(join(here, 'boohee-retry-result.json'), 'utf8'))
const raw = JSON.parse(readFileSync(join(here, '../src/data/boohee-raw.json'), 'utf8'))
const refine = JSON.parse(readFileSync(join(here, 'boohee-refine-report.json'), 'utf8'))

const catOf = (q) => refine.candidates_by_q[q]?.cat ?? raw.items.find((i) => i.q === q)?.cat ?? '家常菜'

const failed = retry.failed.filter((q) => !retry.accepted.some((a) => a.q === q))
const enc = (s) => encodeURIComponent(s)

const rows = failed.map((q) => {
  const searchUrl = `https://food.boohee.com/fb/v1/foods/search?q=${enc(q)}`
  const baidu = `https://www.baidu.com/s?wd=${enc(q + ' 薄荷食物库 热量')}`
  return `| ${q} | ${catOf(q)} | [接口搜索](${searchUrl}) · [百度]( ${baidu}) | ←把 code 填这里 |`
})

const md = `# 薄荷食物库人工核对清单（${failed.length} 道）

自动采集已拉满，以下 ${failed.length} 道在薄荷库的通用条目里没找到与菜名完全一致的，需要人工确认：

**怎么核对**（薄荷网页版已下线，只能用它的数据接口，浏览器直接打开就行）：
1. 点「接口搜索」，浏览器会显示一段 JSON。看 \`foods\` 数组里每项的 \`"name"\`：
   - 找到与菜名相符的**通用家常菜**条目（跳过带空格的品牌货、跳过"皮/生/饭盒/冷冻"这类）
   - 复制那一项的 \`"code"\`（英文拼音或一串字母数字）
2. 把 code 填到表格最后一列发给我，我用接口拉完整数据入库（ code 可用 \`https://food.boohee.com/fb/v1/foods/{code}\` 验证）
3. 如果 JSON 里没有合适的（\`"total_pages":0\` 或全是品牌货），或不确定，填"无"或"?"——这类菜走类目估算或以后校准
4. 也可以在薄荷健康 App 里搜（数据同源），但 App 里拿不到 code，主要还是用上面的接口链接

| 菜名 | 类别 | 搜索入口 | 核对结果（code / 无 / ?） |
|---|---|---|---|
${rows.join('\n')}
`

writeFileSync(join(here, '../../notes/boohee-manual-checklist.md'), md)
console.log(`清单已生成：notes/boohee-manual-checklist.md（${failed.length} 道）`)
console.log(failed.join('、'))
