// 一句话修正的 LLM 语义层：规则层解析不了时，用廉价文本模型（GLM-4-Flash 免费档）
// 把用户原句转成结构化操作 JSON（OpSchema），由 correction.ts 的 applyOps 本地执行。
// 语义理解交给模型，数值与执行永远留在本地——与两段式架构同一哲学。

import { getChatUrl } from './providers'
import { resolveEndpoint } from '../lib/native_http'
import { OpsSchema, type Op } from '../lib/correction'
import { lookupDish, computeMeal } from '../lib/nutrition_db'
import { recognizeMeal } from './vlm'
import { aggregateByDay, aggregateToday, todayText, weekText } from '../lib/stats'
import { composeRecommendation, inferMealType, mainSlotsUsedToday, parseRecPreferences, perMealBudget, type RecMealType } from '../lib/recommend'
import { bmi as calcBmi, recommendEnergy, type Profile } from '../data/profileRepo'
import { localDateStr, type MealRecord } from '../data/mealRepo'
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
  /** 剩余额度计算用（mock 应答与工具返回） */
  targetKcal?: number | null
  eatenKcal?: number
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
  if (ctx.targetKcal != null) {
    const eaten = Math.round(ctx.eatenKcal ?? 0)
    const remain = Math.round(ctx.targetKcal - eaten)
    lines.push(
      remain >= 0
        ? `今日目标 ${ctx.targetKcal} kcal，已吃 ${eaten} kcal，还可吃约 ${remain} kcal。`
        : `今日目标 ${ctx.targetKcal} kcal，已吃 ${eaten} kcal，已超出约 ${-remain} kcal，下一餐清淡些。`,
    )
  }
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
      name: 'recommend_meal',
      description:
        '根据剩余热量额度与用户约束，从本地营养库组合一套餐食（默认荤素搭配、有菜有汤）并生成推荐卡片。用户问「吃什么好 / 晚饭吃点啥 / 推荐一餐」等推荐类问题时 MUST 调用',
      parameters: {
        type: 'object',
        properties: {
          mealType: { type: 'string', enum: ['早餐', '午餐', '晚餐', '加餐'], description: '本餐类型；用户没明说时按当前时段判断' },
          preferences: {
            type: 'string',
            description: '用户对本餐的饮食约束原话（如「不吃荤」「不吃碳水」「想吃两个素菜」「少喝点汤」），没有则传空',
          },
        },
        required: [] as string[],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_profile',
      description:
        '更新用户档案（体重/身高/年龄/性别/目标/每日热量目标/过敏忌口/偏好）。用户陈述或修改这些信息时 MUST 调用，只传本次要改的字段；更新成功以工具返回为准，MUST NOT 在未调用工具时声称已更新',
      parameters: {
        type: 'object',
        properties: {
          weightKg: { type: 'number', description: '体重 kg' },
          heightCm: { type: 'number', description: '身高 cm' },
          age: { type: 'integer', description: '年龄岁' },
          dailyCalorieTarget: { type: 'integer', description: '每日热量目标 kcal' },
          sex: { type: 'string', enum: ['男', '女'] },
          goal: { type: 'string', description: '目标：减脂/增肌/维持或自定义' },
          allergies: { type: 'string', description: '过敏/忌口，整体替换；需追加时包含原内容' },
          preference: { type: 'string', description: '偏好，整体替换；需追加时包含原内容' },
        },
        required: [] as string[],
      },
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
用户问「吃什么好 / 晚饭吃点啥 / 推荐一餐」这类推荐类问题时 MUST 调用 recommend_meal，把餐次和用户约束原话（如「不吃荤」「想吃两个素菜」）传入；依据工具返回的预算与菜品做一两句拟人化介绍，营养数值以卡片为准，不要自行另报数值。
用户陈述或修改身体指标/档案信息（体重、身高、年龄、性别、目标、热量目标、过敏忌口、偏好）时 MUST 调用 update_profile 落库；一句话报多个指标（如「175cm/75kg/30岁/男」）时一次性提取全部字段、只调一次；身体指标类问题直接依据 [档案] 与 BMI 回答。
凡涉及数量的问题 MUST 先调工具再回答，严禁凭空回答数值；工具没查到就直说没有记录。用户问还能吃多少/吃得够不够时，依据 query_today 返回的剩余额度与档案目标回答并给一句可执行建议。
用户提到过敏/忌口/目标等个人信息时，在回复末尾用一行确认。不得提供医疗诊断，涉及疾病建议就医。`

/** 识别卡片数据：recognize_meal 产出，UI 渲染为可编辑卡片；status=saved 后锁定 */
export interface CardData {
  result: MealRecognition
  /** 已压缩餐照 dataURL（与卡片同存，确认入库时直接写入记录）；推荐卡无照片传空串 */
  photoDataUrl: string
  status: 'pending' | 'saved'
  /** 对话/一句话修正日志 */
  corrLogs: string[]
  /** 推荐卡（recommend_meal 产出）：无餐照、默认不入库，用户点「记录这餐」才存 */
  kind?: 'rec'
  /** 再次随机的重放参数：同一约束重新组合（预算按最新档案与当日记录现算） */
  recParams?: { mealType: string; preferences: string }
}

/** 工具执行上下文：ChatPage 注入记录/图片/当前档案；onCard/onProfile 把结果同步给 UI */
export interface ToolCtx {
  meals: MealRecord[]
  /** 用户刚发送的餐照（dataURL，已压缩）；recognize_meal 一次性消费 */
  image?: string
  /** 识别模型配置（视觉模型），与对话文本模型分开 */
  vlmCfg?: { presetId: string; baseUrl: string; model: string; apiKey: string }
  /** 识别完成回调：UI 据此插入卡片消息 */
  onCard?: (card: CardData) => void
  /** 当前档案（update_profile 的合并基底） */
  profile?: Profile
  /** 档案更新回调：UI 刷新侧栏档案卡并持久化 */
  onProfile?: (p: Profile) => void
}

/** 工具执行器：模型只决定「调什么、传什么参」，数据计算全部本地（两段式同一哲学） */
async function executeTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<string> {
  let args: {
    days?: number
    name?: string
    mealType?: string
    preferences?: string
    weightKg?: number
    heightCm?: number
    age?: number
    dailyCalorieTarget?: number
    sex?: string
    goal?: string
    allergies?: string
    preference?: string
  } = {}
  try {
    args = JSON.parse(rawArgs || '{}') as typeof args
  } catch {
    // 参数不是合法 JSON 时按空参处理
  }
  switch (name) {
    case 'query_today': {
      const agg = aggregateToday(ctx.meals)
      const base = todayText(agg)
      const target = ctx.profile?.dailyCalorieTarget
      if (!target) return base
      const remain = Math.round(target - agg.calories)
      return `${base}\n今日热量目标 ${target} kcal，已吃约 ${Math.round(agg.calories)} kcal，${
        remain >= 0 ? `还可吃约 ${remain} kcal` : `已超出约 ${-remain} kcal`
      }`
    }
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
    case 'recommend_meal': {
      // 模型只传餐次+约束原话；预算、选菜、克数配平全部本地（D18 两段式同一哲学）
      const mealType: RecMealType = ['早餐', '午餐', '晚餐', '加餐'].includes(args.mealType ?? '')
        ? (args.mealType as RecMealType)
        : inferMealType('')
      const prefsRaw = String(args.preferences ?? '').slice(0, 120)
      const prefs = parseRecPreferences(prefsRaw)
      const agg = aggregateToday(ctx.meals)
      const slotsUsed = mainSlotsUsedToday(ctx.meals, localDateStr())
      const budget = perMealBudget(ctx.profile?.dailyCalorieTarget ?? null, agg.calories, slotsUsed, mealType)
      const comp = composeRecommendation(mealType, prefs, budget)
      ctx.onCard?.({
        result: comp.result,
        photoDataUrl: '',
        status: 'pending',
        corrLogs: [budget.note, ...comp.applied],
        kind: 'rec',
        recParams: { mealType, preferences: prefsRaw },
      })
      const names = comp.result.items.map((i) => i.name).join('、')
      return `推荐卡片已生成：${mealType}（本餐预算约 ${budget.budget} kcal）＝ ${names}。${budget.note}。请用一两句话介绍这套搭配的思路（荤素/汤的考虑、结合用户约束），并提醒用户：不满意点卡片上的「🎲 再次随机」，满意点「✓ 记录这餐」，默认不会自动记录；卡片上的数值不要复述。`
    }
    case 'update_profile': {
      const cur = ctx.profile
      if (!cur) return '错误：没有当前档案可更新。'
      const patch: Partial<Profile> = {}
      const applied: string[] = []
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const w = num(args.weightKg)
      if (w && w > 20 && w < 300) {
        patch.weightKg = w
        applied.push(`体重 ${w}kg`)
      }
      const h = num(args.heightCm)
      if (h && h > 100 && h < 250) {
        patch.heightCm = h
        applied.push(`身高 ${h}cm`)
      }
      const a = num(args.age)
      if (a && a > 5 && a < 100) {
        patch.age = a
        applied.push(`年龄 ${a}岁`)
      }
      const t = num(args.dailyCalorieTarget)
      if (t && t >= 800 && t <= 6000) {
        patch.dailyCalorieTarget = t
        applied.push(`每日热量目标 ${t} kcal`)
      }
      if (args.sex === '男' || args.sex === '女') {
        patch.sex = args.sex
        applied.push(`性别 ${args.sex}`)
      }
      if (typeof args.goal === 'string' && args.goal.trim()) {
        patch.goal = args.goal.trim().slice(0, 20)
        applied.push(`目标 ${patch.goal}`)
      }
      if (typeof args.allergies === 'string' && args.allergies.trim()) {
        patch.allergies = args.allergies.trim().slice(0, 100)
        applied.push(`过敏/忌口「${patch.allergies}」`)
      }
      if (typeof args.preference === 'string' && args.preference.trim()) {
        patch.preference = args.preference.trim().slice(0, 100)
        applied.push(`偏好「${patch.preference}」`)
      }
      if (applied.length === 0) {
        return '错误：没有合法可更新的字段（数值需在合理范围内）。请向用户说明需要正确的数值。'
      }
      const np: Profile = { ...cur, ...patch }
      // 选定/切换三大目标且本次未显式给热量目标 → 按公式自动填推荐（D17；只在 goal 变更时填，避免覆盖手改值）
      let recLine = ''
      const rec = recommendEnergy(np)
      if (rec && patch.goal && num(args.dailyCalorieTarget) == null) {
        if (np.goal === '减脂') {
          np.dailyCalorieTarget = rec.cut
          recLine = `；已按公式填入减脂推荐 ${rec.cut} kcal（BMR ${rec.bmr} × 1.375 轻活动 − 400）`
        } else if (np.goal === '增肌') {
          np.dailyCalorieTarget = rec.bulk
          recLine = `；已按公式填入增肌推荐 ${rec.bulk} kcal（BMR ${rec.bmr} × 1.375 + 300）`
        } else if (np.goal === '维持') {
          np.dailyCalorieTarget = rec.maintain
          recLine = `；已按公式填入维持推荐 ${rec.maintain} kcal（BMR ${rec.bmr} × 1.375 轻活动）`
        }
        if (recLine) applied.push(`每日热量目标 ${np.dailyCalorieTarget} kcal（公式推荐）`)
      }
      ctx.onProfile?.(np)
      const b = calcBmi(np)
      const agg = aggregateToday(ctx.meals)
      let remainLine = ''
      if (np.dailyCalorieTarget) {
        const remain = Math.round(np.dailyCalorieTarget - agg.calories)
        remainLine =
          remain >= 0
            ? `今日已吃约 ${Math.round(agg.calories)} kcal，还可吃约 ${remain} kcal。`
            : `今日已吃约 ${Math.round(agg.calories)} kcal，已超出约 ${-remain} kcal。`
      }
      return `档案已更新并同步到用户档案卡：${applied.join('、')}${b != null ? `（BMI ${b}）` : ''}。${recLine}${
        remainLine ? `\n${remainLine}` : ''
      }`
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
