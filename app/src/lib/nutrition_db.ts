import ingredientsRaw from '../data/ingredients.json'
import dishesRaw from '../data/dishes.json'
import dishesRefRaw from '../data/dishes-reference.json'
import type { MealRecognition } from '../ai/schema'

// ─── 数据类型 ───────────────────────────────────────────────

export interface Per100g {
  calories: number
  protein_g: number
  fat_g: number
  carbs_g: number
}

export interface Ingredient {
  id: string
  name: string
  per100g: Per100g
  source: 'usda-sr-legacy' | 'cfct-common' | 'none'
  ref: string
  note: string
}

export interface RecipeLine {
  ingredientId: string
  grams: number
}

interface DishRecord {
  id: string
  name: string
  aliases: string[]
  recipe: RecipeLine[]
  typical_portion_g: number
  portion_presets: Record<string, number>
  category: string
  note?: string
}

/** 直录轨菜品（薄荷食物库逐菜实拉值，见 scripts/fetch-boohee.mjs） */
interface ReferenceDishRecord {
  id: string
  name: string
  aliases: string[]
  category: string
  per100g: Per100g
  sodium_mg?: number
  fiber_g?: number
  typical_portion_g: number
  portion_presets: Record<string, number>
  source: 'boohee' | 'boohee-bulk'
  source_url: string
  review?: boolean
  note?: string
}

export type DishOrigin = DishNutrition['origin']

export interface DishNutrition {
  id: string
  name: string
  aliases: string[]
  per100g: Per100g
  typical_portion_g: number
  portion_presets: Record<string, number>
  category: string
  note?: string
  /** 数值来源：default=库内配方派生；reference=外部参考值直录；recipe_override=用户配方；calibration=用户直接校准 */
  origin: 'default' | 'reference' | 'recipe_override' | 'calibration'
  recipe: RecipeLine[]
  /** origin=reference 时的溯源链接 */
  source_url?: string
}

interface DbFiles {
  ingredients: Ingredient[]
}

interface DishDbFile {
  version: string
  dishes: DishRecord[]
}

interface DishRefDbFile {
  version: string
  dishes: ReferenceDishRecord[]
}

const INGREDIENT_DB = ingredientsRaw as DbFiles
const DISH_DB = dishesRaw as unknown as DishDbFile
const DISH_REF_DB = dishesRefRaw as unknown as DishRefDbFile

const INGREDIENT_BY_ID = new Map(INGREDIENT_DB.ingredients.map((i) => [i.id, i]))

// ─── 用户差异化数据（运行时；M3 起随档案持久化） ─────────────

/** 用户直接校准：告知实际热量/营养（"这个菜其实350大卡"）。
 *  持久化与薄荷缓存同模式（localStorage fna.calib.v1；原生端存 webview localStorage），
 *  档案/餐记录在原生走 SQLite，校准属营养库衍生数据，体积小、可重建，不再单独建表。 */
const userCalibrations = new Map<string, DishNutrition>()

const CALIB_KEY = 'fna.calib.v1'
try {
  for (const d of JSON.parse(localStorage.getItem(CALIB_KEY) ?? '[]') as DishNutrition[]) {
    if (d && d.id && d.name) userCalibrations.set(d.id, { ...d, origin: 'calibration' })
  }
} catch {
  // 校准存档损坏则按未校准处理，不阻断启动
}

export function upsertCalibration(dish: DishNutrition): void {
  userCalibrations.set(dish.id, { ...dish, origin: 'calibration' })
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify([...userCalibrations.values()]))
  } catch {
    // localStorage 不可用时仅影响持久化
  }
}

export function listCalibrations(): DishNutrition[] {
  return [...userCalibrations.values()]
}

/** 导入备份：整体替换校准并回写持久层 */
export function restoreCalibrations(list: DishNutrition[]): void {
  userCalibrations.clear()
  for (const d of list) {
    if (d && d.id && d.name) userCalibrations.set(d.id, { ...d, origin: 'calibration' })
  }
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify([...userCalibrations.values()]))
  } catch {
    // 同 upsertCalibration
  }
}

/** 用户配方覆盖：描述实际用料（"放了两克油两个蛋"）→ 数值重算 */
const userRecipeOverrides = new Map<string, RecipeLine[]>()

/** 薄荷科学 API 按需补库（D9）：本地未命中 → API 查询 → 永久缓存于此，优先级仅次于个人校准 */
const apiCached = new Map<string, DishNutrition>()

export function upsertApiDish(dish: DishNutrition): void {
  apiCached.set(dish.id, dish)
}

