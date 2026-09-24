// 一句话修正的 LLM 语义层：规则层解析不了时，用廉价文本模型（GLM-4-Flash 免费档）
// 把用户原句转成结构化操作 JSON（OpSchema），由 correction.ts 的 applyOps 本地执行。
// 语义理解交给模型，数值与执行永远留在本地——与两段式架构同一哲学。

import { getChatUrl } from './providers'
import { resolveEndpoint } from '../lib/native_http'
import { OpsSchema, type Op } from '../lib/correction'
import { lookupDish, computeMeal } from '../lib/nutrition_db'
import { recognizeMeal } from './vlm'
import { aggregateByDay, aggregateToday, todayText, weekText } from '../lib/stats'
import type { MealRecord } from '../data/mealRepo'
import type { RecognitionItem, MealRecognition } from '../ai/schema'

const SYSTEM_PROMPT = `你是饮食记录的修正解析器。给定当前识别条目和用户的一句话，把句子转换成要执行的操作 JSON。
只输出一个 JSON 对象，不要任何其他文字或 markdown 代码块标记。格式：
{"ops":[...],"reply":"给用户的一句话确认"}
可用操作（match 必须来自当前条目名，可部分匹配）：
{"op":"rename","match":"条目名","new_name":"正确菜名"}
{"op":"portion","match":"条目名","grams":120}
{"op":"portion","match":"条目名","factor":0.5}
{"op":"delete","match":"条目名"}
{"op":"add","name":"菜名","grams":150}
{"op":"calibrate","match":"条目名","kcal":350}
说明：grams=改成指定克数；factor=按比例改（0.5=一半，2=两倍，0.33=三分之一）；add 的克数未知就填 0；
calibrate 是用户说某菜"其实/实际只有 N 卡"。无法解析时 ops 给空数组，并在 reply 里礼貌说明。`

function buildUserPrompt(sentence: string, items: RecognitionItem[]): string {
  const lines = items.map(
    (it, i) => `${i + 1}. ${it.name}（${it.portion_g ? `${it.portion_g}g` : '分量未知'}）`,
  )
  return `当前条目：\n${lines.join('\n')}\n\n用户说：${sentence}`
}

function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON')
  return JSON.parse(stripped.slice(start, end + 1))
}

export interface ChatConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** 语义解析复用当前供应商配置（同一个 Key、同一个对话端点），不要求特定厂商 */
export async function parseCorrection(
  sentence: string,
  items: RecognitionItem[],
  cfg: ChatConfig,
): Promise<{ ops: Op[]; reply: string } | null> {
  const res = await fetch(resolveEndpoint(getChatUrl(cfg.baseUrl)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(sentence, items) },
      ],
      temperature: 0.1,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`GLM-4-Flash HTTP ${res.status}`)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = json.choices?.[0]?.message?.content ?? ''
  if (!content) return null
  const parsed = OpsSchema.safeParse(extractJson(content))
  if (!parsed.success) throw new Error('操作 JSON 校验失败')
  return parsed.data
}

// ---- M3 对话查询（spec 5.4：角色/档案/今日状态/规则 组装 system prompt）----

export interface QueryContext {
  profile: string
  today: string
  week: string
}

const QUERY_SYSTEM_PROMPT = `你是用户的私人营养助手。回答风格：简短、口语、不啰嗦，先给结论再给一句建议。
只能依据下面给你的档案与聚合数据回答数字，严禁编造数据里没有的数值。
用户提到过敏/忌口/目标等个人信息时，在回复末尾用一行确认（如「已记入档案：过敏花生」）。
不得提供医疗诊断或用药建议，涉及疾病话题建议就医。`

function buildQuerySystem(ctx: QueryContext): string {
  return `${QUERY_SYSTEM_PROMPT}\n\n[档案] ${ctx.profile}\n[今日状态] ${ctx.today}\n[本周概览] ${ctx.week}`
}

