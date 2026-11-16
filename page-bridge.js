/* ============================================================
 * 雨课堂学习空间 · 页面状态桥
 *
 * auto-next.js 运行在扩展隔离环境，看不到页面里的 Vuex 状态。
 * 本脚本运行在 MAIN world，读取 aiCloudStore.allLeafInfo，
 * 按完整课程顺序找到下一个可学习节点并交给页面路由跳转。
 * ============================================================ */

(function () {
  'use strict';

  const REQUEST = '__ytPageBridgeRequest';
  const RESPONSE = '__ytPageBridgeResponse';
  const SKIP_TYPE_RE = /自测|拓展|self\s*test|extend/i;

  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, '');
  }

  function vueOf(el) {
    if (!el) return null;
    if (el.__vue__) return el.__vue__;
    let vnode = el.__vueParentComponent;
    while (vnode) {
      if (vnode.proxy) return vnode.proxy;
      if (vnode.ctx) return vnode.ctx;
      vnode = vnode.parent;
    }
    return null;
  }

  function getContext() {
    const candidates = [
      document.querySelector('.learning-space-control-unit'),
      document.querySelector('.lms-graph-article'),
      document.querySelector('#app')
    ];

    let vm = null;
    for (const el of candidates) {
      vm = vueOf(el);
      if (vm) break;
    }

    let state = vm && vm.$store && vm.$store.state && vm.$store.state.aiCloudStore;
    if (!state) {
      const rootVm = vueOf(document.querySelector('#app'));
      state = rootVm && rootVm.$store && rootVm.$store.state && rootVm.$store.state.aiCloudStore;
      if (!vm && rootVm) vm = rootVm;
    }
    return { vm, state: state || null };
  }

  function getLeafTypeMap(vm) {
    if (!vm) return null;
    return vm.LeafTypeMap
      || (vm._setupState && vm._setupState.LeafTypeMap)
      || (vm.$options && vm.$options.setupState && vm.$options.setupState.LeafTypeMap)
      || null;
  }

  function leafTypeLabel(item, vm) {
    if (!item) return '';
    if (item.isSelfTest) return '自测';
    if (item.is_guidance) return '片段';

    const map = getLeafTypeMap(vm);
    const mapped = map && map[item.leaf_type];
    if (mapped) return String(mapped);

    const direct = item.leaf_type_name || item.type_name || item.type_label || item.tag_name;
    if (direct) return String(direct);

    if (Number(item.leaf_type) === -99 || Number(item.leaf_type) === -100) return '拓展';
    return '';
  }

  function isLocked(item) {
    return !!(item && (item.is_locked || item.locked));
  }

  function shouldSkip(item, vm) {
    if (!item || isLocked(item)) return true;
    if (item.isSelfTest || item.is_extend || item.isExtend) return true;
    return SKIP_TYPE_RE.test(leafTypeLabel(item, vm));
  }

  function currentIndex(state) {
    const all = Array.isArray(state && state.allLeafInfo) ? state.allLeafInfo : [];
    const current = state && state.leafInfo;
    const currentId = current && current.id != null ? current.id : state && state.leafId;
    const nodeId = current && current.node_id != null ? current.node_id : null;
    if (!all.length || currentId == null) return -1;

    return all.findIndex(item => {
      if (String(item.id) !== String(currentId)) return false;
      return nodeId == null || item.node_id == null || String(item.node_id) === String(nodeId);
    });
  }

  function findNextLearnable(vm, state) {
    const all = Array.isArray(state && state.allLeafInfo) ? state.allLeafInfo : [];
    const idx = currentIndex(state);
    if (idx < 0) return { next: null, skipped: [], reason: 'current-not-found' };

    const skipped = [];
    for (let i = idx + 1; i < all.length; i++) {
      const item = all[i];
      if (isLocked(item)) continue;
      if (shouldSkip(item, vm)) {
        skipped.push({ id: item.id, name: item.name || '', type: leafTypeLabel(item, vm) });
        continue;
      }
      return {
        next: item,
        index: i,
        type: leafTypeLabel(item, vm),
        skipped
      };
    }
    return { next: null, skipped, reason: 'no-next-learnable' };
  }

  function navigateTo(vm, item) {
    if (!vm || !item) return false;

    const handler = vm.handleUnitChange
      || (vm._setupState && vm._setupState.handleUnitChange)
      || (vm.$options && vm.$options.setupState && vm.$options.setupState.handleUnitChange);
    if (typeof handler === 'function') {
      handler.call(vm, item);
      return true;
    }

    const createRoute = vm.createUnitRoute
      || (vm._setupState && vm._setupState.createUnitRoute)
      || (vm.$options && vm.$options.setupState && vm.$options.setupState.createUnitRoute);
    const router = vm.$router || (vm.$root && vm.$root.$router);
    if (typeof createRoute === 'function' && router) {
      router.push(createRoute.call(vm, item));
      return true;
    }
    return false;
  }

  function readState() {
    const { vm, state } = getContext();
    const current = state && state.leafInfo;
    const tag = document.querySelector('.learning-space-control-unit .unit-tag');
    const right = document.querySelector('.learning-space-control-unit .control-right');
    const all = Array.isArray(state && state.allLeafInfo) ? state.allLeafInfo : [];
    const found = findNextLearnable(vm, state);

    return {
      path: location.pathname,
      currentType: textOf(tag) || leafTypeLabel(current, vm),
      isRead: /已读/.test(textOf(right)),
      current: current ? {
        id: current.id,
        name: current.name || '',
        leaf_type: current.leaf_type,
        node_id: current.node_id
      } : null,
      allLeafCount: all.length,
      currentIndex: currentIndex(state),
      next: found.next ? {
        id: found.next.id,
        name: found.next.name || '',
        leaf_type: found.next.leaf_type,
        node_id: found.next.node_id,
        type: found.type
      } : null,
      skipped: found.skipped,
      reason: found.reason || ''
    };
  }

  function navigateNextLearnable() {
    const { vm, state } = getContext();
    const found = findNextLearnable(vm, state);
    if (!found.next) {
      return {
        navigated: false,
        reason: found.reason || 'no-next-learnable',
        skipped: found.skipped
      };
    }

    const navigated = navigateTo(vm, found.next);
    return {
      navigated,
      reason: navigated ? '' : 'navigation-handler-not-found',
      next: {
        id: found.next.id,
        name: found.next.name || '',
        leaf_type: found.next.leaf_type,
        node_id: found.next.node_id,
        type: found.type
      },
      skipped: found.skipped
    };
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const req = event.data;
    if (!req || req.channel !== REQUEST || !req.id) return;

    let response;
    try {
      if (req.action === 'state') response = { ok: true, data: readState() };
      else if (req.action === 'next-learnable') response = { ok: true, data: navigateNextLearnable() };
      else response = { ok: false, error: 'unknown-action' };
    } catch (error) {
      response = { ok: false, error: String(error && error.message || error) };
    }

    window.postMessage({
      channel: RESPONSE,
      id: req.id,
      ...response
    }, '*');
  });
})();
