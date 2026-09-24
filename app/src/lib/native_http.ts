/** 原生环境没有 Vite dev 代理：开发期代理路径在 APK 里映射回真实端点，
 *  由 CapacitorHttp 原生请求（capacitor.config plugins 开关）绕 CORS。 */
import { Capacitor } from '@capacitor/core'

const NATIVE_MAP: Array<[prefix: string, absolute: string]> = [
  ['/ai/zhipu', 'https://open.bigmodel.cn'],
  ['/ai/dashscope', 'https://dashscope.aliyuncs.com'],
  ['/boohee', 'https://api.boohee.com'],
]

export function resolveEndpoint(url: string): string {
  if (!Capacitor.isNativePlatform() || /^https?:\/\//.test(url)) return url
  for (const [prefix, absolute] of NATIVE_MAP) {
    if (url.startsWith(prefix)) return absolute + url.slice(prefix.length)
  }
  return url
}
