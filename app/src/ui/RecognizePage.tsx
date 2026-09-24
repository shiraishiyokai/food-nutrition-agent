import { useEffect, useMemo, useRef, useState } from 'react'
import { recognizeMeal, testConnection, type RecognizeConfig } from '../ai/vlm'
import { PRESETS, getPreset } from '../ai/providers'
import type { MealRecognition } from '../ai/schema'
import { compressImage, type CompressedImage } from '../lib/image'
import { readCache, writeCache } from '../lib/cache'
import { loadSettings, saveSettings, type Settings } from '../lib/settings'
import { computeMeal, upsertApiDish } from '../lib/nutrition_db'
import { applyCorrectionText } from '../lib/correction'
import {
  budgetInfo,
  enrichLookup,
  listCachedFoods,
  toDishNutrition,
} from '../lib/boohee_api'
import { ResultCard } from './ResultCard'
import { getMealRepo, guessMealType, localDateStr, type MealRecord, type MealType } from '../data/mealRepo'
import { applyBackup, buildBackup, exportBackup, summarizeBackup, type BackupFile } from '../lib/backup'

interface UsageInfo {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

type Status = 'idle' | 'busy' | 'done' | 'error'

function fmtKB(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function makeSyntheticMealImage(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 400
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#f5f0e6'
  ctx.fillRect(0, 0, 640, 400)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(320, 230, 170, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#e8e4d8'
  ctx.beginPath()
  ctx.arc(300, 200, 70, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#c8722f'
  ctx.beginPath()
  ctx.ellipse(410, 270, 55, 35, 0.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#333333'
  ctx.font = '24px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('测试图：米饭 + 炸鸡腿（Mock 联调用）', 320, 50)
  return canvas.toDataURL('image/jpeg', 0.85)
}

export function RecognizePage() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [comp, setComp] = useState<CompressedImage | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<MealRecognition | null>(null)
  // 两段式第二段：每次识别后现查营养库（库可更新/校准，故不缓存数值）
  // dbTick：薄荷 API 按需补库后递增，触发重算
  const [dbTick, setDbTick] = useState(0)
  const [booheeMsg, setBooheeMsg] = useState('')
  const [corrInput, setCorrInput] = useState('')
  const [corrLogs, setCorrLogs] = useState<string[]>([])
  const [corrBusy, setCorrBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const computed = useMemo(() => (result ? computeMeal(result) : null), [result, dbTick])
  const [raw, setRaw] = useState('')
  const [error, setError] = useState('')
  const [cacheHit, setCacheHit] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [mealType, setMealType] = useState<MealType>(guessMealType)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const repoRef = useRef<Awaited<ReturnType<typeof getMealRepo>> | null>(null)

  // 备份与迁移（D14）
  const [bkKey, setBkKey] = useState(true)
  const [bkPhotos, setBkPhotos] = useState(true)
  const [bkBusy, setBkBusy] = useState(false)
  const [bkMsg, setBkMsg] = useState('')
  const [pendingImport, setPendingImport] = useState<{ b: BackupFile; summary: string; hasKey: boolean } | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void getMealRepo().then((r) => {
      repoRef.current = r
    })
  }, [])

  /** M2「能记录」：把当前识别+修正结果按餐次存入本地库（浏览器 localStorage / 原生 SQLite） */
  async function handleSave() {
    if (!result || !computed || !comp) return
    const repo = repoRef.current ?? (await getMealRepo())
    repoRef.current = repo
    const rec: MealRecord = {
      id: crypto.randomUUID(),
      date: localDateStr(),
      mealType,
      photoDataUrl: comp.dataUrl,
      items: computed.items.map((c, i) => ({
        name: c.name,
        portionG: c.portionG,
        calories: c.calories,
        proteinG: c.proteinG,
        fatG: c.fatG,
        carbsG: c.carbsG,
        confidence: c.confidence,
        confirmed: result.items[i]?.confirmed,
        estimate: c.estimate,
      })),
      totals: computed.totals,
      corrLogs: [...corrLogs],
      createdAt: Date.now(),
    }
    setSaving(true)
    try {
      await repo.add(rec)
      setSaveMsg(`已存入「${rec.mealType}」· ${rec.totals.calories} kcal，到「记录」页查看`)
    } catch (e) {
      setSaveMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const autotestRanRef = useRef(false)

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 启动时：把薄荷 API 永久缓存播种进营养库（D9 按需补库层）
  useEffect(() => {
    for (const f of listCachedFoods()) upsertApiDish(toDishNutrition(f))
  }, [])

  // 按需补库：本地完全未命中的菜 → 薄荷官方 API 搜索（1 次调用）→ 永久缓存 → 重算
  useEffect(() => {
    if (!result) return
    if (!settings.booheeApiKey.trim()) return
    let cancelled = false
    void (async () => {
      const need = [...new Set(computeMeal(result).items.filter((i) => !i.match).map((i) => i.name))]
      if (need.length === 0) return
      let added = 0
      let failMsg = ''
      for (const n of need) {
        try {
          const f = await enrichLookup(n)
          if (f) {
            upsertApiDish(toDishNutrition(f))
            added++
          }
        } catch (err) {
          failMsg = err instanceof Error ? err.message : String(err)
          break
        }
      }
      if (cancelled) return
      const b = budgetInfo()
      if (failMsg) setBooheeMsg(`薄荷API：${failMsg}（今日已用 ${b.used}/${b.limit}）`)
      else if (added > 0) {
        setBooheeMsg(`薄荷API 补库 ${added} 项（今日剩 ${b.remaining}/${b.limit} 次，查到即永久缓存）`)
        setDbTick((t) => t + 1)
      } else {
        setBooheeMsg(`薄荷API 未命中本次缺失的菜（今日剩 ${b.remaining}/${b.limit} 次）`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [result])

  async function handleExport() {
    setBkBusy(true)
    setBkMsg('')
    try {
      const how = await exportBackup(await buildBackup(bkKey, bkPhotos))
      setBkMsg(
        how === 'shared'
          ? '备份已生成，请在系统分享面板里保存到文件或发送给自己'
          : `备份已下载（${bkKey ? '含 API Key，请妥善保管勿外发' : '不含 Key，导入时保留目标机已有 Key'}）`,
      )
    } catch (e) {
      setBkMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBkBusy(false)
    }
  }

  async function handleImportPicked(file: File | null | undefined) {
    if (!file) return
    setBkMsg('')
    try {
      setPendingImport(summarizeBackup(await file.text()))
    } catch (e) {
      setBkMsg(`导入失败：${e instanceof Error ? e.message : String(e)}（需要食聊导出的 JSON 备份）`)
    }
  }

  async function handleImportConfirm() {
    if (!pendingImport) return
    setBkBusy(true)
    try {
      await applyBackup(pendingImport.b)
      location.reload()
    } catch (e) {
      setBkMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`)
      setBkBusy(false)
    }
  }

  /** 切换预设 = 填入该预设的默认地址与模型（用户可随后自行改写） */
  function applyPreset(presetId: string) {
    const p = getPreset(presetId)
    setSettings((s) => ({ ...s, presetId: p.id, baseUrl: p.baseUrl, model: p.defaultModel, chatModel: p.defaultChatModel }))
    setTestMsg('')
  }

  async function handleTest() {
    setTesting(true)
    setTestMsg('')
    try {
      const r = await testConnection({
        presetId: settings.presetId,
        baseUrl: settings.baseUrl.trim(),
        model: settings.model.trim(),
        apiKey: settings.apiKey.trim(),
      })
      setTestMsg(r.message)
    } finally {
      setTesting(false)
    }
  }

  async function acceptFile(file: File | null | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件')
      setStatus('error')
      return
    }
    setError('')
    setStatus('idle')
    try {
      setComp(await compressImage(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void acceptFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // acceptFile 仅使用 setState，可安全绑定一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 返回 true = 得到结果（含缓存命中）；false = 出错或被取消。状态与错误信息均已写入 state */
  async function runRecognition(dataUrl: string, cfg: RecognizeConfig): Promise<boolean> {
    setStatus('busy')
    setError('')
    setResult(null)
    setCacheHit(false)
    setUsage(null)
    setElapsedMs(0)
    const controller = new AbortController()
    abortRef.current = controller
    const t0 = performance.now()
    try {
      const cfgKey = `${cfg.presetId}/${cfg.model}@${cfg.baseUrl}`
      const cached = await readCache(dataUrl, cfgKey)
      if (cached) {
        setResult(cached)
        setRaw('(24 小时缓存命中，未重新调用接口)')
        setCacheHit(true)
        setStatus('done')
        return true
      }
      const outcome = await recognizeMeal(dataUrl, cfg, controller.signal)
      setResult(outcome.result)
      setRaw(outcome.raw)
      setUsage(outcome.usage ?? null)
      await writeCache(dataUrl, cfgKey, outcome.result)
      setElapsedMs(Math.round(performance.now() - t0))
      setStatus('done')
      return true
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setStatus('idle')
        return false
      }
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
      return false
    } finally {
      abortRef.current = null
    }
  }

  async function handleRecognize() {
    if (!comp) return
    setMealType(guessMealType())
    setSaveMsg('')
    const cfg: RecognizeConfig = {
      presetId: settings.presetId,
      baseUrl: settings.baseUrl.trim(),
      model: settings.model.trim(),
      apiKey: settings.apiKey.trim(),
    }
    if (settings.presetId !== 'mock' && (!cfg.baseUrl || !cfg.model)) {
      setError('请先在设置中填写接口地址与模型名')
      setStatus('error')
      return
    }
    if (settings.presetId !== 'mock' && !cfg.apiKey) {
      setError('请先在上方设置中填写 API Key')
      setStatus('error')
      return
    }
    await runRecognition(comp.dataUrl, cfg)
  }

  /** 一句话修正（D4 对话为核心）：规则层即时解析；失败时复用当前供应商配置做语义解析（结构化操作，本地执行）。
   *  识别结果变化会自动触发薄荷 API 按需补库。 */
  async function handleCorrect() {
    if (!result || !corrInput.trim()) return
    const apiKey = settings.apiKey.trim()
    const chatModel = (settings.chatModel || settings.model).trim()
    const llm =
      settings.presetId !== 'mock' && apiKey && settings.baseUrl.trim() && chatModel
        ? async (sentence: string, items: import('../ai/schema').RecognitionItem[]) => {
            const { parseCorrection } = await import('../ai/chat')
            return parseCorrection(sentence, items, {
              baseUrl: settings.baseUrl.trim(),
              model: chatModel,
              apiKey,
            })
          }
        : undefined
    setCorrBusy(true)
    try {
      const outcome = await applyCorrectionText(result, corrInput.trim(), llm)
      if (outcome.changed) setResult(outcome.result)
      setCorrLogs((l) => [...outcome.logs, ...l].slice(0, 6))
      setCorrInput('')
    } finally {
      setCorrBusy(false)
    }
  }

  useEffect(() => {
    if (autotestRanRef.current) return
    if (new URLSearchParams(window.location.search).get('autotest') !== '1') return
    autotestRanRef.current = true
    void (async () => {
      try {
        const dataUrl = makeSyntheticMealImage()
        setComp({ dataUrl, width: 640, height: 400, bytes: 0, originalBytes: 0 })
        const ok = await runRecognition(dataUrl, {
          presetId: 'mock',
          baseUrl: '',
          model: 'mock-meal',
          apiKey: '',
        })
        const w = window as unknown as { __fnaAutotest?: unknown }
        if (ok) {
          document.title = 'AUTOTEST_PASS'
          w.__fnaAutotest = { ok: true }
        } else {
          document.title = 'AUTOTEST_FAIL'
          w.__fnaAutotest = { ok: false }
        }
      } catch (err) {
        document.title = 'AUTOTEST_FAIL'
        ;(window as unknown as { __fnaAutotest?: unknown }).__fnaAutotest = { ok: false, error: String(err) }
      }
    })()
  }, [])

  return (
    <div className="page">
      <header>
        <div className="head-row">
          <h1>🍱 食聊</h1>
          <button className="gear" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? '收起设置 ▲' : '⚙ 设置'}
          </button>
        </div>
        <p className="sub">
          拍照识别 · 记录 · 对话查询（当前：{settings.presetId === 'mock' ? '模拟模式' : getPreset(settings.presetId).label}）
        </p>
      </header>

      {showSettings && (
      <section className="card">
        <div className="row">
          <label>供应商预设</label>
          <select value={settings.presetId} onChange={(e) => applyPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {settings.presetId !== 'mock' && (
          <>
            <div className="row">
              <label>接口地址</label>
              <input
                value={settings.baseUrl}
                placeholder="https://你的域名/v1（运行时补 /chat/completions）"
                onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
              />
            </div>
            <div className="row">
              <label>模型</label>
              <input
                value={settings.model}
                list="model-suggestions"
                placeholder="模型名（可用建议或自由填写）"
                onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
              />
              <datalist id="model-suggestions">
                {getPreset(settings.presetId).modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="row">
              <label>API Key</label>
              <input
                type="password"
                value={settings.apiKey}
                placeholder="sk-xxxx / s-xxxx（在供应商控制台获取）"
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
              />
            </div>
            <div className="row">
              <label>对话模型</label>
              <input
                value={settings.chatModel}
                list="chat-model-suggestions"
                placeholder="对话/语义修正用文本模型（如 glm-4-flash，比视觉模型便宜）"
                onChange={(e) => setSettings((s) => ({ ...s, chatModel: e.target.value }))}
              />
              <datalist id="chat-model-suggestions">
                {getPreset(settings.presetId)
                  .modelSuggestions.filter((m) => !m.includes('-4v'))
                  .map((m) => (
                    <option key={m} value={m} />
                  ))}
              </datalist>
            </div>
            <div className="row">
              <label></label>
              <button disabled={testing} onClick={() => void handleTest()}>
                {testing ? '测试中…' : '测试连通性'}
              </button>
              {testMsg && <span className="hint">{testMsg}</span>}
            </div>
          </>
        )}
        <div className="row">
          <label>薄荷 API Key</label>
          <input
            type="password"
            value={settings.booheeApiKey}
            placeholder="薄荷科学 ai.boohee.com（可选；识别出错菜时按需补营养库）"
            onChange={(e) => setSettings((s) => ({ ...s, booheeApiKey: e.target.value }))}
          />
        </div>
        <div className="backup-box">
          <h3>备份与迁移</h3>
          <label className="check">
            <input type="checkbox" checked={bkKey} onChange={(e) => setBkKey(e.target.checked)} />
            <span>包含 API Key（换机完整迁移用；备份文件含明文 Key，请勿外发）</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={bkPhotos} onChange={(e) => setBkPhotos(e.target.checked)} />
            <span>包含餐照（体积大；不勾则只迁移数值记录）</span>
          </label>
          <div className="actions">
            <button disabled={bkBusy} onClick={() => void handleExport()}>
              导出备份
            </button>
            <button disabled={bkBusy} onClick={() => importInputRef.current?.click()}>
              导入备份
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                void handleImportPicked(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>
          {bkMsg && <p className="hint">{bkMsg}</p>}
          {pendingImport && (
            <div className="askback">
              <p>将导入：{pendingImport.summary}</p>
              <p>⚠ 覆盖本机现有全部数据{pendingImport.hasKey ? '' : '，且保留本机已有 Key'}。确定？</p>
              <div className="actions">
                <button className="primary" disabled={bkBusy} onClick={() => void handleImportConfirm()}>
                  确认导入
                </button>
                <button onClick={() => setPendingImport(null)}>取消</button>
              </div>
            </div>
          )}
        </div>
        <p className="hint">
          设置自动保存在本机浏览器（localStorage），Key 仅用于本机调用。预设只是默认值，地址/模型/Key 均可改写；
          开发期走本地代理绕 CORS，自定义 https 地址若被浏览器拦截，打包 APK 后原生请求不受限。
        </p>
      </section>
      )}

      <section className="card">
        <h2>照片</h2>
        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            void acceptFile(e.dataTransfer.files?.[0])
          }}
        >
          {comp ? (
            <img src={comp.dataUrl} alt="待识别餐食" />
          ) : (
            <p>点击选择 / 拖拽 / Ctrl+V 粘贴 餐食照片</p>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void acceptFile(e.target.files?.[0])}
        />
        {comp && (
          <p className="hint">
            压缩：{fmtKB(comp.originalBytes)} → {fmtKB(comp.bytes)}（{comp.width}×{comp.height}，JPEG）
          </p>
        )}
        <div className="actions">
          <button className="primary" disabled={!comp || status === 'busy'} onClick={() => void handleRecognize()}>
            {status === 'busy' ? '识别中…' : '开始识别'}
          </button>
          {status === 'busy' && <button onClick={() => abortRef.current?.abort()}>取消</button>}
        </div>
        {settings.presetId !== 'mock' && (
          <p className="hint warn">⚠ 点击识别后，照片将发送至所选供应商的服务器进行识别。</p>
        )}
      </section>

      {error && (
        <section className="card error-card">
          <h2>出错了</h2>
          <pre className="error-text">{error}</pre>
          <p className="hint">HTTP 4xx 请检查 Key 与模型名；JSON 校验两次失败请稍后重试。</p>
        </section>
      )}

      {result && (
        <section className="card">
          <div className="meta-line">
            {cacheHit && <span className="badge cache">24h 缓存命中</span>}
            {elapsedMs > 0 && <span className="meta">耗时 {elapsedMs} ms</span>}
            {usage?.total_tokens != null && (
              <span className="meta">
                tokens {usage.prompt_tokens ?? '?'}/{usage.completion_tokens ?? '?'}/{usage.total_tokens}
              </span>
            )}
          </div>
          <ResultCard result={result} computed={computed!} />
          {booheeMsg && <p className="hint">{booheeMsg}</p>}
          {/* F3 低置信度反问：不确定的项主动澄清，回答走下方一句话修正（改完自动标已确认并从横幅消失） */}
          {(() => {
            const uncertain = computed!.items.filter((c, idx) => c.confidence < 0.6 && !result.items[idx]?.confirmed)
            if (uncertain.length === 0) return null
            return (
              <div className="askback">
                <p>
                  🤔 这 {uncertain.length} 项我没太大把握，帮我看下对不对：
                </p>
                <ul>
                  {uncertain.map((c, i) => (
                    <li key={i}>
                      「{c.name}」约 {c.portionG ?? '?'}g —— 品名和分量对吗？
                    </li>
                  ))}
                </ul>
                <p className="hint">不对就在下方直接说（「不是A是B」「只有一半」）；没问题的项保存后照样计入。</p>
              </div>
            )
          })()}
          <div className="corr-row">
            <input
              value={corrInput}
              placeholder="一句话修改：那个是鱼香肉丝 / 米饭只有半碗 / 炸鸡腿删掉 / 再加一份青菜 / 这餐其实650卡"
              onChange={(e) => setCorrInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCorrect()
              }}
            />
            <button disabled={corrBusy} onClick={() => void handleCorrect()}>{corrBusy ? '解析中…' : '修改'}</button>
          </div>
          {corrLogs.length > 0 && (
            <ul className="corr-logs">
              {corrLogs.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          <div className="save-row">
            <select value={mealType} onChange={(e) => setMealType(e.target.value as MealType)}>
              {(['早餐', '午餐', '晚餐', '加餐'] as MealType[]).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <button className="primary" disabled={saving} onClick={() => void handleSave()}>
              {saving ? '保存中…' : '保存这餐'}
            </button>
            {saveMsg && <span className="save-msg">{saveMsg}</span>}
          </div>
          <details>
            <summary>原始返回 JSON</summary>
            <pre>{raw}</pre>
          </details>
        </section>
      )}

      <footer>
        <p>M1 试验台 · 数据仅存本机 · Mock 模式不联网 · URL 加 ?autotest=1 触发自检</p>
      </footer>
    </div>
  )
}
