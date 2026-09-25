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
  /** P5：性别（男/女，空=未设置）、身高 cm、年龄 —— BMI 与推荐热量的必要输入，缺任一不做推荐 */
  sex?: '' | '男' | '女'
  heightCm?: number | null
  age?: number | null
}

export const EMPTY_PROFILE: Profile = {
  goal: '',
  dailyCalorieTarget: null,
  allergies: '',
  preference: '',
  weightKg: null,
  sex: '',
  heightCm: null,
  age: null,
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
  if (p.sex) parts.push(`性别：${p.sex}`)
  if (p.age != null) parts.push(`年龄：${p.age}岁`)
  if (p.heightCm != null) parts.push(`身高：${p.heightCm}cm`)
  if (p.weightKg != null) parts.push(`体重：${p.weightKg}kg`)
  const b = bmi(p)
  if (b != null) parts.push(`BMI：${b}`)
  if (p.allergies) parts.push(`过敏/忌口：${p.allergies}`)
  if (p.preference) parts.push(`偏好：${p.preference}`)
  return parts.length ? parts.join('；') : '（用户尚未填写档案）'
}

/** BMI = 体重kg ÷ 身高m²；分类按中国成人标准（国家卫健委《肥胖症诊疗指南（2024年版）》） */
export function bmi(p: Profile): number | null {
  if (!p.weightKg || !p.heightCm) return null
  const h = p.heightCm / 100
  return Math.round((p.weightKg / (h * h)) * 10) / 10
}

export function bmiLabel(v: number): string {
  if (v < 18.5) return '体重过低'
  if (v < 24) return '正常'
  if (v < 28) return '超重'
  return '肥胖'
}

export interface EnergyRec {
  bmr: number
  maintain: number
  cut: number
  bulk: number
}

/** 推荐热量（P5，来源见 spec D17，不捏造）：
 *  BMR 用 Mifflin-St Jeor 公式（美国营养与饮食学会认证的标准预测公式，实测误差约 10%）；
 *  维持 = BMR × 1.375（轻身体活动系数，久坐 1.2/轻 1.375/中等 1.55）；
 *  减脂 = 维持 − 400、增肌 = 维持 + 300（通行建议区间 300~500 / 200~500 取中庸）。
 *  交叉验证：170cm/65kg/30岁男 ≈2155，对照中国营养学会《膳食指南2022》轻活动成年男 2250，偏差 4%。
 *  身体数据不齐返回 null —— 宁可不给推荐，绝不编数。 */
export function recommendEnergy(p: Profile): EnergyRec | null {
  if (!p.weightKg || !p.heightCm || !p.age || (p.sex !== '男' && p.sex !== '女')) return null
  const w = p.weightKg
  const h = p.heightCm
  const a = p.age
  const bmr = p.sex === '男' ? 10 * w + 6.25 * h - 5 * a + 5 : 10 * w + 6.25 * h - 5 * a - 161
  const maintain = Math.round((bmr * 1.375) / 10) * 10
  return { bmr: Math.round(bmr), maintain, cut: maintain - 400, bulk: maintain + 300 }
}

/** 对话改档案（P5）的规则层解析：只认窄模式，防误伤卡片修正（「这餐其实650卡」不含「目标」关键词，不会命中） */
export function parseProfileUpdate(sentence: string): { patch: Partial<Profile>; desc: string } | null {
  const patch: Partial<Profile> = {}
  const descs: string[] = []
  const w =
    sentence.match(/体重[^\d]{0,4}(\d{2,3}(?:\.\d)?)\s*(?:kg|公斤|千克)?/) ??
    sentence.match(/我(?:今天)?(?:体重)?\s*(\d{2,3}(?:\.\d)?)\s*(?:kg|公斤)(?:了)?/)
  if (w) {
    const v = Number(w[1])
    if (v > 20 && v < 300) {
      patch.weightKg = v
      descs.push(`体重 ${v}kg`)
    }
  }
  const h = sentence.match(/身高[^\d]{0,4}(1\d{2}(?:\.\d)?)\s*(?:cm|厘米)?/)
  if (h) {
    const v = Number(h[1])
    if (v > 100 && v < 250) {
      patch.heightCm = v
      descs.push(`身高 ${v}cm`)
    }
  }
  const a = sentence.match(/(?:年龄|岁数)[^\d]{0,3}(\d{1,2})/) ?? sentence.match(/我(?:今年)?\s*(\d{1,2})\s*岁/)
  if (a) {
    const v = Number(a[1])
    if (v > 5 && v < 100) {
      patch.age = v
      descs.push(`年龄 ${v}岁`)
    }
  }
  const t = sentence.match(/(?:每日)?(?:热量)?目标[^\d]{0,4}(?:改成|改为|调整?为|设为|设置成)?\s*(\d{3,4})\s*(?:大卡|千卡|卡)?/)
  if (t) {
    const v = Number(t[1])
    if (v >= 800 && v <= 6000) {
      patch.dailyCalorieTarget = v
      descs.push(`每日热量目标 ${v} kcal`)
    }
  }
  // 连报格式：「175cm/75kg/30岁/男」「175cm，75公斤，30岁，男」；已有字段不重复记
  const combo = sentence.match(
    /(\d{3}(?:\.\d)?)\s*(?:cm|厘米)\s*[/，,、]\s*(\d{2,3}(?:\.\d)?)\s*(?:kg|公斤|千克)\s*[/，,、]?\s*(?:(\d{1,2})\s*岁)?\s*[/，,、]?\s*(男|女)?/,
  )
  if (combo) {
    if (patch.heightCm == null) {
      const v = Number(combo[1])
      if (v > 100 && v < 250) {
        patch.heightCm = v
        descs.push(`身高 ${v}cm`)
      }
    }
    if (patch.weightKg == null) {
      const v = Number(combo[2])
      if (v > 20 && v < 300) {
        patch.weightKg = v
        descs.push(`体重 ${v}kg`)
      }
    }
    if (patch.age == null && combo[3]) {
      const v = Number(combo[3])
      if (v > 5 && v < 100) {
        patch.age = v
        descs.push(`年龄 ${v}岁`)
      }
    }
    if (!patch.sex && combo[4]) {
      patch.sex = combo[4] as Profile['sex']
      descs.push(`性别 ${combo[4]}`)
    }
  }
  if (descs.length === 0) return null
  return { patch, desc: descs.join('、') }
}
