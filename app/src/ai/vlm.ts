import { getChatUrl } from './providers'
import { resolveEndpoint } from '../lib/native_http'
import { RECOGNITION_INSTRUCTIONS, USER_PROMPT } from './prompt'
import { MealRecognitionSchema, type MealRecognition } from './schema'

export interface RecognizeConfig {
  /** 预设 id；'mock' 为不联网的模拟模式 */
  presetId: string
  /** 接口根地址（到 /v1、/v4 这一级），运行时补 /chat/completions */
  baseUrl: string
  model: string
  apiKey: string
}

export interface TokenUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface RecognizeOutcome {
  result: MealRecognition
  raw: string
  usage?: TokenUsage
}

const MOCK_RESULT = {
  meal_type: 'lunch',
  items: [
    { name: '米饭', portion_desc: '约一碗 200g', portion_g: 200, confidence: 0.9 },
    { name: '番茄炒蛋', portion_desc: '约 150g', portion_g: 150, confidence: 0.75 },
    { name: '炸鸡腿', portion_desc: '1 个约 120g', portion_g: 120, confidence: 0.55 },
  ],
  notes: ['示例数据：Mock 模式固定返回，用于联调界面流程', '米饭按一碗 200g 估算'],
}

async function mockRecognize(): Promise<RecognizeOutcome> {
  await new Promise((r) => setTimeout(r, 800))
  return { result: MealRecognitionSchema.parse(MOCK_RESULT), raw: JSON.stringify(MOCK_RESULT, null, 2) }
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('回复中未找到 JSON 对象')
  return JSON.parse(text.slice(start, end + 1))
}

function parseResult(raw: string): MealRecognition {
  return MealRecognitionSchema.parse(extractJson(raw))
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  // 部分供应商/模型可能返回分段数组
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

async function callChat(
  cfg: RecognizeConfig,
  messages: unknown[],
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<{ content: string; usage?: TokenUsage }> {
  const res = await fetch(resolveEndpoint(getChatUrl(cfg.baseUrl)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, temperature: 0.2, max_tokens: maxTokens, messages }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`接口返回 HTTP ${res.status}：${text.slice(0, 300) || '(无响应体)'}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[]
    usage?: TokenUsage
  }
  const content = contentToText(data.choices?.[0]?.message?.content)
  if (!content.trim()) throw new Error('接口返回了空内容')
  return { content, usage: data.usage }
}

function buildMessages(dataUrl: string): unknown[] {
  // 视觉模型兼容性考虑：指令并入 user 消息，不依赖 system role 的支持度
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: `${RECOGNITION_INSTRUCTIONS}\n\n${USER_PROMPT}` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]
}

export async function recognizeMeal(
  dataUrl: string,
  cfg: RecognizeConfig,
  signal?: AbortSignal,
): Promise<RecognizeOutcome> {
  if (cfg.presetId === 'mock') return mockRecognize()

  const messages = buildMessages(dataUrl)
  const first = await callChat(cfg, messages, signal)
  try {
    return { result: parseResult(first.content), raw: first.content, usage: first.usage }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content: `上面的输出无法通过 JSON 校验（${reason}）。请重新输出：只输出一个符合指令中结构的 JSON 对象，不要包含任何解释或代码块标记。`,
      },
    ]
    const second = await callChat(cfg, retryMessages, signal)
    return { result: parseResult(second.content), raw: second.content, usage: second.usage }
  }
}

/** 连通性测试：发一条最小文本消息，验证 地址 + Key + 模型 三者是否可用 */
export async function testConnection(cfg: RecognizeConfig): Promise<{ ok: boolean; message: string }> {
  if (cfg.presetId === 'mock') return { ok: true, message: '模拟模式不联网，无需测试' }
  if (!cfg.baseUrl.trim()) return { ok: false, message: '✗ 请先填写接口地址' }
  if (!cfg.model.trim()) return { ok: false, message: '✗ 请先填写模型名' }
  try {
    const { content } = await callChat(
      cfg,
      [{ role: 'user', content: '连接测试。请只回复两个字：正常' }],
      undefined,
      16,
    )
    return { ok: true, message: `✓ 连接成功：模型 ${cfg.model} 已响应「${content.slice(0, 24)}」` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `✗ 连接失败：${msg}` }
  }
}
