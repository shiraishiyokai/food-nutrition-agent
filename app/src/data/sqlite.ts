/** 原生 SQLite 单例连接（@capacitor-community/sqlite）。
 *  注意：registerPlugin 的代理对象绝不能从 async 函数里 return/await——
 *  Promise 解析会访问它的 .then，原生端没有该方法，报 "then() is not implemented"。
 *  因此这里 resolve 的是普通包装对象 { sq }，且全 app 只建一次连接。 */
import { Capacitor } from '@capacitor/core'

const DB = 'fna.db'

const TABLES = `CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, meal_type TEXT NOT NULL,
  photo TEXT NOT NULL, raw_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL);`

type SqlitePlugin = import('@capacitor-community/sqlite').CapacitorSQLitePlugin

let ready: Promise<{ sq: SqlitePlugin }> | null = null

export function getSqlite(): Promise<{ sq: SqlitePlugin }> {
  ready ??= (async () => {
    const { CapacitorSQLite } = await import('@capacitor-community/sqlite')
    await CapacitorSQLite.createConnection({ database: DB, encrypted: false, mode: 'no-encryption', version: 1 })
    await CapacitorSQLite.open({ database: DB })
    await CapacitorSQLite.execute({ database: DB, statements: TABLES })
    return { sq: CapacitorSQLite }
  })()
  return ready
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}
