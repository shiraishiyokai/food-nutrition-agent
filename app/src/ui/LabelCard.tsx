/** 配料表解读卡片（D19）：interpret_label 工具产出，纯查阅用（不入库、无保存按钮）。
 *  每行 = 一个成分 + 知识库命中（类别/功能/留意提示）；未收录成分如实列出，不作猜测；
 *  底部来源清单与卡片内引用编号对应——回答可溯源是本功能红线。 */
import type { CardData } from '../ai/chat'

export function LabelCard({ card }: { card: CardData }) {
  const label = card.label
  if (!label) return null
  const hits = label.items.filter((i) => i.entry)
  const misses = label.items.filter((i) => !i.entry)
  const sources = [...new Set(hits.map((i) => i.entry!.source))]
  const sourceIdx = (s: string) => sources.indexOf(s) + 1

  return (
    <div className="meal-card label-card">
      <div className="mc-head">
        <div className="mc-title">
          <strong>🔎 配料表解读</strong>
          <span className="mc-status">{label.viaPhoto ? '照片提取' : '文字解析'} · 知识库 {hits.length}/{label.items.length} 命中</span>
        </div>
      </div>

      <table className="mc-table">
        <thead>
          <tr>
            <th>成分</th>
            <th>类别</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {label.items.map((it, i) =>
            it.entry ? (
              <tr key={i}>
                <td className="lc-name">
                  {it.entry.name}
                  {it.matchType && it.matchType !== 'exact' && (
                    <i className="lc-tier">{it.matchType === 'semantic' ? ' 语义' : ' 关键词'}匹配</i>
                  )}
                </td>
                <td>{it.entry.category}</td>
                <td className="lc-desc">
                  {it.entry.fn}
                  {it.entry.level === '留意' && <span className="lc-warn">⚠ {it.entry.safety}</span>}
                  <sup className="lc-src">[{sourceIdx(it.entry.source)}]</sup>
                </td>
              </tr>
            ) : (
              <tr key={i} className="lc-miss">
                <td>{it.name}</td>
                <td>—</td>
                <td>暂未收录，不作猜测</td>
              </tr>
            ),
          )}
        </tbody>
      </table>

      {misses.length > 0 && (
        <p className="lc-note">以下成分知识库暂未收录，已如实标注而非猜测：{misses.map((m) => m.name).join('、')}</p>
      )}

      <ol className="lc-sources">
        {sources.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="lc-note">解读仅供参考，不构成健康或医疗建议。</p>
    </div>
  )
}
