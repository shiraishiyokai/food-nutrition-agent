/** M3「能对话」（spec 5.4 / F5 / 场景 3）：对话查询页。
 *  上下文 = 档案 + 本地聚合（今日/近7天），不喂原始记录；Mock 预设走本地模板应答。
 *  多会话：fna.chat.v2 { sessions, activeId }，每会话独立历史，可新建/删除。 */
import { useEffect, useRef, useState } from 'react'
import { answerQuery, answerQueryTools, mockAnswer, type ChatConfig, type QueryContext } from '../ai/chat'
import { loadSettings } from '../lib/settings'
import { getPreset } from '../ai/providers'
import { getMealRepo } from '../data/mealRepo'
import { aggregateByDay, aggregateToday, todayText, weekText } from '../lib/stats'
import { getProfileRepo, profileText, type Profile } from '../data/profileRepo'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  ts: number
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
  const bottomRef = useRef<HTMLDivElement | null>(null)

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

  async function send() {
    const q = input.trim()
    if (!q || busy || !active) return
    const s = loadSettings()
    // 历史回传时剥掉工具使用徽标行（仅展示用，不进模型上下文）
    const history = active.msgs.map(({ role, content }) => ({ role, content: content.replace(/\n🔧[^\n]*$/, '') }))
    patchActive((se) => ({
      ...se,
      title: se.msgs.length === 0 ? q.slice(0, 12) : se.title,
      msgs: [...se.msgs, { role: 'user', content: q, ts: Date.now() }],
    }))
    setInput('')
    setBusy(true)
    setError('')
    try {
      const [all, prof] = await Promise.all([getMealRepo().then((r) => r.list()), getProfileRepo().load()])
      const ctx: QueryContext = {
        profile: profileText(profile ?? prof),
        today: todayText(aggregateToday(all)),
        week: weekText(aggregateByDay(all)),
      }
      let reply: string
      if (s.presetId === 'mock') {
        await new Promise((r) => setTimeout(r, 300))
        reply = mockAnswer(q, ctx)
      } else {
        if (!s.apiKey.trim()) throw new Error('未配置 API Key（点上方模式徽标去设置）')
        const cfg: ChatConfig = { baseUrl: s.baseUrl, model: s.chatModel || s.model, apiKey: s.apiKey.trim() }
        try {
          // Function Calling 优先：模型自主决定调 query_today / query_week / lookup_food
          const r = await answerQueryTools(q, ctx, history, cfg, all)
          const used = [...new Set(r.toolsUsed)]
          reply = used.length ? `${r.reply}\n🔧 ${used.join('、')}` : r.reply
        } catch (toolErr) {
          // 供应商不支持 tools 或工具循环失败 → 回落注入式（原 M3 路径）
          console.warn('function calling 回落注入式：', toolErr)
          reply = await answerQuery(q, ctx, history, cfg)
        }
      }
      patchActive((se) => ({ ...se, msgs: [...se.msgs, { role: 'assistant', content: reply, ts: Date.now() }] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v) || null)

  return (
    <div className="page">
      <header>
        <h1>💬 对话</h1>
        <button className="mode-badge" onClick={() => window.dispatchEvent(new CustomEvent('fna:goto', { detail: 'recognize' }))}>
          {modeLabel}
        </button>
      </header>

      <details className="card profile-card">
        <summary>我的档案（注入对话）</summary>
        {profile && (
          <div className="profile-grid">
            <label>
              目标
              <select value={profile.goal} onChange={(e) => void saveProfile({ ...profile, goal: e.target.value })}>
                <option value="">未设置</option>
                <option>减脂</option>
                <option>增肌</option>
                <option>维持</option>
              </select>
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
              体重 kg
              <input
                type="number"
                value={profile.weightKg ?? ''}
                onChange={(e) => void saveProfile({ ...profile, weightKg: numOrNull(e.target.value) })}
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
      </details>

      <div className="sess-row">
        {store.sessions.map((se) => (
          <span
            key={se.id}
            className={`sess-chip${se.id === store.activeId ? ' on' : ''}`}
            onClick={() => setStore((st) => ({ ...st, activeId: se.id }))}
          >
            {se.title}
            <i
              className="sess-del"
              onClick={(e) => {
                e.stopPropagation()
                delSession(se.id)
              }}
            >
              ×
            </i>
          </span>
        ))}
        <button className="sess-add" onClick={addSession}>
          ＋ 新对话
        </button>
      </div>

      <section className="card chat-stream">
        {!active || active.msgs.length === 0 ? (
          <p className="hint">问问看：「今天吃了多少热量」「蛋白够了吗」「本周趋势怎么样」。</p>
        ) : (
          active.msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))
        )}
        {busy && <div className="bubble assistant typing">…</div>}
        <div ref={bottomRef} />
      </section>

      {error && <p className="hint warn">⚠ {error}</p>}

      <div className="chat-row">
        <input
          value={input}
          placeholder="问我今天吃了什么 / 热量够不够…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <button className="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
          {busy ? '思考中…' : '发送'}
        </button>
      </div>
    </div>
  )
}
