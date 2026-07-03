# Figma HTML Loop

> 让设计稿在 **Figma ⇆ HTML** 之间双向流动的一体化工具。
> 把 Figma 选区导出成 HTML、用 Agent 或浏览器编辑、再无损回流成 Figma 图层;也能把任意一份 HTML **还原成一个全新的 Figma 页面**。

**版本 `roundtrip-1.0`**

---

## 1. 这是什么

一个把「设计（Figma）」和「网页（HTML/CSS）」打通成闭环的本地工具。设计师无需了解 Node、API、manifest —— 在 Figma 里选中一个 Frame、点一下插件,剩下的交给 Agent。

```
Figma 选区  ──导出──▶  HTML/CSS  ──编辑──▶  采集/对比  ──回流──▶  Figma 图层
                                                        └──▶  Figma 新页面（从外部 HTML 还原整屏）
```

## 2. 能做什么

| 场景 | 说明 |
|---|---|
| **设计 → 代码** | 把 Figma 一屏导出成可运行的 HTML/CSS,保留图层身份、字体、图片、SVG |
| **改样式回流** | 在导出的 HTML 上改颜色 / 渐变 / 尺寸 / 位置 / 圆角 / 阴影 / 描边 / 文案,一键写回原 Figma 图层 |
| **新增 / 删除图层** | 在 HTML 里新增元素(可嵌套)回流成新图层;删掉的元素回流时同步删除 |
| **外部 HTML → 新页面** | 把一份与 Figma 无关的 HTML 整屏还原成一个全新 Figma 页面,不影响任何已有页面 |
| **批量多屏** | 一份 HTML 里的多个屏一次导入,自动排成画布网格 |

## 3. 工作原理

```
┌────────────┐   Figma 插件    ┌──────────────┐   浏览器采集    ┌──────────────┐
│  Figma 画布 │ ──────────────▶ │ Local Helper │ ◀────────────── │  HTML 预览页  │
│（插件读写）  │ ◀────────────── │  (Node 服务)  │ ──补丁──▶        │ (注入采集脚本) │
└────────────┘   应用补丁       └──────────────┘   对比/构建      └──────────────┘
```

- **采集**：浏览器里注入的脚本实时把 DOM 的样式、位置、结构 POST 给本地 helper。
- **对比 / 构建**：helper 把 CSS 翻译成 Figma 样式模型,生成「补丁」(patch) —— 更新 / 新建 / 删除。
- **应用**：Figma 插件用官方 Plugin API 把补丁落到画布。Agent 不能直接读写画布,必须经插件。

## 4. 功能

### Figma → HTML
- 选区导出 HTML/CSS + `loop-manifest.json`,保留 `data-figma-id`、图层名/路径、布局与样式快照
- 图片、SVG、字体一并打包导出
- **自动存档**:每次导出在 `figma-html-loop-export/_archive/<时间戳>__<框架名>/` 存一份自包含副本,新导出**不覆盖**旧的;历史副本可随时打开(`http://localhost:7800/export/_archive/<...>/index.html`),用 `exports` 命令列出。`figma-html-loop-export/` 顶层始终是"最新"那份,回流/采集流程照旧

### HTML → Figma 回流（更新原图层）
- 文本内容
- 颜色：纯色、**线性渐变**、径向渐变、锥形渐变
- 描边 / 边框(色 + 宽)
- 阴影 / 模糊：`box-shadow`、`filter: drop-shadow`、`backdrop-filter: blur`
- 圆角：统一 + 四角独立
- 不透明度、可见性
- 文本样式：字号、字体、字重、斜体、对齐、字间距、行高、下划线;**同一文本内多字号/多色的富文本**
- 位置 / 尺寸:采用父级相对坐标比较,只对真正移动的图层产出位移,不误伤嵌套节点

### 结构变更
- **新增图层**:支持嵌套(卡片内套图标 + 文字),自动排进 auto-layout 组
- **删除图层**:HTML 删元素则回流删除(带防误删保护:保护选区根与零尺寸节点)
- **图片图层**:本地文件 / `file://` / 绝对路径,以内容 hash 引用(补丁轻量)
- **SVG / 矢量**:内联 `<svg>` 或 `<img *.svg>` → Figma 矢量节点

### CSS 布局 → Figma Auto Layout
- `display:flex` 容器自动转成 Figma auto-layout:方向、间距、内边距、主/交叉轴对齐、换行
- 子节点自适应:拉伸(stretch)、撑满(grow)、绝对定位
- 含绝对定位覆盖层的容器保持定位 frame(正确还原 app 屏的 sheet / 蒙层)

### 外部 HTML → 新 Figma 页面
- 一份 HTML 直接还原成一个**全新的独立页面**,不动其他页面
- 无需 Figma 选区、无需 manifest
- 多屏可按列数排成网格一次导入

### 创建闭环
- 应用后把 Figma 分配的图层 id **写回源 HTML** 并生成 manifest —— 同一屏可**反复改、反复同步**,不会重复创建

