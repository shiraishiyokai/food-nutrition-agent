/** 健康档案（spec 5.4 / F4 / D2）：目标、忌口过敏、偏好、热量目标。
 *  与 MealRepo 同构：web dev 走 localStorage，原生走 SQLite profile 表（单行 JSON，spec 6.2）。
 *  身体数据/TDEE 计算（D2 P1）暂只留体重字段，后续加身高年龄活动量。 */
import { getSqlite, isNative } from './sqlite'

export interface Profile {
  /** 减脂 / 增肌 / 维持 / 自定义描述 */
  goal: string
  /** 每日热量目标 kcal（可空，空则不注入） */
  dailyCalorieTarget: number | null
  /** 过敏/忌口，自由文本 */
  allergies: string
  /** 偏好，自由文本（少油、不吃香菜…） */
  preference: string
  /** 体重 kg（可空；对话建议用） */
  weightKg: number | null
}

export const EMPTY_PROFILE: Profile = {
  goal: '',
  dailyCalorieTarget: null,
  allergies: '',
  preference: '',
  weightKg: null,
}

const LS_KEY = 'fna.profile.v1'
class LocalProfileRepo {
  async load(): Promise<Profile> {
    try {
      return { ...EMPTY_PROFILE, ...(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Profile) }
    } catch {
      return { ...EMPTY_PROFILE }
    }
  }

  async save(p: Profile): Promise<void> {
    localStorage.setItem(LS_KEY, JSON.stringify(p))
  }
}

class SqliteProfileRepo {
  async load(): Promise<Profile> {
    const { sq } = await getSqlite()
    const { values } = await sq.query({ database: 'fna.db', statement: 'SELECT json FROM profile WHERE id = 1', values: [] })
    const row = (values ?? [])[0] as { json: string } | undefined
    return row ? { ...EMPTY_PROFILE, ...(JSON.parse(row.json) as Profile) } : { ...EMPTY_PROFILE }
  }

  async save(p: Profile): Promise<void> {
    const { sq } = await getSqlite()
    await sq.run({
      database: 'fna.db',
      statement: 'INSERT OR REPLACE INTO profile (id, json, updated_at) VALUES (1, ?, ?)',
      values: [JSON.stringify(p), Date.now()],
    })
  }
}

export function getProfileRepo(): LocalProfileRepo | SqliteProfileRepo {
  return isNative() ? new SqliteProfileRepo() : new LocalProfileRepo()
}

/** 拼 system prompt 的 [档案] 段；空字段不输出 */
export function profileText(p: Profile): string {
  const parts: string[] = []
  if (p.goal) parts.push(`目标：${p.goal}`)
  if (p.dailyCalorieTarget != null) parts.push(`每日热量目标：${p.dailyCalorieTarget} kcal`)
  if (p.weightKg != null) parts.push(`体重：${p.weightKg}kg`)
  if (p.allergies) parts.push(`过敏/忌口：${p.allergies}`)
  if (p.preference) parts.push(`偏好：${p.preference}`)
  return parts.length ? parts.join('；') : '（用户尚未填写档案）'
}
