import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期经本地代理转发 LLM 请求以绕过浏览器 CORS；
// 线上 web 构建无代理，由 native_http.resolveEndpoint 把代理路径映射为真实端点直连
// （智谱/百炼/薄荷三接口均实测允许浏览器跨域，2026-09-25）。
// base 用相对路径：GitHub Pages 子路径（/food-nutrition-agent/）与 APK 本地根路径两者都兼容。
export default defineConfig({
  base: './',
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
