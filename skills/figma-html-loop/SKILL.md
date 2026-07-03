---
name: figma-html-loop
description: >-
  Use when the user wants to move designs between Figma and HTML with Agent
  help. Covers five scenarios: (A) export a Figma selection to HTML/CSS; (B)
  edit the HTML and reflow color/gradient/size/position/radius/shadow/stroke/
  text changes back onto the original Figma layers; (C) add new layers; (D)
  delete layers; and (E) reconstruct an EXTERNAL HTML screen into a BRAND-NEW
  Figma page (no prior Figma selection or manifest needed) without touching
  other pages. Trigger words include: 把 Figma 导出成 HTML、回流 / 反向同步 /
  改完写回 Figma、新增图层、删除图层、把这个 HTML / 这一屏还原到 Figma、生成到
  Figma、新建一个 Figma 页面、不要覆盖其他页面、export selection to code, sync
  back to Figma, import this screen into Figma as a new page. Also use for setup
  or troubleshooting of the bundled Figma plugin, local helper, CLI commands,
  manifest, selection confirmation, HTML capture, build-page, patch preview, or
  Codex/Claude compatibility.
---

# Figma HTML Loop

## Promise

Help a designer move a design through this loop:

```text
Figma selection -> HTML/CSS -> Agent edits -> back to Figma
```

Use simple language. The user should not need to know what Figma-Bridge, Node servers, APIs, or manifests are.

This Skill is self-contained in product language: it uses the plugin and local helper that come with this Skill. Do not tell the user to download `kingkongshot/Figma-Bridge`.

## 使用场景（先对号入座，再走对应流程）/ Scenarios

先用「触发词」判断用户属于哪个场景，再走该场景的流程。同一句话可能命中多个场景（如"改完 A、删掉 B、再加 C"），按 update / create / delete 组合成一个补丁一起 apply。

### 场景 A ｜设计导出成 HTML（Figma → HTML）
- **触发词**：把这个 Figma 导出成 HTML、导出选区、Figma 转网页、Figma to HTML、export selection to code。
- **用法**：确认 helper 在跑 → 让用户在 Figma **选中一个 Frame/组件** → 插件点 **Export Selection** → `export`。产物含 `index.html`、`styles.css`、`loop-manifest.json`。
- **自动存档**：每次导出都会在 `figma-html-loop-export/_archive/<时间戳>__<框架名>/` 存一份自包含副本,**新导出不覆盖旧的**。顶层目录始终是"最新"那份(回流/采集用它)；历史副本用 `exports` 命令列出、按各自 URL 打开。用户说"导出被覆盖了/想保留之前的页面"时,指给他们看 `_archive` 或 `exports` 列表。

### 场景 B ｜改样式回流到原图（HTML → Figma · 局部更新）
- **触发词**：把 HTML 改的颜色/尺寸/位置/文案**同步回 Figma**、回流、反向同步、改完写回 Figma、sync back、update the original Figma。
- **用法**：改导出的 HTML → 浏览器打开预览页 → `capture-stable`（或 `capture-latest`）→ `diff`（不带 `--manifest` 用最新采集）→ **先向用户总结补丁** → `apply`。
- **能改什么**：文本、纯色/渐变、描边、阴影、四角圆角、opacity、字重/斜体/对齐/字间距/行高、位置/尺寸（按父级相对坐标比较,只对真正移动的图层产出位移）。
- **真差分**：`diff` 已逐属性对比导出基线,只产出**真正改动**的 op（自动滤掉未变属性、auto-layout 子节点位移、亚像素抖动)。改一个区块补丁就只含那个区块,**无需再人工筛选**;直接把补丁摘要给用户即可。

### 场景 C ｜新增图层（HTML → Figma · 新元素）
- **触发词**：给 Figma 加一个/几个新元素、补齐……选项、新增图层、add layers。
- **用法**：在 HTML 里新增元素，加 `data-figma-create="frame|text|image"` + `data-figma-name`（可嵌套：卡片=frame，里面放 text/image）→ 采集 → `diff` → `apply`。

### 场景 D ｜删除图层（HTML → Figma）
- **触发词**：把……删掉、删除底部按钮、remove this layer。
- **用法**：HTML 删掉元素 → 采集 → `diff`（默认检测删除，保护根节点与零尺寸节点）→ **删除项务必先和用户确认** → `apply`。

