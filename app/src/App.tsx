import { useEffect, useState } from 'react'
import { RecognizePage } from './ui/RecognizePage'
import { HistoryPage } from './ui/HistoryPage'
import { ChatPage } from './ui/ChatPage'

export default function App() {
  const [tab, setTab] = useState<'recognize' | 'history' | 'chat'>('recognize')

  useEffect(() => {
    // 子页面跳转请求（如对话页「点此配置真模型」→ 识别页设置）
    const h = (e: Event) => setTab((e as CustomEvent<string>).detail as 'recognize')
    window.addEventListener('fna:goto', h)
    return () => window.removeEventListener('fna:goto', h)
  }, [])

  return (
    <>
      {tab === 'recognize' ? <RecognizePage /> : tab === 'history' ? <HistoryPage /> : <ChatPage />}
      <nav className="tabbar">
        <button className={tab === 'recognize' ? 'on' : ''} onClick={() => setTab('recognize')}>
          📸 识别
        </button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          📒 记录
        </button>
        <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          💬 对话
        </button>
      </nav>
    </>
  )
}