export function upsertRecipeOverride(dishId: string, lines: RecipeLine[]): void {
  userRecipeOverrides.set(dishId, lines)
}

export function listRecipeOverrides(): [string, RecipeLine[]][] {
  return [...userRecipeOverrides.entries()]
}

// ─── 配方派生（派生轨） ─────────────────────────────────────

/** 配方 → 每百克值：Σ(原料每百克×克数) ÷ 总克数 × 100；水计入总重（正确稀释） */
function derivePer100g(recipe: RecipeLine[]): { per100g: Per100g; totalGrams: number } {
  let cal = 0
  let p = 0
  let f = 0
  let c = 0
  let totalGrams = 0
  for (const line of recipe) {
    const ing = INGREDIENT_BY_ID.get(line.ingredientId)
    if (!ing) throw new Error(`配方引用了未知原料: ${line.ingredientId}`)
    const k = line.grams / 100
    cal += ing.per100g.calories * k
    p += ing.per100g.protein_g * k
    f += ing.per100g.fat_g * k
    c += ing.per100g.carbs_g * k
    totalGrams += line.grams
  }
  if (totalGrams <= 0) throw new Error('配方总重为 0')
  const r1 = (n: number) => Math.round(n * 10) / 10
  return {
    per100g: {
      calories: Math.round((cal / totalGrams) * 100),
      protein_g: r1((p / totalGrams) * 100),
      fat_g: r1((f / totalGrams) * 100),
      carbs_g: r1((c / totalGrams) * 100),
    },
    totalGrams,
  }
}

function buildDish(record: DishRecord, recipe: RecipeLine[], origin: DishNutrition['origin']): DishNutrition {
  const { per100g } = derivePer100g(recipe)
  return {
    id: record.id,
    name: record.name,
    aliases: record.aliases,
    per100g,
    typical_portion_g: record.typical_portion_g,
    portion_presets: record.portion_presets,
    category: record.category,
    note: record.note,
    origin,
    recipe,
  }
}

function buildReferenceDish(record: ReferenceDishRecord): DishNutrition {
  return {
    id: record.id,
    name: record.name,
    aliases: record.aliases,
    per100g: record.per100g,
    typical_portion_g: record.typical_portion_g,
    portion_presets: record.portion_presets,
    category: record.category,
    note: record.note ?? (record.review ? '采集时名称非精确匹配，建议复核' : undefined),
    origin: 'reference',
    recipe: [],
    source_url: record.source_url,
  }
}

/** 派生轨（配方假设） */
const DEFAULT_DISHES: DishNutrition[] = DISH_DB.dishes.map((d) => buildDish(d, d.recipe, 'default'))
/** 直录轨·精选（外部参考值，经人工核定/精确匹配）：查找顺序在派生轨之前 */
const REFERENCE_DISHES: DishNutrition[] = DISH_REF_DB.dishes.map(buildReferenceDish)

// ─── 类目兜底（D8）：未命中菜品按同类均值估算，明确标注、不冒充精确值 ──

interface CategoryMean {
  per100g: Per100g
  count: number
}

const CATEGORY_MEANS = (() => {
  const groups = new Map<string, { cal: number; p: number; f: number; c: number; n: number }>()
  for (const d of [...REFERENCE_DISHES, ...DEFAULT_DISHES]) {
    if (d.per100g.calories <= 0) continue
    let g = groups.get(d.category)
    if (!g) groups.set(d.category, (g = { cal: 0, p: 0, f: 0, c: 0, n: 0 }))
    g.cal += d.per100g.calories
    g.p += d.per100g.protein_g
    g.f += d.per100g.fat_g
    g.c += d.per100g.carbs_g
    g.n += 1
  }
  const means = new Map<string, CategoryMean>()
  for (const [cat, g] of groups) {
    means.set(cat, {
      per100g: {
        calories: Math.round(g.cal / g.n),
        protein_g: Math.round((g.p / g.n) * 10) / 10,
        fat_g: Math.round((g.f / g.n) * 10) / 10,
        carbs_g: Math.round((g.c / g.n) * 10) / 10,
      },
      count: g.n,
    })
  }
  return means
})()

export function categoryMean(category: string): CategoryMean | null {
  return CATEGORY_MEANS.get(category) ?? CATEGORY_MEANS.get('家常菜') ?? null
}

// ─── 查询 ───────────────────────────────────────────────────

export type MatchType = 'exact' | 'alias' | 'fuzzy'

export interface DishMatch {
  dish: DishNutrition
  matchType: MatchType
}

