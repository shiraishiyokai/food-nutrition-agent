// 一句话修正引擎（D4 对话为核心的第一块，M1 版）：用户用自然语言修改识别结果，
// 本地规则解析、零模型调用。支持：改名 / 改分量（克数·一半·倍数·碗份预设）/ 删除 / 补充 / 热量校准。
// 设计原则：只动能确定的东西——解析不了的句子原样报"没看懂"，不猜。
// 多轮对话编排（追问、上下文省略等）属 M3 对话层，这里先做单句指令。

import { z } from 'zod'
import type { MealRecognition, RecognitionItem } from '../ai/schema'
import { DISH_CATEGORIES } from '../ai/schema'
import { lookupDish, upsertCalibration } from './nutrition_db'

function asCategory(c: string | undefined): RecognitionItem['category'] {
  return (DISH_CATEGORIES as readonly string[]).includes(c ?? '') ? (c as RecognitionItem['category']) : '家常菜'
}

// ─── LLM 语义层操作协议（规则层解析不了时，由廉价文本模型产出结构化操作） ──

export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), match: z.string().min(1), new_name: z.string().min(1) }),
  z.object({ op: z.literal('portion'), match: z.string().min(1), grams: z.coerce.number().optional(), factor: z.coerce.number().optional() }),
  z.object({ op: z.literal('delete'), match: z.string().min(1) }),
  z.object({ op: z.literal('add'), name: z.string().min(1), grams: z.coerce.number().optional() }),
  z.object({ op: z.literal('calibrate'), match: z.string().min(1), kcal: z.coerce.number() }),
])
export const OpsSchema = z.object({ ops: z.array(OpSchema).default([]), reply: z.string().default('') })
export type Op = z.infer<typeof OpSchema>

/** LLM 解析回调：输入原句与当前条目，返回结构化操作（null = 未配置/失败） */
export type CorrectionLLM = (
  sentence: string,
  items: RecognitionItem[],
) => Promise<{ ops: Op[]; reply: string } | null>

const norm = (s: string) => s.replace(/[（）()\s·]/g, '').toLowerCase()

function findItem(items: RecognitionItem[], mention: string): RecognitionItem | null {
  const m = norm(mention)
  if (!m) return null
  // 名字最长优先（"番茄豆腐汤" 先于 "豆腐"）
  const sorted = [...items].sort((a, b) => norm(b.name).length - norm(a.name).length)
  return (
    sorted.find((it) => norm(it.name) === m) ??
    sorted.find((it) => norm(it.name).includes(m) || m.includes(norm(it.name))) ??
    null
  )
}

function findPresetGrams(item: RecognitionItem, unitWord: string): number | null {
  const match = lookupDish(item.name)
  const presets = match?.dish.portion_presets
  if (!presets) return null
  const key = Object.keys(presets).find((k) => k.includes(unitWord) || unitWord.includes(k))
  return key ? presets[key] : null
}

export interface CorrectionOutcome {
  result: MealRecognition
  logs: string[]
  changed: boolean
}

/** 解析并应用一句话修正；按 ；; \n 拆分多句，逐句执行。
 *  规则层先走（即时免费），解析失败且配置了 LLM 回调时交给语义层。 */
