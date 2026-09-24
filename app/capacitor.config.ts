import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.shiliao.app',
  appName: '食聊',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  // CapacitorHttp：fetch 走原生 HTTP，绕过 WebView CORS（spec 6.1 关键决策）
  plugins: { CapacitorHttp: { enabled: true } },
}

export default config
