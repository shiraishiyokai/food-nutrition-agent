# AGENTS.md — food-nutrition-agent 项目总入口

> 任何 AI Agent 接手本项目，先读本文件；修 Bug 行为约束见上级 `D:\my-project\AGENTS.md`（修复尝试上限/回滚/根因报告），错误案例见 `D:\my-project\MISTAKES.md`。
> 文档与代码冲突时：以代码为准，并回改文档。改完代码必须跑 `npx tsc --noEmit`（在 `app/` 下）。

## 1. 项目是什么
「食聊」：拍照驱动的个人饮食营养 Agent，已打包 Android APK。照片 → VLM 识别菜名/分量 → 本地营养库查表算数值 → 卡片确认 → 一句话修正 → 记录/对话查询。**模型只识别，不算数**（两段式架构，见 `docs/decisions.md`）。
上位文档：`Food-Nutrition-Agent-Spec.md`（产品+AI 规格、决策记录 D1–D14、里程碑 M1–M4）。

## 2. 当前项目状态（截至 2026-09-24 晚）
- **M1 ✅**（验收豁免——用户明确不再追 20 餐指标，勿再推动）。
- **M2 ✅ 开发完成**：Capacitor 8 打包 APK（com.shiliao.app），原生 SQLite 存餐记录/档案；MuMu 模拟器全链路验证通过。**待验收：真机连续 3 天真实记录**。
- **M3 ✅ 开发完成**：档案注入 system prompt、对话查询（今日/本周聚合注入）、低置信度反问、一句话修正、双模型（识别 glm-4v-flash / 对话 chatModel 如 glm-4-flash）、多会话聊天。mock 双端走通；真实 Key 端到端待用户在模拟器确认。
- **M4 未启动**：release 签名、配料表解读、档案自动抽取等。
- 数据基座：原料库 78 项 / 直录菜 108 道 / 配方菜 43 道 + 薄荷 API 按需补库 + 个人校准（**已持久化** `fna.calib.v1`，2026-09-24 修）+ 备份导出/导入（`lib/backup.ts`）。

## 3. 技术栈
React 19 + TypeScript 5.8 + Vite 6 + zod 4 + **Capacitor 8**（@capacitor-community/sqlite、@capacitor/filesystem、@capacitor/share）。无测试框架。存储双层：原生端餐记录/档案进 SQLite `fna.db`，其余（设置/校准/聊天/薄荷缓存）进 WebView localStorage；纯浏览器时全部 localStorage。数据工具链为 Node 脚本（`app/scripts/*.mjs`）。

## 4. 目录结构
```
food-nutrition-agent/
├── Food-Nutrition-Agent-Spec.md   # 上位规格：定位/决策/功能/AI 设计/里程碑
├── AGENTS.md · docs/              # 本文件 + architecture/decisions/known-issues
├── build-apk.bat                  # 一键 APK 构建（须 CRLF 行尾，LF 会令 cmd 解析错乱）
├── toolchain/                     # 便携 JDK 21（Capacitor 8 硬性要求，免全局环境）
├── notes/                         # 实测日志（只追加不重写）
└── app/
    ├── vite.config.ts             # dev 代理：/ai/zhipu /ai/dashscope /boohee
    ├── scripts/                   # 数据溯源工具链（生成 src/data 资产）
    ├── android/                   # Capacitor Android 工程（Gradle 8.14.3 / SDK 34）
    └── src/
        ├── App.tsx                # 三 Tab：📸识别 / 💶记录 / 💬对话 + 'fna:goto' 跨页跳转
        ├── ai/                    # vlm(识别) / chat(修正解析+对话问答) / providers / prompt / schema
        ├── lib/                   # nutrition_db / boohee_api / correction / native_http / stats
        │                          #   / backup(备份迁移) / image / cache / settings
        ├── data/                  # sqlite.ts(连接单例) / mealRepo / profileRepo + 数据资产 JSON
        └── ui/                    # RecognizePage(识别+设置+备份) / ResultCard / ChatPage / HistoryPage
```

