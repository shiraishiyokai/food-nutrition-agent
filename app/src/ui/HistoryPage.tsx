/** M2「记录」页：按日分组的餐记录历史 + 每日合计（spec 6.1 每日汇总视图）。 */
import { useEffect, useState } from 'react'
import { getMealRepo, localDateStr, type MealRecord } from '../data/mealRepo'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function dayLabel(date: string): string {
  const today = localDateStr()
  if (date === today) return '今天'
  const y = new Date(Date.now() - 86400000)
  if (date === localDateStr(y)) return '昨天'
  const d = new Date(`${date}T12:00:00`)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

function timeLabel(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmt(n: number | null, unit = ''): string {
  return n == null ? '—' : `${Math.round(n * 10) / 10}${unit}`
}

export function HistoryPage() {
  const [meals, setMeals] = useState<MealRecord[] | null>(null)
  const [repoTick, setRepoTick] = useState(0)

  useEffect(() => {
    void getMealRepo()
      .then((r) => r.list())
      .then(setMeals)
  }, [repoTick])

  async function handleDelete(id: string) {
    const repo = await getMealRepo()
    await repo.remove(id)
    setRepoTick((t) => t + 1)
  }

  if (meals == null) return <div className="page"><p className="hint">加载中…</p></div>
  if (meals.length === 0) {
    return (
      <div className="page">
        <header>
          <h1>📒 记录</h1>
        </header>
        <section className="card">
          <p className="hint">还没有记录。去「识别」页拍一餐，点「保存这餐」即可。</p>
        </section>
      </div>
    )
  }

  const byDate = new Map<string, MealRecord[]>()
  for (const m of meals) {
    const arr = byDate.get(m.date) ?? []
    arr.push(m)
    byDate.set(m.date, arr)
  }

  return (
    <div className="page">
      <header>
        <h1>📒 记录</h1>
        <p className="sub">共 {meals.length} 餐 · 数据仅存本机</p>
      </header>
      {[...byDate.entries()].map(([date, dayMeals]) => {
        const t = dayMeals.reduce(
          (a, m) => ({
            calories: a.calories + (m.totals.calories || 0),
            proteinG: a.proteinG + (m.totals.proteinG || 0),
            fatG: a.fatG + (m.totals.fatG || 0),
            carbsG: a.carbsG + (m.totals.carbsG || 0),
          }),
          { calories: 0, proteinG: 0, fatG: 0, carbsG: 0 },
        )
        return (
          <section className="card day-block" key={date}>
            <h2 className="day-head">
              {dayLabel(date)}
              <span className="day-total">
                合计 {Math.round(t.calories)} kcal · 蛋白 {fmt(t.proteinG, 'g')} · 脂肪 {fmt(t.fatG, 'g')} · 碳水{' '}
                {fmt(t.carbsG, 'g')}
              </span>
            </h2>
            {dayMeals.map((m) => (
              <div className="meal-card" key={m.id}>
                <div className="meal-head">
                  <strong>
                    {m.mealType} {timeLabel(m.createdAt)}
                  </strong>
                  <span className="meal-kcal">{m.totals.calories} kcal</span>
                  <button className="del-btn" onClick={() => void handleDelete(m.id)}>
                    删除
                  </button>
                </div>
                <div className="meal-body">
                  {m.photoDataUrl && <img className="thumb" src={m.photoDataUrl} alt={`${m.mealType}照片`} />}
                  <div className="meal-lines">
                    {m.items.map((it, i) => (
                      <div className="meal-line" key={i}>
                        {it.name} {it.portionG != null ? `${it.portionG}g` : ''}
                        {it.estimate ? '（类目估算）' : ''} → <b>{fmt(it.calories, ' kcal')}</b>
                      </div>
                    ))}
                    <p className="mini">
                      蛋白 {fmt(m.totals.proteinG, 'g')} · 脂肪 {fmt(m.totals.fatG, 'g')} · 碳水 {fmt(m.totals.carbsG, 'g')}
                    </p>
                    {m.corrLogs.length > 0 && (
                      <ul className="corr-logs">
                        {m.corrLogs.slice(0, 3).map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