export async function applyCorrectionText(
  current: MealRecognition,
  text: string,
  llm?: CorrectionLLM,
): Promise<CorrectionOutcome> {
  const logs: string[] = []
  let result: MealRecognition = {
    ...current,
    items: current.items.map((it) => ({ ...it })),
  }
  let changed = false

  const sentences = text
    .split(/[；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const sentence of sentences) {
    const before = JSON.stringify(result.items)
    let log = applyOne(result, sentence)
    if (JSON.stringify(result.items) !== before) {
      changed = true
    } else if (log.startsWith('⚠') && llm) {
      // 规则层没看懂 → LLM 语义层兜底
      try {
        const parsed = await llm(sentence, result.items)
        if (parsed) {
          const applied = applyOps(result, parsed.ops)
          if (applied > 0) {
            changed = true
            log = parsed.reply || `已按语义执行 ${applied} 项修改`
          } else {
            log = parsed.reply || log
          }
        }
      } catch (err) {
        log = `⚠ 语义解析失败：${err instanceof Error ? err.message : String(err)}`
      }
    }
    logs.push(log)
  }

  return { result, logs, changed }
}

/** 执行 LLM 产出的操作序列（与规则层共用同一套变更逻辑），返回成功执行的条数 */
function applyOps(result: MealRecognition, ops: Op[]): number {
  let applied = 0
  for (const op of ops) {
    if (op.op === 'delete') {
      const item = findItem(result.items, op.match)
      if (item) {
        result.items = result.items.filter((it) => it !== item)
        applied++
      }
      continue
    }
    if (op.op === 'add') {
      const match = lookupDish(op.name)
      const portion = op.grams && op.grams > 0 ? Math.round(op.grams) : (match?.dish.typical_portion_g ?? 150)
      result.items.push({
        name: op.name,
        category: asCategory(match?.dish.category),
        portion_desc: `约${portion}g（补充）`,
        portion_g: portion,
        confidence: 0.6,
        confirmed: true,
      })
      applied++
      continue
    }
    const item = findItem(result.items, op.match)
    if (!item) continue
    if (op.op === 'rename') {
      item.name = op.new_name
      item.confidence = Math.max(item.confidence, 0.85)
      item.confirmed = true
      applied++
      continue
    }
    if (op.op === 'portion') {
      const base = item.portion_g ?? 0
      const g = op.grams != null && op.grams > 0 ? op.grams : base * (op.factor ?? 1)
      if (g > 0 && g <= 3000) {
        item.portion_g = Math.round(g * 10) / 10
        item.portion_desc = `约${Math.round(item.portion_g)}g（修正）`
        item.confirmed = true
        applied++
      }
      continue
    }
    if (op.op === 'calibrate') {
      const match = lookupDish(item.name)
      if (item.portion_g && match) {
        const per100 = Math.round((op.kcal / item.portion_g) * 100)
        upsertCalibration({ ...match.dish, per100g: { ...match.dish.per100g, calories: per100 } })
        item.confirmed = true
        applied++
      }
    }
  }
  return applied
}

function applyOne(result: MealRecognition, sentence: string): string {
  const s = norm(sentence)
  const raw = sentence

  // ── 删除：删掉X / 去掉X / 没有X / X不要了 ──
  const delMatch = s.match(/(?:删掉|去掉|移除|不要了?|没有)\s*(.+)/) ?? raw.match(/(.{1,20}?)(?:不要了)/)
  if (delMatch) {
    const item = findItem(result.items, delMatch[1])
    if (!item) return `⚠ 没找到「${delMatch[1]}」，无法删除`
    result.items = result.items.filter((it) => it !== item)
    return `已删除：${item.name}`
  }

  // ── 热量校准：X其实350卡 / X实际只有280大卡 → 写入个人校准库 ──
  const calMatch = s.match(/(.{1,20}?)(?:其实|实际)(?:只有|有|是)?\s*(\d+(?:\.\d+)?)\s*(?:大卡|千卡|卡)/)
  if (calMatch) {
    const item = findItem(result.items, calMatch[1])
    const kcal = Number(calMatch[2])
    if (!item) return `⚠ 没找到「${calMatch[1]}」，无法校准`
    if (!item.portion_g || item.portion_g <= 0) return `⚠「${item.name}」没有分量，先补分量再校准`
    const match = lookupDish(item.name)
    if (!match) return `⚠「${item.name}」不在库中，直接告诉我每100克多少卡更好`
    const per100 = Math.round((kcal / item.portion_g) * 100)
    upsertCalibration({ ...match.dish, per100g: { ...match.dish.per100g, calories: per100 } })
    item.confirmed = true
    return `已校准：${item.name} 按每100克 ${per100} kcal 计（个人校准，永久生效）`
  }

  // ── 改名：不是A是B / A改成B（B含克数则转改分量）/ A其实是B ──
  const renameNot = s.match(/(?:不是|不是用的是?)\s*(.{1,20}?)\s*是\s*(.+)/)
  const renameChange = s.match(/(.{1,20}?)改成(.+)/)
  const renameActually = s.match(/(.{1,20}?)其实是?(.+)/)
  if (renameNot || renameChange || renameActually) {
    const [wrongM, rightM] = renameNot
      ? [renameNot[1], renameNot[2]]
      : renameChange
        ? [renameChange[1], renameChange[2]]
        : [renameActually![1], renameActually![2]]
    // "改成 100克" 这类是改分量不是改名
    if (renameChange && /克|g$/i.test(norm(rightM))) {
      return applyPortionGrams(result, wrongM, rightM)
    }
    const item = findItem(result.items, wrongM)
    if (!item) return `⚠ 没找到「${wrongM}」，无法改名`
    const newName = rightM.trim()
    item.name = newName
    item.confirmed = true
    if (item.confidence < 1) item.confidence = 0.85
    return `已改名：${wrongM.trim()} → ${newName}（将按新菜名重新查库）`
  }

  // ── 分量：克数 ──
  const gramMatch = s.match(/(.{1,20}?)(?:分量)?(?:改成|改为|换成|只有|有|大概|约)?\s*(\d+(?:\.\d+)?)\s*(?:克|g)\b/i)
  if (gramMatch) return applyPortionGrams(result, gramMatch[1], gramMatch[2] + '克')

  // ── 分量：一半 / 两倍 ──
  const halfMatch = s.match(/(.{1,20}?)(?:只有|改成|吃)?(半个|半碗|半份|一半)/)
  if (halfMatch) {
    const item = findItem(result.items, halfMatch[1])
    if (!item) return `⚠ 没找到「${halfMatch[1]}」，无法改分量`
    const preset = findPresetGrams(item, halfMatch[2])
    const g = preset ?? Math.round((item.portion_g ?? 0) * 0.5)
    if (!g) return `⚠「${item.name}」没有当前分量基准，请直接说克数`
    item.portion_g = g
    item.portion_desc = `约${g}g（修正）`
    item.confirmed = true
    return `已改分量：${item.name} → ${g}g`
  }
  const doubleMatch = s.match(/(.{1,20}?)(两倍|双倍|翻倍)/)
  if (doubleMatch) {
    const item = findItem(result.items, doubleMatch[1])
    if (!item || !item.portion_g) return `⚠ 没找到「${doubleMatch[1]}」或没有分量基准`
    item.portion_g = item.portion_g * 2
    item.portion_desc = `约${item.portion_g}g（修正）`
    item.confirmed = true
    return `已改分量：${item.name} → ${item.portion_g}g`
  }

  // ── 补充：再加一份X / 添加X / 还有X ──
  const addMatch = s.match(/(?:再加|添加|加上|补充|还有)(?:一个|一份|一碗|一盘)?\s*(.+)/)
  if (addMatch) {
    const name = addMatch[1].trim()
    const match = lookupDish(name)
    const portion = match?.dish.typical_portion_g ?? 150
    const item: RecognitionItem = {
      name,
      category: asCategory(match?.dish.category),
      portion_desc: `约${portion}g（补充）`,
      portion_g: portion,
      confidence: 0.6,
      confirmed: true,
    }
    result.items.push(item)
    return `已补充：${name} 约${portion}g${match ? '' : '（库中暂无，待补库/校准）'}`
  }

  return `⚠ 没看懂「${raw}」。试试：米饭只有半碗 / 那个是鱼香肉丝 / 炸鸡腿删掉 / 再加一份青菜`
}

function applyPortionGrams(result: MealRecognition, mention: string, gramsText: string): string {
  const item = findItem(result.items, mention)
  const g = Number(gramsText.match(/(\d+(?:\.\d+)?)/)?.[1])
  if (!item) return `⚠ 没找到「${mention.trim()}」，无法改分量`
  if (!g || g <= 0 || g > 3000) return `⚠ 分量「${gramsText}」不合理`
  item.portion_g = g
  item.portion_desc = `约${g}g（修正）`
  item.confirmed = true
  return `已改分量：${item.name} → ${g}g`
}