## 5. 模块职责
- `ai/vlm.ts`：`recognizeMeal`——发图给视觉模型，抽 JSON、zod 校验，失败重试 1 次。
- `ai/chat.ts`：`parseCorrection`（一句话→结构化 ops JSON）+ `answerQuery`（对话问答，档案/今日/本周聚合注入 system prompt）+ `mockAnswer`。
- `lib/nutrition_db.ts`：**数值权威**。五级查找（校准>API缓存>直录108>配方43>类目均值兜底）+ `computeMeal`。校准读写 localStorage `fna.calib.v1`，模块加载时自动恢复。
- `lib/boohee_api.ts`：薄荷官方 API 按需补库（每日预算 45/50、查到永久缓存、未命中负缓存）。
- `lib/correction.ts`：修正引擎——规则层正则先行（改名/改分量/增删/校准），失败才走 LLM 语义层，统一 `applyOps` 本地执行。
- `lib/native_http.ts`：`resolveEndpoint`——原生端把 dev 代理路径（/ai/zhipu 等）映射回真实主机。**修 404 的关键**：映射表存裸主机，勿存到 /api/paas/v4 这一级。
- `lib/backup.ts`：备份导出/导入（D14）。设置/档案/餐记录/校准/薄荷缓存全覆盖；Key 是否包含由用户勾选，**不含 Key 的备份导入时保留目标机已有 Key**；界面永不明文展示 Key。
- `lib/stats.ts`：今日/本周聚合（对话注入用，只给聚合不给原始记录）。
- `data/sqlite.ts`：连接单例。**勿从 async 函数直接返回/await 插件代理对象**（registerPlugin 的 thenable 陷阱，必须包 `{ sq }` 返回）；`query()` 必须显式传 `values: []`。
- `data/mealRepo.ts` / `profileRepo.ts`：Repository 双实现（浏览器 localStorage / 原生 SQLite），接口含 `replaceAll`（导入备份用）。
- `ui/RecognizePage.tsx`：识别编排 + 设置卡（⚙ 收纳，默认收起）+ 备份与迁移区。
- `ui/ChatPage.tsx`：多会话聊天（`fna.chat.v2`），徽标显示当前对话模型，mock 模式可点击跳设置。

## 6. 启动方式
```bash
# Web 开发
cd app && npm install && npm run dev   # → http://localhost:5173
# APK 构建（双击 build-apk.bat，或 bash 内）：
cd app/android && JAVA_HOME=<toolchain/jdk-21> cmd //c gradlew.bat assembleDebug
# MuMu 安装（模拟器运行中）：
adb connect 127.0.0.1:16384 && adb -s 127.0.0.1:16384 install -r <apk路径>   # -r 保留用户数据
```
默认**模拟模式**（不联网、无需 Key）。URL 加 `?autotest=1` 触发 Mock 全流程自检（`document.title` → `AUTOTEST_PASS/FAIL`）。

## 7. 测试/验证方式（无单元测试框架，按此组合验证）
1. `npx tsc --noEmit`（`app/` 下）——唯一客观回归门槛，也是 `npm run build` 的第一半。
2. 浏览器 `?autotest=1`——Mock 模式跑通「压缩→识别→配方派生→卡片」。
3. 持久化/备份类改动：浏览器 E2E 实测（写入→reload→验证仍在；导出→清空→导入→核对），勿只看构建通过。
4. 原生改动：重出 APK → `adb install -r` MuMu → 启动无 crash（`adb logcat` 抽查）。
5. `node scripts/verify-dishes.mjs`——派生值 vs 直录值交叉校验。

## 8. 重要开发规则
- **两段式红线**：VLM 输出永远不含营养数值；数值 = 库值 × 克数，代码计算。
- **不降级估算**：库未命中且类目兜底也不可得时显示「—」待校准，MUST NOT 用模型估算数值顶上。
- **可溯源**：营养数值必须能答上来源（校准/API缓存/直录/配方/类目），不准编造。
- **Key 脱敏**：Key 只存本机；任何导出/日志/界面展示环节不得明文泄露；备份是否带 Key 由用户显式勾选。
- 数据资产（`src/data/` 三个 JSON）不手改：由 scripts 生成或人工核定；改动须重跑 verify。
- 里程碑结束时回写 spec「决策记录」；新的重要技术决策进 `docs/decisions.md`。

