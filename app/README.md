# app/ — 开发指南

项目门面与功能介绍见[根 README](../README.md)；规格与决策记录见 [../Food-Nutrition-Agent-Spec.md](../Food-Nutrition-Agent-Spec.md)。

## 运行

```bash
npm install
npm run dev        # → http://localhost:5173（默认模拟模式，不联网可联调）
```

- ⚙ 设置页：选供应商（智谱/百炼/自定义 OpenAI 兼容端点/模拟）+ 填 Key；预设只是默认值模板，baseUrl/模型/Key 全可改
- `?autotest=1`：合成图 mock 识别出卡片的自检链路（title → AUTOTEST_PASS/FAIL）

## 构建与验证

```bash
npx tsc --noEmit          # 唯一客观回归门槛
npm run build             # tsc + vite build（产物 dist/，base 相对路径，Pages 与 APK 双兼容）
node scripts/verify-dishes.mjs   # 派生 vs 直录交叉校验
```

APK（Capacitor 8，需 JDK 21）：

```bash
npm run build && npx cap sync android
cd android && JAVA_HOME=<jdk21路径> cmd //c gradlew.bat assembleDebug
# 或项目根双击 build-apk.bat；MuMu 安装：adb -s 127.0.0.1:16384 install -r <apk>
```

手动 E2E 关键路径：发图出卡 → 对话修正（数值重算+校准写库）→ 确认入库（记录页核对）→ 档案指令 → 推荐卡（🎲再次随机/✓记录这餐）。持久化改动必须「写入→刷新→仍在」。

## 数据工具链（scripts/）

营养库数据的采集-质检-装配管线（运行时资产在 `src/data/`，勿手改）：

```bash
node scripts/crawl-boohee-full.mjs        # 薄荷公开接口枚举采集（断点续采+1.2s限速+429退避90s）
node scripts/quality-screen.mjs           # 质检：能量自洽/油酱/空热量等可解释规则 → quality-report.json
node scripts/build-full-reference.mjs     # 装配（已含质检）→ src/data/dishes-reference-full.json
```

其他：`fetch-usda*.mjs` → `build-ingredients.mjs`（原料库）；`fetch-boohee.mjs`/`refine/retry`（精选直录采集）→ `build-dishes-reference.mjs`；`verify-dishes.mjs`（交叉校验）。

## 目录速览

```
src/
├── App.tsx          # 三页签：💬对话(默认) / 📒记录 / ⚙设置
├── ai/              # chat.ts(六工具+修正语义层) / vlm / providers / prompt / schema
├── lib/             # nutrition_db(六级查找) / recommend(餐食推荐) / correction / boohee_api
│                    #   / backup / native_http / stats / image / cache / settings
├── data/            # sqlite / mealRepo / profileRepo(BMI+公式推荐) + 数据 JSON（勿手改）
└── ui/              # ChatPage(主入口编排) / MealCard(识别+推荐卡) / HistoryPage / SettingsPage
```

## 网络层（三环境一套代码）

`lib/native_http.ts resolveEndpoint`：dev 走 Vite 代理（`vite.config.ts`）；线上 web 构建直连真实端点（智谱/百炼/薄荷均实测支持浏览器 CORS）；APK 原生走 CapacitorHttp。

## 数据来源与授权说明

- `src/data/dishes-reference.json`（精选 108 道）与 `src/data/dishes-reference-full.json`（全量约 940 道）的数值采集自薄荷食物库公开接口（food.boohee.com，专业机构测算值），每条数据附带 `source_url` 可溯源；采集脚本见 `scripts/`（断点续采 + 限速 + 429 退避 + 质检规则）。
- 精选库经人工核定；全量库经自动质检（能量自洽性等规则，见 `scripts/quality-screen.mjs`）但未经逐条核定，命中时 UI 以「批量参考值」徽章与精选库区分，用户校准永远优先。
- 数值仅作饮食参考，不构成医疗建议。若薄荷方面对数据再分发有异议，请提 issue 联系处理。
