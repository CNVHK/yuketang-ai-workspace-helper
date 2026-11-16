/* ============================================================
 * 雨课堂 · 强制倍速（网页上下文 / MAIN world，document_start 注入）
 *
 * 做法：直接改写 HTMLMediaElement.prototype.playbackRate 的 setter。
 *       网页（包括播放器自己）无论怎么设置速度，最终都会被强制成目标倍速，
 *       不存在"设了又被改回去"的拉锯问题。
 *
 * 【改倍速】在页面控制台执行（然后刷新页面）：
 *     localStorage.ytSpeed = '1.5'      // 1.5 倍
 *     localStorage.ytSpeed = '3'        // 3 倍
 * 【关掉倍速】执行：
 *     localStorage.ytSpeed = '1'        // 1 倍 = 关闭强制倍速
 * 【恢复默认 2 倍】执行：
 *     localStorage.removeItem('ytSpeed')
 * ============================================================ */
(() => {
  'use strict';

  const PREFIX = '[强制倍速]';
  const log = (...a) => console.log(PREFIX, ...a);

  const DEFAULT_SPEED = 2;      // 默认倍速

  let target = DEFAULT_SPEED;
  try {
    const raw = localStorage.getItem('ytSpeed');
    if (raw !== null) {
      const s = parseFloat(raw);
      if (!isNaN(s) && s > 0.05 && s <= 16) target = s;
    }
  } catch (e) {}

  if (!(target > 1.01)) {
    log('目标倍速为 ' + target + '，视为关闭，不介入');
    return;
  }

  // ---- 1. 拿到原生的 setter，改写属性定义 ----
  let nativeDesc = null;
  let nativeDefaultDesc = null;
  try {
    nativeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    nativeDefaultDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'defaultPlaybackRate');
  } catch (e) {}

  if (!nativeDesc || !nativeDesc.set) {
    log('⚠️ 拿不到原生 playbackRate 属性，改用定时器方案');
  } else {
    try {
      Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
        configurable: true,
        enumerable: nativeDesc.enumerable,
        get() { return nativeDesc.get.call(this); },
        set(_ignored) {
          // 网页想设成多少都不管，一律按目标倍速来
          nativeDesc.set.call(this, target);
        }
      });
      log('已接管 playbackRate 接口，目标 ' + target + 'x');
    } catch (e) {
      log('⚠️ 改写 playbackRate 失败，改用定时器方案：' + e.message);
    }
  }

  // defaultPlaybackRate 也必须一起接管。
  // 按 HTML 规范，设置 defaultPlaybackRate 会在原生代码里顺带把 playbackRate 也设成同一个值，
  // 这个过程绕过所有 JS setter —— 只改 playbackRate 的话会被它绕过去。
  if (nativeDefaultDesc && nativeDefaultDesc.set) {
    try {
      Object.defineProperty(HTMLMediaElement.prototype, 'defaultPlaybackRate', {
        configurable: true,
        enumerable: nativeDefaultDesc.enumerable,
        get() { return nativeDefaultDesc.get.call(this); },
        set(_ignored) {
          nativeDefaultDesc.set.call(this, target);
        }
      });
      log('已接管 defaultPlaybackRate 接口（防止播放器用这个绕过）');
    } catch (e) {
      log('⚠️ 改写 defaultPlaybackRate 失败：' + e.message);
    }
  }

  // ---- 2. 主动把倍速设上去（属性初始值仍是 1，得我们自己设） ----
  const setNative = (media, rate) => {
    try {
      if (nativeDesc && nativeDesc.set) nativeDesc.set.call(media, rate);
      else media.playbackRate = rate;   // 没拿到原生 setter 时的退路
    } catch (e) {}
  };

  let setCount = 0;
  const applyAll = () => {
    let media;
    try { media = document.querySelectorAll('video, audio'); } catch (e) { return; }
    media.forEach(m => {
      if (Math.abs((m.playbackRate || 1) - target) > 0.01) {
        setNative(m, target);
        setCount++;
        if (setCount <= 5) log('已把倍速设为 ' + target + 'x');
      }
      try { m.defaultPlaybackRate = target; } catch (e) {}
    });
  };

  applyAll();

  // 视频是 SPA 动态换的，持续盯着
  setInterval(applyAll, 1500);

  try {
    new MutationObserver(applyAll).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // ---- 3. 播放/加载媒体时再补一次（有些播放器会在这一刻重置） ----
  ['loadstart', 'loadedmetadata', 'play', 'ratechange'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const t = e.target;
      if (t && t.tagName && /^(VIDEO|AUDIO)$/.test(t.tagName)) setNative(t, target);
    }, true);
  });

  log('已启用：目标倍速 ' + target + 'x（想改：控制台执行 localStorage.ytSpeed = "1.5" 后刷新）');

  // 给隔离世界的脚本留个"我活着"的标记（DOM 是两个世界共享的）
  const mark = (state) => {
    try { document.documentElement.setAttribute('data-yt-speed-active', state + ':' + target); } catch (e) {}
  };
  mark('on');
  setInterval(() => mark('on'), 3000);

  window.addEventListener('load', () => {
    applyAll();
    const v = document.querySelector('video');
    log('就绪。当前视频实际倍速：' + (v ? v.playbackRate : '(还没找到视频)') + 'x');
  });
})();
