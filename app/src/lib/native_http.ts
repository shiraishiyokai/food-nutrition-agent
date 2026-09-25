/** 请求端点解析，三种环境一套代码：
 *  - 开发期：走 Vite 代理（vite.config server.proxy），相对路径原样返回；
 *  - APK 原生：CapacitorHttp 直连（capacitor.config plugins 开关）；
 *  - 线上 web（GitHub Pages 等静态托管，没有代理）：构建产物（import.meta.env.PROD）
 *    把代理前缀映射为真实端点直连。
 *  智谱 / 百炼 / 薄荷三接口均实测允许浏览器跨域直连（2026-09-25 预检 + 实响应双重验证）。 */
import { Capacitor } from '@capacitor/core'

const ENDPOINT_MAP: Array<[prefix: string, absolute: string]> = [
  ['/ai/zhipu', 'https://open.bigmodel.cn'],
  ['/ai/dashscope', 'https://dashscope.aliyuncs.com'],
  ['/boohee', 'https://api.boohee.com'],
]

export function resolveEndpoint(url: string): string {
  if (/^https?:\/\//.test(url)) return url
  if (Capacitor.isNativePlatform() || import.meta.env.PROD) {
    for (const [prefix, absolute] of ENDPOINT_MAP) {
      if (url.startsWith(prefix)) return absolute + url.slice(prefix.length)
    }
  }
  return url
}
