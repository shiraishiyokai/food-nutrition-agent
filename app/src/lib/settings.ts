import { PRESETS, getPreset } from '../ai/providers'

/** 用户可完全自定义的供应商配置：预设只负责填默认值，baseUrl/model/key 均可改写 */
export interface Settings {
  presetId: string
  /** 接口根地址（到 /v1、/v4 这一级），运行时补 /chat/completions */
  baseUrl: string
  model: string
  /** 对话/语义修正用的文本模型；空则回落到 model */
  chatModel: string
  apiKey: string
  /** 薄荷科学开放平台 API Key（ai.boohee.com，免费档；用于本地库未命中时按需补库） */
  booheeApiKey: string
}

const KEY = 'fna.settings.v2'
const LEGACY_KEY = 'fna.settings.v1'

export function defaultSettings(): Settings {
  const mock = getPreset('mock')
  return { presetId: mock.id, baseUrl: mock.baseUrl, model: mock.defaultModel, chatModel: mock.defaultChatModel, apiKey: '', booheeApiKey: '' }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<Settings>) }
    // v1 迁移：固定供应商列表 → 预设 + 可编辑地址（用户已有的 Key 全部保留）
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const v1 = JSON.parse(legacyRaw) as {
        providerId?: string
        model?: string
        apiKey?: string
        booheeApiKey?: string
      }
      const preset = getPreset(v1.providerId ?? 'mock')
      return {
        presetId: preset.id,
        baseUrl: preset.baseUrl,
        model: v1.model || preset.defaultModel,
        chatModel: v1.model || preset.defaultChatModel,
        apiKey: v1.apiKey ?? '',
        booheeApiKey: v1.booheeApiKey ?? '',
      }
    }
  } catch {
    // 存档损坏则回落默认
  }
  return defaultSettings()
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // localStorage 不可用时静默失败（如隐私模式），仅影响持久化
  }
}

export function presetOptions(): typeof PRESETS {
  return PRESETS
}
