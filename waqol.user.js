// ==UserScript==
// @name         WAQoL
// @namespace    local
// @version      1.0.0
// @description  Quality of Life updates for Whatsapp Web
// @match        https://web.whatsapp.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const LOG = (...a) => console.info("[WAQoL]", ...a);
  const WS = /\s/;
  const VERSION = "1.0.0";
  const SETTINGS_KEY = "waqol:settings:v1";
  const DEFAULT_MESSAGE_LIMIT = 100;
  const MIN_MESSAGE_LIMIT = 40;
  const MAX_MESSAGE_LIMIT = 500;
  const FIXES = [
    ["scrollLayer", "Hardware-accelerated scrolling"],
    ["emitter", "Instant event cleanup"],
    ["historyPage", "Larger history batches"],
    ["collectionBatch", "Routed collection updates"],
    ["messageSlice", "Allocation-free message slicing"],
    ["messageRunway", "History runway"],
    ["messageWindow", "Virtual message window"],
    ["clockCache", "Date and time cache"],
  ];

  function normalizeMessageLimit(value) {
    if (value == null || String(value).trim() === "") return DEFAULT_MESSAGE_LIMIT;
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_MESSAGE_LIMIT;
    return Math.max(MIN_MESSAGE_LIMIT, Math.min(MAX_MESSAGE_LIMIT, Math.round(number)));
  }
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      return { messageLimit: normalizeMessageLimit(saved && saved.messageLimit) };
    } catch {
      return { messageLimit: DEFAULT_MESSAGE_LIMIT };
    }
  }
  const settings = loadSettings();

  // making sure script runs cleanly
  const state = window.__waQoLState || (window.__waQoLState = {});
  for (const [key] of FIXES) if (!(key in state)) state[key] = null;
  const registries = window.__waQoLRegistries ||
    (window.__waQoLRegistries = {});
  const registry = (name) => registries[name] || (registries[name] = new WeakMap());
  const resolved = window.__waQoLSymbols || (window.__waQoLSymbols = {});

  function applyMessageLimit(value, persist = true) {
    const limit = normalizeMessageLimit(value);
    settings.messageLimit = limit;
    for (const [key] of FIXES) {
      const ctl = state[key];
      if (ctl && typeof ctl.setLimit === "function") ctl.setLimit(limit);
    }
    if (persist) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
      catch {}
    }
    return limit;
  }

  const API = window.__waQoL = window.__patch = {
    enabled: true,
    version: VERSION,
    set(v) {
      API.enabled = !!v;
      for (const [key] of FIXES) if (state[key]) state[key].set(API.enabled);
      return API.enabled;
    },
    reset() {
      for (const [key] of FIXES) if (state[key]) state[key].reset();
    },
    stats() {
      const out = { version: VERSION, settings: { messageLimit: settings.messageLimit },
                    symbols: resolved };
      for (const [key] of FIXES) out[key] = state[key] ? state[key].info() : null;
      return JSON.stringify(out);
    },
    getMessageLimit() { return settings.messageLimit; },
    setMessageLimit(value) { return applyMessageLimit(value); },
    openPanel() {
      if (!window.__waQolUI) return false;
      window.__waQolUI.open();
      return true;
    },
  };

  // whatsapp renames internal code each update, we safely test its own code to see what it does, and null what we don't have 100% sure
  function sourceOf(fn) {
    try { return Function.prototype.toString.call(fn); } catch { return ""; }
  }
  function minifiedMembers(target, ownOnly) {
    const names = new Set();
    for (let o = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Object.getOwnPropertyNames(o)) {
        if (/^\$/.test(name)) names.add(name);
      }
      if (ownOnly) break;
    }
    return Array.from(names);
  }

  function resolveEmitterSymbols(E) {
    const event = "waqol_probe_" + Math.random().toString(36).slice(2);
    let probe;
    try { probe = new E(); } catch { return null; }
    const marker = function () {};
    try { probe.on(event, marker); } catch { return null; }

    let map = null;
    for (const name of Object.getOwnPropertyNames(probe)) {
      let value;
      try { value = probe[name]; } catch { continue; }
      if (!value || typeof value !== "object") continue;
      const list = value[event];
      if (Array.isArray(list) && list.some((e) => e && e.callback === marker)) {
        map = name; break;
      }
    }
    if (!map) return null;

    let dispatch = null;
    const token = {};
    for (const name of minifiedMembers(E.prototype)) {
      let fn;
      try { fn = E.prototype[name]; } catch { continue; }
      if (typeof fn !== "function" || fn.length !== 2) continue;
      if (!/\.callback\.call\(/.test(sourceOf(fn))) continue;
      let hits = 0, seen;
      const entry = { callback: function (a) { hits++; seen = a; }, context: null };
      try { fn.call(probe, [entry], [token]); } catch { continue; }
      if (hits === 1 && seen === token) { dispatch = name; break; }
    }
    try { probe.off(event, marker); } catch {}
    return dispatch ? { map, dispatch } : null;
  }

  function resolveClockPrivates(Clock) {
    const skew = Number(Clock.skew) || 0;
    const now = Math.floor(Date.now() / 1000);
    const samples = [now - 300, now - 86400 * 2, now - 86400 * 40, now - 86400 * 400];
    const roles = [
      ["time", "timestampStr"],
      ["date", "dateStr"],
      ["monthDay", "monthDayStr"],
    ];
    const publicNames = new Set(roles.map((r) => r[1]));
    const candidates = minifiedMembers(Clock)
      .filter((n) => !publicNames.has(n) && typeof Clock[n] === "function");
    const found = {};
    const taken = new Set();
    for (const [role, publicName] of roles) {
      if (typeof Clock[publicName] !== "function") return null;
      let expected;
      try { expected = samples.map((t) => Clock[publicName](t)); } catch { return null; }
      if (expected.some((v) => typeof v !== "string" || !v.length)) return null;
      for (const name of candidates) {
        if (taken.has(name)) continue;
        const fn = Clock[name];
        if (fn.length < 1) continue;
        let ok = true;
        for (let i = 0; i < samples.length; i++) {
          let got;
          try { got = fn.call(Clock, samples[i] + skew); } catch { ok = false; break; }
          if (got !== expected[i]) { ok = false; break; }
        }
        if (ok) { found[role] = name; taken.add(name); break; }
      }
      if (!found[role]) return null;
    }
    return found;
  }

  function readsLikeIslandSlicer(source) {
    return /\.slice\(/.test(source) && /\bbefore\b/.test(source) &&
           /\bafter\b/.test(source);
  }
  function islandFieldNames(source) {
    const anchors = source.match(/this\.(\$\w+)\s*=\s*0\s*,\s*this\.(\$\w+)\s*=/);
    const direction = source.match(/if\s*\(\s*this\.(\$\w+)\s*\)/);
    if (!anchors || !direction) return null;
    const [, start, height] = anchors;
    if (start === height || direction[1] === start || direction[1] === height) return null;
    return { start, height, up: direction[1] };
  }
  function behavesLikeIslandSlicer(fn, fields) {
    const probe = { state: { cursor: { before: 40, after: 40 } } };
    probe[fields.start] = 0; probe[fields.height] = 0; probe[fields.up] = false;
    const input = [];
    for (let i = 0; i < 400; i++) input.push({ probeIndex: i });
    let out;
    try { out = fn.call(probe, input); } catch { return false; }
    if (!Array.isArray(out) || out.length === 0 || out.length >= input.length) return false;
    const start = input.indexOf(out[0]);
    if (start < 0) return false;
    for (let i = 0; i < out.length; i++) if (out[i] !== input[start + i]) return false;
    return typeof probe[fields.start] === "number";
  }
  function findIslandSlicer(P) {
    for (const name of minifiedMembers(P, true)) {
      let fn;
      try { fn = P[name]; } catch { continue; }
      if (typeof fn !== "function" || fn.length !== 1) continue;
      if (!readsLikeIslandSlicer(sourceOf(fn))) continue;
      const fields = islandFieldNames(sourceOf(fn));
      if (!fields) continue;
      if (!behavesLikeIslandSlicer(fn, fields)) continue;
      return { name, fields };
    }
    return null;
  }

  // tries to find conversation component by the members it owns
  function findConversationComponent(matches) {
    const seen = new Set();
    for (const el of document.querySelectorAll("#main *")) {
      const key = Object.keys(el).find((name) => name.indexOf("__reactFiber$") === 0);
      let fiber = key && el[key];
      while (fiber && !seen.has(fiber)) {
        seen.add(fiber);
        const node = fiber.stateNode;
        if (node && typeof node === "object" && matches(node)) return node;
        fiber = fiber.return;
      }
    }
    return null;
  }

  // keep the msg list on a compositor-managed scroll layer
  function installScrollLayer() {
    const RULE = '[data-testid="conversation-panel-messages"]' +
      '{will-change:scroll-position!important}';
    const existing = window.__waQoLLayerControl;
    if (existing) { state.scrollLayer = existing; return "reused"; }
    let style = document.getElementById("wa-qol-scroll-layer");
    if (!style) {
      style = document.createElement("style");
      style.id = "wa-qol-scroll-layer";
      (document.head || document.documentElement).appendChild(style);
    }
    let on = true;
    style.textContent = RULE;
    const ctl = {
      set(v) { on = !!v; style.textContent = on ? RULE : ""; },
      reset() {},
      info() {
        const pane = document.querySelector('[data-testid="conversation-panel-messages"]');
        return { enabled: on, applied: !!pane && getComputedStyle(pane).willChange
          .split(",").map((x) => x.trim()).includes("scroll-position") };
      },
    };
    state.scrollLayer = ctl;
    window.__waQoLLayerControl = ctl;
    return "ok";
  }

  // speed up WAWebEventEmitter.off() 
  function installEmitterFix(E) {
    const P = E && E.prototype;
    if (!P || typeof P.on !== "function" || typeof P.off !== "function") return "shape";
    const existing = registry("emitter").get(P);
    if (existing) { state.emitter = existing; return "reused"; }

    const sym = resolveEmitterSymbols(E);
    if (!sym) return "unresolved";
    const MAP = sym.map, DISPATCH = sym.dispatch;
    resolved.emitter = { map: MAP, dispatch: DISPATCH };

    const originalOn = P.on, originalOff = P.off;

    // test again resolved names
    try {
      const probe = new E(), f = function () {};
      probe.on("t", f);
      const arr = probe[MAP] && probe[MAP].t;
      if (!Array.isArray(arr) || arr.length !== 1 || arr[0].callback !== f) return "selftest-shape";
      let hits = 0;
      probe.trigger("t");
      probe.on("t", function () { hits++; });
      probe.trigger("t");
      if (hits !== 1) return "selftest-dispatch";
      probe.off("t", f);
      if (probe[MAP] && probe[MAP].t && probe[MAP].t.some((e) => e.callback === f))
        return "selftest-off";
    } catch (e) { return "selftest-threw: " + e; }

    const IDX = new WeakMap();
    let on = true, fast = 0, slow = 0, compacts = 0, saved = 0, indexed = 0;

    const put = (m, k, e) => { const a = m.get(k); if (a) a.push(e); else m.set(k, [e]); };
    const drop = (m, k, e) => {
      const a = m.get(k); if (!a) return;
      const i = a.indexOf(e); if (i >= 0) a.splice(i, 1);
      if (!a.length) m.delete(k);
    };
    const index = (m, e) => {
      put(m, e.callback, e);
      const alias = e.callback && e.callback._callback;
      if (alias) put(m, alias, e);
    };
    const build = (arr) => {
      const m = new Map(); let d = 0;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (e.__dead) { d++; continue; }
        index(m, e);
      }
      const rec = { m, d };
      IDX.set(arr, rec); indexed++;
      return rec;
    };
    const compact = (arr, rec) => {
      let w = 0;
      for (let i = 0; i < arr.length; i++) if (!arr[i].__dead) arr[w++] = arr[i];
      arr.length = w;
      compacts++;
      const r = build(arr);
      rec.m = r.m; rec.d = r.d;
    };

    P.on = function (ev, cb) {
      const r = originalOn.apply(this, arguments);
      if (typeof ev === "string" && !WS.test(ev) && typeof cb === "function" && this[MAP]) {
        const arr = this[MAP][ev];
        if (arr && arr.length) {
          const rec = IDX.get(arr);
          if (rec) index(rec.m, arr[arr.length - 1]);
        }
      }
      return r;
    };

    P.off = function (ev, cb, ctx) {
      const map = this[MAP];
      if (!on || !map || typeof ev !== "string" || WS.test(ev) || cb == null || ctx != null) {
        slow++;
        return originalOff.apply(this, arguments);
      }
      const arr = map[ev];
      if (!arr) return this;
      fast++;
      const rec = IDX.get(arr) || build(arr);
      const hits = rec.m.get(cb);
      if (hits && hits.length) {
        saved += arr.length;
        const list = hits.slice();
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (!e.__dead) { e.__dead = true; rec.d++; }
          drop(rec.m, e.callback, e);
          const alias = e.callback && e.callback._callback;
          if (alias) drop(rec.m, alias, e);
        }
        if (rec.d >= arr.length) {
          arr.length = 0; rec.m = new Map(); rec.d = 0;
          delete map[ev];
        } else if (rec.d * 8 > arr.length || rec.d > 256) {
          // trigger() walks every slot, so tombstones are not free: keep them rare.
          compact(arr, rec);
        }
      }
      return this;
    };

    P[DISPATCH] = function (list, args) {
      const n = args.length, L = list.length;
      for (let i = 0; i < L; i++) {
        const e = list[i];
        if (e.__dead) continue;
        const c = e.context != null ? e.context : this;
        switch (n) {
          case 0: e.callback.call(c); break;
          case 1: e.callback.call(c, args[0]); break;
          case 2: e.callback.call(c, args[0], args[1]); break;
          case 3: e.callback.call(c, args[0], args[1], args[2]); break;
          default: e.callback.apply(c, args); break;
        }
      }
    };

    P.getListenersCount = function (ev) {
      const m = this[MAP];
      if (!m) return 0;
      const cnt = (a) => {
        if (!a) return 0;
        const rec = IDX.get(a);
        if (!rec || !rec.d) return a.length;
        let n = 0;
        for (let i = 0; i < a.length; i++) if (!a[i].__dead) n++;
        return n;
      };
      if (typeof ev === "string") return cnt(m[ev]);
      let t = 0;
      for (const k in m) t += cnt(m[k]);
      return t;
    };

    const ctl = {
      set(v) { on = !!v; },
      reset() { fast = slow = compacts = saved = 0; },
      info() { return { enabled: on, fast, slow, compacts, pushesSaved: saved, arrays: indexed }; },
    };
    state.emitter = ctl;
    registry("emitter").set(P, ctl);
    return "ok";
  }

  // fetch a deeper history runway per IndexedDB query
  function installHistoryPageLimit(Loads, Constants) {
    if (!Loads || typeof Loads.loadEarlierMsgs !== "function" || !Constants ||
        typeof Constants.PAGE_SIZE !== "number") return "shape";
    const existing = registry("historyPage").get(Loads);
    if (existing) { state.historyPage = existing; return "reused"; }

    let limit = settings.messageLimit;
    const original = Loads.loadEarlierMsgs;
    let on = true, calls = 0, active = 0, savedPageSize = Constants.PAGE_SIZE;

    function enter() {
      if (active++ === 0) {
        savedPageSize = Constants.PAGE_SIZE;
        Constants.PAGE_SIZE = limit;
      }
    }
    function leave() {
      if (active > 0 && --active === 0) Constants.PAGE_SIZE = savedPageSize;
    }
    const wrapped = function () {
      if (!on) return original.apply(this, arguments);
      calls++;
      enter();
      let result;
      try { result = original.apply(this, arguments); }
      catch (e) { leave(); throw e; }
      return Promise.resolve(result).then(
        (value) => { leave(); return value; },
        (error) => { leave(); throw error; }
      );
    };
    try { Loads.loadEarlierMsgs = wrapped; } catch { return "readonly"; }
    if (Loads.loadEarlierMsgs !== wrapped) return "readonly";

    const ctl = {
      set(v) { on = !!v; },
      setLimit(value) { limit = normalizeMessageLimit(value); },
      reset() { calls = 0; },
      info() { return { enabled: on, limit, stock: savedPageSize, calls, active }; },
    };
    state.historyPage = ctl;
    registry("historyPage").set(Loads, ctl);
    return "ok";
  }
  // combine add updates and send them only to specific listeners watching for that item's id
  function installCollectionAddBatch(React, Values, Listeners) {
    if (!React || typeof React.useRef !== "function" ||
        typeof React.useLayoutEffect !== "function" || !Values || !Listeners ||
        typeof Values.useCollectionValues !== "function" ||
        typeof Values.useOptionalCollectionValues !== "function" ||
        typeof Listeners.useListeners !== "function") return "shape";
    const existing = registry("collectionBatch").get(Values);
    if (existing) { state.collectionBatch = existing; return "reused"; }

    const originalCollectionValues = Values.useCollectionValues;
    const originalOptionalValues = Values.useOptionalCollectionValues;
    const originalUseListeners = Listeners.useListeners;
    const hubs = new WeakMap();
    const sourceIds = new WeakMap();
    let nextSourceId = 1, collectionContext = null, on = true;
    let addEvents = 0, flushes = 0, callbacks = 0, skipped = 0, liveHubs = 0;

    function sourceId(source) {
      if ((typeof source !== "object" && typeof source !== "function") || source == null)
        return String(source);
      let id = sourceIds.get(source);
      if (id == null) { id = nextSourceId++; sourceIds.set(source, id); }
      return id;
    }
    function invokeHub(hub, all) {
      hub.pending = false;
      let current;
      if (all || hub.pendingAll) {
        current = Array.from(hub.subscribers);
      } else {
        const selected = new Set();
        for (const key of hub.pendingKeys) {
          const records = hub.byKey.get(key);
          if (records) for (const record of records) selected.add(record);
        }
        current = Array.from(selected);
      }
      hub.pendingAll = false;
      hub.pendingKeys.clear();
      flushes++;
      callbacks += current.length;
      for (let i = 0; i < current.length; i++) current[i].callback();
    }
    function getHub(source) {
      let hub = hubs.get(source);
      if (hub) return hub;
      hub = { source, subscribers: new Set(), byKey: new Map(), pending: false,
        pendingAll: false, pendingKeys: new Set(), handle: null };
      hub.handle = function (model) {
        addEvents++;
        if (!on) { invokeHub(hub, true); return; }
        const id = model && model.id;
        const key = id == null ? null : String(id);
        if (key == null) hub.pendingAll = true;
        else if (hub.byKey.has(key)) hub.pendingKeys.add(key);
        else { skipped++; return; }
        if (!hub.pending) {
          hub.pending = true;
          queueMicrotask(() => { if (hub.pending) invokeHub(hub); });
        }
      };
      source.on("add", hub.handle);
      hubs.set(source, hub);
      liveHubs++;
      return hub;
    }
    function subscribe(source, callback, key) {
      const hub = getHub(source);
      const record = { callback, key };
      hub.subscribers.add(record);
      let records = hub.byKey.get(key);
      if (!records) hub.byKey.set(key, records = new Set());
      records.add(record);
      if (typeof source.incObservers === "function") source.incObservers();
      let subscribed = true;
      return function () {
        if (!subscribed) return;
        subscribed = false;
        hub.subscribers.delete(record);
        const records = hub.byKey.get(key);
        if (records) {
          records.delete(record);
          if (records.size === 0) hub.byKey.delete(key);
        }
        if (typeof source.decObservers === "function") source.decObservers();
        if (hub.subscribers.size === 0) {
          source.off("add", hub.handle);
          hubs.delete(source);
          liveHubs--;
        }
      };
    }
    function isBatchable(entries) {
      return Array.isArray(entries) && entries.every((entry) => entry &&
        entry.eventOrEvents === "add" && entry.source &&
        typeof entry.source.on === "function" && typeof entry.source.off === "function" &&
        typeof entry.callback === "function");
    }
    function batchedUseListeners(entries, target) {
      const targetKey = target == null ? null : String(target);
      const currentCallbacks = entries.map((entry) => entry.callback);
      const callbackRef = React.useRef(currentCallbacks);
      callbackRef.current = currentCallbacks;
      const signature = "wa-add-route:" + targetKey + ":" +
        entries.map((entry) => sourceId(entry.source)).join("-");
      React.useLayoutEffect(function () {
        const removers = entries.map((entry, index) => subscribe(entry.source, function () {
          const callback = callbackRef.current[index];
          if (callback) callback();
        }, targetKey));
        return function () { removers.forEach((remove) => remove()); };
      }, [signature]);
    }
    function markCall(fn, self, args) {
      const previous = collectionContext;
      collectionContext = { target: args[1] };
      try { return fn.apply(self, args); }
      finally { collectionContext = previous; }
    }
    const wrappedCollectionValues = function () {
      return markCall(originalCollectionValues, this, arguments);
    };
    const wrappedOptionalValues = function () {
      return markCall(originalOptionalValues, this, arguments);
    };
    const wrappedUseListeners = function (entries) {
      if (collectionContext && isBatchable(entries))
        return batchedUseListeners(entries, collectionContext.target);
      return originalUseListeners.apply(this, arguments);
    };

    try {
      Values.useCollectionValues = wrappedCollectionValues;
      Values.useOptionalCollectionValues = wrappedOptionalValues;
      Listeners.useListeners = wrappedUseListeners;
    } catch {
      try {
        Values.useCollectionValues = originalCollectionValues;
        Values.useOptionalCollectionValues = originalOptionalValues;
        Listeners.useListeners = originalUseListeners;
      } catch {}
      return "readonly";
    }
    if (Values.useCollectionValues !== wrappedCollectionValues ||
        Values.useOptionalCollectionValues !== wrappedOptionalValues ||
        Listeners.useListeners !== wrappedUseListeners) return "readonly";

    const ctl = {
      set(v) { on = !!v; },
      reset() { addEvents = flushes = callbacks = skipped = 0; },
      info() { return { enabled: on, addEvents, flushes, callbacks, skipped, liveHubs }; },
    };
    state.collectionBatch = ctl;
    registry("collectionBatch").set(Values, ctl);
    return "ok";
  }

  // slice rows using a simple array instead of every time recreating the full chat list
  function installMessageSlice(CollectionModule) {
    if (!CollectionModule || typeof CollectionModule.ChatMsgsCollection !== "function")
      return "shape";
    const instance = findConversationComponent((node) =>
      typeof node.getMsgs === "function" &&
      node.props && node.props.msgCollection && node.state && node.state.cursor);
    if (!instance) return "no-instance";
    const P = Object.getPrototypeOf(instance);
    const existing = registry("messageSlice").get(P);
    if (existing) { state.messageSlice = existing; return "reused"; }

    const OriginalCollection = CollectionModule.ChatMsgsCollection;
    const originalGetMsgs = P.getMsgs;
    const originalGetRenderedMessageCount = P.getRenderedMessageCount;
    if (typeof originalGetRenderedMessageCount !== "function") return "shape";
    const fullCounts = new WeakMap();
    let on = true, calls = 0, models = 0, countHits = 0;
    class ArrayCollection {
      constructor() { this.models = []; this.length = 0; }
      set(items) {
        this.models = Array.isArray(items) ? items : Array.from(items || []);
        this.length = this.models.length;
        models += this.length;
        return this;
      }
      toArray() { return this.models; }
      get(key) {
        for (let i = 0; i < this.models.length; i++) {
          const id = this.models[i] && this.models[i].id;
          if (id === key || (id != null && key != null && String(id) === String(key)))
            return this.models[i];
        }
      }
      indexOf(model) { return this.models.indexOf(model); }
      reset() { this.models = []; this.length = 0; return this; }
    }
    function withCollection(self, args, Constructor) {
      const previous = CollectionModule.ChatMsgsCollection;
      CollectionModule.ChatMsgsCollection = Constructor;
      try { return originalGetMsgs.apply(self, args); }
      finally { CollectionModule.ChatMsgsCollection = previous; }
    }

    // check message order and paging against WA before making changes
    try {
      const stock = withCollection(instance, [false], OriginalCollection);
      const fast = withCollection(instance, [false], ArrayCollection);
      if (stock.length !== fast.length || stock.some((msg, i) =>
          !fast[i] || String(msg.id) !== String(fast[i].id))) return "selftest";
    } catch { return "selftest-threw"; }
    calls = models = 0;

    const wrapped = function () {
      if (!on) return originalGetMsgs.apply(this, arguments);
      calls++;
      const full = arguments[0] !== true;
      if (!full) fullCounts.delete(this);
      const result = withCollection(this, arguments, ArrayCollection);
      if (full) fullCounts.set(this, result.length);
      return result;
    };
    const wrappedCount = function () {
      if (on && fullCounts.has(this)) {
        countHits++;
        return fullCounts.get(this);
      }
      return originalGetRenderedMessageCount.apply(this, arguments);
    };
    try {
      P.getMsgs = wrapped;
      P.getRenderedMessageCount = wrappedCount;
    } catch {
      try { P.getMsgs = originalGetMsgs; P.getRenderedMessageCount = originalGetRenderedMessageCount; }
      catch {}
      return "readonly";
    }
    if (P.getMsgs !== wrapped || P.getRenderedMessageCount !== wrappedCount) return "readonly";
    const ctl = {
      set(v) { on = !!v; },
      reset() { calls = models = countHits = 0; },
      info() { return { enabled: on, calls, models, countHits }; },
    };
    state.messageSlice = ctl;
    registry("messageSlice").set(P, ctl);
    return "ok";
  }

  // avoid resizing loading extra views of messages 
  function installMessageRunway() {
    const instance = findConversationComponent((node) =>
      typeof node.getMsgs === "function" && typeof node.loadEarlierMsgs === "function" &&
      node.props && node.props.msgCollection && node.state && node.state.cursor);
    if (!instance) return "no-instance";
    const P = Object.getPrototypeOf(instance);
    const existing = registry("messageRunway").get(P);
    if (existing) { state.messageRunway = existing; return "reused"; }

    const originalDidUpdate = P.componentDidUpdate;
    if (typeof originalDidUpdate !== "function") return "shape";
    let target = settings.messageLimit;
    const warmed = new WeakSet(), queued = new WeakSet(), pending = new Set();
    let on = true, scheduled = 0, expansions = 0, bottomRestores = 0;
    function expand(cursor, collection) {
      if (!cursor || !collection || typeof cursor.loadBefore !== "function" ||
          typeof cursor.loadAfter !== "function") return cursor;
      let missing = target - (cursor.before + cursor.after);
      if (missing <= 0) return cursor;
      const before = typeof cursor.hasBefore === "function" && cursor.hasBefore(collection);
      const after = typeof cursor.hasAfter === "function" && cursor.hasAfter(collection);
      let next = cursor;
      if (before && after) {
        const above = Math.ceil(missing / 2);
        next = next.loadBefore(collection, { count: above });
        missing -= above;
        if (missing > 0) next = next.loadAfter(collection, { count: missing });
      } else if (after) {
        next = next.loadAfter(collection, { count: missing });
      } else {
        next = next.loadBefore(collection, { count: missing });
      }
      expansions++;
      return next;
    }
    function schedule(self, delay = 500) {
      const chat = self && self.props && self.props.chat;
      if (!on || !chat || warmed.has(chat) || queued.has(chat)) return;
      queued.add(chat);
      scheduled++;
      const record = { timer: 0, chat };
      record.timer = setTimeout(function () {
        pending.delete(record);
        queued.delete(chat);
        if (!on || self.props.chat !== chat || !self.scrollContainer ||
            !self.scrollContainer.isConnected) return;
        warmed.add(chat);
        const normalBottom = self.state.focusCtx == null && self.props.threadId == null &&
          self.state.isNearBottom;
        const cursor = expand(self.state.cursor, self.props.msgCollection);
        if (cursor === self.state.cursor) return;
        self.setState({ cursor }, function () {
          if (!normalBottom || self.props.chat !== chat || !self.scrollContainer) return;
          self.scrollContainer.scrollTop = self.scrollContainer.scrollHeight;
          bottomRestores++;
        });
      }, delay);
      pending.add(record);
    }
    const wrappedDidUpdate = function (previousProps) {
      const result = originalDidUpdate.apply(this, arguments);
      if (!previousProps || previousProps.chat !== this.props.chat) schedule(this);
      return result;
    };
    try { P.componentDidUpdate = wrappedDidUpdate; } catch { return "readonly"; }
    if (P.componentDidUpdate !== wrappedDidUpdate) return "readonly";
    schedule(instance);

    const ctl = {
      set(v) {
        on = !!v;
        if (!on) {
          for (const record of pending) {
            clearTimeout(record.timer);
            queued.delete(record.chat);
          }
          pending.clear();
        } else schedule(instance);
      },
      setLimit(value) {
        target = normalizeMessageLimit(value);
        const chat = instance && instance.props && instance.props.chat;
        if (on && chat) {
          warmed.delete(chat);
          schedule(instance, 0);
        }
      },
      reset() { scheduled = expansions = bottomRestores = 0; },
      info() {
        return { enabled: on, target, scheduled, expansions, bottomRestores,
          pending: pending.size };
      },
    };
    state.messageRunway = ctl;
    registry("messageRunway").set(P, ctl);
    return "ok";
  }

  // retain virtual message island
  function installMessageWindow() {
    const instance = findConversationComponent((node) =>
      typeof node.hasMoreMessagesOnIslandBelow === "function" &&
      typeof node.getRenderedMessageCount === "function" &&
      node.state && node.state.cursor);
    if (!instance) return "no-instance";
    const P = Object.getPrototypeOf(instance);
    const existing = registry("messageWindow").get(P);
    if (existing) { state.messageWindow = existing; return "reused"; }

    const found = findIslandSlicer(P);
    if (!found) return "no-slicer";
    const SLICE = found.name, F = found.fields;
    resolved.island = { slice: SLICE, fields: F };
    const originalSlice = P[SLICE];
    const originalHasBelow = P.hasMoreMessagesOnIslandBelow;
    let cap = settings.messageLimit;
    let shift = Math.max(10, Math.round(cap / 5));
    let on = true, slices = 0, maxInput = 0;
    const slice = function (items) {
      if (!on) return originalSlice.apply(this, arguments);
      slices++;
      if (items.length > maxInput) maxInput = items.length;
      const cursorSize = this.state.cursor.before + this.state.cursor.after;
      if (items.length <= cap) {
        this[F.start] = 0;
        this[F.height] = cursorSize;
        return items;
      }
      const movement = Math.max(cursorSize - this[F.height], shift);
      let start;
      if (this[F.up]) {
        start = Math.max(0, this[F.start] - movement);
      } else {
        const lastStart = Math.max(0, items.length - cap);
        start = Math.min(lastStart, this[F.start] + movement);
      }
      this[F.start] = Math.max(0, Math.min(start, items.length - cap));
      this[F.height] = cursorSize;
      return items.slice(this[F.start], this[F.start] + cap);
    };
    const hasBelow = function () {
      if (!on) return originalHasBelow.apply(this, arguments);
      return this.getRenderedMessageCount() > this[F.start] + cap;
    };
    try {
      P[SLICE] = slice;
      P.hasMoreMessagesOnIslandBelow = hasBelow;
    } catch {
      try { P[SLICE] = originalSlice; P.hasMoreMessagesOnIslandBelow = originalHasBelow; }
      catch {}
      return "readonly";
    }
    if (P[SLICE] !== slice || P.hasMoreMessagesOnIslandBelow !== hasBelow) return "readonly";
    const ctl = {
      set(v) { on = !!v; },
      setLimit(value) {
        const next = normalizeMessageLimit(value);
        if (next === cap) return;
        cap = next;
        shift = Math.max(10, Math.round(cap / 5));
        const pane = instance && instance.scrollContainer;
        if (!on || !pane || !pane.isConnected || typeof instance.forceUpdate !== "function")
          return;
        const fromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        instance.forceUpdate(function () {
          if (!pane.isConnected) return;
          pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight - fromBottom);
        });
      },
      reset() { slices = maxInput = 0; },
      info() { return { enabled: on, cap, shift, slices, maxInput,
        boundTo: SLICE, fields: F }; },
    };
    state.messageWindow = ctl;
    registry("messageWindow").set(P, ctl);
    return "ok";
  }

  // cache clock strings used by the msgs
  function installClockCache(Clock, Moment) {
    if (!Clock || typeof Clock.timestampStr !== "function" ||
        !Moment || typeof Moment.locale !== "function") return "shape";
    const existing = registry("clockCache").get(Clock);
    if (existing) { state.clockCache = existing; return "reused"; }

    const names = ["relativeStr", "relativeDateStr", "relativeDateAndTimeStr",
      "dateStr", "monthStr", "monthYearStr", "timeStr", "timestampStr", "monthDayStr"];
    const originals = new Map(), cache = new Map(), formatters = new Map();
    const privates = resolveClockPrivates(Clock);
    if (!privates) return "unresolved";
    const p2Name = privates.time, p4Name = privates.date, p6Name = privates.monthDay;
    resolved.clock = { time: p2Name, date: p4Name, monthDay: p6Name };
    const originalP2 = Clock[p2Name], originalP4 = Clock[p4Name], originalP6 = Clock[p6Name];
    if (typeof originalP2 !== "function" || typeof originalP4 !== "function" ||
        typeof originalP6 !== "function") return "shape";
    let on = true, hits = 0, misses = 0, formatterCreates = 0;
    for (const name of names) if (typeof Clock[name] === "function") originals.set(name, Clock[name]);
    if (!originals.size) return "shape";

    const define = (name, value) => {
      try { Object.defineProperty(Clock, name, { configurable: true, writable: true, value }); }
      catch {}
    };
    const restorePrivates = () => {
      define(p2Name, originalP2); define(p4Name, originalP4); define(p6Name, originalP6);
    };

    function formatter(kind, context, options) {
      const zone = context.timeZoneHardCode || "";
      const key = kind + "|" + Moment.locale() + "|" + zone + "|" +
        (options.hour12 == null ? "" : options.hour12) + "|" +
        (options.year || "");
      let value = formatters.get(key);
      if (!value) {
        const opts = Object.assign({}, options);
        if (zone) opts.timeZone = zone;
        value = new Intl.DateTimeFormat(Moment.locale(), opts);
        formatters.set(key, value);
        formatterCreates++;
      }
      return value;
    }
    function fastP2(timestamp) {
      if (!on || !this.shouldUseIntlDateTimeFormat())
        return originalP2.apply(this, arguments);
      const hour24 = this.getIs24Hour();
      let value = formatter("time", this,
        { hour12: !hour24, hour: "numeric", minute: "numeric" }).format(timestamp * 1000);
      return hour24 ? value.replace(/^24/, "00") : value.replace(/^0/, "12");
    }
    function fastP4(timestamp) {
      if (!on || !this.shouldUseIntlDateTimeFormat())
        return originalP4.apply(this, arguments);
      return formatter("date", this,
        { year: "numeric", month: "numeric", day: "numeric" }).format(timestamp * 1000);
    }
    function fastP6(timestamp, includeYear) {
      if (!on || !this.shouldUseIntlDateTimeFormat())
        return originalP6.apply(this, arguments);
      const options = { month: "short", day: "numeric" };
      if (includeYear === true) options.year = "numeric";
      return formatter("month-day", this, options).format(timestamp * 1000);
    }
    const originalTimeStr = originals.get("timeStr");
    function fastTimeStr(timestamp) {
      if (!on || !this.shouldUseIntlDateTimeFormat())
        return originalTimeStr.apply(this, arguments);
      const adjusted = (timestamp + this.skew) * 1000;
      const hour24 = this.getIs24Hour();
      const time = formatter("time", this,
        { hour12: !hour24, hour: "numeric", minute: "numeric" }).format(adjusted);
      const date = formatter("date", this,
        { year: "numeric", month: "numeric", day: "numeric" }).format(adjusted);
      return time + ", " + date;
    }

    // guard for timezones
    const sample = Math.floor(Date.now() / 1000) - 1234567;
    try {
      const expected = [originalP2.call(Clock, sample), originalP4.call(Clock, sample),
        originalP6.call(Clock, sample, false), originalP6.call(Clock, sample, true),
        originalTimeStr.call(Clock, sample)];
      define(p2Name, fastP2); define(p4Name, fastP4); define(p6Name, fastP6);
      const actual = [fastP2.call(Clock, sample), fastP4.call(Clock, sample),
        fastP6.call(Clock, sample, false), fastP6.call(Clock, sample, true),
        fastTimeStr.call(Clock, sample)];
      if (expected.some((value, i) => value !== actual[i])) throw Error("formatter mismatch");
    } catch {
      restorePrivates();
      return "formatter-selftest";
    }

    let cachedDay = "", cachedDaySkew = NaN, nextDayCheck = 0;
    function keyFor(name, args) {
      const now = Date.now(), skew = Number(Clock.skewMS) || 0;
      if (now >= nextDayCheck || skew !== cachedDaySkew) {
        cachedDay = new Date(now + skew).toDateString();
        cachedDaySkew = skew;
        nextDayCheck = now + 30000;
      }
      const hour24 = typeof Clock.getIs24Hour === "function" ? Clock.getIs24Hour() : "?";
      let key = name + "|" + Clock.skewMS + "|" + hour24 + "|" + cachedDay;
      for (let i = 0; i < args.length; i++) key += "|" + typeof args[i] + ":" + String(args[i]);
      return key;
    }
    try {
      originals.forEach((original, name) => {
        const implementation = name === "timeStr" ? fastTimeStr : original;
        Object.defineProperty(Clock, name, {
          configurable: true,
          writable: true,
          value: function () {
            if (!on) return implementation.apply(this, arguments);
            const key = keyFor(name, arguments);
            if (cache.has(key)) { hits++; return cache.get(key); }
            misses++;
            const value = implementation.apply(this, arguments);
            cache.set(key, value);
            if (cache.size > 2048) cache.delete(cache.keys().next().value);
            return value;
          },
        });
      });
    } catch {
      originals.forEach((original, name) => define(name, original));
      restorePrivates();
      return "readonly";
    }

    const ctl = {
      set(v) { on = !!v; },
      reset() { hits = misses = 0; cache.clear(); },
      info() {
        return { enabled: on, hits, misses, entries: cache.size, methods: originals.size,
          formatters: formatters.size, formatterCreates };
      },
    };
    state.clockCache = ctl;
    registry("clockCache").set(Clock, ctl);
    return "ok";
  }

  // WAQoL panel
  function installPanelUI() {
    const existing = window.__waQolUI;
    if (existing && typeof existing.reconcile === "function") {
      existing.reconcile();
      return "reused";
    }

    const style = document.createElement("style");
    style.className = "waqol__styles";
    style.textContent = `
      .waqol__nav-item{width:40px;height:40px;flex:0 0 40px}
      .waqol__nav-button{width:40px;height:40px;padding:0;border:0;border-radius:50%;
        display:grid;place-items:center;background:transparent;color:var(--WDS-content-deemphasized,var(--icon,#54656f));
        cursor:pointer;position:relative;outline:none}
      .waqol__nav-button:hover{background:var(--WDS-surface-highlight,rgba(255,255,255,.1))}
      .waqol__nav-button:focus-visible{box-shadow:0 0 0 2px var(--WDS-accent,#21c063)}
      .waqol__nav-button[aria-expanded="true"]{background:transparent;
        color:var(--WDS-content-default,var(--primary,#111b21))}
      .waqol__nav-button[aria-expanded="true"]:hover{background:var(--WDS-surface-highlight,rgba(255,255,255,.1))}
      .waqol__nav-button svg{display:block;width:24px;height:24px}
      .waqol__tooltip[hidden]{display:none!important}
      .waqol__tooltip{position:fixed;z-index:2147483645;transform:translateY(-50%);
        padding:4px 8px;border-radius:4px;max-width:200px;white-space:pre-line;pointer-events:none;
        background:var(--WDS-surface-inverse,#eee);color:var(--WDS-content-inverse,#0a0a0a);
        font-size:12px;line-height:16px;font-weight:400;
        box-shadow:0 0 20px rgba(0,0,0,.2),0 1px 0 rgba(0,0,0,.04)}
      .waqol__overlay[hidden]{display:none!important}
      .waqol__overlay{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;
        padding:24px;background:var(--WDS-background-dimmer,rgba(0,0,0,.32));font-family:"Roboto Variable",Roboto,"Helvetica Neue",Helvetica,sans-serif;
        color:var(--WDS-content-default,var(--primary,#111b21));box-sizing:border-box;opacity:0}
      .waqol__dialog{width:min(868px,calc(100vw - 48px));height:min(705px,calc(100vh - 48px));
        display:flex;flex-direction:column;overflow:hidden;border-radius:18px;transform-origin:center;
        background:var(--WDS-surface-elevated-default,#fff);
        box-shadow:rgba(0,0,0,.26) 0 2px 18px 0,rgba(0,0,0,.1) 0 8px 10px 0}
      .waqol__overlay--open{animation:waqol-backdrop-in 280ms cubic-bezier(.2,0,0,1) both}
      .waqol__overlay--open .waqol__dialog{animation:waqol-dialog-in 200ms cubic-bezier(.2,0,0,1) 180ms both}
      .waqol__overlay--closing{animation:waqol-backdrop-out 280ms cubic-bezier(.8,0,1,1) 120ms both}
      .waqol__overlay--closing .waqol__dialog{animation:waqol-dialog-out 200ms cubic-bezier(.8,0,1,1) both}
      @keyframes waqol-backdrop-in{from{opacity:0}to{opacity:1}}
      @keyframes waqol-dialog-in{from{opacity:0;transform:scale(0)}to{opacity:1;transform:scale(1)}}
      @keyframes waqol-dialog-out{from{transform:scale(1)}to{transform:scale(0)}}
      @keyframes waqol-backdrop-out{from{opacity:1}to{opacity:0}}
      .waqol__dialog *{box-sizing:border-box}
      .waqol__header{display:block;padding:24px 36px 18px}
      .waqol__title{margin:0;font-size:22px;line-height:28px;font-weight:400;letter-spacing:normal}
      .waqol__body{padding:0 36px 22px;overflow:auto;overscroll-behavior:contain;flex:1 1 auto}
      .waqol__section{margin:0}
      .waqol__section--history{margin-bottom:22px}
      .waqol__section-title{margin:0;font-size:14px;line-height:20px;font-weight:545;
        color:var(--WDS-content-deemphasized,var(--secondary,#667781))}
      .waqol__setting-list{margin-top:19px}
      .waqol__setting{min-height:67px;padding:14px 0 0;display:block}
      .waqol__setting-content{min-height:53px;padding:0 0 14px;border-bottom:1px solid var(--WDS-lines-divider,rgba(255,255,255,.1))}
      .waqol__setting-title{font-size:15px;line-height:20px;font-weight:400}
      .waqol__setting-meta{margin-top:1px;color:var(--WDS-lines-outline-default,#757778);font-size:14px;line-height:18px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .waqol__setting--editable{padding-top:14px}
      .waqol__setting--editable .waqol__setting-content{padding-bottom:14px;display:flex;align-items:flex-start;gap:24px}
      .waqol__setting-copy{min-width:0;flex:1}
      .waqol__field{width:128px;height:40px;display:flex;align-items:flex-start;flex:0 0 128px;
        border-bottom:2px solid var(--WDS-lines-outline-default,#757778);transition:border-color 100ms linear}
      .waqol__field:focus-within{border-bottom-color:var(--WDS-accent,var(--input-border-active,#21c063))}
      .waqol__input{min-width:0;flex:1;height:38px;padding:8px 0 5px;border:0;border-radius:0;outline:0;
        background:transparent;color:inherit;caret-color:var(--WDS-accent,#21c063);
        font:inherit;font-size:17px;line-height:25px;color-scheme:light dark}
      @media(prefers-reduced-motion:reduce){.waqol__overlay--open,.waqol__overlay--closing,
        .waqol__overlay--open .waqol__dialog,.waqol__overlay--closing .waqol__dialog{animation-duration:1ms;animation-delay:0ms}}
      @media(max-width:560px){.waqol__overlay{padding:12px}.waqol__dialog{width:calc(100vw - 24px);height:calc(100vh - 24px)}
        .waqol__header{padding:20px 18px 14px}.waqol__body{padding:0 18px 18px}}
    `;
    (document.head || document.documentElement).appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.className = "waqol__nav-item";
    const navButton = document.createElement("button");
    navButton.className = "waqol__nav-button";
    navButton.type = "button";
    navButton.setAttribute("aria-expanded", "false");
    navButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none">' +
      '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M12 10.75v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="7.25" r="1.15" fill="currentColor"/></svg>';
    wrapper.appendChild(navButton);

    const tooltip = document.createElement("div");
    tooltip.className = "waqol__tooltip";
    tooltip.id = "waqol-nav-tooltip";
    tooltip.textContent = "WAQoL";
    tooltip.hidden = true;
    function showTooltip() {
      if (navButton.getAttribute("aria-expanded") === "true") return;
      const rect = navButton.getBoundingClientRect();
      tooltip.hidden = false;
      tooltip.style.left = Math.round(rect.right + 4) + "px";
      tooltip.style.top = Math.round(rect.top + rect.height / 2) + "px";
    }
    function hideTooltip() { tooltip.hidden = true; }
    navButton.addEventListener("mouseenter", showTooltip);
    navButton.addEventListener("mouseleave", hideTooltip);
    navButton.addEventListener("focus", showTooltip);
    navButton.addEventListener("blur", hideTooltip);
    navButton.addEventListener("click", hideTooltip);

    const overlay = document.createElement("div");
    overlay.className = "waqol__overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="waqol__dialog" tabindex="-1">
        <header class="waqol__header">
          <h2 class="waqol__title">WAQoL</h2>
        </header>
        <div class="waqol__body">
          <section class="waqol__section waqol__section--history">
            <h3 class="waqol__section-title">Message history</h3>
            <div class="waqol__setting-list">
              <div class="waqol__setting waqol__setting--editable">
                <div class="waqol__setting-content">
                  <div class="waqol__setting-copy">
                    <div class="waqol__setting-title">Message limit</div>
                    <div class="waqol__setting-meta">Limit of messages until it starts loading from the history</div>
                  </div>
                  <div class="waqol__field">
                    <input class="waqol__input" type="number" min="${MIN_MESSAGE_LIMIT}" max="${MAX_MESSAGE_LIMIT}" step="10" inputmode="numeric">
                  </div>
                </div>
              </div>
            </div>
          </section>
          <section class="waqol__section">
            <h3 class="waqol__section-title">Optimization status</h3>
            <div class="waqol__setting-list waqol__status-list"></div>
          </section>
        </div>
      </section>`;

    const statusList = overlay.querySelector(".waqol__status-list");
    const input = overlay.querySelector(".waqol__input");
    let previousFocus = null, closeTimer = 0;

    function optimizationInfo(key) {
      try { return state[key] && typeof state[key].info === "function" ? state[key].info() : null; }
      catch { return null; }
    }
    function refreshStatus() {
      statusList.replaceChildren();
      for (const [key, label] of FIXES) {
        const info = optimizationInfo(key);
        let word = "Active";
        if (!info) word = "Unavailable";
        else if (info.enabled === false) word = "Disabled";
        else if (key === "scrollLayer" && !info.applied) word = "Ready";
        const row = document.createElement("div");
        row.className = "waqol__setting";
        const copy = document.createElement("div");
        copy.className = "waqol__setting-content";
        const name = document.createElement("div");
        name.className = "waqol__setting-title";
        name.textContent = label;
        const detail = document.createElement("div");
        detail.className = "waqol__setting-meta";
        detail.textContent = word;
        copy.append(name, detail);
        row.append(copy);
        statusList.appendChild(row);
      }
    }
    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
      previousFocus = document.activeElement;
      input.value = String(settings.messageLimit);
      refreshStatus();
      overlay.querySelector(".waqol__body").scrollTop = 0;
      overlay.hidden = false;
      overlay.classList.remove("waqol__overlay--open", "waqol__overlay--closing");
      void overlay.offsetWidth;
      overlay.classList.add("waqol__overlay--open");
      navButton.setAttribute("aria-expanded", "true");
      setTimeout(() => {
        if (overlay.classList.contains("waqol__overlay--open"))
          input.focus({ preventScroll: true });
      }, 380);
    }
    function close() {
      if (overlay.hidden || overlay.classList.contains("waqol__overlay--closing")) return;
      const limit = normalizeMessageLimit(input.value);
      if (limit !== settings.messageLimit) {
        applyMessageLimit(limit);
        refreshStatus();
      }
      overlay.classList.remove("waqol__overlay--open");
      overlay.classList.add("waqol__overlay--closing");
      navButton.setAttribute("aria-expanded", "false");
      closeTimer = setTimeout(() => {
        closeTimer = 0;
        overlay.hidden = true;
        overlay.classList.remove("waqol__overlay--closing");
        if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function")
          previousFocus.focus();
      }, 410);
      return true;
    }
    // find <header>
    function findRail() {
      for (const header of document.querySelectorAll("header")) {
        const buttons = Array.from(header.querySelectorAll("button")).filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left < 80 && rect.top >= 0 && rect.top < 500 &&
            rect.width >= 36 && rect.width <= 44 && rect.height >= 36 && rect.height <= 44;
        });
        for (const button of buttons) {
          let candidate = button.parentElement;
          while (candidate && candidate !== header) {
            const directButtons = Array.from(candidate.children).filter((child) => {
              const found = child.matches("button") ? child : child.querySelector("button");
              if (!found) return false;
              const rect = found.getBoundingClientRect();
              return rect.left < 80 && rect.width >= 36 && rect.width <= 44;
            });
            if (directButtons.length >= 4) return candidate;
            candidate = candidate.parentElement;
          }
        }
      }
      return null;
    }
    function reconcile() {
      if (wrapper.isConnected) return true;
      const rail = findRail();
      if (!rail) return false;
      const separator = Array.from(rail.children).find((child) => child.tagName === "HR");
      rail.insertBefore(wrapper, separator || null);
      return true;
    }

    navButton.addEventListener("click", open);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); close(); }
    });
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(overlay.querySelectorAll("button:not(:disabled),input:not(:disabled)"));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    const body = document.body || document.documentElement;
    body.appendChild(overlay);
    body.appendChild(tooltip);
    const ctl = { open, close, reconcile, refresh: refreshStatus, info: () => ({
      mounted: wrapper.isConnected, open: !overlay.hidden, messageLimit: settings.messageLimit,
    }) };
    window.__waQolUI = ctl;
    reconcile();
    setInterval(reconcile, 2000);
    return "ok";
  }

  function startPanelUI() {
    try { installPanelUI(); }
    catch (error) { LOG("panel unavailable", error); }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", startPanelUI, { once: true });
  else startPanelUI();

  let done = false;
  function attempt() {
    if (done) return true;
    // wait until the main UI is fully loaded before making changes
    if (!document.querySelector("#main")) return false;
    const R = window.require;
    if (typeof R !== "function") return false;
    let E, React;
    try { E = R("WAWebEventEmitter"); React = R("react"); } catch { return false; }
    if (!E || !React) return false;
    const results = {
      scrollLayer: installScrollLayer(),
      emitter: installEmitterFix(E),
    };

    const optional = [
      ["historyPage", () => installHistoryPageLimit(
        R("WAWebChatLoadMessages"), R("WAWebCollectionConstants"))],
      ["collectionBatch", () => installCollectionAddBatch(
        React, R("useWAWebCollectionValues"), R("useWAWebListener"))],
      ["messageSlice", () => installMessageSlice(R("WAWebChatMsgsCollection"))],
      ["messageRunway", () => installMessageRunway()],
      ["messageWindow", () => installMessageWindow()],
      ["clockCache", () => installClockCache(R("WAWebClock").Clock, R("WAWeb-moment"))],
    ];
    for (const [key, install] of optional) {
      try { results[key] = install(); }
      catch { results[key] = "unavailable"; }
    }
    done = true;
    LOG(results);
    return true;
  }

  if (!attempt()) {
    const iv = setInterval(() => { if (attempt()) clearInterval(iv); }, 500);
  }
})();
