/* ============================================================
 * 雨课堂 · 防切屏检测（网页上下文 / MAIN world，document_start 注入）
 *
 * 作用：让网页「永远以为」浏览器窗口是可见且有焦点的，
 *       并且拦住网页因切标签页而主动暂停视频的行为。
 *
 * 【临时关掉】在页面控制台执行：localStorage.ytAntiSwitch = 'off'  然后刷新页面
 * 【重新打开】在页面控制台执行：localStorage.removeItem('ytAntiSwitch')  然后刷新页面
 * ============================================================ */
(() => {
  'use strict';

  const PREFIX = '[防切屏]';
  const log = (...a) => console.log(PREFIX, ...a);

  let off = false;
  try { off = localStorage.getItem('ytAntiSwitch') === 'off'; } catch (e) {}
  if (off) {
    log('已按 localStorage 设置跳过（ytAntiSwitch = off）');
    return;
  }

  // ---- 0. 先记住"真实"的可见性判断，改之前留一手 ----
  let realHiddenDesc = null;
  try { realHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'); } catch (e) {}
  const reallyHidden = () => {
    try { return realHiddenDesc ? realHiddenDesc.get.call(document) : false; } catch (e) { return false; }
  };

  // 先抢在打补丁之前，用原生 API 注册我们自己的切屏监听（仅用于打日志/兜底）
  const nativeDocAdd = document.addEventListener.bind(document);
  const nativeWinAdd = window.addEventListener.bind(window);

  const BLOCKED = new Set([
    'visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange',
    'blur', 'pagehide'
  ]);

  let blockedCount = 0;

  // ---- 1. 让可见性判断永远返回"可见" ----
  const force = (obj, map) => {
    for (const k of Object.keys(map)) {
      const v = map[k];
      try { Object.defineProperty(obj, k, { get: () => v, configurable: true }); } catch (e) {}
    }
  };
  force(document, {
    hidden: false,
    visibilityState: 'visible',
    webkitHidden: false,
    webkitVisibilityState: 'visible'
  });
  try { document.hasFocus = () => true; } catch (e) {}

  // ---- 2. 吞掉网页注册的切屏 / 失焦监听 ----
  const patchAdd = (obj, label) => {
    const orig = obj.addEventListener;
    if (typeof orig !== 'function') return;
    obj.addEventListener = function (type, ...rest) {
      if (BLOCKED.has(String(type).toLowerCase())) {
        blockedCount++;
        if (blockedCount <= 6) log('拦截了一个 ' + type + ' 监听（来源：' + label + '）');
        return;
      }
      return orig.apply(this, [type, ...rest]);
    };
  };
  patchAdd(window, 'window');
  patchAdd(document, 'document');

  // ---- 3. 堵掉 onvisibilitychange / onblur 这种属性式写法 ----
  const noop = { get: () => undefined, set: () => {}, configurable: true };
  try { Object.defineProperty(document, 'onvisibilitychange', noop); } catch (e) {}
  try { Object.defineProperty(document, 'onblur', noop); } catch (e) {}
  try { Object.defineProperty(window, 'onblur', noop); } catch (e) {}
  try { Object.defineProperty(window, 'onpagehide', noop); } catch (e) {}

  // ---- 4. 釜底抽薪：窗口在后台时，拒绝网页调用 video.pause() ----
  let blockedPauses = 0;
  try {
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      // 只有在"真的切到后台"、且视频确实是在播的时候才拦
      if (reallyHidden() && this.duration && !this.ended && !this.paused) {
        blockedPauses++;
        if (blockedPauses <= 5) log('已拦下一次后台暂停（视频继续播放）');
        return;
      }
      return origPause.apply(this, arguments);
    };
  } catch (e) {}

  // ---- 5. 兜底：后台被暂停了就拉回来（浏览器会节流定时器，所以只当保险） ----
  let wasPlaying = false;
  setInterval(() => {
    const v = document.querySelector('video');
    if (!v || !v.duration) return;
    const playing = !v.paused && !v.ended;

    if (!reallyHidden()) {      // 窗口在前台，如实记录状态
      wasPlaying = playing;
      return;
    }
    // 窗口在后台：离开前在播、现在却被暂停了 → 拉回来
    if (wasPlaying && !playing && v.currentTime > 0.3) {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }, 1000);

  // ---- 6. 打日志：让用户能在控制台看到确实生效了 ----
  nativeDocAdd('visibilitychange', () => {
    if (reallyHidden()) {
      log('窗口已切到后台 —— 第 4 步会拒绝后续的 pause() 调用；已拦截监听 ' + blockedCount + ' 个，已拦截暂停 ' + blockedPauses + ' 次');
    } else {
      log('窗口回到前台');
    }
  }, true);

  log('已启用：网页检测不到切屏/失焦（拦截监听 ' + blockedCount + ' 个）');

  // 给隔离世界的脚本留个"我活着"的标记
  const mark = () => {
    try {
      document.documentElement.setAttribute(
        'data-yt-antiswitch-active',
        'on:' + blockedCount + ':' + blockedPauses
      );
    } catch (e) {}
  };
  mark();
  setInterval(mark, 3000);

  nativeWinAdd('load', () => {
    mark();
    log('就绪。累计拦截切屏监听 ' + blockedCount + ' 个，拒绝后台暂停 ' + blockedPauses + ' 次');
  });
})();