export async function answerQuery(
  question: string,
  ctx: QueryContext,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  cfg: ChatConfig,
): Promise<string> {
  const res = await fetch(resolveEndpoint(getChatUrl(cfg.baseUrl)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: buildQuerySystem(ctx) },
        ...history.slice(-6),
        { role: 'user', content: question },
      ],
      temperature: 0.4,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) throw new Error(`对话 HTTP ${res.status}`)
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('模型返回为空')
  return content
}

/** Mock 联调：不联网，用真实聚合数据生成模板回答（浏览器/模拟器无 Key 也能走通场景 3） */
export function mockAnswer(question: string, ctx: QueryContext): string {
  const hasCal = /卡|热量|kcal/i.test(question)
  const hasProtein = /蛋白|蛋白质/.test(question)
  const isWeek = /本周|这周|一周|7 ?天|趋势/.test(question)
  const lines: string[] = []
  if (isWeek) lines.push(`[Mock 应答] 本周概览：${ctx.week}。`)
  else lines.push(`[Mock 应答] ${ctx.today}。`)
  if (hasProtein && ctx.today !== '今日还没有记录') lines.push('按一般减脂目标，蛋白再补 20~30g 就很稳了。')
  else if (hasCal) lines.push('整体量级参考你档案里的目标来控制即可。')
  else lines.push('想查热量/蛋白直接问，比如「今天热量够吗」。')
  if (ctx.profile !== '（用户尚未填写档案）') lines.push(`（已结合档案：${ctx.profile}）`)
  else lines.push('提示：在上方「我的档案」里填目标/忌口，建议会更贴合你。')
  return lines.join('\n')
}

// ---- Function Calling（D15）：对话查询从「数据注入」升级为「模型自主调工具」----
// 工具按 OpenAI 兼容 tools 格式定义，智谱/百炼/自定义端点同一套代码；执行永远在本地。
// 失败时由 ChatPage 回落 answerQuery 注入式（降级路径，不锁死单一供应商）。

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type ToolMsg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_today',
      description: '查询用户今天已记录的餐次与营养聚合（总热量/蛋白/脂肪/碳水 + 每餐明细）',
      parameters: { type: 'object', properties: {}, required: [] as string[] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_week',
      description: '查询最近 N 天的按日营养聚合（每天 热量/餐数，默认 7 天，最多 30 天）',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '回看天数，默认 7' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recognize_meal',
      description: '识别用户刚上传的餐食照片，生成可编辑的识别卡片。用户发来餐照时 MUST 调用',
      parameters: { type: 'object', properties: {}, required: [] as string[] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_food',
      description: '按菜名查本地营养库：每百克热量/三大营养素、常见份量、数值来源',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '菜名，如 番茄炒蛋' } },
        required: ['name'],
      },
    },
  },
] as const

const TOOLS_SYSTEM_PROMPT = `你是用户的私人营养助手。回答风格：简短、口语，先给结论再给一句建议。
本地数据工具：今天吃了什么用 query_today；一段时间的趋势用 query_week；某道菜的营养用 lookup_food。
用户发来餐食照片时 MUST 调用 recognize_meal 识别并生成卡片；识别后等用户确认入库或提出修改，不要替用户决定是否记录。
凡涉及数量的问题 MUST 先调工具再回答，严禁凭空回答数值；工具没查到就直说没有记录。
用户提到过敏/忌口/目标等个人信息时，在回复末尾用一行确认。不得提供医疗诊断，涉及疾病建议就医。`

/** 识别卡片数据：recognize_meal 产出，UI 渲染为可编辑卡片；status=saved 后锁定 */
export interface CardData {
  result: MealRecognition
  /** 已压缩餐照 dataURL（与卡片同存，确认入库时直接写入记录） */
  photoDataUrl: string
  status: 'pending' | 'saved'
  /** 对话/一句话修正日志 */
  corrLogs: string[]
}

