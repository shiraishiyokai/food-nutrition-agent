import { useEffect, useState } from 'react'
import { HistoryPage } from './ui/HistoryPage'
import { ChatPage } from './ui/ChatPage'
import { SettingsPage } from './ui/SettingsPage'

type Tab = 'chat' | 'history' | 'settings'

export default function App() {
  // 对话为主页签（对话化重构①）：识别、记录确认全在对话内完成
  const [tab, setTab] = useState<Tab>('chat')

  useEffect(() => {
    // 子页面跳转请求（如对话页模式徽标 → 设置页）
    const h = (e: Event) => setTab((e as CustomEvent<string>).detail as Tab)
    window.addEventListener('fna:goto', h)
    return () => window.removeEventListener('fna:goto', h)
  }, [])

  return (
    <>
      {tab === 'chat' ? <ChatPage /> : tab === 'history' ? <HistoryPage /> : <SettingsPage />}
      <nav className="tabbar">
        <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          💬 对话
        </button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          📒 记录
        </button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
          ⚙ 设置
        </button>
      </nav>
    </>
  )
}
