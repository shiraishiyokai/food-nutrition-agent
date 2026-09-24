/** 供应商预设：只是"默认值模板"，接口地址 / 模型 / Key 全部允许用户改写（spec D4 用户自主）。
 *  开发期 baseUrl 用 Vite 代理相对路径绕浏览器 CORS；APK 原生请求（CapacitorHttp）可填任意 https 地址。 */
export interface ProviderPreset {
  id: string
  label: string
  /** 接口根地址（到 /v1、/v4 这一级），运行时补 /chat/completions 作为对话端点 */
  baseUrl: string
  defaultModel: string
  /** 对话/查询用文本模型（识别用视觉模型，对话用便宜的文本模型） */
  defaultChatModel: string
  /** 常用模型建议（输入框下拉提示，可自由填写） */
  modelSuggestions: string[]
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'mock',
    label: '模拟模式（不联网，界面联调用）',
    baseUrl: '',
    defaultModel: 'mock-meal',
    defaultChatModel: 'mock-meal',
    modelSuggestions: ['mock-meal'],
  },
  {
    id: 'zhipu',
    label: '智谱开放平台',
    baseUrl: '/ai/zhipu/api/paas/v4',
    defaultModel: 'glm-4v-flash',
    defaultChatModel: 'glm-4-flash',
    modelSuggestions: ['glm-4v-flash', 'glm-4v-plus', 'glm-4-flash'],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（OpenAI 兼容）',
    baseUrl: '/ai/dashscope/compatible-mode/v1',
    defaultModel: 'qwen-vl-plus',
    defaultChatModel: 'qwen-plus',
    modelSuggestions: ['qwen-vl-plus', 'qwen-vl-max'],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容接口）',
    baseUrl: 'https://',
    defaultModel: '',
    defaultChatModel: '',
    modelSuggestions: [],
  },
]

export function getPreset(id: string): ProviderPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]
}

/** 根地址 + /chat/completions = 对话端点 */
export function getChatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}
