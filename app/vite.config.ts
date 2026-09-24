import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期经本地代理转发 LLM 请求以绕过浏览器 CORS；
// 打包为 APK 后改走 CapacitorHttp 原生请求（spec 6.1），届时删除此代理依赖。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ai/zhipu': {
        target: 'https://open.bigmodel.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai\/zhipu/, ''),
      },
      '/ai/dashscope': {
        target: 'https://dashscope.aliyuncs.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai\/dashscope/, ''),
      },
      // 薄荷科学官方 API（按需补营养库）；APK 后同 CapacitorHttp 直连
      '/boohee': {
        target: 'https://api.boohee.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/boohee/, ''),
      },
    },
  },
})
