# 星空雨课堂助手

> 作者：**MJ**

长江雨课堂 / 学堂在线（`ai-workspace` 学习空间）的浏览器增强扩展。装上之后，视频播完会自动跳下一个，切标签页不会暂停，并且全程二倍速。

> 支持 `changjiang.yuketang.cn`、`*.yuketang.cn`、`*.xuetangx.com`、`*.gdufemooc.cn`
> 主要针对新版 `/ai-workspace/lms-graph/` 学习空间，同时兼容 `/pro/lms/*` 与 `/v2/web/*`。

> **当前可用版本：`1.0.3`（2026-11-16）**
> 已适配当前最新可用的长江雨课堂 `ai-workspace`（`/ai-workspace/lms-graph/`）页面结构：视频结束后可继续图文，图文完成“已读”后自动进入下一个可学习节点，并跳过自测、拓展。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| **播完自动下一个** | 视频结束后按完整课程顺序继续；图文进入并完成“已读”后自动下一个，自测和拓展不加载直接跳过 |
| **防切屏暂停** | 切到其它标签页、窗口失焦时，视频不再被网页暂停，可以后台挂着 |
| **强制二倍速** | 接管播放速率，网页把它改回 1 倍速也会自动恢复。切换视频后依然生效 |
| **星空提示球** | 右下角常驻状态球，显示当前状态开关；可拖动到任意位置，位置会记住 |

### 关于右下角的小球

- **点一下** —— 开关自动连播。关闭时球体变暗、状态灯变红、背景停止流动
- **长按约 0.2 秒后拖动** —— 把球挪到任意位置，松手自动记住
- **鼠标悬浮** —— 背景开始流动；悬浮在球体**上端**时流速变成 3 倍
- 位置想恢复默认右下角：控制台执行 `localStorage.removeItem('ytBadgePos')` 后刷新页面

---

## 安装

本扩展是「未打包扩展」，需要用浏览器的开发者模式加载。**推荐用 Edge**（开发与测试环境）。

### 步骤

1. **下载**
   到 [Releases](../../releases/latest) 下载最新的 `star-yuketang-helper.zip`，解压到任意目录。
   （也可以直接 `git clone` 本仓库，效果一样）

2. **打开扩展管理页**
   - Edge：地址栏输入 `edge://extensions/`
   - Chrome：地址栏输入 `chrome://extensions/`

3. **打开开发者模式**
   在页面左下角找到「开发人员模式 / Developer mode」开关，打开它。

4. **加载扩展**
   点页面上方（Edge 在左上角）的「**加载解压缩的扩展 / Load unpacked**」，
   选中你解压出来的那个文件夹 —— 注意要选**里面直接有 `manifest.json` 的那一层**。

5. **验证**
   回到雨课堂课程页面，按 `Ctrl + F5` 强制刷新。
   右下角出现一个深蓝色星空小球，就是成功了。

### 装完之后

打开任意课程视频页，点一下右下角的小球让它变成绿色状态，就可以放着不管了。

---

## 配置

所有配置都通过浏览器控制台（F12 → Console）执行，改完**需要刷新页面**。

| 想做什么 | 执行 |
| --- | --- |
| 改倍速（例：1.5 倍） | `localStorage.ytSpeed = '1.5'` |
| 关闭强制倍速 | `localStorage.ytSpeed = '1'` |
| 恢复默认 2 倍速 | `localStorage.removeItem('ytSpeed')` |
| 关闭防切屏 | `localStorage.ytAntiSwitch = 'off'` |
| 重新开启防切屏 | `localStorage.removeItem('ytAntiSwitch')` |
| 小球位置归位 | `localStorage.removeItem('ytBadgePos')` |

### 想改代码里的参数

常用参数集中在 `auto-next.js` 顶部的 `CFG` 对象里，改完在扩展管理页点一下「重新加载」即可：

```js
const CFG = {
  skipNonVideo: true,        // true = 只跳下一个「视频」，自动跳过作业/讨论
  playbackRate: 2,           // 默认倍速
  starLoopMs: 12000,         // 星空流动一圈的时长，越大越慢
  hoverSpeed: 1.2,           // 悬浮在球体上的流速倍率
  fastHoverZoneRatio: 0.42,  // 球体上方多少比例算「上端」
  fastHoverSpeed: 3,         // 悬浮在「上端」时的流速倍率
  longPressMs: 200           // 长按多少毫秒进入拖拽模式
};
```

---

## 实现说明

扩展分两套脚本，跑在**两个互相隔离的 JS 环境**里，这是理解本项目结构的关键：

| 文件 | 运行环境 | 职责 |
| --- | --- | --- |
| `anti-switch.js` | `MAIN`（网页环境） | 防切屏。改 `document.hidden`、吞掉 `visibilitychange`/`blur` 监听、拒绝后台 `video.pause()` |
| `force-speed.js` | `MAIN`（网页环境） | 接管 `HTMLMediaElement.prototype` 的 `playbackRate` / `defaultPlaybackRate` setter |
| `page-bridge.js` | `MAIN`（网页环境） | 读取页面 Vuex 中的完整课程列表，直接定位下一个视频 / 图文，并跳过自测和拓展 |
| `auto-next.js` | `ISOLATED`（扩展隔离环境） | 页面 UI（星空小球、提示条）、视频结束监听、找「下一个」入口并跳转 |

几个设计上的取舍：

- **为什么提示球和提示条不用 CSS `@keyframes`？**
  因为站点可能有 CSP 限制会拦掉注入的 `<style>`，所以全部改用内联样式 + Web Animations API 驱动动画。

- **为什么倍速要写两遍？**
  `MAIN` 和 `ISOLATED` 世界各有独立的一套 `HTMLMediaElement.prototype`，只改一边另一边看不见。

- **为什么还要设 `defaultPlaybackRate`？**
  按 HTML 规范，媒体元素加载新资源时会**在内核层**把 `playbackRate` 重置为 `defaultPlaybackRate`，这个重置绕过所有 JS setter —— 只改 `playbackRate` 的话，切换视频后就会被打回 1 倍速。

- **星空贴图怎么来的？**
  运行时用固定随机种子生成内联 SVG（`starTextureUrl()`），不联网、不占仓库体积，每次生成结果一致。

---

## 图标

仓库内保留了可直接使用的 `icon16/32/48/128.png` 成品图标。

---

## 免责声明

本项目为开源浏览器扩展，供学习与技术交流使用。

- 扩展通过修改网页行为实现自动化，**可能违反所访问平台的使用条款**，请自行评估风险
- 由此造成的一切后果（包括但不限于账号受限、学习成绩受影响）由使用者自行承担
- 请勿用于任何商业用途，也请不要用它替代真实的学习过程

如果你是在校学生，建议只把这套东西当作一个「浏览器扩展开发」的学习案例，而不是逃课工具。

---

## 许可

[MIT](LICENSE)

## 来源说明

本项目的早期版本 / 上游参考仓库：

- <https://github.com/Xuyisheng14/test>

上游旧版本采用 **MIT License**。本仓库在此基础上继续维护并适配最新可用的雨课堂 `ai-workspace` 页面，继续沿用同一 MIT 开源协议；原始版权与许可声明见 [LICENSE](LICENSE)。
