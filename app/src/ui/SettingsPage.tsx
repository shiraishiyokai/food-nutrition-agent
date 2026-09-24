/** ⚙ 设置页（对话化重构②：BYOK 配置 + 备份迁移收进最后一个页签）。
 *  从识别页整体迁出（D13③ 的 ⚙ 折叠卡演进为独立 Tab），逻辑不变：
 *  预设只是默认值模板，baseUrl/model/Key 全可改；备份含 Key 脱敏规约见 lib/backup.ts（D14）。 */
import { useEffect, useRef, useState } from 'react'
import { testConnection } from '../ai/vlm'
import { PRESETS, getPreset } from '../ai/providers'
import { loadSettings, saveSettings, type Settings } from '../lib/settings'
import { applyBackup, buildBackup, exportBackup, summarizeBackup, type BackupFile } from '../lib/backup'

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  // 备份与迁移（D14）
  const [bkKey, setBkKey] = useState(true)
  const [bkPhotos, setBkPhotos] = useState(true)
  const [bkBusy, setBkBusy] = useState(false)
  const [bkMsg, setBkMsg] = useState('')
  const [pendingImport, setPendingImport] = useState<{ b: BackupFile; summary: string; hasKey: boolean } | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

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

  return (
    <div className="page">
      <header>
        <h1>⚙ 设置</h1>
        <p className="sub">BYOK：Key 只存本机，不进代码不上云；备份是否携带 Key 由你勾选</p>
      </header>

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
              <label>识别模型（视觉）</label>
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
              <label>对话模型（文本）</label>
              <input
                value={settings.chatModel}
                list="chat-model-suggestions"
                placeholder="对话/修正/识别工具用，比视觉模型便宜（如 glm-4-flash）"
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
        <p className="hint">
          设置自动保存在本机；预设只是默认值，地址/模型/Key 均可改写。开发期走本地代理绕 CORS，
          自定义 https 地址若被浏览器拦截，打包 APK 后原生请求不受限。
        </p>
      </section>

      <section className="card">
        <h2>备份与迁移</h2>
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
        <p className="hint">覆盖：供应商设置 / 档案 / 餐记录 / 个人校准 / 薄荷缓存。换机或重装后一键恢复。</p>
      </section>

      <footer>
        <p>数据仅存本机（沙箱），卸载即清空；迁移只走备份导出/导入。</p>
      </footer>
    </div>
  )
}