## 9. 关键数据流（识别主链路）
照片 → `compressImage`（1024px/JPEG 0.8）→ `readCache`（图片哈希+模型，24h）→ `recognizeMeal`（VLM）→ `computeMeal`（查库×克数；未命中→类目均值兜底）→ `ResultCard`（匹配类型/数值来源/置信度）→ useEffect 对未命中项调 `enrichLookup`（补库→重算）→ 低置信项反问（<0.6）→ 一句话修正 `applyCorrectionText`（规则层→LLM）→ 保存 `mealRepo.add`。
网络路径双轨：**dev** 走 Vite 代理（/ai/zhipu 等）；**原生** 经 `native_http.resolveEndpoint` + CapacitorHttp 直连真实主机（已实现，两段路径拼接是历史 404 事故点，见 §5 native_http）。

## 10. Agent/LLM/Tool 现状
- LLM 调用三处：`vlm.recognizeMeal`（视觉，glm-4v-flash）、`chat.parseCorrection`（修正解析）、`chat.answerQuery`（对话问答）；均直连 HTTP 无 SDK，识别与对话可分模型（settings.chatModel）。
- 记忆：档案+聚合注入 system prompt（长期）、会话历史（短期）、个人校准（反馈学习，已持久化）。
- Tool：**对话查询已用原生 function calling**（D15）——`chat.ts` TOOLS（query_today/query_week/lookup_food）+ `executeTool` 本地执行 + `answerQueryTools` 三轮收敛；失败自动回落注入式 `answerQuery`。外部 API 仅薄荷 `food/search`（带预算+负缓存）；修正 ops 是「模型定语义、本地执行」模式。
- 无 RAG：营养库是编译期静态 JSON + 运行时缓存。

## 11. 核心代码（改前必读）
`lib/nutrition_db.ts`（数值权威）、`lib/correction.ts`、`lib/boohee_api.ts`、`lib/native_http.ts`、`lib/backup.ts`、`data/sqlite.ts`（thenable 陷阱）、`ai/vlm.ts`+`ai/prompt.ts`、`ai/schema.ts`、`ui/RecognizePage.tsx`、`src/data/` 数据 JSON、`scripts/` 工具链。

## 12. 不要随意修改
- `src/data/dishes-reference.json` / `ingredients.json` / `dishes.json`——数据资产，溯源+人工核定成果。
- `ai/prompt.ts` 的判别规则——每条对应一次实测误判。
- `ai/schema.ts` 的 `DISH_CATEGORIES` 九类——与营养库类目均值体系耦合。
- `lib/boohee_api.ts` 的预算/负缓存逻辑——防 429 与免费额度耗尽。
- `lib/settings.ts` 的 v1→v2 迁移分支、`lib/backup.ts` 的 Key 保留/脱敏语义——保护用户数据。
- `data/sqlite.ts` 的 `{ sq }` 包装——拆掉会触发 registerPlugin thenable 崩溃。
- `notes/` 与 `docs/known-issues.md` 只追加/标状态，不改写历史。

## 13. 当前已知重要问题
见 `docs/known-issues.md`。用户校准不持久（K7）已于 2026-09-24 修复（`fna.calib.v1`，E2E 验证）；CapacitorHttp（K11 相关）已实现。

## 14. 本地存储清单（接手排查先看这里）
| 键/表 | 内容 | 位置 |
|---|---|---|
| SQLite `meals` | 餐记录（含照片 dataURL） | 仅原生 `fna.db` |
| SQLite `profile` | 健康档案 | 仅原生 `fna.db` |
| `fna.settings.v2` | 供应商+双 Key+chatModel | localStorage |
| `fna.calib.v1` | 个人校准（营养库启动时恢复） | localStorage |
| `fna.boohee.{cache,miss,budget}.v1` | 补库缓存/负缓存/每日预算 | localStorage |
| `fna.chat.v2` | 多会话聊天 | localStorage |
| `fna.recog.v1:*` | 24h 识别缓存 | localStorage |
| `fna.meals.v1` / `fna.profile.v1` | 餐记录/档案 | 仅浏览器（原生走 SQLite） |

全部位于应用私有沙箱（`/data/data/com.shiliao.app/`），卸载或系统「清除数据」即全失，无云备份——迁移走 `lib/backup.ts` 导出/导入。
