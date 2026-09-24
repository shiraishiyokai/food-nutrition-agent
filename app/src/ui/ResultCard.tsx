import type { MealRecognition } from '../ai/schema'
import type { ComputedMeal, ComputedItem, RecipeLine, DishOrigin } from '../lib/nutrition_db'
import { getIngredient } from '../lib/nutrition_db'

const MEAL_LABELS: Record<MealRecognition['meal_type'], string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function ConfidenceBadge({ value }: { value: number }) {
  const level = value >= 0.8 ? 'high' : value >= 0.6 ? 'mid' : 'low'
  const label = level === 'high' ? '高' : level === 'mid' ? '中' : '低·需确认'
  return <span className={`badge conf-${level}`}>{label} {Math.round(value * 100)}%</span>
}

function MatchBadge({ matchType }: { matchType: 'exact' | 'alias' | 'fuzzy' }) {
  if (matchType === 'exact') return <span className="badge match-exact">精确匹配</span>
  if (matchType === 'alias') return <span className="badge match-alias">别名匹配</span>
  return (
    <span className="badge match-fuzzy" title="按菜名模糊匹配到营养库，请确认是否为同一道菜">
      模糊匹配·请确认
    </span>
  )
}

function OriginBadge({ origin, sourceUrl }: { origin: DishOrigin; sourceUrl?: string }) {
  if (origin === 'calibration') return <span className="badge match-alias">个人校准值</span>
  if (origin === 'recipe_override') return <span className="badge match-alias">我的配方</span>
  if (origin === 'reference') {
    return (
      <a className="badge match-alias ref-link" href={sourceUrl} target="_blank" rel="noreferrer"
        title="直录自薄荷食物库的公开参考值（专业机构测算值），点击可查看来源">
        直录参考值
      </a>
    )
  }
  return null
}

/** 配方构成展开行：番茄 150g · 鸡蛋 120g · 油 12g（每百克约 112 kcal） */
function RecipeLine({ recipe, per100g }: { recipe: RecipeLine[]; per100g: number }) {
  const parts = recipe.map((line) => {
    const ing = getIngredient(line.ingredientId)
    const zh = ing?.name ?? line.ingredientId
    if (line.grams >= 899) return `${zh} 少许`
    return `${zh} ${line.grams}g`
  })
  return (
    <span className="recipe-line">
      配方：{parts.join(' · ')} → 每百克约 {per100g} kcal
    </span>
  )
}

function Row({ item, confirmed }: { item: ComputedItem; confirmed?: boolean }) {
  const uncertain = item.estimate != null || (!confirmed && item.confidence < 0.6)
  return (
    <tr className={uncertain ? 'needs-confirm' : ''}>
      <td>
        <div className="food-cell">
          {item.name}
          {confirmed && <span className="badge match-exact">已确认</span>}
          {item.match ? (
            <>
              <MatchBadge matchType={item.match.matchType} />
              <OriginBadge origin={item.match.dish.origin} sourceUrl={item.match.dish.source_url} />
            </>
          ) : item.estimate ? (
            <span className="badge match-fuzzy" title="未命中营养库，按同类菜品均值估算">
              类目估算
            </span>
          ) : (
            <span className="badge match-none">待校准</span>
          )}
        </div>
        {item.confidence < 0.6 && <span className="confirm-hint">（请确认品名/分量）</span>}
        {item.estimate && item.per100gUsed && (
          <span className="recipe-line">
            「{item.estimate.category}」类 {item.estimate.basisCount} 道菜均值估算 · 每百克约 {item.per100gUsed.calories} kcal · 如需更准请校准
          </span>
        )}
        {item.recipe && item.recipe.length > 0 && item.per100gUsed && (
          <RecipeLine recipe={item.recipe} per100g={item.per100gUsed.calories} />
        )}
        {item.match?.dish.origin === 'reference' && (!item.recipe || item.recipe.length === 0) && item.per100gUsed && (
          <span className="recipe-line">
            来源：薄荷食物库{item.match.dish.source_url ? '（直录参考值）' : ''} · 每百克 {item.per100gUsed.calories} kcal
          </span>
        )}
      </td>
      <td>{item.portionG ? `${item.portionG}g` : '—'}</td>
      <td>{item.calories ?? '—'}</td>
      <td>{item.proteinG != null ? `${round1(item.proteinG)}g` : '—'}</td>
      <td>{item.fatG != null ? `${round1(item.fatG)}g` : '—'}</td>
      <td>{item.carbsG != null ? `${round1(item.carbsG)}g` : '—'}</td>
      <td>
        <ConfidenceBadge value={item.confidence} />
      </td>
    </tr>
  )
}

export function ResultCard({ result, computed }: { result: MealRecognition; computed: ComputedMeal }) {
  const unmatchedCount = computed.unmatchedNames.length
  const estimatedCount = computed.estimatedNames.length

  return (
    <div className="result-card">
      <div className="result-head">
        <span className="meal-chip">{MEAL_LABELS[result.meal_type]}</span>
        <span className="result-title">
          {result.items.length} 个条目 · 已匹配合计约 {Math.round(computed.totals.calories)} kcal
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>食物</th>
              <th>分量</th>
              <th>kcal</th>
              <th>蛋白</th>
              <th>脂肪</th>
              <th>碳水</th>
              <th>置信度</th>
            </tr>
          </thead>
          <tbody>
            {computed.items.map((it, i) => (
              <Row key={i} item={it} confirmed={result.items[i]?.confirmed} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="sums">
        已匹配合计：热量 {Math.round(computed.totals.calories)} kcal · 蛋白 {round1(computed.totals.proteinG)}g
        · 脂肪 {round1(computed.totals.fatG)}g · 碳水 {round1(computed.totals.carbsG)}g
      </p>
      {estimatedCount > 0 && (
        <div className="unmatched estimated">
          ≈ {estimatedCount} 项未命中菜品库，已按「类目均值」估算（{computed.estimatedNames.join('、')}）——误差大于精确匹配，告诉我实际用料或热量即可入库校准。
        </div>
      )}
      {unmatchedCount > 0 && (
        <div className="unmatched">
          ⚠ {unmatchedCount} 项无数值（{computed.unmatchedNames.join('、')}）——数值显示为「—」。
          告诉我实际用料或热量即可入库校准，<b>不会</b>用模型估算代替。
        </div>
      )}
      {result.notes.length > 0 && (
        <div className="notes">
          <h4>估算假设</h4>
          <ul>
            {result.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="db-version">
        数值来源：USDA SR Legacy 原料库 + 中国食物成分表公开值 × 配方派生 ｜ 薄荷食物库直录参考值 ｜ 未命中菜按类目均值兜底
      </p>
    </div>
  )
}
