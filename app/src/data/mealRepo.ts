/** 数据层（spec 6.1 Repository 抽象，D3）：MealRepo 接口 + 双实现。
 *  纯浏览器（dev）走 localStorage；Capacitor 原生走 SQLite（@capacitor-sqlite 动态加载）。
 *  M2 规模下 meal_items 暂存于 raw_json 单表，接口不变，后续需要再拆表。 */
import { getSqlite, isNative } from './sqlite'

export type MealType = '早餐' | '午餐' | '晚餐' | '加餐'

export interface MealRecordItem {
  name: string
  portionG: number | null
  calories: number | null
  proteinG: number | null
  fatG: number | null
  carbsG: number | null
  confidence: number
  confirmed?: boolean
  estimate?: { category: string; basisCount: number } | null
}

export interface MealRecord {
  id: string
  /** 本地时区日期 YYYY-MM-DD */
  date: string
  mealType: MealType
  /** 识别用压缩图（640px JPEG dataURL），SQLite/web 均直接存 */
  photoDataUrl: string
  items: MealRecordItem[]
  totals: { calories: number; proteinG: number; fatG: number; carbsG: number }
  /** 一句话修正记录（M2「对话历史」的载体） */
  corrLogs: string[]
  createdAt: number
}

export interface MealRepo {
  list(): Promise<MealRecord[]>
  add(r: MealRecord): Promise<void>
  remove(id: string): Promise<void>
  /** 导入备份用：整体替换全部记录 */
  replaceAll(records: MealRecord[]): Promise<void>
}

export function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 按当前时间推断餐次（保存时可改） */
export function guessMealType(d = new Date()): MealType {
  const h = d.getHours()
  if (h < 10) return '早餐'
  if (h < 15) return '午餐'
  if (h < 21) return '晚餐'
  return '加餐'
}

const LS_KEY = 'fna.meals.v1'

class LocalMealRepo implements MealRepo {
  async list(): Promise<MealRecord[]> {
    try {
      const all = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as MealRecord[]
      return all.sort((a, b) => b.createdAt - a.createdAt)
    } catch {
      return []
    }
  }

  async add(r: MealRecord): Promise<void> {
    const all = await this.list()
    all.unshift(r)
    localStorage.setItem(LS_KEY, JSON.stringify(all))
  }

  async remove(id: string): Promise<void> {
    const all = await this.list()
    localStorage.setItem(LS_KEY, JSON.stringify(all.filter((m) => m.id !== id)))
  }

  async replaceAll(records: MealRecord[]): Promise<void> {
    localStorage.setItem(LS_KEY, JSON.stringify(records))
  }
}

class SqliteMealRepo implements MealRepo {
  async list(): Promise<MealRecord[]> {
    const { sq } = await getSqlite()
    const { values } = await sq.query({ database: 'fna.db', statement: 'SELECT raw_json FROM meals ORDER BY created_at DESC', values: [] })
    return ((values ?? []) as Array<{ raw_json: string }>).map((v) => JSON.parse(v.raw_json) as MealRecord)
  }

  async add(r: MealRecord): Promise<void> {
    const { sq } = await getSqlite()
    await sq.run({
      database: 'fna.db',
      statement: 'INSERT INTO meals (id, date, meal_type, photo, raw_json, created_at) VALUES (?,?,?,?,?,?)',
      values: [r.id, r.date, r.mealType, r.photoDataUrl, JSON.stringify(r), r.createdAt],
    })
  }

  async remove(id: string): Promise<void> {
    const { sq } = await getSqlite()
    await sq.run({ database: 'fna.db', statement: 'DELETE FROM meals WHERE id = ?', values: [id] })
  }

  async replaceAll(records: MealRecord[]): Promise<void> {
    const { sq } = await getSqlite()
    await sq.execute({ database: 'fna.db', statements: 'DELETE FROM meals' })
    for (const r of records) await this.add(r)
  }
}

export async function getMealRepo(): Promise<MealRepo> {
  return isNative() ? new SqliteMealRepo() : new LocalMealRepo()
}
