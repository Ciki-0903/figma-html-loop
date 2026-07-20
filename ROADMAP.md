# Roadmap / Ideas

记录尚未落地、但值得做的长期方案。

## 布局保真自检 harness（Layout Fidelity Self-Check）

**要解决的问题**

Figma → HTML 导出偶发保真 bug（元素被撑大、容器错位等），目前都是**反应式**发现的:用户在截图里看到 → 人工排查 → 打一个补丁。慢一拍,且容易回归。

这类 bug 有两条系统性来源:

1. **语义鸿沟**:Figma 能容忍 / 自动修正的布局数据(如 padding 超过帧尺寸、约束坐标换算),浏览器 CSS 不会,需要在导出时补齐。
2. **双路径漂移**:定位等布局属性由两段代码分别生成(inline CSS 的 `layoutToCss` 与 utility-class 的 `layoutToTailwindClasses`),两边一旦不同步,就拼出"半套错误"(例:CENTER 约束的 `left:50%` 被 `left-[16px]` 挤掉却保留了 `margin-left`)。

**核心洞察**

每次导出的 `loop-manifest.json` **已经记录了每个图层在 Figma 里的精确坐标与尺寸**——这就是 ground truth,不需要额外的人工基线。

**方案**

导出后,用无头浏览器渲染这份 HTML,量出每个节点的实际渲染盒(`getBoundingClientRect`),与 manifest 里的 Figma 坐标逐一对比,**偏差超过阈值(如 >3px)的节点直接报出来**。

- 同时覆盖两类问题:新出现的语义鸿沟(当场抓到)+ 引擎改动引入的回归(测试挂掉)。
- 这一轮的两个 bug 它都会当场命中:按钮"渲染宽 271 ≠ Figma 74"、卡片"渲染 x=-155 ≠ Figma 16"。

**落地步骤**

1. 存几份代表性导出(含组件实例、各类约束、auto-layout、图片/SVG)作为 fixture,写进 `npm test`:渲染 → 逐节点对比 manifest bounds,超差即失败。
2. 加几条廉价的不变量单测(无需渲染):
   - auto-layout 帧的左右 padding 之和 ≤ 帧宽、上下 padding 之和 ≤ 帧高;
   - 同一元素不同时出现互相矛盾的 `left` + `margin-left`(或 `top` + `margin-top`)。
3. (可选,结构性根治双路径漂移)把 inline-CSS 与 utility-class 两条定位路径合并成一条——class 路径只压缩同一份权威 CSS 的输出,而不是并行再算一遍。

**为什么值得**

把"几天后在截图里发现"变成"导出当场报错 / 测试挂掉"。个别语义鸿沟无法穷举,但有了自动核对,每个 bug 一出现就被抓到并可用 fixture 锁死,还原度只会越来越高、不再回退。
