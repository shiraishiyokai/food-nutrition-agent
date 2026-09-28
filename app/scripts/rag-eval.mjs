// RAG 召回评测（D19）：验证检索确定层（精确/别名/关键词）的召回。
// 用法：node scripts/rag-eval.mjs   → 逐用例 PASS/FAIL + 汇总命中率，exit 0/1
// 说明：向量层需 API Key，无法离线跑——本脚本覆盖标签场景主力（成分名是标准写法），
//       语义层的阈值调优留待真 Key 验收（设计文档 §4 有记录）。匹配逻辑与 lib/rag.ts 同口径。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const kb = JSON.parse(readFileSync(join(here, '../src/data/additives-kb.json'), 'utf8'))
const entries = kb.entries

const norm = (s) => s.replace(/[（）()[\]【】\s·、，,]/g, '').toLowerCase()
const bigrams = (s) => {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}
const dice = (a, b) => {
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}
const keywordScore = (query, e) => {
  const q = norm(query)
  let best = dice(q, norm(e.name))
  best = Math.max(best, dice(q, norm(e.category)))
  const boost = (n) => (n.length >= 2 && q.includes(n) ? 0.8 + 0.01 * Math.min(n.length, 15) : 0)
  best = Math.max(best, boost(norm(e.name)))
  for (const a of e.aliases) best = Math.max(best, boost(norm(a)))
  return best
}
const KEYWORD_MIN = 0.5

function retrieve(name) {
  const t = norm(name)
  const exact = entries.find((e) => norm(e.name) === t || e.aliases.some((a) => norm(a) === t))
  if (exact) return { entry: exact, tier: 'exact', score: 1 }
  let best = null
  for (const e of entries) {
    const s = keywordScore(name, e)
    if (!best || s > best.score) best = { e, score: s }
  }
  if (best && best.score >= KEYWORD_MIN) return { entry: best.e, tier: 'keyword', score: best.score }
  return { entry: null, tier: 'miss', score: best?.score ?? 0 }
}

// 用例：标准名全覆盖 + 全部别名 + 手写难例（括号备注/混入杂质词/口语别名）+ 必须失配的反例
const cases = []
for (const e of entries) {
  cases.push({ q: e.name, expect: e.id, tag: '标准名' })
  for (const a of e.aliases) cases.push({ q: a, expect: e.id, tag: '别名' })
}
const hard = [
  { q: '阿斯巴甜（含苯丙氨酸）', expect: 'aspartame', tag: '括号备注' },
  { q: '复配甜味剂（阿斯巴甜）', expect: 'aspartame', tag: '混入杂质词' },
  { q: '无糖可乐里的三氯蔗糖', expect: 'sucralose', tag: '句子式查询' },
  { q: '贻贝多糖胶', expect: null, tag: '反例：不存在的成分' },
  { q: '迷迭香提取物', expect: null, tag: '反例：未收录成分' },
  { q: '氟化钠', expect: null, tag: '反例：非食品成分' },
]
cases.push(...hard)

let pass = 0
const fails = []
for (const c of cases) {
  const r = retrieve(c.q)
  const got = r.entry?.id ?? null
  if (got === c.expect) pass++
  else fails.push({ q: c.q, expect: c.expect, got, tier: r.tier, score: r.score.toFixed(2) })
}
console.log(`用例 ${cases.length} | 通过 ${pass} | 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败明细:')
  for (const f of fails) console.log(`  ✗「${f.q}」期望 ${f.expect} 实得 ${f.got}（${f.tier} ${f.score}）`)
  process.exit(1)
}
console.log('✓ 全部通过')
