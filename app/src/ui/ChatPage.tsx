/** M3+对话化重构（spec 5.4 / F5 / 需求①③④）：对话是唯一主入口。
 *  发餐照 → 模型调 recognize_meal 工具 → 本地识别+查库 → 卡片消息 →
 *  卡片点改 / 对话一句话修正（规则层→语义层）/ 确认入库；纯文本走查询工具或 mock 模板。
 *  多会话：fna.chat.v2 { sessions, activeId }；布局：左侧会话栏可收起（手机抽屉）。 */
import { useEffect, useRef, useState } from 'react'
import { answerQuery, answerQueryTools, mockAnswer, type CardData, type ChatConfig, type QueryContext } from '../ai/chat'
import { recognizeMeal } from '../ai/vlm'
import { loadSettings } from '../lib/settings'
import { getPreset } from '../ai/providers'
import { computeMeal } from '../lib/nutrition_db'
import { applyCorrectionText } from '../lib/correction'
import { composeRecommendation, inferMealType, mainSlotsUsedToday, parseRecPreferences, perMealBudget, type RecMealType } from '../lib/recommend'
import { compressImage, makeSyntheticMealImage, type CompressedImage } from '../lib/image'
import { isNative } from '../data/sqlite'
import { getMealRepo, localDateStr, type MealRecord, type MealType } from '../data/mealRepo'
import { aggregateByDay, aggregateToday, todayText, weekText } from '../lib/stats'
import { getProfileRepo, profileText, bmi, bmiLabel, recommendEnergy, parseProfileUpdate, type Profile } from '../data/profileRepo'
import { MealCard } from './MealCard'

interface ChatMsg {
  role: 'user' | 'assistant' | 'card'
  content: string
  ts: number
  /** 用户消息附带餐照（缩略展示） */
  image?: string
  /** role=card 时的识别卡片数据 */
  card?: CardData
}

interface ChatSession {
  id: string
  title: string
  msgs: ChatMsg[]
}

interface ChatStore {
  sessions: ChatSession[]
  activeId: string
}

const CHAT_KEY = 'fna.chat.v2'

/** mock 模式的推荐意图识别（配置真模型时由模型自主调 recommend_meal 工具判断） */
const REC_INTENT_RE = /吃(什么|啥)|吃点(什么|啥)|推荐.{0,8}(餐|菜|吃)|安排.{0,4}(餐|饭|吃)|帮我想.{0,4}(吃|餐)|来.{0,3}(套|份).{0,3}(餐|菜|吃)/

function newSession(): ChatSession {
  return { id: crypto.randomUUID(), title: '新对话', msgs: [] }
}

function loadStore(): ChatStore {
  try {
    const v2 = JSON.parse(localStorage.getItem(CHAT_KEY) ?? 'null') as ChatStore | null
    if (v2?.sessions?.length) return v2
  } catch {
    /* 坏档回落 */
  }
  const se = newSession()
  return { sessions: [se], activeId: se.id }
}

