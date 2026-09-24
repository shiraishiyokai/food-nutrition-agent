# AGENTS.md — food-nutrition-agent 项目总入口

> 任何 AI Agent 接手本项目，先读本文件；修 Bug 行为约束见上级 `D:\my-project\AGENTS.md`（修复尝试上限/回滚/根因报告），错误案例见 `D:\my-project\MISTAKES.md`。
> 文档与代码冲突时：以代码为准，并回改文档。改完代码必须跑 `npx tsc --noEmit`（在 `app/` 下）。

## 1. 项目是什么
「食聊」：**对话即主入口**的拍照饮食营养 Agent（Android APK）。用户在对话里发餐照 → 模型调 recognize_meal 工具 → 本地识别+查库 → 可编辑识别卡片 → 对话/点改修正 → 确认入库；纯文本问题走查询工具。**模型只识别、只决定调什么，不算数**（两段式架构 + function calling，见 `docs/decisions.md`）。
上位文档：`Food-Nutrition-Agent-Spec.md`（产品+AI 规格、决策记录 D1–D17、里程碑 M1–M4）。

## 2. 当前项目状态（截至 2026-09-25）
- **M1 ✅（验收豁免，勿再推动 20 餐）/ M2 ✅ / M3 ✅**（详见 spec）。
- **对话化重构 ✅（2026-09-25，P1–P5）**：对话/记录/设置三页签；识别卡片闭环（recognize_meal 工具 → 卡片 → 点改/对话修正/确认入库）；左会话栏布局（手机抽屉）；独立设置页（含备份迁移）；APP 拍照/相册（@capacitor/camera）；档案增强（BMI + Mifflin-St Jeor 公式推荐热量 + 对话改档案）。
- **代码版本线：GitHub `github.com/shiraishiyokai/food-nutrition-agent`（私有）**，main 分支，每个功能段独立 commit；推送失败多为网络（国内连 GitHub 间歇超时），隔段时间重试即可。
- 待办：真机连续 3 天记录（M2 验收）、真 Key 端识别卡片全流程用户验收、APP 相机实拍验收（模拟器只验了安装启动渲染）。

## 3. 技术栈
React 19 + TypeScript 5.8 + Vite 6 + zod 4 + Capacitor 8（@capacitor-community/sqlite、@capacitor/filesystem、@capacitor/share、@capacitor/camera）。无测试框架（回归 = tsc + ?autotest=1 + 手动 E2E）。存储双层：原生端餐记录/档案进 SQLite `fna.db`，其余进 WebView localStorage；纯浏览器时全 localStorage。

## 4. 目录结构
```
food-nutrition-agent/
├── Food-Nutrition-Agent-Spec.md   # 上位规格：定位/决策 D1-D17/功能/AI 设计/里程碑
├── AGENTS.md · docs/              # 本文件 + architecture/decisions/known-issues
├── build-apk.bat                  # 一键 APK 构建（须 CRLF 行尾）
├── toolchain/                     # 便携 JDK 21（Capacitor 8 硬性要求）
├── notes/                         # 实测日志与截图（只追加不重写）
└── app/
    ├── vite.config.ts             # dev 代理：/ai/zhipu /ai/dashscope /boohee
    ├── scripts/                   # 数据溯源工具链
    ├── android/                   # Capacitor Android 工程
    └── src/
        ├── App.tsx                # 三页签：💬对话(默认) / 📒记录 / ⚙设置 + 'fna:goto'
        ├── ai/                    # chat.ts(工具层+修正解析+问答) / vlm / providers / prompt / schema
        ├── lib/                   # nutrition_db / boohee_api / correction / backup / native_http
        │                          #   / stats / image(含合成测试图) / cache / settings
        ├── data/                  # sqlite.ts / mealRepo / profileRepo(BMI+公式推荐+档案解析) + 数据 JSON
        └── ui/                    # ChatPage(主入口) / MealCard(识别卡片) / HistoryPage / SettingsPage
```

