/** 识别卡片消息（对话化重构 P2/P3）：recognize_meal 工具产出，在对话流内渲染。
 *  支持三通道修改：卡片上直接编辑 / 对话一句话修正（applyOps）/ 低置信项反问。
 *  两段式红线在对话内依然成立：展示数值一律 computeMeal 本地现算，模型文本只作旁注。 */
import { useMemo, useState } from 'react'
import type { CardData } from '../ai/chat'
import { computeMeal } from '../lib/nutrition_db'
import { guessMealType, type MealType } from '../data/mealRepo'

interface Props {
  card: CardData
  saving: boolean
  onChange: (c: CardData) => void
  onSave: (mealType: MealType) => void
}

const MEAL_TYPES: MealType[] = ['早餐', '午餐', '晚餐', '加餐']

export function MealCard({ card, saving, onChange, onSave }: Props) {
  const computed = useMemo(() => computeMeal(card.result), [card])
  const items = card.result.items
  const locked = card.status === 'saved'
  const [mealType, setMealType] = useState<MealType>(guessMealType)

  function patchItem(i: number, patch: Partial<{ name: string; portion_g: number }>) {
    if (locked) return
    const next = items.map((it, idx) => (idx === i ? { ...it, ...patch, confirmed: true } : it))
    onChange({ ...card, result: { ...card.result, items: next } })
  }

  function removeItem(i: number) {
    if (locked) return
    onChange({ ...card, result: { ...card.result, items: items.filter((_, idx) => idx !== i) } })
  }

  const uncertain = computed.items.filter((c, idx) => c.confidence < 0.6 && !items[idx]?.confirmed)

  return (
    <div className="meal-card">
      <div className="mc-head">
        {card.photoDataUrl && <img className="mc-thumb" src={card.photoDataUrl} alt="餐照" />}
        <div className="mc-title">
          <strong>🍽 识别卡片</strong>
          <span className="mc-status">{locked ? '✓ 已入库' : '待确认'}</span>
        </div>
      </div>

      <table className="mc-table">
        <thead>
          <tr>
            <th>食物</th>
            <th>克数</th>
            <th>kcal</th>
            {!locked && <th></th>}
          </tr>
        </thead>
        <tbody>
          {computed.items.map((c, i) => (
            <tr key={i}>
              <td>
                <input
                  className="mc-name"
                  value={items[i]?.name ?? c.name}
                  disabled={locked}
                  onChange={(e) => patchItem(i, { name: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="mc-grams"
                  type="number"
                  min={0}
                  value={items[i]?.portion_g ?? c.portionG ?? ''}
                  disabled={locked}
                  onChange={(e) => patchItem(i, { portion_g: Number(e.target.value) || 0 })}
                />
              </td>
              <td className="mc-kcal">{c.calories != null ? Math.round(c.calories) : '—'}</td>
              {!locked && (
                <td>
                  <button className="mc-del" onClick={() => removeItem(i)}>
                    ×
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mc-total">
        合计：<strong>{Math.round(computed.totals.calories)} kcal</strong> · 蛋白 {Math.round(computed.totals.proteinG)}g · 脂肪{' '}
        {Math.round(computed.totals.fatG)}g · 碳水 {Math.round(computed.totals.carbsG)}g
      </p>

      {!locked && uncertain.length > 0 && (
        <div className="askback">
          <p>🤔 这 {uncertain.length} 项把握不大：直接在输入框说（「不是A是B」「米饭只有一半」），或点改上表。</p>
          <ul>
            {uncertain.map((c, i) => (
              <li key={i}>
                「{c.name}」约 {c.portionG ?? '?'}g
              </li>
            ))}
          </ul>
        </div>
      )}

      {card.corrLogs.length > 0 && (
        <ul className="corr-logs mc-logs">
          {card.corrLogs.slice(0, 4).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}

      {!locked && (
        <div className="save-row">
          <select value={mealType} onChange={(e) => setMealType(e.target.value as MealType)}>
            {MEAL_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button className="primary" disabled={saving} onClick={() => onSave(mealType)}>
            {saving ? '保存中…' : '✓ 确认记录'}
          </button>
        </div>
      )}
    </div>
  )
}
