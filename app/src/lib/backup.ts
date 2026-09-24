/** 备份与迁移（D14）：让用户自主换机——全部本地数据一键导出/导入。
 *  覆盖：设置（含/不含 Key 由用户勾选）、档案、餐记录（含/不含照片）、个人校准、薄荷补库缓存。
 *  脱敏规约：界面上 Key 只走密码框/勾选描述，永不明文展示；
 *  不含 Key 的备份导入时保留目标机已有 Key（空 Key 不覆盖）。
 *  web 端走浏览器下载；原生端写入缓存目录后调系统分享（微信传输助手/保存到文件）。 */
import { Capacitor } from '@capacitor/core'
import { loadSettings, saveSettings, type Settings } from './settings'
import { getProfileRepo, type Profile } from '../data/profileRepo'
import { getMealRepo, type MealRecord } from '../data/mealRepo'
import { listCalibrations, restoreCalibrations, type DishNutrition } from './nutrition_db'

const BOOHEE_CACHE_KEY = 'fna.boohee.cache.v1'

export interface BackupFile {
  app: 'shiliao'
  version: 1
  exportedAt: string
  /** includeKey=false 时 apiKey/booheeApiKey 置空导出 */
  settings: Settings
  profile: Profile | null
  meals: MealRecord[]
  calibrations: DishNutrition[]
  booheeCache: unknown[]
  photosIncluded: boolean
}

export async function buildBackup(includeKey: boolean, includePhotos: boolean): Promise<BackupFile> {
  const s = loadSettings()
  const settings: Settings = includeKey ? { ...s } : { ...s, apiKey: '', booheeApiKey: '' }
  const mealsRaw = await (await getMealRepo()).list()
  const meals = includePhotos ? mealsRaw : mealsRaw.map((m) => ({ ...m, photoDataUrl: '' }))
  let profile: Profile | null = null
  try {
    profile = await getProfileRepo().load()
  } catch {
    profile = null
  }
  let booheeCache: unknown[] = []
  try {
    booheeCache = JSON.parse(localStorage.getItem(BOOHEE_CACHE_KEY) ?? '[]') as unknown[]
  } catch {
    booheeCache = []
  }
  return {
    app: 'shiliao',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    profile,
    meals,
    calibrations: listCalibrations(),
    booheeCache,
    photosIncluded: includePhotos,
  }
}

export async function exportBackup(b: BackupFile): Promise<'shared' | 'downloaded'> {
  const json = JSON.stringify(b)
  const fname = `shiliao-backup-${b.exportedAt.slice(0, 10)}.json`
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    const res = await Filesystem.writeFile({
      path: fname,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    const { Share } = await import('@capacitor/share')
    await Share.share({ title: fname, url: res.uri })
    return 'shared'
  }
  const blob = new Blob([json], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fname
  a.click()
  URL.revokeObjectURL(a.href)
  return 'downloaded'
}

/** 解析 + 校验备份，返回确认用的摘要；此步不落盘，确认后才 applyBackup */
export function summarizeBackup(raw: string): { b: BackupFile; summary: string; hasKey: boolean } {
  const b = JSON.parse(raw) as BackupFile
  if (b.app !== 'shiliao' || b.version !== 1) throw new Error('不是食聊导出的备份文件')
  const hasKey = !!(b.settings?.apiKey || b.settings?.booheeApiKey)
  return {
    b,
    hasKey,
    summary: `供应商设置${hasKey ? '（含 Key）' : '（不含 Key）'} · 档案${b.profile ? '' : '无'} · 餐记录 ${
      b.meals?.length ?? 0
    } 条${b.photosIncluded ? '（含照片）' : '（无照片）'} · 校准 ${b.calibrations?.length ?? 0} 条 · 薄荷缓存 ${
      b.booheeCache?.length ?? 0
    } 条`,
  }
}

/** 应用备份（覆盖式迁移）。设置/档案/记录/校准/缓存全部替换；返回摘要文案 */
export async function applyBackup(b: BackupFile): Promise<string> {
  const cur = loadSettings()
  const merged: Settings = {
    ...cur,
    ...b.settings,
    apiKey: b.settings.apiKey || cur.apiKey,
    booheeApiKey: b.settings.booheeApiKey || cur.booheeApiKey,
  }
  saveSettings(merged)
  if (b.profile) await getProfileRepo().save({ ...b.profile })
  await (await getMealRepo()).replaceAll(b.meals ?? [])
  restoreCalibrations(b.calibrations ?? [])
  try {
    localStorage.setItem(BOOHEE_CACHE_KEY, JSON.stringify(b.booheeCache ?? []))
  } catch {
    // 缓存写失败不阻断迁移主体
  }
  return '导入完成'
}