/** 工具执行上下文：ChatPage 注入记录与刚上传的图片；onCard 把识别卡片推给 UI 渲染 */
export interface ToolCtx {
  meals: MealRecord[]
  /** 用户刚发送的餐照（dataURL，已压缩）；recognize_meal 一次性消费 */
  image?: string
  /** 识别模型配置（视觉模型），与对话文本模型分开 */
  vlmCfg?: { presetId: string; baseUrl: string; model: string; apiKey: string }
  /** 识别完成回调：UI 据此插入卡片消息 */
  onCard?: (card: CardData) => void
}

/** 工具执行器：模型只决定「调什么、传什么参」，数据计算全部本地（两段式同一哲学） */
async function executeTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<string> {
  let args: { days?: number; name?: string } = {}
  try {
    args = JSON.parse(rawArgs || '{}') as typeof args
  } catch {
    // 参数不是合法 JSON 时按空参处理
  }
  switch (name) {
    case 'query_today':
      return todayText(aggregateToday(ctx.meals))
    case 'query_week': {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 30)
      return weekText(aggregateByDay(ctx.meals).slice(0, days))
    }
    case 'lookup_food': {
      const q = String(args.name ?? '').trim()
      if (!q) return '缺少菜名参数'
      const m = lookupDish(q)
      if (!m) return `本地营养库未命中「${q}」`
      return JSON.stringify({ 菜名: m.dish.name, 每百克: m.dish.per100g, 常见份量g: m.dish.typical_portion_g, 数值来源: m.dish.origin })
    }
    case 'recognize_meal': {
      if (!ctx.image) return '错误：本轮没有收到图片。请提示用户先上传餐食照片再识别。'
      if (!ctx.vlmCfg) return '错误：识别模型未配置，请提示用户到设置页填写。'
      const img = ctx.image
      ctx.image = undefined
      const c = ctx.vlmCfg
      const outcome = await recognizeMeal(img, {
        presetId: c.presetId,
        baseUrl: c.baseUrl,
        model: c.model,
        apiKey: c.apiKey,
      })
      ctx.onCard?.({ result: outcome.result, photoDataUrl: img, status: 'pending', corrLogs: [] })
      const meal = computeMeal(outcome.result)
      const names = meal.items.map((i) => i.name).join('、')
      return `识别完成，共 ${meal.items.length} 项（${names}），合计约 ${Math.round(meal.totals.calories)} kcal。识别卡片已展示给用户，请等待用户确认入库或提出修改，不要罗列完整营养明细。`
    }
    default:
      return `未知工具 ${name}`
  }
}

export interface ToolsAnswer {
  reply: string
  /** 实际发生的工具调用名（按顺序，可能重复）；空数组 = 模型未调工具直接回答 */
  toolsUsed: string[]
}

/** Function Calling 主循环：模型自主选工具 → 本地执行 → 结果回填 → 最多 3 轮收敛 */
export async function answerQueryTools(
  question: string,
  ctx: QueryContext,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  cfg: ChatConfig,
  toolCtx: ToolCtx,
): Promise<ToolsAnswer> {
  const messages: ToolMsg[] = [
    { role: 'system', content: `${TOOLS_SYSTEM_PROMPT}\n\n[档案] ${ctx.profile}` },
    ...history.slice(-6),
    { role: 'user', content: question },
  ]
  const toolsUsed: string[] = []
  for (let round = 0; round < 3; round++) {
    const res = await fetch(resolveEndpoint(getChatUrl(cfg.baseUrl)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, tools: TOOLS, temperature: 0.4, max_tokens: 500 }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`对话 HTTP ${res.status}`)
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>
    }
    const msg = json.choices?.[0]?.message
    const calls = msg?.tool_calls ?? []
    if (calls.length === 0) {
      const content = msg?.content ?? ''
      if (!content) throw new Error('模型返回为空')
      return { reply: content, toolsUsed }
    }
    // assistant 的 tool_calls 必须原样回传，工具结果以 role:tool + tool_call_id 对应
    messages.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls })
    for (const c of calls) {
      toolsUsed.push(c.function?.name ?? 'unknown')
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: await executeTool(c.function?.name ?? '', c.function?.arguments ?? '', toolCtx),
      })
    }
  }
  throw new Error('工具调用超过 3 轮未收敛，请换个问法')
}