## 5. 模块职责
- `ui/ChatPage.tsx`：**主入口与编排中枢**。send() 优先级：档案指令（parseProfileUpdate）→ 待确认卡片修正（applyCorrectionText）→ mock 模板 → function calling 循环（失败回落注入式 answerQuery）。发图走 recognize_meal 工具；确认入库 confirmSave。
- `ui/MealCard.tsx`：识别卡片——名字/克数点改、删除、合计（computeMeal 现算）、低置信反问、修正日志、餐次选择 + 确认记录按钮。
- `ui/SettingsPage.tsx`：BYOK 配置（预设=默认值模板，全可改）+ 备份迁移（D14 脱敏规约）。
- `ui/HistoryPage.tsx`：按日分组记录（浏览/删除）。
- `ai/chat.ts`：`TOOLS` 四件套（query_today/query_week/lookup_food/**recognize_meal**）+ `executeTool`（本地执行）+ `answerQueryTools`（3 轮循环）+ `parseCorrection`（修正语义层）+ `answerQuery`（注入式降级）+ `CardData/ToolCtx` 类型。
- `lib/nutrition_db.ts`：**数值权威**。五级查找（校准>API缓存>直录108>配方43>类目均值）+ computeMeal。校准持久化 `fna.calib.v1`。
- `lib/correction.ts`：修正引擎——规则层正则先行，失败走 LLM 语义层，统一 applyOps 本地执行。
- `data/profileRepo.ts`：档案存储 + `bmi/bmiLabel`（中国标准）+ `recommendEnergy`（Mifflin-St Jeor×1.375，数据不全返回 null 拒绝推荐，来源见 D17）+ `parseProfileUpdate`（对话改档案窄规则）+ `profileText`（system prompt 档案段）。
- `data/mealRepo.ts`：MealRepo 双实现（localStorage/SQLite），含 replaceAll。
- `data/sqlite.ts`：连接单例。**勿从 async 函数返回/await 插件代理对象**（thenable 陷阱，包 `{ sq }`）；query() 必须显式 `values: []`。
- `lib/backup.ts`：备份导出/导入（Key 勾选携带、不含 Key 导入时保留目标机 Key）。
- `lib/native_http.ts`：resolveEndpoint 代理路径→真实主机映射（裸主机，勿存到 /api/paas/v4 级）。
- `lib/boohee_api.ts`：薄荷 API 补库（预算 45/50、永久缓存、负缓存）。
- `lib/stats.ts`：今日/本周聚合；`lib/image.ts`：压缩 + makeSyntheticMealImage（autotest）。

## 6. 启动方式
```bash
cd app && npm install && npm run dev   # → http://localhost:5173
# APK：双击 build-apk.bat，或 bash 内 cd app/android + JAVA_HOME=<jdk21> cmd //c gradlew.bat assembleDebug
# MuMu：adb connect 127.0.0.1:16384 && adb -s 127.0.0.1:16384 install -r <apk>   # -r 保留数据
```
默认模拟模式（不联网）。URL 加 `?autotest=1` → 对话页合成图 mock 识别出卡片（title → AUTOTEST_PASS/FAIL）。

## 7. 测试/验证方式
1. `npx tsc --noEmit`（app/ 下）——唯一客观回归门槛。
2. 浏览器 `?autotest=1`——对话流 mock 识别出卡片全链路。
3. 手动 E2E 关键路径：发图出卡 → 对话修正（数值变+校准写库）→ 确认入库（记录页核对）→ 档案指令（体重/目标）。持久化类改动必须「写入→刷新→仍在」。
4. 原生改动：重出 APK → adb install -r MuMu → 启动无 FATAL（logcat）。
5. `node scripts/verify-dishes.mjs`——派生 vs 直录交叉校验。

## 8. 重要开发规则
- **两段式红线**：VLM 输出不含营养数值；数值=库值×克数代码算；卡片/对话/记录三处数值一律 computeMeal 现算。
- **推荐公式不编造**：热量推荐只走 `recommendEnergy`（来源见 D17）；数据不全返回 null；改公式必须先查权威来源并回写 spec。
- **Key 脱敏**：Key 只存本机；导出/日志/界面不得明文；备份带 Key 需用户显式勾选。
- 数据资产三个 JSON 不手改；notes/ 与 known-issues 只追加。
- **每个功能段收尾：commit + push GitHub**（版本线），推送失败记入待办稍后重试。

## 9. 关键数据流（对话主链路）
发餐照 → compressImage → 用户消息(含图) → send() 优先级链：parseProfileUpdate(档案)→ applyCorrectionText(卡片修正)→ mock / answerQueryTools。recognize_meal 执行：recognizeMeal(VLM)→ onCard 推卡片 + 摘要回模型 → 模型转述。确认入库：computeMeal → mealRepo.add → 卡片锁定。网络双轨：dev Vite 代理 / 原生 resolveEndpoint+CapacitorHttp。
查询问题：模型自主调 query_today/query_week/lookup_food → executeTool 本地算 → 结果回填 → 模型组织回答。

## 10. Agent/LLM/Tool 现状
- LLM 调用三处：vlm.recognizeMeal（视觉）、chat.parseCorrection（修正语义层）、answerQueryTools（对话+工具循环）；识别与对话分模型（chatModel）。
- **四工具**：recognize_meal / query_today / query_week / lookup_food——OpenAI 兼容格式，模型自主决定调用；执行全本地；失败回落注入式。
- 记忆：档案+聚合注入（profileText/stats）、会话历史 fna.chat.v2（含卡片与图片）、个人校准 fna.calib.v1（反馈学习）。
- 无 RAG：营养库为编译期静态 JSON + 运行时缓存。

## 11. 核心代码（改前必读）
`ui/ChatPage.tsx`（编排中枢+send 优先级链）、`ui/MealCard.tsx`、`ai/chat.ts`（工具层）、`lib/nutrition_db.ts`（数值权威）、`lib/correction.ts`、`data/profileRepo.ts`（公式来源 D17）、`lib/backup.ts`、`data/sqlite.ts`（thenable 陷阱）、`ai/prompt.ts`（判别规则勿删）。

## 12. 不要随意修改
- `src/data/` 三个数据 JSON；`ai/prompt.ts` 判别规则；`ai/schema.ts` DISH_CATEGORIES 九类。
- `lib/boohee_api.ts` 预算/负缓存；`lib/settings.ts` v1→v2 迁移；`lib/backup.ts` Key 语义。
- `data/sqlite.ts` 的 `{ sq }` 包装；`data/profileRepo.ts` recommendEnergy 的公式与来源注释（改前查证+回写 spec）。
- `notes/`、`docs/known-issues.md` 只追加。

## 13. 当前已知重要问题
见 `docs/known-issues.md`。K7 校准已修（fna.calib.v1）；配方覆盖仍内存（无入口，观察中）；K8 无自动化测试——重构期间唯一回归网是 tsc+autotest+手动 E2E。

## 14. 本地存储清单
| 键/表 | 内容 | 位置 |
|---|---|---|
| SQLite `meals` | 餐记录（含照片） | 仅原生 fna.db |
| SQLite `profile` | 档案（含性别/身高/年龄） | 仅原生 fna.db |
| `fna.settings.v2` | 供应商+双 Key+chatModel | localStorage |
| `fna.calib.v1` | 个人校准 | localStorage |
| `fna.chat.v2` | 多会话聊天（**含卡片与餐照 dataURL，体积增长注意**） | localStorage |
| `fna.boohee.{cache,miss,budget}.v1` | 补库缓存/负缓存/预算 | localStorage |
| `fna.recog.v1:*` | 24h 识别缓存 | localStorage |
| `fna.meals.v1` / `fna.profile.v1` | 记录/档案 | 仅浏览器 |

全在应用私有沙箱，卸载即失，迁移只走备份导出/导入。