### 可靠性
- **真差分(最小补丁)**:回流只产出**真正改动**的图层与属性。把整屏采集逐属性和导出基线比对,自动滤掉未变的颜色 / 渐变 / 圆角 / 描边 / 不透明度 / 位置尺寸,以及 auto-layout 子节点的无意义位移和浏览器渲染的亚像素抖动 —— 一次改一个区块,补丁就只含那个区块,无需人工筛选
- **补丁审批**:插件先展示「+新增 ~修改 −删除」摘要,需确认后才应用;删除项二次确认
- **事务性**:新页构建若失败则整页回滚,绝不留半成品;应用后给出成功/失败计数
- **采集稳定**:`capture-stable` 等采集内容 settle 后再继续,不靠固定等待

## 5. 目录结构

| 目录 | 职责 |
|---|---|
| `packages/bridge-engine` | Figma → HTML 引擎 |
| `packages/local-helper` | 本地 helper(Node HTTP 服务,端口 **7800**):采集、对比、构建、补丁排队 |
| `packages/plugin` | Figma 插件:选区导出 + 补丁应用 |
| `packages/cli` | `figma-html-loop` 命令入口 |
| `skills/figma-html-loop` | 给 Agent 用的 Skill(设计师友好话术 + 参考文档 + 插件资产副本) |
| `scripts/`、`test/` | 构建/同步脚本与回归测试 |

## 6. 快速开始

```bash
# 1. 构建引擎（首次）
npm run build

# 2. 启动本地 helper（端口 7800）
npm run start

# 3. 打印插件路径,去 Figma 导入
npm run plugin-path
```

在 **Figma 桌面版** → Plugins → Development → **Import plugin from manifest**,选打印出的 `manifest.json`。
插件面板顶部会显示当前版本 `✅ roundtrip-1.0`,据此确认导入的是最新版本。

## 7. CLI 命令

```bash
figma-html-loop doctor                    # 检查 helper 是否在跑
figma-html-loop start | stop | restart
figma-html-loop plugin-path               # 打印插件 manifest 路径
figma-html-loop export --out ./figma-html-loop-export       # Figma 选区 → HTML（自动存一份带时间戳的副本）
figma-html-loop exports                                     # 列出历史导出副本（含各自可打开的 URL）
figma-html-loop capture-latest --out ./html-capture.json    # 拉取浏览器实时采集
figma-html-loop capture-stable --out ./html-capture.json    # 等采集稳定后返回
figma-html-loop diff --manifest ./figma-html-loop-export/loop-manifest.json --out ./figma-patch.json   # 生成回流补丁
figma-html-loop annotate-ids --html ./screen.html           # 为外部 HTML 注入稳定锚点
figma-html-loop build-page --page-name "新页面" --cols 2 --out ./figma-patch.json   # 外部 HTML → 新页面 / 批量网格
figma-html-loop apply --patch ./figma-patch.json            # 把补丁交给插件（插件内确认后应用）
figma-html-loop writeback --html ./screen.html --manifest-out ./loop-manifest.json  # 应用后回写 id + 生成 manifest
```

## 8. 补丁格式（patch）

`diff` / `build-page` 产出 `{ schemaVersion: "0.3.0", operations: [...] }`,每个 operation 有 `action`:

- `update` — 按 Figma `id` 改现有图层(`text` + `style`)
- `create` — 新建图层(`kind`: rectangle/text/frame/image/svg,`parentId`、`name`、`text`、`segments`、`imageId`、`svgContent`、`style`,可含 `children` 嵌套)
- `delete` — 删除图层

顶层可选 `page: { create, name }`(新建页面构建);共享 `style` 模型涵盖 fills(纯色/渐变)、描边、圆角、effects、opacity/visible、文本属性、auto-layout。详见 `skills/figma-html-loop/references/interface-contract.md`。

## 9. 插件版本

版本号在插件 `code.js`、`ui.html` 与 helper `server.js` 三处保持一致(当前 `roundtrip-1.0`)。插件加载后 UI 顶部显示实际加载的版本并与期望比对(`✅ up to date` / `⚠️ re-import`),重新导入后据此确认是否为新版本。

## 10. 已知边界

- **渐变**:线性渐变精确;径向 / 锥形渐变以居中变换近似。
- **创建的是基础图层**:new / build 产出的是普通 frame / text / rect / image / vector,不是 Figma 组件实例;需要组件实例请在 Figma 内复制现有实例。
- **富文本**:还原同一文本内的多字号 / 多色;跨块的复杂排版仍以段落为粒度。
- **位置回流**:依赖导出 HTML 的 `data-figma-id` 嵌套与 Figma 父子结构一致(标准导出满足)。
- **真差分的边界**:字号 / 字重 / 字体 / 阴影等属性,manifest 基线未逐项快照,故仅在**该图层同时有已验证的改动**(文案、颜色、圆角、位置尺寸等)时随之回流;对某图层**只**改字重或只加阴影、别无他变的情形,需配合导出侧基线增强(路线图)。
- **端口**:helper 固定 **7800**(`FIGMA_HTML_LOOP_PORT` 可覆盖)。
