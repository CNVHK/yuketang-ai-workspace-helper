/* ============================================================
 * 雨课堂 · 视频播完自动下一个
 * 本地浏览器扩展（Manifest V3）的内容脚本
 *
 * 作用：视频播放到结尾后，自动跳转到下一个视频。
 * 依次尝试以下策略寻找「下一个」入口：
 *   A. 自定义选择器（见下方 CFG.nextSelectors）
 *   B. 旧版章节列表里当前高亮项的下一项
 *   C. 新版 ai-workspace 底部的「下一单元」箭头
 *   D. 页面上文字为「下一节 / 下一个 / 继续学习…」的按钮
 *   E. 全页面 /video/数字 链接按顺序取下一个（不依赖类名，抗改版）
 * 快捷键：Alt+J 开关脚本；Alt+D 打印诊断信息（排查用）。
 * ============================================================ */

(function () {
  'use strict';

  /* ===================== 用户可调参数 ===================== */
  const CFG = {
    enabled: true,            // 总开关（也可以用 Alt+J 切换）
    delayBeforeJump: 1200,    // 视频结束后等多少毫秒再跳（太快有时页面还在写状态）
    retryTimes: 3,            // 找不到入口时的重试次数
    retryInterval: 1500,      // 每次重试间隔（毫秒）
    autoPlayAfterJump: true,  // 跳转后尝试自动播放（浏览器可能拦截带声音的自动播放）
    // 文字匹配：按钮/链接上出现这些词就算「下一个」入口
    nextTexts: ['下一节', '下一个', '下一讲', '下一课', '下一章', '下一集', '继续学习', '继续观看', '播放下一', 'Next'],
    // 如果自动识别不准，把你的「下一节」按钮选择器填进来，例：['.next-btn', 'button[data-role="next"]']
    nextSelectors: [],
    // 雨课堂章节列表专用：true = 只跳下一个「视频」，自动跳过「作业 / 讨论 / 测验」等非视频节点
    // 想让它老老实实按顺序跳「下一项」（哪怕是作业），把这里改成 false
    skipNonVideo: true,
    // 倍速：默认 2 倍。可在控制台用 localStorage.ytSpeed = '1.5' 覆盖（改完刷新页面）
    playbackRate: 2,
    autoSpeed: true,          // false = 完全不碰倍速
    graphReadWaitMs: 8000,    // 图文最多等多久写完成状态
    graphAdvanceDelay: 1000,  // 图文页至少停留多久再跳
    coursewareReadWaitMs: 8000, // 课件最多等多久写完成状态
    coursewareAdvanceDelay: 1000, // 课件页至少停留多久再跳
    skipAdvanceDelay: 500,    // 误入自测/拓展时，多快跳走

    // ---- 圆形角标的动画参数 ----
    starLoopMs: 12000,        // 星空背景循环流动一圈的时长（越大越慢）
    sweepLoopMs: 3000,        // 光带扫过一轮的时长
    hoverSpeed: 1.2,          // 鼠标悬浮在球体上的播放倍率
    fastHoverZoneRatio: 0.42, // 球体上方多大比例算「上端」（0.42 = 上方 42% 的高度）
    fastHoverSpeed: 3,        // 鼠标悬浮到「上端」时的播放倍率
    sweepIdleOpacity: 0.45,   // 不悬浮时光带的可见度（改成 0 就只在悬浮时出现）
    longPressMs: 200          // 长按多少毫秒后进入拖拽模式
  };
  /* ======================================================= */

  const TAG = '[自动连播]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const IS_TOP = window === window.top;
  let enabled = CFG.enabled;
  let running = false;
  let bridgeSeq = 0;
  const bridgePending = new Map();
  let lastRouteKey = location.href;
  let nonVideoAdvanceKey = '';
  let nonVideoAdvanceSince = 0;
  let nonVideoAdvanceBusy = false;

  // 目标倍速：优先读 localStorage.ytSpeed（和 force-speed.js 用同一个配置源）
  let speedSource = 'CFG 默认值';
  const SPEED_TARGET = (() => {
    if (!CFG.autoSpeed) { speedSource = 'CFG.autoSpeed = false'; return 1; }
    try {
      const raw = localStorage.getItem('ytSpeed');
      if (raw !== null) {
        const s = parseFloat(raw);
        if (!isNaN(s) && s > 0.05 && s <= 16) {
          speedSource = 'localStorage.ytSpeed = ' + raw;
          return s;
        }
        speedSource = 'localStorage.ytSpeed = ' + JSON.stringify(raw) + '（无法解析，已忽略）';
      }
    } catch (e) {}
    return CFG.playbackRate;
  })();
  const SPEED_ON = SPEED_TARGET > 1.01;
  let rateFixed = 0;

  /* ---------------------- 倍速（隔离世界这一份，双保险） ---------------------- */

  // 隔离世界也有自己的一套 HTMLMediaElement.prototype，
  // 所以网页环境那边改了 setter，这边还得自己设一遍，否则会互相看不见。
  //
  // ⚠️ 关键点：播放器切换视频时通常会 video.src = 新地址 + video.load()，
  //    而按 HTML 规范，走资源加载流程时浏览器内部会把 playbackRate
  //    重置成 defaultPlaybackRate —— 这个重置发生在原生代码里，
  //    绕过所有 JS setter，所以我们改的 setter 完全挡不住。
  //    因此必须把 defaultPlaybackRate 也一起设上，这是上一版漏掉的地方。
  function enforceRate(media) {
    if (!SPEED_ON || !media) return;
    try {
      if (Math.abs((media.defaultPlaybackRate || 1) - SPEED_TARGET) > 0.01) {
        media.defaultPlaybackRate = SPEED_TARGET;
      }
      if (Math.abs((media.playbackRate || 1) - SPEED_TARGET) < 0.01) return;
      media.playbackRate = SPEED_TARGET;
      rateFixed++;
      if (rateFixed <= 8) log('倍速已设为 ' + SPEED_TARGET + 'x（第 ' + rateFixed + ' 次）');
    } catch (e) {}
  }

  function currentRate() {
    const v = document.querySelector('video');
    return v ? Number(v.playbackRate) || 1 : null;
  }

  function enforceAllRates() {
    if (!SPEED_ON) return;
    let list;
    try { list = document.querySelectorAll('video, audio'); } catch (e) { return; }
    list.forEach(enforceRate);
  }

  /* ---------------------- 工具函数 ---------------------- */

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) < 0.05) return false;
    return true;
  }

  function disabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/disabled|disable|is-lock|locked|ban/i.test(cls)) return true;
    return false;
  }

  function textOf(el) {
    return ((el.innerText || el.textContent || '') + '').replace(/\s+/g, '');
  }

  /* ---------------------- 页面状态桥 ---------------------- */

  const BRIDGE_REQUEST = '__ytPageBridgeRequest';
  const BRIDGE_RESPONSE = '__ytPageBridgeResponse';

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== BRIDGE_RESPONSE || !msg.id) return;
    const pending = bridgePending.get(msg.id);
    if (!pending) return;
    bridgePending.delete(msg.id);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  });

  function bridgeRequest(action, timeoutMs) {
    return new Promise(resolve => {
      const id = 'yt-' + Date.now() + '-' + (++bridgeSeq);
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        resolve({ ok: false, error: 'bridge-timeout' });
      }, timeoutMs || 1800);
      bridgePending.set(id, { resolve, timer });
      window.postMessage({ channel: BRIDGE_REQUEST, id, action }, '*');
    });
  }

  function currentRouteKind() {
    const path = location.pathname;
    const tag = textOf(document.querySelector('.learning-space-control-unit .unit-tag'));
    if (/课件/.test(tag)) return 'courseware';
    if (/\/video\/\d+/.test(path)) return 'video';
    if (/\/graph\/\d+/.test(path)) return 'graph';
    if (/\/self-test\//.test(path)) return 'self-test';
    if (/\/extend\//.test(path)) return 'extend';
    return 'other';
  }

  // 从元素向上找到真正可点击的那一层
  function climbClickable(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node.parentElement; i++) {
      const tag = node.tagName;
      const role = node.getAttribute && node.getAttribute('role');
      if (tag === 'BUTTON' || tag === 'A' || role === 'button' || node.onclick) return node;
      node = node.parentElement;
    }
    return el;
  }

  // 用接近真实鼠标的方式点击，尽量触发前端框架的事件
  function clickReal(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const opt = {
      bubbles: true, cancelable: true, view: window, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opt));
      el.dispatchEvent(new MouseEvent('mousedown', opt));
      el.dispatchEvent(new PointerEvent('pointerup', opt));
      el.dispatchEvent(new MouseEvent('mouseup', opt));
      el.dispatchEvent(new MouseEvent('click', opt));
    } catch (e) {
      try { el.click(); } catch (e2) { warn('点击失败', e2); }
    }
  }

  function toast(msg) {
    if (!IS_TOP) return;
    let box = document.getElementById('__yt_autonext_toast');

    if (!box) {
      box = document.createElement('div');
      box.id = '__yt_autonext_toast';
      box.style.cssText = [
        'position:fixed', 'left:18px', 'bottom:18px', 'z-index:2147483647',
        'display:inline-flex', 'align-items:center', 'gap:9px',
        'padding:9px 16px 9px 13px', 'border-radius:11px',
        'max-width:60vw', 'box-sizing:border-box',
        'font:500 13px/1.35 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
        'letter-spacing:.2px', 'color:#eaf1ff',
        'pointer-events:none', 'user-select:none',
        'overflow:hidden', 'isolation:isolate',
        'background-color:#080d22',
        'box-shadow:0 8px 26px rgba(4,8,26,.55), inset 0 0 0 1px rgba(140,170,255,.28)',
        'transition:opacity .32s, transform .32s',
        'opacity:0', 'transform:translateY(6px)'
      ].join(';');

      // ① 星空贴图层（和右下角圆球用的是同一张）
      const tStars = document.createElement('span');
      tStars.style.cssText = [
        'position:absolute',
        'left:' + (-TILE - 24) + 'px', 'right:' + (-TILE - 24) + 'px',
        'top:-34px', 'bottom:-34px',
        'background-image:' + starTextureUrl(),
        'background-repeat:repeat',
        'background-size:' + TILE + 'px ' + TILE + 'px',
        'opacity:.62', 'pointer-events:none', 'z-index:0'
      ].join(';');
      box.appendChild(tStars);

      // ② 流动光带层
      const tFlow = document.createElement('span');
      tFlow.style.cssText = [
        'position:absolute', 'top:-34px', 'bottom:-34px', 'left:0', 'width:44%',
        'pointer-events:none', 'z-index:1', 'opacity:.55',
        'transform:translateX(-160%)',
        'background:linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(150,190,255,.10) 26%, rgba(255,255,255,.42) 50%, rgba(150,190,255,.10) 74%, rgba(255,255,255,0) 100%)'
      ].join(';');
      box.appendChild(tFlow);

      // ③ 最左侧：发光的五角恒星（替掉原来的 🎬）
      const tStar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      tStar.setAttribute('viewBox', '0 0 24 24');
      tStar.setAttribute('width', '16');
      tStar.setAttribute('height', '16');
      tStar.style.cssText = [
        'position:relative', 'z-index:2', 'flex:0 0 auto',
        'filter:drop-shadow(0 0 7px rgba(255,214,120,.9))'
      ].join(';');
      tStar.innerHTML = '<defs><linearGradient id="ytToastStar" x1="0.2" y1="0" x2="0.6" y2="1">'
        + '<stop offset="0" stop-color="#fffdf4"/>'
        + '<stop offset="1" stop-color="#ffc95e"/>'
        + '</linearGradient></defs>'
        + '<path d="M12 2 L14.25 8.91 L21.51 8.91 L15.63 13.18 L17.88 20.09 '
        + 'L12 15.82 L6.12 20.09 L8.37 13.18 L2.49 8.91 L9.75 8.91 Z" '
        + 'fill="url(#ytToastStar)"/>';
      box.appendChild(tStar);

      // ④ 文字
      const tTxt = document.createElement('span');
      tTxt.style.cssText = 'position:relative;z-index:2;text-shadow:0 1px 3px rgba(0,0,0,.72)';
      box.appendChild(tTxt);
      box.__txt = tTxt;

      // 常驻动画（隐藏时暂停，省电）
      const tAnims = [];
      try {
        tAnims.push(tStars.animate(
          [{ transform: 'translateX(0px)' }, { transform: 'translateX(-' + TILE + 'px)' }],
          { duration: 7000, iterations: Infinity, easing: 'linear' }
        ));
        tAnims.push(tFlow.animate(
          [{ transform: 'translateX(-160%)' }, { transform: 'translateX(300%)' }],
          { duration: 2200, iterations: Infinity, easing: 'cubic-bezier(.45,0,.25,1)' }
        ));
      } catch (e) {}
      tAnims.forEach(a => { try { a.pause(); } catch (e) {} });
      box.__anims = tAnims;

      (document.body || document.documentElement).appendChild(box);
    }

    if (box.__txt) box.__txt.textContent = msg;
    box.style.opacity = '1';
    box.style.transform = 'translateY(0)';
    (box.__anims || []).forEach(a => { try { a.play(); } catch (e) {} });

    clearTimeout(box.__t);
    box.__t = setTimeout(() => {
      box.style.opacity = '0';
      box.style.transform = 'translateY(6px)';
      (box.__anims || []).forEach(a => { try { a.pause(); } catch (e) {} });
    }, 2800);
  }

  /* ---------------------- 视频监听 ---------------------- */

  const watched = new WeakSet();
  const finished = new WeakSet();

  function attach(video) {
    if (!video || watched.has(video)) return;
    watched.add(video);

    video.addEventListener('ended', () => {
      if (finished.has(video)) return;
      finished.add(video);
      onVideoEnd('ended 事件');
    });

    // 有些播放器把 ended 吞掉了，用 timeupdate 兜底
    video.addEventListener('timeupdate', () => {
      if (!video.duration || video.duration < 3) return;
      if (finished.has(video)) return;
      if (video.currentTime >= video.duration - 0.7) {
        finished.add(video);
        onVideoEnd('进度到达结尾');
      }
    });

    // 用户拖回去重看时，重新武装
    video.addEventListener('play', () => {
      if (video.duration && video.currentTime < video.duration - 5) finished.delete(video);
    });

    video.addEventListener('loadedmetadata', () => { finished.delete(video); });

    // ---- 倍速：新视频一加载就设上，被改回去也跟着改回来 ----
    enforceRate(video);
    ['loadedmetadata', 'loadeddata', 'durationchange', 'loadstart', 'emptied', 'abort',
     'canplay', 'canplaythrough', 'play', 'playing', 'seeking', 'seeked', 'waiting',
     'stalled', 'suspend', 'progress', 'volumechange'].forEach(evt => {
      video.addEventListener(evt, () => enforceRate(video));
    });
    video.addEventListener('ratechange', () => {
      // 播放器想把速度改回 1x？稍等一下再改回来（避免和它自己打架成死循环）
      setTimeout(() => enforceRate(video), 150);
    });

    log('已接管视频', video.currentSrc || video.src || '(无 src)');
  }

  function scanVideos(root) {
    const scope = root || document;
    try { scope.querySelectorAll('video').forEach(attach); } catch (e) {}
    // 影子 DOM 里的 video
    try {
      scope.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          el.shadowRoot.querySelectorAll('video').forEach(attach);
        }
      });
    } catch (e) {}
  }

  /* ---------------------- 自动跳转策略 ---------------------- */

  // 策略 A：自定义选择器
  function byCustomSelector(doc) {
    if (!CFG.nextSelectors.length) return null;
    for (const sel of CFG.nextSelectors) {
      let el = null;
      try { el = doc.querySelector(sel); } catch (e) { continue; }
      if (el && visible(el) && !disabled(el)) return { el, how: '自定义选择器 ' + sel };
    }
    return null;
  }

  // 策略 B：靠文字找按钮
  function byText(doc) {
    const cands = doc.querySelectorAll('button, a, [role="button"], div, span, li, p');
    let best = null;
    for (const el of cands) {
      const t = textOf(el);
      if (!t || t.length > 10) continue;          // 太长的是容器，不是按钮
      if (!CFG.nextTexts.some(k => t.includes(k))) continue;
      if (!visible(el) || disabled(el)) continue;
      // 取最内层的那个
      if (!best || best.contains(el)) best = el;
    }
    if (!best) return null;
    return { el: climbClickable(best), how: '文字匹配「' + textOf(best) + '」' };
  }

  // ★ 主策略：雨课堂 lms-graph 的章节列表
  //   真实结构（实测）：
  //   <div class="nav-item-leaf-box">
  //     <div class="leaf-item [is-active]">
  //       <div class="leaf-item-left">
  //         <div class="leaf-item-tag">视频</div>
  //         <div class="leaf-item-title ellipsis">3.2 劳动文化的内涵—教学视频</div>
  //       </div>
  //       <div class="leaf-item-right">…</div>
  //     </div>
  //   </div>
  //   当前播放项带 is-active。找到它，点它后面第一个「视频」项。
  function byYuketangLeaf(doc) {
    const leaves = [...doc.querySelectorAll('.leaf-item')];
    if (leaves.length < 2) return null;

    let idx = leaves.findIndex(el => el.classList.contains('is-active'));
    if (idx === -1) {
      // 高亮标记偶尔挂在父级 .nav-item-leaf-box 上
      const box = doc.querySelector('.nav-item-leaf-box.is-active, .nav-item-leaf-box.is-current');
      if (box) idx = leaves.indexOf(box.querySelector('.leaf-item'));
    }
    if (idx === -1) {
      warn('找到 .leaf-item 列表（' + leaves.length + ' 项），但定位不到当前播放项');
      return null;
    }

    log('章节列表共 ' + leaves.length + ' 项，当前第 ' + (idx + 1) + ' 项：' + textOf(leaves[idx]).slice(0, 30));

    const skipped = [];
    const hidden = [];
    for (let i = idx + 1; i < leaves.length; i++) {
      const el = leaves[i];
      const t = textOf(el);
      if (disabled(el)) continue;
      if (CFG.skipNonVideo && !isVideoLeaf(el)) { skipped.push(t.slice(0, 20)); continue; }
      if (!visible(el)) {
        const link = el.matches('a[href*="/video/"]')
          ? el
          : el.querySelector('a[href*="/video/"]');
        const href = link && link.getAttribute('href');
        if (href && /\/video\/\d+/.test(href)) {
          if (skipped.length) log('已跳过非视频项：' + skipped.join(' / '));
          if (hidden.length) log('已跳过前面 ' + hidden.length + ' 个无地址的不可见项');
          log('目标项在折叠目录中，改为直接跳转其视频地址');
          return {
            el: link,
            how: '折叠章节第 ' + (i + 1) + ' 项「' + t.slice(0, 26) + '」',
            navigate: true
          };
        }
        hidden.push(t.slice(0, 20));
        continue;
      }
      if (skipped.length) log('已跳过非视频项：' + skipped.join(' / '));
      if (hidden.length) log('⚠️ 跳过了 ' + hidden.length + ' 个不可见项（章节可能折叠着）');
      const status = el.querySelector('.leaf-item-status');
      if (status) log('目标项状态：' + textOf(status));
      return { el: el, how: '章节列表第 ' + (i + 1) + ' 项「' + t.slice(0, 26) + '」' };
    }
    if (skipped.length) log('后面的项全是非视频：' + skipped.join(' / '));
    if (hidden.length) log('⚠️ 后面有 ' + hidden.length + ' 项不可见，章节可能折叠着，请手动展开');
    return null;
  }

  // 判断某个章节项是不是「视频」（看 .leaf-item-tag 的标签文字）
  function isVideoLeaf(leaf) {
    const tagEl = leaf.querySelector('.leaf-item-tag');
    const tag = tagEl ? textOf(tagEl) : '';
    if (!tag) return true;   // 没标签就当成视频，别漏掉
    return /视频|音视频|音频|video/i.test(tag);
  }

  // 策略 C：新版学习空间底部的「下一单元」箭头。
  // 前端源码中的控件是 .learning-space-control-unit，
  // 下一项按钮为 .unit-arrow.arrow-reverse，点击后由 Vue Router 在 SPA 内换页。
  function byYuketangControlUnit(doc) {
    const selectors = [
      '.learning-space-control-unit .control-right .unit-arrow.arrow-reverse',
      '.learning-space-control-unit .unit-arrow.arrow-reverse'
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el && visible(el) && !disabled(el)) {
        return { el, how: '新版学习空间「下一单元」' };
      }
    }
    return null;
  }

  // 策略 B 的兜底：章节列表里当前高亮项的下一项
  function byActiveList(doc) {
    const re = /(^|[-_\s])(active|current|selected|playing)([-_\s]|$)/i;
    let cur = null, deepest = -1;

    for (const el of doc.querySelectorAll('*')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!cls || !re.test(cls)) continue;
      const link = (el.matches && el.matches('a[href*="/video/"]'))
        ? el
        : (el.querySelector ? el.querySelector('a[href*="/video/"]') : null);
      if (!link || !visible(link)) continue;
      let d = 0, p = el;
      while (p && p.parentElement) { d++; p = p.parentElement; }
      if (d > deepest) { deepest = d; cur = el; }
    }
    if (!cur) return null;

    let node = cur;
    while (node && node !== doc.body) {
      let sib = node.nextElementSibling;
      while (sib) {
        const link = (sib.matches && sib.matches('a[href*="/video/"]'))
          ? sib
          : (sib.querySelector ? sib.querySelector('a[href*="/video/"]') : null);
        if (link && visible(link) && !disabled(link)) {
          return { el: link, how: '章节列表下一项' };
        }
        sib = sib.nextElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  // 策略 E：全页面找带 /video/数字 的链接，取当前视频的下一条
  function byVideoLinks(doc) {
    const m = location.href.match(/\/video\/(\d+)/);
    if (!m) return null;
    const cur = m[1];

    const anchors = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const mm = href.match(/\/video\/(\d+)/);
      if (!mm) continue;
      if (seen.has(mm[1])) continue;
      seen.add(mm[1]);
      anchors.push(a);
    }
    if (!anchors.length) return null;

    const idx = anchors.findIndex(a => (a.getAttribute('href') || '').includes('/video/' + cur));
    if (idx >= 0) {
      for (let i = idx + 1; i < anchors.length; i++) {
        const a = anchors[i];
        if (disabled(a)) continue;
        return {
          el: a,
          how: visible(a) ? '链接顺序' : '折叠章节视频链接',
          navigate: true
        };
      }
    }
    return null;
  }

  function findTarget(doc) {
    return (
      byCustomSelector(doc) ||
      byYuketangControlUnit(doc) || // ★ 新版完整课程顺序，不受目录折叠影响
      byYuketangLeaf(doc) ||        // ★ 旧版章节列表
      byText(doc) ||
      byActiveList(doc) ||
      byVideoLinks(doc) ||
      null
    );
  }

  function attemptOnce() {
    // 先在当前文档里找
    let hit = findTarget(document);
    if (hit) return hit;

    // 再钻进同源 iframe 找
    for (const f of document.querySelectorAll('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch (e) { continue; }
      if (!d) continue;
      hit = findTarget(d);
      if (hit) return hit;
    }
    return null;
  }

  // 跳转后，等新的 video 元素出现并尝试播放（让连播能一直往下走）
  function kickNextVideo(prevVideo) {
    if (!CFG.autoPlayAfterJump) return;
    const prevSrc = prevVideo ? (prevVideo.currentSrc || prevVideo.src || '') : '';
    const prevDuration = prevVideo ? Number(prevVideo.duration) || 0 : 0;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const v = document.querySelector('video');
      const currentSrc = v ? (v.currentSrc || v.src || '') : '';
      const sourceChanged = !!(prevSrc && currentSrc && currentSrc !== prevSrc);
      const durationChanged = !!(prevDuration && v && v.duration && Math.abs(v.duration - prevDuration) > 0.5);
      const changed = v && (v !== prevVideo || sourceChanged || durationChanged);
      // SPA 可能复用同一个 video 元素；新片源若从已看进度开始，currentTime 不一定接近 0。
      const restarted = v && v === prevVideo && !v.ended && v.currentTime < 3;
      if (v && v.duration && !v.ended && (changed || restarted)) {
        scanVideos(document);
        enforceRate(v);              // 新视频先把倍速设上
        if (v.paused) {
          const p = v.play();
          if (p && p.catch) p.catch(() => {
            warn('新视频的自动播放被浏览器拦截，请手动点一下播放键');
          });
        }
        clearInterval(timer);
        log('下一个视频已就位' + (SPEED_ON ? '，倍速 ' + SPEED_TARGET + 'x' : ''));
        if (SPEED_ON) toast('已切到下一个视频（' + SPEED_TARGET + ' 倍速）');
        return;
      }
      if (tries > 45) {
        clearInterval(timer);
        warn('跳转后 45 秒内没等到新的视频元素');
      } else if (tries > 3 && currentRouteKind() !== 'video') {
        clearInterval(timer);
        log('已进入非视频单元，停止等待新视频');
      }
    }, 1000);
  }

  function doJump(how, el, navigate) {
    const href = el && el.getAttribute ? el.getAttribute('href') : null;
    if (navigate && href) {
      // 是真正的链接：直接跳最稳，SPA 状态也不会丢
      log('跳转 →', href);
      location.href = el.href || href;
      return;
    }

    const before = location.href;
    const prevVideo = document.querySelector('video');
    clickReal(el);
    kickNextVideo(prevVideo);

    // 1.5 秒后还没跳走，就换更内层的元素再点一次；再不行才退化成改地址
    setTimeout(() => {
      if (location.href !== before) return;                  // 已经跳走了，收工
      if (href && /\/video\/\d+/.test(href)) {
        log('点击无效，改为直接跳转 →', href);
        location.href = el.href || href;
        return;
      }
      const inner = el.querySelector('.leaf-item-left, .leaf-item-title')
        || (el.matches && el.matches('.unit-arrow') ? el.parentElement : el.firstElementChild);
      if (inner && inner !== el) {
        log('第一次点击没反应，改为点击更内层元素重试');
        clickReal(inner);
      }
    }, 1500);
  }

  function logBridgeSkips(skipped) {
    if (!skipped || !skipped.length) return;
    const names = skipped.map(x => (x.type || '未知') + '「' + (x.name || x.id) + '」');
    log('已跳过：' + names.join(' / '));
  }

  async function tryBridgeNext(prevVideo) {
    const res = await bridgeRequest('next-learnable', 2500);
    if (!res || !res.ok || !res.data || !res.data.navigated) return false;
    logBridgeSkips(res.data.skipped);
    const next = res.data.next || {};
    log('页面状态桥跳转 →', next.type || '未知', next.name || next.id || '');
    toast('跳转下一个：' + (next.type || '学习单元') + '「' + (next.name || next.id || '') + '」');
    if (/视频/.test(next.type || '')) kickNextVideo(prevVideo);
    return true;
  }

  async function maybeAdvanceNonVideoPage() {
    if (!enabled || !IS_TOP || nonVideoAdvanceBusy) return;

    if (location.href !== lastRouteKey) {
      lastRouteKey = location.href;
      nonVideoAdvanceKey = '';
      nonVideoAdvanceSince = 0;
    }

    const kind = currentRouteKind();
    if (kind !== 'graph' && kind !== 'courseware' && kind !== 'self-test' && kind !== 'extend') return;

    const key = location.pathname + location.search;
    if (nonVideoAdvanceKey === key) return;
    if (!nonVideoAdvanceSince) nonVideoAdvanceSince = Date.now();
    const elapsed = Date.now() - nonVideoAdvanceSince;

    if (kind === 'graph' || kind === 'courseware') {
      const isGraph = kind === 'graph';
      const label = isGraph ? '图文' : '课件';
      const minDelay = isGraph ? CFG.graphAdvanceDelay : CFG.coursewareAdvanceDelay;
      const maxWait = isGraph ? CFG.graphReadWaitMs : CFG.coursewareReadWaitMs;
      if (elapsed < minDelay) return;
      const state = await bridgeRequest('state', 1200);
      const isRead = !!(state && state.ok && state.data && state.data.isRead);
      if (!isRead && elapsed < maxWait) return;
      log(isRead ? label + '已读，继续下一个' : label + '等待完成状态超时，继续下一个');
    } else if (elapsed < CFG.skipAdvanceDelay) {
      return;
    }

    nonVideoAdvanceKey = key;
    nonVideoAdvanceBusy = true;
    try {
      const moved = await tryBridgeNext(null);
      if (!moved) {
        const hit = attemptOnce();
        if (hit) {
          log('页面状态桥不可用，改用页面按钮：' + hit.how);
          doJump(hit.how, hit.el, hit.navigate);
        } else {
          nonVideoAdvanceKey = '';
          warn('页面状态桥暂时无法跳过当前非视频单元');
        }
      }
    } finally {
      nonVideoAdvanceBusy = false;
    }
  }

  function onVideoEnd(reason) {
    if (!enabled || running) return;
    log('视频播放结束（' + reason + '）');
    toast('本节已播完，正在找下一个…');
    running = true;

    // 通知顶层页面帮忙找入口（视频在 iframe 里时很有用）
    try {
      const msg = { __ytAutoNext: 'ended', href: location.href, t: Date.now() };
      if (!IS_TOP) window.top.postMessage(msg, '*');
      document.querySelectorAll('iframe').forEach(f => {
        try { f.contentWindow.postMessage(msg, '*'); } catch (e) {}
      });
    } catch (e) {}

    let tries = 0;
    const tick = async () => {
      tries++;

      if (tries === 1) {
        const prevVideo = document.querySelector('video');
        if (await tryBridgeNext(prevVideo)) {
          setTimeout(() => { running = false; }, 3000);
          return;
        }
      }

      const hit = attemptOnce();
      if (hit) {
        log('找到入口：' + hit.how);
        toast('跳转下一个：' + hit.how);
        doJump(hit.how, hit.el, hit.navigate);
        setTimeout(() => { running = false; }, 3000);
        return;
      }
      if (tries < CFG.retryTimes) {
        setTimeout(tick, CFG.retryInterval);
      } else {
        warn('没找到「下一个」入口。请按 Alt+D 把诊断信息发给助手。');
        toast('没找到下一个入口，按 Alt+D 看诊断');
        running = false;
      }
    };
    setTimeout(tick, CFG.delayBeforeJump);
  }

  /* ---------------------- 跳转后自动播放 ---------------------- */

  function tryAutoplay() {
    if (!enabled || !CFG.autoPlayAfterJump) return;
    scanVideos(document);
    const v = document.querySelector('video');
    if (!v) return;
    if (!v.paused) return;
    const p = v.play();
    if (p && p.catch) p.catch(() => {
      warn('自动播放被浏览器拦截，请手动点一下播放键');
    });
  }

  /* ---------------------- 跨 frame 消息 ---------------------- */

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.__ytAutoNext === 'ended') {
      // 别的 frame 里的视频播完了，我来负责找入口
      if (!enabled) return;
      setTimeout(async () => {
        if (await tryBridgeNext(null)) return;
        const hit = attemptOnce();
        if (hit) {
          log('（来自 iframe 的通知）找到入口：' + hit.how);
          toast('跳转下一个：' + hit.how);
          doJump(hit.how, hit.el, hit.navigate);
        }
      }, 300);
    }
  });

  /* ---------------------- 快捷键 ---------------------- */

  window.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'j') {
      enabled = !enabled;
      toast(enabled ? '自动连播：已开启' : '自动连播：已关闭');
      log('开关 →', enabled);
      const b = document.getElementById('__yt_autonext_badge');
      if (b && b.__paint) b.__paint();
    } else if (k === 'd') {
      diagnose();
    }
  }, true);

  function diagnose() {
    const videos = [...document.querySelectorAll('video')];
    const info = {
      当前页面: location.href,
      是否顶层: IS_TOP,
      开关状态: enabled,
      倍速目标: SPEED_ON ? SPEED_TARGET + 'x' : '已关闭（' + SPEED_TARGET + 'x）',
      倍速配置来源: speedSource,
      当前视频实测倍速: currentRate(),
      网页环境脚本_倍速: document.documentElement.getAttribute('data-yt-speed-active') || '❌ 没运行（说明 MANIFEST 里的 MAIN world 脚本没生效）',
      网页环境脚本_防切屏: document.documentElement.getAttribute('data-yt-antiswitch-active') || '❌ 没运行（同上）',
      已修正倍速次数: rateFixed,
      找到视频数: videos.length,
      视频详情: videos.map(v => ({
        src: (v.currentSrc || v.src || '').slice(0, 120),
        时长: v.duration,
        当前: v.currentTime,
        暂停: v.paused,
        倍速: v.playbackRate
      })),
      带video链接数: document.querySelectorAll('a[href*="/video/"]').length,
      带video链接示例: [...document.querySelectorAll('a[href*="/video/"]')].slice(0, 8).map(a => a.getAttribute('href')),
      新版下一单元控件数: document.querySelectorAll('.learning-space-control-unit').length,
      新版下一单元箭头: [...document.querySelectorAll('.learning-space-control-unit .unit-arrow.arrow-reverse')]
        .map(el => ({
          类名: typeof el.className === 'string' ? el.className : '',
          可见: visible(el),
          禁用: disabled(el)
        })),
      '章节列表leaf-item数': document.querySelectorAll('.leaf-item').length,
      当前播放项: (() => {
        const a = document.querySelector('.leaf-item.is-active');
        return a ? textOf(a) : '(没找到 .leaf-item.is-active)';
      })(),
      当前项索引: (() => {
        const l = [...document.querySelectorAll('.leaf-item')];
        return l.findIndex(el => el.classList.contains('is-active'));
      })(),
      后5项: (() => {
        const l = [...document.querySelectorAll('.leaf-item')];
        const i = l.findIndex(el => el.classList.contains('is-active'));
        if (i === -1) return [];
        return l.slice(i + 1, i + 6).map(el => (el.querySelector('.leaf-item-tag')?.textContent || '').trim() + ' | ' + textOf(el).slice(0, 30) + ' | 可见=' + visible(el));
      })(),
      文字匹配结果: [...document.querySelectorAll('button, a, [role="button"], div, span, li')]
        .filter(el => {
          const t = textOf(el);
          return t && t.length <= 10 && CFG.nextTexts.some(k => t.includes(k)) && visible(el);
        })
        .slice(0, 8)
        .map(el => el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') + ' → ' + textOf(el))
    };
    console.log('%c' + TAG + ' 诊断信息 ↓（请复制下面这一整块发给助手）', 'color:#0a0;font-weight:bold');
    console.log(JSON.stringify(info, null, 2));
    toast('诊断信息已打印到控制台（F12 → Console）');
    return info;
  }

  // 手动测试用：控制台执行 __ytNext.jump() 立即尝试跳转
  window.__ytNext = {
    find: () => attemptOnce(),
    jump: () => { const h = attemptOnce(); if (h) { log('手动命中：' + h.how); doJump(h.how, h.el, h.navigate); } else { warn('手动尝试也没找到入口'); } return h; },
    on: () => { enabled = true; toast('自动连播：已开启'); },
    off: () => { enabled = false; toast('自动连播：已关闭'); },
    diagnose,
    list: () => [...document.querySelectorAll('a[href*="/video/"]')].map(a => a.getAttribute('href')),
    cfg: CFG
  };

  /* ---------------------- 页面提示条（星空贴图 + 悬浮流动） ---------------------- */
  //
  // 实现上刻意不用 <style> 标签和 CSS @keyframes，因为网站可能有 CSP 限制会拦掉；
  // 改用「内联样式 + Web Animations API（element.animate）」驱动动画，稳定得多。

  const BAR_ID = '__yt_autonext_badge';

  // 贴图是正方形，方便横竖都无缝平铺。漂移必须正好移动一整块才看不出接缝。
  const TILE = 160;

  // 圆形角标的直径
  const BADGE_SIZE = 62;

  // 拖拽后位置存在这里（localStorage，刷新后保留）
  const POS_KEY = 'ytBadgePos';

  // 用固定随机种子生成星空贴图（纯内联 SVG，不联网，每次结果一致）
  //
  // ⚠️ 这里的星点半径是按「1:1 输出」标定的：
  //    圆形角标可视面积很小，如果像宽条形那样把贴图缩小再用，
  //    半径 1px 的星点缩到 1/3 就成了亚像素噪点，等于白画。
  //    所以按 1:1 平铺，并把半径直接定成 0.8~2.4px。
  function starTextureUrl() {
    let seed = 20260924;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const S = TILE;

    let dots = '';
    for (let i = 0; i < 60; i++) {
      const x = (rnd() * S).toFixed(1);
      const y = (rnd() * S).toFixed(1);
      const r = (0.8 + rnd() * 1.6).toFixed(2);
      const o = (0.35 + rnd() * 0.65).toFixed(2);
      const roll = rnd();
      const fill = roll > 0.86 ? '#ffd9a8' : (roll > 0.62 ? '#cfe0ff' : '#ffffff');
      dots += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + fill + '" opacity="' + o + '"/>';
    }

    // 三颗亮一些的十字星
    [[34, 30, 1.05], [118, 74, 0.9], [76, 128, 1.2]].forEach(t => {
      const x = t[0], y = t[1], k = t[2];
      dots += '<path d="M' + x + ' ' + (y - 6 * k) + ' L' + (x + 1.4 * k) + ' ' + y
            + ' L' + x + ' ' + (y + 6 * k) + ' L' + (x - 1.4 * k) + ' ' + y + ' Z"'
            + ' fill="#ffffff" opacity="' + (0.6 * k).toFixed(2) + '"/>';
    });

    // 星云都完整落在贴图内部（离边缘够远），这样平铺时四周不会有硬边
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S + '">'
      + '<defs>'
      + '<radialGradient id="yw" cx="50%" cy="50%" r="50%">'
      + '<stop offset="0" stop-color="#3b63d8" stop-opacity=".17"/>'
      + '<stop offset="1" stop-color="#3b63d8" stop-opacity="0"/></radialGradient>'
      + '<radialGradient id="ng1" cx="50%" cy="50%" r="50%">'
      + '<stop offset="0" stop-color="#5b7cff" stop-opacity=".40"/>'
      + '<stop offset="1" stop-color="#5b7cff" stop-opacity="0"/></radialGradient>'
      + '<radialGradient id="ng2" cx="50%" cy="50%" r="50%">'
      + '<stop offset="0" stop-color="#a855f7" stop-opacity=".34"/>'
      + '<stop offset="1" stop-color="#a855f7" stop-opacity="0"/></radialGradient>'
      + '</defs>'
      + '<rect width="' + S + '" height="' + S + '" fill="#080d22"/>'
      + '<circle cx="80" cy="80" r="72" fill="url(#yw)"/>'
      + '<circle cx="52" cy="58" r="46" fill="url(#ng1)"/>'
      + '<circle cx="118" cy="116" r="42" fill="url(#ng2)"/>'
      + dots
      + '</svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }

  function createBadge() {
    if (!IS_TOP) return;
    if (document.getElementById(BAR_ID)) return;

    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const anims = [];

    // 位置边界（别让球被拖出屏幕）
    const clampX = (x) => Math.max(4, Math.min(window.innerWidth - BADGE_SIZE - 4, x));
    const clampY = (y) => Math.max(4, Math.min(window.innerHeight - BADGE_SIZE - 4, y));

    // 读取上次拖拽的位置；没拖过就默认右下角
    let savedPos = null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && isFinite(p.left) && isFinite(p.top)) savedPos = { left: clampX(+p.left), top: clampY(+p.top) };
      }
    } catch (e) {}

    const b = document.createElement('div');
    b.id = BAR_ID;
    b.style.cssText = [
      'position:fixed', 'z-index:2147483647',
      'width:' + BADGE_SIZE + 'px', 'height:' + BADGE_SIZE + 'px',
      'border-radius:50%',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'padding:0', 'margin:0', 'box-sizing:border-box',
      'font:500 11px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'letter-spacing:.3px', 'color:#e8f0ff',
      'cursor:pointer', 'user-select:none', 'overflow:hidden', 'isolation:isolate',
      'touch-action:none',
      'background-color:#080d22',
      'box-shadow:0 6px 20px rgba(4,8,26,.5), inset 0 0 0 1px rgba(140,170,255,.25)',
      'transition:transform .28s cubic-bezier(.2,.8,.3,1), box-shadow .28s, opacity .28s, filter .28s',
      'opacity:.82'
    ].join(';')
      + (savedPos
        ? ';left:' + savedPos.left + 'px;top:' + savedPos.top + 'px'
        : ';right:18px;bottom:18px');

    // ① 星空贴图层（比容器大一圈，循环平移时不会露边）
    const stars = document.createElement('span');
    stars.style.cssText = [
      'position:absolute',
      'left:' + (-TILE - 24) + 'px', 'right:' + (-TILE - 24) + 'px',
      'top:-30px', 'bottom:-30px',
      'background-image:' + starTextureUrl(),
      'background-repeat:repeat',
      'background-size:' + TILE + 'px ' + TILE + 'px',
      'opacity:.95', 'pointer-events:none', 'z-index:0'
    ].join(';');
    b.appendChild(stars);

    // ② 流动光带层（斜向掠过；不悬浮时也保留一点可见度，营造持续流动感）
    const flow = document.createElement('span');
    flow.style.cssText = [
      'position:absolute', 'top:-30px', 'bottom:-30px', 'left:0', 'width:58%',
      'pointer-events:none', 'z-index:1',
      'opacity:' + CFG.sweepIdleOpacity,
      'transform:translateX(-150%)', 'transition:opacity .25s',
      'background:linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(150,190,255,.12) 26%, rgba(255,255,255,.5) 50%, rgba(150,190,255,.12) 74%, rgba(255,255,255,0) 100%)'
    ].join(';');
    b.appendChild(flow);

    // ③ 中间的播放三角（和扩展图标同一个图形）
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('viewBox', '0 0 24 24');
    glyph.setAttribute('width', '19');
    glyph.setAttribute('height', '19');
    glyph.style.cssText = [
      'position:relative', 'z-index:2', 'flex:0 0 auto',
      'filter:drop-shadow(0 0 6px rgba(150,190,255,.85))',
      'transition:opacity .28s, filter .28s'
    ].join(';');
    glyph.innerHTML = '<defs><linearGradient id="ytBadgeTri" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b8d0ff"/></linearGradient></defs>'
      + '<path d="M8.6 5.4 L18.4 12 L8.6 18.6 Z" fill="url(#ytBadgeTri)"/>';
    b.appendChild(glyph);

    // ④ 「连播」二字（前端只保留这一个说明 + 右上角的绿色状态点）
    const label = document.createElement('span');
    label.textContent = '连播';
    label.style.cssText = [
      'position:relative', 'z-index:2', 'margin-top:2px',
      'text-shadow:0 1px 3px rgba(0,0,0,.75)',
      'transition:opacity .28s, text-shadow .28s'
    ].join(';');
    b.appendChild(label);

    // ⑤ 右上角状态圆点
    const dot = document.createElement('i');
    dot.style.cssText = [
      'position:absolute', 'right:9px', 'top:9px', 'z-index:3',
      'width:8px', 'height:8px', 'border-radius:50%',
      'box-sizing:border-box', 'border:1px solid rgba(6,10,26,.85)',
      'background:#39d98a', 'box-shadow:0 0 9px #39d98a'
    ].join(';');
    b.appendChild(dot);

    // 开 = 正常亮度 / 关 = 整体暗淡；悬浮时再亮一档
    const idleOpacity = () => (enabled ? 0.82 : 0.42);
    const hoverOpacity = () => (enabled ? 1 : 0.6);
    let hovering = false;
    let hoverZone = null;         // 'fast'（球体上端）| 'normal'
    let dragging = false;
    let suppressClickUntil = 0;   // 长按/拖拽之后短时间内忽略 click

    const paint = () => {
      const r = currentRate();
      const mainOk = !!document.documentElement.getAttribute('data-yt-speed-active');
      const mainAS = !!document.documentElement.getAttribute('data-yt-antiswitch-active');
      const mismatch = SPEED_ON && r !== null && Math.abs(r - SPEED_TARGET) > 0.05;

      if (!enabled) {
        // 已停用：状态点变红 + 整个球暗淡（去色 + 压暗）
        dot.style.background = '#ff6b6b';
        dot.style.boxShadow = '0 0 9px #ff6b6b';
        glyph.style.opacity = '.32';
        label.style.opacity = '.5';
        stars.style.opacity = '.28';
        b.style.filter = 'grayscale(.55) brightness(.78)';
      } else {
        dot.style.background = '#39d98a';
        dot.style.boxShadow = '0 0 9px #39d98a';
        glyph.style.opacity = '1';
        label.style.opacity = '1';
        stars.style.opacity = '.95';
        b.style.filter = 'none';
      }

      if (!dragging) b.style.opacity = String(hovering ? hoverOpacity() : idleOpacity());

      b.title = '星空雨课堂助手\n'
        + '连播：' + (enabled ? '已开启（点一下关闭）' : '已关闭（点一下开启）') + '\n'
        + '长按约 0.2 秒后拖动，可把小球挪到任意位置（松手自动记住）\n\n'
        + '实测倍速：' + (r !== null ? r.toFixed(2) + 'x' : '暂未找到视频') + '\n'
        + '目标倍速：' + (SPEED_ON ? SPEED_TARGET + 'x' : '未启用')
        + (mismatch ? '  ⚠️ 没跟上' : '') + '\n'
        + '网页环境脚本：倍速' + (mainOk ? '✓' : '✗') + ' 防切屏' + (mainAS ? '✓' : '✗') + '\n\n'
        + '防切屏关闭：localStorage.ytAntiSwitch = "off" 后刷新\n'
        + '改倍速：localStorage.ytSpeed = "1.5" 后刷新；"1" = 关闭倍速\n'
        + '位置归位：localStorage.removeItem("ytBadgePos") 后刷新';

      // 开关一变，立刻同步动画的播放/暂停
      applyAnimState();
    };

    // ---- 常驻动画：星空缓慢循环流动；悬浮时整体提速到 hoverSpeed ----
    let starAnim = null, flowAnim = null;
    if (!reduced) {
      try {
        starAnim = stars.animate(
          [{ transform: 'translateX(0px)' }, { transform: 'translateX(-' + TILE + 'px)' }],
          { duration: CFG.starLoopMs, iterations: Infinity, easing: 'linear' }
        );
      } catch (e) {}
      try {
        flowAnim = flow.animate(
          [{ transform: 'translateX(-150%)' }, { transform: 'translateX(320%)' }],
          { duration: CFG.sweepLoopMs, iterations: Infinity, easing: 'cubic-bezier(.45,0,.25,1)' }
        );
      } catch (e) {}
    }
    if (starAnim) anims.push(starAnim);
    if (flowAnim) anims.push(flowAnim);

    // 关键就是这一行：Web Animations 动画自带 playbackRate，改它就能整体变速，且不会跳帧
    const setSpeed = (k) => {
      anims.forEach(a => { try { a.playbackRate = k; } catch (e) {} });
    };
    const setFlowOpacity = (v) => { flow.style.opacity = String(v); };
    const playAll = () => { anims.forEach(a => { try { a.play(); } catch (e) {} }); };
    const pauseAll = () => { anims.forEach(a => { try { a.pause(); } catch (e) {} }); };

    // 动画状态统一在这里决定：
    //   关掉连播 → 整个暂停（背景真的停住，不只是变暗）
    //   开着连播 → 常速流动；悬浮 → 按分区提速
    const applyAnimState = () => {
      if (!enabled) {
        pauseAll();
        setFlowOpacity(CFG.sweepIdleOpacity * 0.45);
        return;
      }
      setSpeed(hovering
        ? (hoverZone === 'fast' ? CFG.fastHoverSpeed : CFG.hoverSpeed)
        : 1);
      playAll();
      setFlowOpacity(hovering ? 1 : CFG.sweepIdleOpacity);
    };

    // ---- 悬浮分区：普通区域 1.2 倍，球体「上端」3 倍 ----
    // 0 = 球的最顶部，1 = 球的最底部
    const zoneAt = (clientY) => {
      const rect = b.getBoundingClientRect();
      if (!rect.height) return 'normal';
      const rel = (clientY - rect.top) / rect.height;
      return rel <= CFG.fastHoverZoneRatio ? 'fast' : 'normal';
    };

    const applyZone = (clientY) => {
      const z = zoneAt(clientY);
      if (z === hoverZone) return;
      hoverZone = z;
      if (dragging) return;
      applyAnimState();
      // 上端给一点视觉反馈：辉光收紧变亮（关闭连播时不做这个反馈）
      if (enabled) {
        b.style.boxShadow = z === 'fast'
          ? '0 10px 34px rgba(4,8,26,.66), 0 0 0 1px rgba(190,220,255,.85), 0 0 36px rgba(115,165,255,.68)'
          : '0 10px 30px rgba(4,8,26,.62), 0 0 0 1px rgba(165,195,255,.55), 0 0 26px rgba(92,132,255,.45)';
      }
      if (z === 'fast') log('悬浮到球体上端 → 背景流速 ' + CFG.fastHoverSpeed + ' 倍');
    };

    b.addEventListener('mouseenter', (e) => {
      hovering = true;
      hoverZone = null;                 // 强制重算一次真实分区
      if (!dragging) {
        b.style.opacity = String(hoverOpacity());
        b.style.transform = 'translateY(-3px) scale(1.06)';
        glyph.style.filter = 'drop-shadow(0 0 11px rgba(180,215,255,1))';
        label.style.textShadow = '0 0 10px rgba(175,210,255,.95), 0 1px 3px rgba(0,0,0,.75)';
      }
      applyZone(e.clientY);
    });

    // 悬浮时鼠标在球内移动，实时切换分区（上端 ↔ 其余部分）
    b.addEventListener('mousemove', (e) => {
      if (!dragging) applyZone(e.clientY);
    });

    b.addEventListener('mouseleave', () => {
      hovering = false;
      hoverZone = null;
      if (!dragging) {
        b.style.opacity = String(idleOpacity());
        b.style.transform = 'none';
        b.style.boxShadow = '0 6px 20px rgba(4,8,26,.5), inset 0 0 0 1px rgba(140,170,255,.25)';
        glyph.style.filter = 'drop-shadow(0 0 6px rgba(150,190,255,.85))';
        label.style.textShadow = '0 1px 3px rgba(0,0,0,.75)';
      }
      applyAnimState();
    });

    // ---- 长按约 0.2 秒进入拖拽模式（松手记住位置）；短按 = 开关连播 ----
    let pressTimer = null;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let didMove = false;

    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 只响应左键
      e.stopPropagation();
      const rect = b.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      didMove = false;
      const pid = e.pointerId;

      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        dragging = true;
        suppressClickUntil = Date.now() + 2000;
        try { b.setPointerCapture(pid); } catch (err) {}
        b.style.cursor = 'grabbing';
        b.style.opacity = '1';
        b.style.transform = 'scale(1.1)';
        b.style.boxShadow = '0 14px 38px rgba(4,8,26,.72), 0 0 0 1px rgba(175,205,255,.75), 0 0 32px rgba(92,132,255,.6)';
        log('进入拖拽模式，松手后会记住新位置');
        toast('拖动小球调整位置，松手即保存');
      }, CFG.longPressMs);
    });

    b.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.stopPropagation();
      didMove = true;
      const nx = clampX(startLeft + (e.clientX - startX));
      const ny = clampY(startTop + (e.clientY - startY));
      b.style.left = nx + 'px';
      b.style.top = ny + 'px';
      b.style.right = 'auto';
      b.style.bottom = 'auto';
    });

    const endPress = () => {
      clearTimeout(pressTimer);
      if (!dragging) return;
      dragging = false;
      b.style.cursor = 'pointer';
      b.style.transform = 'none';
      b.style.opacity = String(hovering ? hoverOpacity() : idleOpacity());
      b.style.boxShadow = '0 6px 20px rgba(4,8,26,.5), inset 0 0 0 1px rgba(140,170,255,.25)';
      // 只有真的拖动过才记录位置；否则（长按但没动）保持原样，免得球跳到左上角
      if (didMove) {
        const rect = b.getBoundingClientRect();
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            left: Math.round(rect.left),
            top: Math.round(rect.top)
          }));
        } catch (e) {}
        log('小球位置已保存：left=' + Math.round(rect.left) + ' top=' + Math.round(rect.top));
      }
      suppressClickUntil = Date.now() + 600;
      hoverZone = null;   // 位置变了，分区要重新算
    };
    b.addEventListener('pointerup', (e) => { e.stopPropagation(); endPress(); });
    b.addEventListener('pointercancel', endPress);

    // 窗口尺寸变了，把球拉回可视范围内
    window.addEventListener('resize', () => {
      if (!b.style.left || b.style.left === 'auto') return;
      b.style.left = clampX(parseInt(b.style.left, 10) || 0) + 'px';
      b.style.top = clampY(parseInt(b.style.top, 10) || 0) + 'px';
    });

    // ---- 短按：开关连播 ----
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (Date.now() < suppressClickUntil) return;   // 长按/拖拽引发的那次 click，忽略掉
      enabled = !enabled;
      paint();
      toast(enabled ? '自动连播：已开启' : '自动连播：已关闭');
      log('连播开关 →', enabled);
    });

    b.__paint = paint;
    paint();
    (document.body || document.documentElement).appendChild(b);
  }

  /* ---------------------- 启动 ---------------------- */

  scanVideos(document);
  createBadge();

  // 页面是 SPA，视频会被换掉，持续盯着
  setInterval(() => {
    scanVideos(document);
    enforceAllRates();
    const b = document.getElementById('__yt_autonext_badge');
    if (b && b.__paint) b.__paint();   // 角标顺便刷新实测倍速
    maybeAdvanceNonVideoPage().catch(() => {});
  }, 1000);

  // 倍速单独再快一档：500ms 校准一次，切视频那一刻不容易漏
  setInterval(enforceAllRates, 500);

  const mo = new MutationObserver(() => scanVideos(document));
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  window.addEventListener('load', () => {
    scanVideos(document);
    createBadge();
    enforceAllRates();
    setTimeout(tryAutoplay, 1500);
  });

  log('已启动' + (IS_TOP ? '（顶层页面）' : '（iframe 内）'));
  log('倍速配置：目标 ' + (SPEED_ON ? SPEED_TARGET + 'x' : '未启用（' + SPEED_TARGET + 'x）')
      + '，来源：' + speedSource);
  if (!SPEED_ON) {
    warn('倍速当前是关闭状态，所以不会改速度。'
       + '想开回 2x：控制台执行 localStorage.removeItem("ytSpeed") 后刷新页面');
  }
  log('Alt+J 开关连播，Alt+D 打印诊断。');
})();