### 场景 E ｜从一份 HTML 新建一个 Figma 页面（外部 HTML → 新页面）
- **触发词**：把这个 HTML / 这一屏 / 这个页面**还原到 Figma**、生成到 Figma、**新建一个 Figma 页面**、不要覆盖其他页面、import this screen into Figma as a new page、turn this HTML into a Figma page。
- **适用**：来源 HTML **与 Figma 无关**（PRD 里的一屏、别处的网页、flow 稿的某屏），要**新建一个独立 Figma 页面**来装，**不动任何已有页面**。和 B/C 的区别：**不需要 Figma 选区、不需要 manifest**。
- **用法**：见下方 **「New Screen From HTML」** 专节。

## New Screen From HTML（场景 E 详细流程）

当用户想把一份现成 HTML「还原成一个新的 Figma 页面」时，走这个流程（不需要先从 Figma 导出）：

1. 确认 helper 在跑（`doctor`）。让用户在 Figma **打开要放的文件**（新建空文件也行）。
2. **标注来源 HTML**：给每个要变成图层的元素加两个属性：
   - `data-figma-create="frame"`（容器/背景块/卡片）、`"text"`（文字）、`"image"`（`<img>`）；
   - `data-figma-name="图层名"`（Figma 图层面板显示名）。
   - 结构按视觉层级嵌套即可（用真实布局，采集会读实际像素位置）；`display:flex` 会被翻成 Figma auto-layout。
3. **注入稳定锚点**：`annotate-ids --html <文件>`（给每个 create 元素补 `data-figma-create-id`，供之后写回定位）。
4. **注入采集脚本**：在 HTML 末尾加 `<script src="http://localhost:7800/figma-html-loop-capture.js"></script>`。
5. **浏览器打开该 HTML**（`file://` 也可，脚本会自动把 DOM POST 给 helper）。
6. `build-page --page-name "页面名" --out ./figma-patch.json`（生成含 `page.create` 的**嵌套 create 补丁**，无需 manifest）。
   - **批量多屏**：若一份 HTML 里有多个 `data-figma-create` 顶层屏，加 `--cols N --gap G`，会把它们排成 N 列网格一次导入同一新页（列宽=最大屏宽，行高按各行最高屏自适应）。
7. **向用户总结**将新建的页面与图层数 → `apply`。插件收到后**先展示「+新增 ~修改 −删除」摘要,用户在插件里点 Apply 确认后**才新建该页并构建,其他页面不受影响。
8. **闭环回写**（可选但推荐）：apply 成功后 `writeback --html <文件> --manifest-out ./loop-manifest.json` —— 把 Figma 分配的 id 写回 HTML 并生成 manifest。之后再改这一屏（改色/尺寸/文案）走场景 B（`capture-stable` → `diff --manifest ./loop-manifest.json` → `apply`），会**更新原图层**而不是重复创建。

> 提醒：新建出的是普通 frame/text/image/vector 图层（非组件实例）。图片以内容 hash 引用,补丁保持轻量。插件更新后需让用户**重新导入插件**,并对照插件顶部显示的版本(`✅ roundtrip-1.0`)确认导入成功。

## Parts

- **Figma plugin**: installed once inside Figma from `assets/figma-plugin/manifest.json`.
- **Local helper**: the canonical helper is `packages/local-helper/src/server.js`, started via the CLI (`figma-html-loop start`). The `scripts/` folder is a thin compatibility shim that runs the same canonical helper.
- **CLI commands**: used by the Agent to check status, wait for selection, export HTML, capture edited HTML, make a patch, and apply changes.

The Agent cannot read or edit the Figma canvas by itself. Figma canvas access must go through the bundled Figma plugin.

## First Response

Decide whether the user is setting up for the first time.

If yes, read `references/setup.md` and walk the user through one step at a time.

If the user already installed the plugin, run this from the Skill folder:

```bash
cd /Users/bytedance/figma-html-loop
node packages/cli/bin/figma-html-loop.js doctor
```

Explain the result in friendly terms:

- "The local helper is running."
- "The local helper is not running yet. I can start it, then you can reopen the Figma plugin."

## Normal Loop

Use this flow:

