/** 本地聚合（spec 5.4：查询类问题只注入「档案 + 当日/本周聚合」，不喂原始记录） */
import type { MealRecord } from '../data/mealRepo'
import { localDateStr } from '../data/mealRepo'

export interface DayTotals {
  date: string
  mealCount: number
  calories: number
  proteinG: number
  fatG: number
  carbsG: number
}

/** 按日聚合，日期倒序（最新在前） */
export function aggregateByDay(meals: MealRecord[]): DayTotals[] {
  const map = new Map<string, DayTotals>()
  for (const m of meals) {
    const d = map.get(m.date) ?? { date: m.date, mealCount: 0, calories: 0, proteinG: 0, fatG: 0, carbsG: 0 }
    d.mealCount += 1
    d.calories += m.totals.calories || 0
    d.proteinG += m.totals.proteinG || 0
    d.fatG += m.totals.fatG || 0
    d.carbsG += m.totals.carbsG || 0
    map.set(m.date, d)
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
}

export interface TodaySummary extends DayTotals {
  /** 「午餐 721kcal(米饭/番茄炒蛋/炸鸡腿)」 */
  meals: string[]
}

export function aggregateToday(meals: MealRecord[]): TodaySummary {
  const today = localDateStr()
  const base: TodaySummary = { date: today, mealCount: 0, calories: 0, proteinG: 0, fatG: 0, carbsG: 0, meals: [] }
  for (const m of meals) {
    if (m.date !== today) continue
    base.mealCount += 1
    base.calories += m.totals.calories || 0
    base.proteinG += m.totals.proteinG || 0
    base.fatG += m.totals.fatG || 0
    base.carbsG += m.totals.carbsG || 0
    base.meals.push(`${m.mealType} ${m.totals.calories}kcal(${m.items.map((i) => i.name).join('/')})`)
  }
  return base
}

export function todayText(s: TodaySummary): string {
  if (s.mealCount === 0) return '今日还没有记录'
  return `今日已记 ${s.mealCount} 餐，共 ${Math.round(s.calories)} kcal（蛋白 ${Math.round(s.proteinG)}g / 脂肪 ${Math.round(s.fatG)}g / 碳水 ${Math.round(s.carbsG)}g）。明细：${s.meals.join('；')}`
}

export function weekText(days: DayTotals[]): string {
  const recent = days.slice(0, 7)
  if (recent.length === 0) return '近 7 天没有记录'
  return `近 ${recent.length} 天：${recent.map((d) => `${d.date.slice(5)} ${Math.round(d.calories)}kcal/${d.mealCount}餐`).join('，')}`
}
