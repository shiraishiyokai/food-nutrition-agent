import type { MealRecognition } from '../ai/schema'

const PREFIX = 'fna.recog.v1'
const TTL_MS = 24 * 60 * 60 * 1000

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function cacheKey(dataUrl: string, cfgKey: string): Promise<string> {
  return sha256Hex(dataUrl).then((h) => `${PREFIX}:${h.slice(0, 32)}:${cfgKey}`)
}

/** 相同图片 + 相同模型 24h 内命中缓存，不重复调用（spec 5.5） */
export async function readCache(dataUrl: string, cfgKey: string): Promise<MealRecognition | null> {
  const key = await cacheKey(dataUrl, cfgKey)
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { ts: number; result: MealRecognition }
    if (Date.now() - parsed.ts > TTL_MS) {
      localStorage.removeItem(key)
      return null
    }
    return parsed.result
  } catch {
    localStorage.removeItem(key)
    return null
  }
}

export async function writeCache(dataUrl: string, cfgKey: string, result: MealRecognition): Promise<void> {
  const key = await cacheKey(dataUrl, cfgKey)
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), result }))
  } catch {
    // 容量满时静默放弃缓存，不影响主流程
  }
}
