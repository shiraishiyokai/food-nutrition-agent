/** 餐食推荐引擎（D18）：纯本地组合，不联网、不让模型报数——
 *  菜品只能来自精选直录库（数值可溯源到薄荷等来源），克数按「本餐预算」现场配平；
 *  三餐占比红线：默认一天三餐，本餐预算 =（今日目标 − 已吃）÷ 剩余正餐数，
 *  早餐/午餐不会把剩余额度一次用完。模型只负责传餐次与约束原话并做拟人化叙述，
 *  卡片上的数字一律由 MealCard 的 computeMeal 现算（两段式同一哲学）。 */
import { listReferenceDishes, type DishNutrition } from './nutrition_db'
import type { MealRecognition, RecognitionItem } from '../ai/schema'

export type RecMealType = '早餐' | '午餐' | '晚餐' | '加餐'

const MEAL_TYPE_EN: Record<RecMealType, MealRecognition['meal_type']> = {
  早餐: 'breakfast',
  午餐: 'lunch',
  晚餐: 'dinner',
  加餐: 'snack',
}

// ─── 约束解析（规则层；解析不到的约束由模型在叙述里自行照顾） ──

export interface RecPreferences {
  noMeat: boolean
  noCarb: boolean
  noSoup: boolean
  /** 「想吃两个素菜」→ 2 */
  vegCount: number | null
}

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 }

export function parseRecPreferences(text: string): RecPreferences {
  const t = text ?? ''
  const vegM = t.match(/([一二两三四五\d])\s*个?\s*(?:素菜|青菜|蔬菜)/)
  return {
    noMeat: /不吃荤|不吃肉|吃素|素食|不要肉|没肉|无肉/.test(t),
    noCarb: /不吃碳水|不要碳水|不要主食|不吃主食|低碳/.test(t),
    noSoup: /少喝汤|不要汤|不喝汤|没有汤|别喝汤/.test(t),
    vegCount: vegM ? (CN_NUM[vegM[1]] ?? Number(vegM[1]) ?? null) : null,
  }
}

// ─── 餐次推断 ───────────────────────────────────────────────

export function defaultMealTypeByHour(d = new Date()): RecMealType {
  const h = d.getHours()
  if (h < 10) return '早餐'
  if (h < 14) return '午餐'
  if (h < 21) return '晚餐'
  return '加餐'
}

/** 从问句推断餐次：「晚饭吃点啥」→ 晚餐；推断不出按当前时段 */
export function inferMealType(text: string, d = new Date()): RecMealType {
  const t = text ?? ''
  if (/夜宵/.test(t)) return '加餐'
  if (/晚饭|晚餐|晚上吃/.test(t)) return '晚餐'
  if (/午饭|午餐|中午/.test(t)) return '午餐'
  if (/早饭|早餐|早上/.test(t)) return '早餐'
  if (/加餐|零食|下午茶/.test(t)) return '加餐'
  return defaultMealTypeByHour(d)
}

// ─── 每餐预算（D18 三餐占比） ───────────────────────────────

export interface RecBudget {
  budget: number
  note: string
  remainingSlots: number
}

/** 今日已占用的正餐数（加餐不占槽位）：推荐预算按「剩余正餐」均摊 */
export function mainSlotsUsedToday(meals: Array<{ date: string; mealType: string }>, today: string): number {
  return new Set(
    meals
      .filter((m) => m.date === today && ['早餐', '午餐', '晚餐'].includes(m.mealType))
      .map((m) => m.mealType),
  ).size
}

export function perMealBudget(
  target: number | null | undefined,
  eatenKcal: number,
  slotsUsed: number,
  mealType: RecMealType,
): RecBudget {
  const remainingSlots = Math.max(1, 3 - slotsUsed)
  if (!target || target <= 0) {
    const fallback = mealType === '早餐' ? 450 : mealType === '加餐' ? 200 : 650
    return {
      budget: fallback,
      remainingSlots,
      note: `未设每日热量目标，按常规${mealType}约 ${fallback} kcal 配平（在档案设定目标后自动改为按三餐占比计算）`,
    }
  }
  const remain = Math.max(0, Math.round(target - eatenKcal))
  const budget = Math.round(remain / remainingSlots)
  return {
    budget,
    remainingSlots,
    note: `本餐预算 ${budget} kcal＝今日目标 ${target} − 已吃 ${Math.round(eatenKcal)}，余 ${remain} ÷ 剩余 ${remainingSlots} 正餐（一天按三餐计）`,
  }
}

// ─── 菜品分类（启发式，仅用于挑选组合；数值不受影响） ───────

type Bucket = 'staple' | 'protein' | 'meat' | 'veg' | 'soup' | 'fruit'

const EXCLUDE_RE = /蛋糕|甜品|糕点|月饼|雪糕|冰淇淋|布丁|罐头|速食|半成品/
const SOUP_RE = /汤|羹$/
const STAPLE_RE = /饭$|炒饭|拌饭|面$|面条|炒面|拌面|米粉|米线|粥|馒头|包子|饺子|面包|吐司|意面|汉堡|三明治|饼$|薯/
const PROTEIN_RE = /鸡蛋|蛋羹|蒸蛋|水煮蛋|煎蛋|茶叶蛋|牛奶|酸奶|豆浆/
const MEAT_RE = /肉|排骨|鸡腿|鸡翅|鸡|鸭|鱼|虾|蟹|牛|羊|排$|肝|腊肠|火腿|培根|蛋/
/** 汤圆/汤圆类名字带「汤」但不是汤品 */
const FAKE_SOUP_RE = /汤圆/