1. Start or check the local helper.
2. Ask the user to open Figma.
3. Ask the user to select one Frame or component.
4. Ask the user to open **Figma HTML Loop** from Figma's plugin menu.
5. Ask the user to click **Export Selection**.
6. Wait for the confirmed selection.
7. Export HTML/CSS and the manifest.
8. Edit the HTML/CSS as requested.
9. Capture the edited page in a browser.
10. Build a patch from the capture and manifest.
11. Summarize the patch and ask for approval.
12. Apply the approved patch through the Figma plugin.
13. Ask the user to inspect the result in Figma.

Use these CLI names when available:

```bash
figma-html-loop doctor --json
figma-html-loop start-helper --json
figma-html-loop plugin-path --json
figma-html-loop wait-selection --timeout 60 --json
figma-html-loop export --out ./figma-html-loop-export --json
figma-html-loop exports --json                                            # 列出历史导出副本(时间戳+框架名+可打开 URL)
figma-html-loop capture-stable --out ./html-capture.json --json           # 等浏览器采集稳定后返回（推荐）
figma-html-loop capture-latest --out ./html-capture.json --json           # 直接拉取最新采集
figma-html-loop diff --manifest ./figma-html-loop-export/loop-manifest.json --out ./figma-patch.json --json
figma-html-loop build-page --page-name "新页面名" --cols 2 --out ./figma-patch.json --json   # 场景 E：外部 HTML → 新页面 / 批量网格
figma-html-loop annotate-ids --html ./screen.html --json                            # 场景 E：写回前注入稳定 create-id
figma-html-loop apply --patch ./figma-patch.json --json
figma-html-loop writeback --html ./screen.html --manifest-out ./loop-manifest.json --json  # 场景 E：apply 后回写 id + 生成 manifest（闭环）
```

Scenario map:
- A 导出 → `export`
- B 局部回流 / C 新增 / D 删除 → `capture-stable` → `diff` → `apply`
- E 外部 HTML → 新页面 → `annotate-ids` → 注入采集脚本 → 浏览器打开 → `build-page` → `apply` →（闭环）`writeback`

命令通过 `node packages/cli/bin/figma-html-loop.js <cmd>` 运行(未全局安装时)。首次可先 `npm run build` 构建引擎、`npm run start` 起 helper。

## Selection Rules

Prefer one top-level Frame or component.

If the user selects many loose layers, say:

> This will work better if you select the parent Frame that contains those layers.

Do not continue from a random selection change. Continue only after the user clicks **Export Selection** in the plugin.

## Before Applying Back To Figma

Always summarize the proposed changes first:

- text updates
- color/style updates
- size or position updates
- new layers
- deleted, hidden, or image-replaced layers
- **new page created** (场景 E：将新建一个 Figma 页面 + N 个图层)
- anything that may not remain fully editable

Ask for approval before applying:

> Should I apply these changes back to Figma?

补丁 `apply` 后会排队给插件,**插件会再展示一次「+新增 ~修改 −删除」摘要,由用户在插件里点 Apply 确认**(删除项二次确认);构建失败会整页回滚,不留半成品。

For **场景 E（build-page 新建页面）**, also tell the user:

- 会**新建一个独立页面**,**不动其他任何页面**；
- 产出是普通 frame/text/image/vector 图层（**非组件实例**）。

## Preserve Structure

Use the saved manifest and `data-figma-id` whenever possible.

Prefer updating the original Figma node. Create a new Figma node only when there is no original match.

If `data-figma-id` was removed from the HTML, warn the user that the return trip may be less editable or less exact.

## Communication Style

Use designer-friendly wording:

- Say "local helper" instead of "server".
- Say "plugin file" before saying "`manifest.json`".
- Say "open Terminal and paste this command" only when a command is necessary.
- Say "the plugin should show Connected" instead of "the health endpoint should return 200".

When blocked, give one next action first. Load `references/troubleshooting.md` when needed.

## Compatibility

Keep the workflow usable in both Codex and Claude:

- Prefer CLI commands with JSON output.
- Keep core behavior independent of MCP tools.
- Use local files and local HTTP endpoints as the shared interface.
- Avoid Codex-only assumptions in user-facing setup steps.

## References

- Read `references/setup.md` for first-time setup on a new device.
- Read `references/troubleshooting.md` when a step is blocked.
- Read `references/interface-contract.md` when implementing or wiring the bundled helper, plugin, or CLI.