export function ChatPage() {
  const [store, setStore] = useState<ChatStore>(loadStore)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [attach, setAttach] = useState<CompressedImage | null>(null)
  const [saving, setSaving] = useState(false)
  const [recMsg, setRecMsg] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const attachInputRef = useRef<HTMLInputElement | null>(null)
  const autotestRanRef = useRef(false)
  // 会话侧栏：桌面默认展开，手机（≤760px）默认收起为抽屉
  const [sideOpen, setSideOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches)

  const active = store.sessions.find((s) => s.id === store.activeId) ?? store.sessions[0]
  const settings = loadSettings()
  const modeLabel =
    settings.presetId === 'mock'
      ? '⚠ 模拟模式 · 本地模板应答（点此配置真模型）'
      : `${getPreset(settings.presetId).label} · ${settings.chatModel || settings.model}`

  useEffect(() => {
    void getProfileRepo().load().then(setProfile)
  }, [])

  useEffect(() => {
    localStorage.setItem(CHAT_KEY, JSON.stringify(store))
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [store])

  function patchActive(fn: (se: ChatSession) => ChatSession) {
    setStore((st) => ({
      ...st,
      sessions: st.sessions.map((se) => (se.id === st.activeId ? fn(se) : se)),
    }))
  }

  function addSession() {
    const se = newSession()
    setStore((st) => ({ sessions: [se, ...st.sessions], activeId: se.id }))
    setError('')
  }

  function delSession(id: string) {
    setStore((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id)
      if (sessions.length === 0) {
        const se = newSession()
        return { sessions: [se], activeId: se.id }
      }
      return { sessions, activeId: st.activeId === id ? sessions[0].id : st.activeId }
    })
  }

  async function saveProfile(p: Profile) {
    setProfile(p)
    await getProfileRepo().save(p)
  }

  /** P5：选目标模板后按公式自动填推荐热量（数据齐才填，绝不编造）；随时可手动改 */
  function applyGoal(goal: string) {
    if (!profile) return
    const next: Profile = { ...profile, goal }
    fillRec(next, goal)
    void saveProfile(next)
  }

  /** 身体数据改完后:目标已选则按新数据重算推荐,否则只提示 */
  function applyBody(field: 'age' | 'heightCm' | 'weightKg', raw: string) {
    if (!profile) return
    const next: Profile = { ...profile, [field]: numOrNull(raw) }
    fillRec(next, next.goal)
    void saveProfile(next)
  }

  /** 依据 goal 与身体数据填推荐;纯本地公式,不联网不编造 */
  function fillRec(next: Profile, goal: string) {
    const rec = recommendEnergy(next)
    if (rec && goal === '减脂') {
      next.dailyCalorieTarget = rec.cut
      setRecMsg(`已按公式填入减脂推荐 ${rec.cut} kcal（BMR ${rec.bmr} × 1.375 轻活动 − 400），可手动修改`)
    } else if (rec && goal === '增肌') {
      next.dailyCalorieTarget = rec.bulk
      setRecMsg(`已按公式填入增肌推荐 ${rec.bulk} kcal（BMR ${rec.bmr} × 1.375 + 300），可手动修改`)
    } else if (rec && goal === '维持') {
      next.dailyCalorieTarget = rec.maintain
      setRecMsg(`已按公式填入维持推荐 ${rec.maintain} kcal（BMR ${rec.bmr} × 1.375 轻活动）`)
    } else {
      setRecMsg(rec ? '' : '补全 性别/年龄/身高/体重 后，选目标会自动填入公式推荐热量')
    }
  }

  async function acceptAttach(file: File | null | undefined) {
    if (!file || !file.type.startsWith('image/')) return
    try {
      setAttach(await compressImage(file))
      setError('')
    } catch (e) {
      setError(`图片处理失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 推荐卡「再次随机」：同一约束重新组合；预算按最新档案与当日记录现算（D18） */
  async function rerollRec(idx: number, card: CardData) {
    if (!card.recParams) return
    try {
      const all = await (await getMealRepo()).list()
      const prof = profile ?? (await getProfileRepo().load())
      const mealType = (
        ['早餐', '午餐', '晚餐', '加餐'].includes(card.recParams.mealType) ? card.recParams.mealType : inferMealType('')
      ) as RecMealType
      const prefs = parseRecPreferences(card.recParams.preferences)
      const budget = perMealBudget(
        prof.dailyCalorieTarget ?? null,
        aggregateToday(all).calories,
        mainSlotsUsedToday(all, localDateStr()),
        mealType,
      )
      const comp = composeRecommendation(mealType, prefs, budget)
      updateCardAt(idx, { ...card, result: comp.result, corrLogs: [budget.note, ...comp.applied] })
    } catch (e) {
      setError(`重新推荐失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function pushAssistant(text: string) {
    patchActive((se) => ({ ...se, msgs: [...se.msgs, { role: 'assistant' as const, content: text, ts: Date.now() }] }))
  }

  function pushCard(card: CardData) {
    patchActive((se) => ({ ...se, msgs: [...se.msgs, { role: 'card' as const, content: '识别卡片', card, ts: Date.now() }] }))
  }

  function updateCardAt(idx: number, card: CardData) {
    patchActive((se) => ({ ...se, msgs: se.msgs.map((m, i) => (i === idx ? { ...m, card } : m)) }))
  }

  /** 确认入库：卡片当前状态写为 MealRecord（数值由 computeMeal 现算，两段式红线） */
  async function confirmSave(idx: number, card: CardData, mealType: MealType) {
    setSaving(true)
    try {
      const computed = computeMeal(card.result)
      const rec: MealRecord = {
        id: crypto.randomUUID(),
        date: localDateStr(),
        mealType,
        photoDataUrl: card.photoDataUrl,
        items: computed.items.map((c) => ({
          name: c.name,
          portionG: c.portionG,
          calories: c.calories,
          proteinG: c.proteinG,
          fatG: c.fatG,
          carbsG: c.carbsG,
          confidence: c.confidence,
          confirmed: true,
          estimate: c.estimate,
        })),
        totals: computed.totals,
        corrLogs: [...card.corrLogs],
        createdAt: Date.now(),
      }
      await (await getMealRepo()).add(rec)
      updateCardAt(idx, { ...card, status: 'saved' })
      pushAssistant(`已记录「${mealType}」 ${Math.round(rec.totals.calories)} kcal ✓（到「📒 记录」页查看）`)
    } catch (e) {
      setError(`入库失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  async function send() {
    const q = input.trim()
    const img = attach?.dataUrl ?? null
    if ((!q && !img) || busy || !active) return
    const s = loadSettings()
    const history = active.msgs
      .filter((m): m is ChatMsg & { role: 'user' | 'assistant' } => m.role !== 'card')
      .map(({ role, content }) => ({ role, content: content.replace(/\n🔧[^\n]*$/, '') }))
    patchActive((se) => ({
      ...se,
      title: se.msgs.length === 0 ? (q || '图片识别').slice(0, 12) : se.title,
      msgs: [...se.msgs, { role: 'user', content: q || '（发了一张餐食照片，请识别）', ts: Date.now(), image: img ?? undefined }],
    }))
    setInput('')
    setAttach(null)
    setBusy(true)
    setError('')
    try {
      const [all, prof] = await Promise.all([getMealRepo().then((r) => r.list()), getProfileRepo().load()])
      const profNow = profile ?? prof
      const ctx: QueryContext = {
        profile: profileText(profNow),
        today: todayText(aggregateToday(all)),
        week: weekText(aggregateByDay(all)),
        targetKcal: profNow.dailyCalorieTarget,
        eatenKcal: aggregateToday(all).calories,
      }

      // P5：档案类指令。配置了真模型时 MUST 交给模型走 update_profile 工具（统一 🔧 可见、可验证）；
      // 规则层只在 mock/无 Key 模式下兜底（此时没有模型可调），纯本地零成本
      const profUpd = q ? parseProfileUpdate(q) : null
      if (profUpd && !img && (s.presetId === 'mock' || !s.apiKey.trim())) {
        const np: Profile = { ...(profile ?? prof), ...profUpd.patch }
        // 目标为三大模板 → 按公式填推荐热量（与工具路径同一公式,见 D17）
        const rec = recommendEnergy(np)
        let recLine = ''
        if (rec && profUpd.patch.goal) {
          if (np.goal === '减脂') {
            np.dailyCalorieTarget = rec.cut
            recLine = `；已按公式填入减脂推荐 ${rec.cut} kcal`
          } else if (np.goal === '增肌') {
            np.dailyCalorieTarget = rec.bulk
            recLine = `；已按公式填入增肌推荐 ${rec.bulk} kcal`
          } else if (np.goal === '维持') {
            np.dailyCalorieTarget = rec.maintain
            recLine = `；已按公式填入维持推荐 ${rec.maintain} kcal`
          }
        }
        await saveProfile(np)
        const b = bmi(np)
        const eaten = Math.round(aggregateToday(all).calories)
        const remain = np.dailyCalorieTarget != null ? Math.round(np.dailyCalorieTarget - eaten) : null
        const remainLine = remain != null ? (remain >= 0 ? `今日已吃 ${eaten} kcal，还可吃约 ${remain} kcal。` : `今日已吃 ${eaten} kcal，已超出约 ${-remain} kcal。`) : ''
        pushAssistant(
          `已记入档案：${profUpd.desc}${recLine}${remainLine ? `\n${remainLine}` : ''}${
            b != null && profUpd.patch.weightKg != null ? `（BMI ${b}，${bmiLabel(b)}）` : ''
          }\n🔧 本地档案更新（模拟模式）`,
        )
        return
      }

      // 有待确认卡片且用户输入纯文本 → 先试卡片修正（规则层正则先行，失败走语义层，见 D10）。
      // 规则层纯本地零成本,mock 模式也可用,故放在 mock 分支之前
      const pendIdx = active.msgs.findIndex((m) => m.role === 'card' && m.card?.status === 'pending')
      if (pendIdx >= 0 && q && !img) {
        const cardMsg = active.msgs[pendIdx]
        const outcome = await applyCorrectionText(cardMsg.card!.result, q, async (sentence, items) => {
          const { parseCorrection } = await import('../ai/chat')
          return parseCorrection(sentence, items, {
            baseUrl: s.baseUrl.trim(),
            model: (s.chatModel || s.model).trim(),
            apiKey: s.apiKey.trim(),
          })
        })
        if (outcome.changed) {
          updateCardAt(pendIdx, { ...cardMsg.card!, result: outcome.result, corrLogs: [...outcome.logs, ...cardMsg.card!.corrLogs] })
          pushAssistant(outcome.logs.join('\n') || '已修改。')
          return
        }
        // 修正未命中 → 按普通查询继续
      }

      // Mock 预设：不联网。图片直接走 mock 识别出卡片；推荐问题走同一本地推荐引擎；其余文本走模板应答
      if (s.presetId === 'mock') {
        if (img) {
          await new Promise((r) => setTimeout(r, 400))
          const outcome = await recognizeMeal(img, { presetId: 'mock', baseUrl: '', model: 'mock-meal', apiKey: '' })
          pushCard({ result: outcome.result, photoDataUrl: img, status: 'pending', corrLogs: [] })
          pushAssistant('识别完成（模拟模式）：卡片在下面，可直接点改，或输入「米饭只有一半」这类话让我改；没问题点「✓ 确认记录」。')
        } else if (REC_INTENT_RE.test(q)) {
          const mealType = inferMealType(q)
          const prefs = parseRecPreferences(q)
          const budget = perMealBudget(
            ctx.targetKcal ?? null,
            ctx.eatenKcal ?? 0,
            mainSlotsUsedToday(all, localDateStr()),
            mealType,
          )
          const comp = composeRecommendation(mealType, prefs, budget)
          pushCard({
            result: comp.result,
            photoDataUrl: '',
            status: 'pending',
            corrLogs: [budget.note, ...comp.applied],
            kind: 'rec',
            recParams: { mealType, preferences: q.slice(0, 120) },
          })
          pushAssistant(`[Mock 应答] ${mealType}推荐来了（本餐约 ${budget.budget} kcal）：不满意点「🎲 再次随机」换一套，满意点「✓ 记录这餐」，默认不会自动记录。`)
        } else {
          await new Promise((r) => setTimeout(r, 300))
          pushAssistant(mockAnswer(q, ctx))
        }
        return
      }

      if (!s.apiKey.trim()) throw new Error('未配置 API Key（点上方模式徽标去设置）')
      const cfg: ChatConfig = { baseUrl: s.baseUrl, model: s.chatModel || s.model, apiKey: s.apiKey.trim() }
      const vlmCfg = { presetId: s.presetId, baseUrl: s.baseUrl.trim(), model: s.model.trim(), apiKey: s.apiKey.trim() }

      try {
        const r = await answerQueryTools(q || '请识别用户刚上传的餐食照片并生成卡片', ctx, history, cfg, {
          meals: all,
          image: img ?? undefined,
          vlmCfg,
          onCard: pushCard,
          profile: profile ?? prof,
          onProfile: (np) => void saveProfile(np),
        })
        const used = [...new Set(r.toolsUsed)]
        pushAssistant(used.length ? `${r.reply}\n🔧 ${used.join('、')}` : r.reply)
      } catch (toolErr) {
        // 供应商不支持 tools 或工具循环失败 → 回落注入式（识别类问题则直接报错提示）
        console.warn('function calling 回落注入式：', toolErr)
        if (img) throw toolErr
        pushAssistant(await answerQuery(q, ctx, history, cfg))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // autotest：?autotest=1 时用合成图走 mock 识别出卡片（不依赖任何配置）
  useEffect(() => {
    if (autotestRanRef.current) return
    if (new URLSearchParams(window.location.search).get('autotest') !== '1') return
    autotestRanRef.current = true
    void (async () => {
      try {
        const dataUrl = makeSyntheticMealImage()
        const outcome = await recognizeMeal(dataUrl, { presetId: 'mock', baseUrl: '', model: 'mock-meal', apiKey: '' })
        setStore((st) => {
          const se = st.sessions[0]
          return {
            ...st,
            activeId: se.id,
            sessions: [
              {
                ...se,
                title: se.msgs.length ? se.title : '自检识别',
                msgs: [
                  ...se.msgs,
                  { role: 'user' as const, content: '（发了一张餐食照片，请识别）', ts: Date.now(), image: dataUrl },
                  { role: 'card' as const, content: '识别卡片', ts: Date.now(), card: { result: outcome.result, photoDataUrl: dataUrl, status: 'pending' as const, corrLogs: [] } },
                ],
              },
              ...st.sessions.slice(1),
            ],
          }
        })
        document.title = 'AUTOTEST_PASS'
      } catch {
        document.title = 'AUTOTEST_FAIL'
      }
    })()
  }, [])

  const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v) || null)

  return (
    <div className="chat-shell">
      {sideOpen && <div className="side-overlay" onClick={() => setSideOpen(false)} />}
      <aside className={`chat-side${sideOpen ? ' open' : ''}`}>
        <div className="side-head">
          <span>对话历史</span>
          <button className="side-close" onClick={() => setSideOpen(false)}>
            ×
          </button>
        </div>
        <div className="side-sess">
          {store.sessions.map((se) => (
            <div
              key={se.id}
              className={`sess-item${se.id === store.activeId ? ' on' : ''}`}
              onClick={() => setStore((st) => ({ ...st, activeId: se.id }))}
            >
              <span className="sess-title">{se.title}</span>
              <i
                className="sess-del"
                onClick={(e) => {
                  e.stopPropagation()
                  delSession(se.id)
                }}
              >
                ×
              </i>
            </div>
          ))}
          <button className="side-new" onClick={addSession}>
            ＋ 新对话
          </button>
        </div>
        <details className="card profile-card">
          <summary>我的档案（注入对话）</summary>
          {profile && (
            <div className="profile-grid">
              <label>
                目标
                <select value={profile.goal} onChange={(e) => applyGoal(e.target.value)}>
                  <option value="">未设置</option>
                  <option>减脂</option>
                  <option>增肌</option>
                  <option>维持</option>
                </select>
              </label>
              <label>
                性别
                <select value={profile.sex ?? ''} onChange={(e) => { const next = { ...profile, sex: e.target.value as Profile['sex'] }; fillRec(next, next.goal); void saveProfile(next) }}>
                  <option value="">未设置</option>
                  <option>男</option>
                  <option>女</option>
                </select>
              </label>
              <label>
                年龄
                <input
                  type="number"
                  defaultValue={profile.age ?? ''}
                  key={`age-${profile.age ?? ''}`}
                  onBlur={(e) => applyBody('age', e.target.value)}
                />
              </label>
              <label>
                身高 cm
                <input
                  type="number"
                  defaultValue={profile.heightCm ?? ''}
                  key={`h-${profile.heightCm ?? ''}`}
                  onBlur={(e) => applyBody('heightCm', e.target.value)}
                />
              </label>
              <label>
                体重 kg
                <input
                  type="number"
                  defaultValue={profile.weightKg ?? ''}
                  key={`w-${profile.weightKg ?? ''}`}
                  onBlur={(e) => applyBody('weightKg', e.target.value)}
                />
              </label>
              <label>
                每日热量目标 kcal
                <input
                  type="number"
                  value={profile.dailyCalorieTarget ?? ''}
                  onChange={(e) => void saveProfile({ ...profile, dailyCalorieTarget: numOrNull(e.target.value) })}
                />
              </label>
              <label>
                过敏 / 忌口
                <input
                  value={profile.allergies}
                  placeholder="花生、乳糖不耐…"
                  onChange={(e) => void saveProfile({ ...profile, allergies: e.target.value })}
                />
              </label>
              <label>
                偏好
                <input
                  value={profile.preference}
                  placeholder="少油、不吃香菜…"
                  onChange={(e) => void saveProfile({ ...profile, preference: e.target.value })}
                />
              </label>
            </div>
          )}
          {(() => {
            if (!profile) return null
            const v = bmi(profile)
            return v != null ? <p className="bmi-line">BMI {v}（{bmiLabel(v)}，中国成人标准）</p> : null
          })()}
          {recMsg && <p className="rec-msg">{recMsg}</p>}
        </details>
      </aside>
      {/* 需求④ web 快捷入口：餐照文件可拖进对话区任意位置，与 Ctrl+V 粘贴同走 acceptAttach */}
      <div
        className="chat-main"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'))
          if (f) {
            e.preventDefault()
            void acceptAttach(f)
          }
        }}
      >
        <header className="chat-head">
          <button className="side-toggle" onClick={() => setSideOpen((v) => !v)} aria-label="切换会话栏">
            ☰
          </button>
          <button
            className="mode-badge"
            onClick={() => window.dispatchEvent(new CustomEvent('fna:goto', { detail: 'settings' }))}
          >
            {modeLabel}
          </button>
        </header>

        <section className="card chat-stream">
          {!active || active.msgs.length === 0 ? (
            <p className="hint">
              发一张餐照我来识别（📷 选择 / 拖入对话区 / Ctrl+V 粘贴均可），或问「今天吃了多少热量」「蛋白够了吗」「本周趋势怎么样」。
            </p>
          ) : (
            active.msgs.map((m, i) =>
              m.role === 'card' && m.card ? (
                <div key={i} className="bubble card-bubble">
                  <MealCard
                    card={m.card}
                    saving={saving}
                    onChange={(c) => updateCardAt(i, c)}
                    onSave={(mt) => void confirmSave(i, m.card!, mt)}
                    onReroll={m.card.kind === 'rec' ? () => void rerollRec(i, m.card!) : undefined}
                  />
                </div>
              ) : (
                <div key={i} className={`bubble ${m.role}`}>
                  {m.image && <img className="msg-img" src={m.image} alt="餐照" />}
                  {m.content}
                </div>
              ),
            )
          )}
          {busy && <div className="bubble assistant typing">…</div>}
          <div ref={bottomRef} />
        </section>

        {error && <p className="hint warn chat-error">⚠ {error}</p>}

        {attach && (
          <div className="attach-preview">
            <img src={attach.dataUrl} alt="待发送餐照" />
            <button onClick={() => setAttach(null)}>×</button>
          </div>
        )}

        <div className="chat-row">
          <button
            className="attach-btn"
            title={isNative() ? '拍照 / 相册' : '选择 / 拖拽 / Ctrl+V 粘贴餐照'}
            onClick={() => {
              if (isNative()) {
                void (async () => {
                  try {
                    const { Camera, CameraSource, CameraResultType } = await import('@capacitor/camera')
                    const photo = await Camera.getPhoto({
                      resultType: CameraResultType.DataUrl,
                      source: CameraSource.Prompt,
                      quality: 80,
                      width: 1024,
                    })
                    if (photo.dataUrl) setAttach({ dataUrl: photo.dataUrl, width: 1024, height: 1024, bytes: 0, originalBytes: 0 })
                  } catch {
                    /* 用户取消或插件缺失 */
                  }
                })()
              } else {
                attachInputRef.current?.click()
              }
            }}
          >
            📷
          </button>
          <input
            ref={attachInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void acceptAttach(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <input
            value={input}
            placeholder={attach ? '可写备注后发送，或直接发送识别' : '发餐照识别 / 问今天吃了什么 / 「米饭只有一半」改卡片'}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              // 需求④ web 快捷入口：Ctrl+V 直接粘贴餐照截图；纯文本粘贴不受影响
              const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith('image/'))
              if (f) {
                e.preventDefault()
                void acceptAttach(f)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send()
            }}
          />
          <button className="primary" disabled={busy || (!input.trim() && !attach)} onClick={() => void send()}>
            {busy ? '…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