function normalize(s: string): string {
  return s.replace(/[（）()·\s]/g, '').toLowerCase()
}

function allDishes(): DishNutrition[] {
  return [...userCalibrations.values(), ...apiCached.values(), ...REFERENCE_DISHES, ...DEFAULT_DISHES]
}

/** 校准 > 直录参考值 > 配方派生 > 包含式模糊；全落空返回 null（触发类目兜底，禁止直接用模型估算） */
export function lookupDish(name: string): DishMatch | null {
  const target = normalize(name)
  if (!target) return null
  const dishes = allDishes()

  const hit = dishes.find((d) => normalize(d.name) === target)
  if (hit) return { dish: hit, matchType: 'exact' }

  const aliasHit = dishes.find((d) => d.aliases.some((a) => normalize(a) === target))
  if (aliasHit) return { dish: aliasHit, matchType: 'alias' }

  const fuzzy = dishes.find(
    (d) => target.includes(normalize(d.name)) || normalize(d.name).includes(target),
  )
  if (fuzzy) return { dish: fuzzy, matchType: 'fuzzy' }
  return null
}

export function getIngredient(id: string): Ingredient | undefined {
  return INGREDIENT_BY_ID.get(id)
}

// ─── 用餐计算 ───────────────────────────────────────────────

export interface ComputedItem {
  name: string
  portionG: number | null
  confidence: number
  match: DishMatch | null
  per100gUsed: Per100g | null
  recipe: RecipeLine[] | null
  /** 类目兜底估算信息；null=非兜底 */
  estimate: { category: string; basisCount: number } | null
  calories: number | null
  proteinG: number | null
  fatG: number | null
  carbsG: number | null
}

export interface ComputedMeal {
  items: ComputedItem[]
  totals: { calories: number; proteinG: number; fatG: number; carbsG: number }
  /** 完全无数值可依的条目（未命中且类目兜底也失效） */
  unmatchedNames: string[]
  /** 走类目兜底估算的条目名 */
  estimatedNames: string[]
}

/** 数值一律 = 库中每百克值 × 克数，代码计算（spec 5.2 第二段），模型输出不参与。
 *  未命中库的菜：有 category 时按类目均值兜底（estimate 标记，UI 明示），仍无则显示「—」。 */
export function computeMeal(recognition: MealRecognition): ComputedMeal {
  const items: ComputedItem[] = recognition.items.map((it) => {
    const match = lookupDish(it.name)
    const portionG = it.portion_g ?? match?.dish.typical_portion_g ?? null

    if (!match && portionG != null && portionG > 0) {
      const est = categoryMean(it.category)
      if (est) {
        const k = portionG / 100
        return {
          name: it.name,
          portionG,
          confidence: it.confidence,
          match: null,
          per100gUsed: est.per100g,
          recipe: null,
          estimate: { category: it.category, basisCount: est.count },
          calories: Math.round(est.per100g.calories * k),
          proteinG: Math.round(est.per100g.protein_g * k * 10) / 10,
          fatG: Math.round(est.per100g.fat_g * k * 10) / 10,
          carbsG: Math.round(est.per100g.carbs_g * k * 10) / 10,
        }
      }
    }

    if (!match || portionG == null || portionG <= 0) {
      return { name: it.name, portionG, confidence: it.confidence, match, per100gUsed: null, recipe: null, estimate: null, calories: null, proteinG: null, fatG: null, carbsG: null }
    }

    const per = match.dish.per100g
    const k = portionG / 100
    return {
      name: it.name,
      portionG,
      confidence: it.confidence,
      match,
      per100gUsed: per,
      recipe: match.dish.recipe,
      estimate: null,
      calories: Math.round(per.calories * k),
      proteinG: Math.round(per.protein_g * k * 10) / 10,
      fatG: Math.round(per.fat_g * k * 10) / 10,
      carbsG: Math.round(per.carbs_g * k * 10) / 10,
    }
  })

  const matched = items.filter((i) => i.calories != null)
  const totals = matched.reduce(
    (acc, i) => ({
      calories: acc.calories + (i.calories ?? 0),
      proteinG: acc.proteinG + (i.proteinG ?? 0),
      fatG: acc.fatG + (i.fatG ?? 0),
      carbsG: acc.carbsG + (i.carbsG ?? 0),
    }),
    { calories: 0, proteinG: 0, fatG: 0, carbsG: 0 },
  )

  return {
    items,
    totals,
    unmatchedNames: items.filter((i) => i.calories == null).map((i) => i.name),
    estimatedNames: items.filter((i) => i.estimate).map((i) => i.name),
  }
}
