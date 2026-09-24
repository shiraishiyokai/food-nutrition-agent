import { useEffect, useState } from 'react'
import { RecognizePage } from './ui/RecognizePage'
import { HistoryPage } from './ui/HistoryPage'
import { ChatPage } from './ui/ChatPage'
import { SettingsPage } from './ui/SettingsPage'

type Tab = 'chat' | 'history' | 'settings' | 'recognize'

export default function App() {
  // 对话为主页签（对话化重构①）；识别页仅剩 ?autotest=1 联调入口，不再出现在页签
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).has('autotest') ? 'recognize' : 'chat',
  )

  useEffect(() => {
    // 子页面跳转请求（如对话页模式徽标 → 设置页）
    const h = (e: Event) => setTab((e as CustomEvent<string>).detail as Tab)
    window.addEventListener('fna:goto', h)
    return () => window.removeEventListener('fna:goto', h)
  }, [])

  return (
    <>
      {tab === 'chat' ? (
        <ChatPage />
      ) : tab === 'history' ? (
        <HistoryPage />
      ) : tab === 'settings' ? (
        <SettingsPage />
      ) : (
        <RecognizePage />
      )}
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