function classify(d: DishNutrition): Bucket | null {
  const n = d.name
  if (EXCLUDE_RE.test(n)) return null
  if (FAKE_SOUP_RE.test(n)) return 'staple'
  if (d.category === '汤' || SOUP_RE.test(n)) return 'soup'
  if (d.category === '主食' || STAPLE_RE.test(n)) return 'staple'
  if (d.category === '水果') return 'fruit'
  if (d.category === '饮品') return null
  if (d.category === '蛋白类' || PROTEIN_RE.test(n)) return 'protein'
  if (MEAT_RE.test(n)) return 'meat'
  return 'veg'
}

/** 疑似含荤（名字没肉字但蛋白量露馅，如 麻辣香锅；肉夹馍这类带肉主食也算）。
 *  豆制品/菌菇蛋白高但属素，白名单放行。仅用于「不吃荤」约束过滤，不影响数值。 */
const VEG_OK_RE = /豆腐|豆皮|腐竹|豆干|豆浆|豆花|菇|菌|木耳|腐乳/
function isMeaty(d: DishNutrition): boolean {
  if (MEAT_RE.test(d.name)) return true
  return d.per100g.protein_g >= 9 && !VEG_OK_RE.test(d.name)
}

// ─── 组合 ───────────────────────────────────────────────────

interface Slot {
  bucket: Bucket
  label: string
}

function slotsFor(mealType: RecMealType, prefs: RecPreferences): { slots: Slot[]; applied: string[] } {
  let slots: Slot[]
  if (mealType === '加餐') {
    slots = [{ bucket: 'fruit', label: '水果' }]
  } else if (mealType === '早餐') {
    slots = [
      { bucket: 'staple', label: '主食' },
      { bucket: 'protein', label: '蛋白' },
      { bucket: 'fruit', label: '水果' },
    ]
  } else {
    slots = [
      { bucket: 'staple', label: '主食' },
      { bucket: 'meat', label: '荤菜' },
      { bucket: 'veg', label: '素菜' },
      { bucket: 'soup', label: '汤' },
    ]
  }
  const applied: string[] = []
  if (prefs.noCarb) {
    slots = slots.filter((s) => s.bucket !== 'staple')
    applied.push('已按要求去掉主食（不吃碳水）')
  }
  if (prefs.noSoup) {
    slots = slots.filter((s) => s.bucket !== 'soup')
    applied.push('已按要求去掉汤')
  }
  if (prefs.noMeat) {
    const hadMeat = slots.some((s) => s.bucket === 'meat')
    slots = slots.map((s) => (s.bucket === 'meat' ? { bucket: 'veg' as const, label: '素菜' } : s))
    if (hadMeat) applied.push('已按要求把荤菜换成素菜（不吃荤）')
  }
  if (prefs.vegCount && prefs.vegCount > 0) {
    slots = slots.filter((s) => s.bucket !== 'veg')
    for (let i = 0; i < Math.min(prefs.vegCount, 4); i++) slots.push({ bucket: 'veg', label: '素菜' })
    applied.push(`素菜 × ${prefs.vegCount}`)
  }
  return { slots, applied }
}

const round10 = (g: number) => Math.max(30, Math.round(g / 10) * 10)

export interface ComposedRec {
  result: MealRecognition
  applied: string[]
}

/** 组合一套餐食：随机选菜 → 按预算等比配平克数（0.6~1.4 倍、10g 步长）→ 仍超标先减汤 */
export function composeRecommendation(mealType: RecMealType, prefs: RecPreferences, budget: RecBudget): ComposedRec {
  const pool = new Map<Bucket, DishNutrition[]>()
  for (const d of listReferenceDishes()) {
    const b = classify(d)
    if (!b) continue
    if (!pool.has(b)) pool.set(b, [])
    pool.get(b)!.push(d)
  }
  const { slots, applied } = slotsFor(mealType, prefs)
  const used = new Set<string>()
  const picks: DishNutrition[] = []
  for (const s of slots) {
    const cands = (pool.get(s.bucket) ?? []).filter(
      (d) => !used.has(d.name) && (!prefs.noMeat || !isMeaty(d)),
    )
    if (cands.length === 0) continue
    const d = cands[Math.floor(Math.random() * cands.length)]
    picks.push(d)
    used.add(d.name)
  }
  if (picks.length === 0) {
    const any = (pool.get('veg') ?? pool.get('staple') ?? [])[0]
    if (any) picks.push(any)
  }
  let portions = picks.map((d) => round10(d.typical_portion_g || 100))
  const kcalAt = (gs: number[]) => gs.reduce((sum, g, i) => sum + (g * picks[i].per100g.calories) / 100, 0)
  if (kcalAt(portions) > 0) {
    const k = Math.min(1.4, Math.max(0.6, budget.budget / kcalAt(portions)))
    portions = portions.map((g) => round10(g * k))
  }
  if (kcalAt(portions) > budget.budget * 1.15 && picks.length > 2) {
    const soupIdx = picks.findIndex((d) => classify(d) === 'soup')
    if (soupIdx >= 0) {
      picks.splice(soupIdx, 1)
      portions.splice(soupIdx, 1)
      applied.push('为控制热量已减掉汤品')
      const k2 = Math.min(1.5, Math.max(0.6, budget.budget / kcalAt(portions)))
      portions = portions.map((g) => round10(g * k2))
    }
  }
  const items: RecognitionItem[] = picks.map((d, i) => ({
    name: d.name,
    category: d.category as RecognitionItem['category'],
    portion_desc: `约 ${portions[i]}g`,
    portion_g: portions[i],
    confidence: 1,
    confirmed: true,
  }))
  const result: MealRecognition = { meal_type: MEAL_TYPE_EN[mealType], items, notes: [] }
  return { result, applied }
}
