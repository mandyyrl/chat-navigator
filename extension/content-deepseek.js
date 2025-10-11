(() => {
  const SEL_MSG = '.ds-message';
  const SEL_SCROLL = '.ds-scroll-area';

  const nowTs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // --- Route helpers (Stage 3) ---
  function isConversationRouteDeepseek(pathname = location.pathname) {
    try {
      const segs = String(pathname || '').split('/').filter(Boolean);
      const i = segs.indexOf('s');
      if (i === -1) return false;
      const slug = segs[i + 1];
      return typeof slug === 'string' && slug.length > 0 && /^[A-Za-z0-9_-]+$/.test(slug);
    } catch { return false; }
  }

  function extractConversationIdFromPath(pathname = location.pathname) {
    try {
      const segs = String(pathname || '').split('/').filter(Boolean);
      const i = segs.indexOf('s');
      if (i === -1) return null;
      const slug = segs[i + 1];
      return (slug && /^[A-Za-z0-9_-]+$/.test(slug)) ? slug : null;
    } catch { return null; }
  }

  // --- DOM utilities (Stage 2) ---
  function waitForElement(selector, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const n = document.querySelector(selector);
        if (n) {
          try { obs.disconnect(); } catch {}
          resolve(n);
        }
      });
      try { obs.observe(document.body, { childList: true, subtree: true }); } catch {}
      setTimeout(() => { try { obs.disconnect(); } catch {} resolve(null); }, timeoutMs);
    });
  }

  function isElementScrollable(el) {
    if (!el) return false;
    try {
      const cs = getComputedStyle(el);
      const oy = (cs.overflowY || '').toLowerCase();
      const overflowOk = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
      if (!overflowOk && el !== document.scrollingElement && el !== document.documentElement && el !== document.body) return false;
      // content larger than viewport
      if ((el.scrollHeight - el.clientHeight) > 4) return true;
      // try programmatic scroll
      const prev = el.scrollTop;
      el.scrollTop = prev + 1;
      const changed = el.scrollTop !== prev;
      el.scrollTop = prev;
      return changed;
    } catch { return false; }
  }

  function getScrollableAncestor(startEl) {
    // 1) Prefer nearest scrollable ancestor in the chain
    let el = startEl;
    while (el && el !== document.body) {
      if (isElementScrollable(el)) return el;
      el = el.parentElement;
    }
    // 2) Site-provided scroll area if it actually scrolls and contains the conversation
    try {
      const siteScroll = document.querySelector(SEL_SCROLL);
      if (siteScroll && (siteScroll.contains(startEl) || startEl.contains(siteScroll)) && isElementScrollable(siteScroll)) {
        return siteScroll;
      }
    } catch {}
    // 3) Fallback to document scroller if scrollable
    const docScroll = document.scrollingElement || document.documentElement || document.body;
    return isElementScrollable(docScroll) ? docScroll : (document.documentElement || document.body);
  }

  function normalizeText(text) {
    try {
      let s = String(text || '').replace(/\s+/g, ' ').trim();
      s = s.replace(/^\s*(you\s*said\s*[:：]?\s*)/i, '');
      s = s.replace(/^\s*((你说|您说|你說|您說)\s*[:：]?\s*)/, '');
      return s;
    } catch { return ''; }
  }

  // Heuristic user-message detector
  // Primary: user messages are followed by an actions toolbar (next sibling)
  // Fallback: user bubbles are right-aligned relative to the conversation container
  function detectIsUserMessage(el, conversationContainer) {
    try {
      const next = el?.nextElementSibling;
      if (next) {
        // Strong signals of the user action toolbar
        if (next.querySelector('.ds-icon-button, .ds-icon-button__hover-bg')) return true;
        // Generic action buttons that contain ds-icon
        const btnLike = Array.from(next.querySelectorAll('[role="button"], button, [tabindex]'));
        if (btnLike.some(b => b.querySelector('.ds-icon'))) return true;
        // Layout container often uses ds-flex; presence together with icons is also a hint
        if (next.querySelector('.ds-flex .ds-icon')) return true;
      }
    } catch {}

    // Geometry fallback: right-aligned bubbles treated as user messages
    try {
      const cRect = conversationContainer?.getBoundingClientRect?.();
      const r = el?.getBoundingClientRect?.();
      if (cRect && r) {
        const centerX = r.left + (r.width || 0) / 2;
        const midX = cRect.left + (cRect.width || 0) / 2;
        if ((centerX - midX) >= 16) return true; // threshold 16px to avoid jitter
      }
    } catch {}
    return false;
  }

  // --- Timeline Manager (Stage 2,5,6 minimal) ---
  class DeepseekTimeline {
    constructor() {
      this.conversationContainer = null;
      this.scrollContainer = null;
      this.timelineBar = null;
      this.track = null;
      this.trackContent = null;
      this.markers = [];
      this.firstOffset = 0;
      this.spanPx = 1;
      this.onScroll = null;
      this.mutationObserver = null;
      this.resizeObserver = null;
      // Stage 7: virtualization + min-gap state
      this.contentHeight = 0;
      this.yPositions = [];
      this.visibleRange = { start: 0, end: -1 };
      this.markersVersion = 0;
      this.usePixelTop = false;
      this._cssVarTopSupported = null;
      this.scrollRafId = null;

      // Stage 8: active + tooltip + star
      this.activeIdx = -1;
      this.ui = { tooltip: null };
      this.measureEl = null; // hidden measurer for tooltip truncation
      this.tooltipHideDelay = 100;
      this.tooltipHideTimer = null;
      this.showRafId = null;

      // Long-press star
      this.longPressDuration = 550; // ms
      this.longPressMoveTolerance = 6; // px
      this.longPressTimer = null;
      this.pressStartPos = null;
      this.pressTargetDot = null;
      this.suppressClickUntil = 0;
      this.starred = new Set();
      this.conversationId = null;
      this.onStorage = null; // cross-tab star sync via localStorage

      // P1: debounce active + theme/viewport observers + tooltip cache + idle correction
      this.lastActiveChangeTime = 0;
      this.minActiveChangeInterval = 120; // ms
      this.pendingActiveIdx = null;
      this.activeChangeTimer = null;
      this.themeObserver = null;
      this.onVisualViewportResize = null;
      this.truncateCache = new Map();
      this.resizeIdleTimer = null;
      this.resizeIdleDelay = 140; // ms
      this.resizeIdleRICId = null;

      // P1: debounce active + observers + caches
      this.lastActiveChangeTime = 0;
      this.minActiveChangeInterval = 120; // ms
      this.pendingActiveIdx = null;
      this.activeChangeTimer = null;
      this.themeObserver = null;
      this.onVisualViewportResize = null;
      this.truncateCache = new Map();
      this.resizeIdleTimer = null;
      this.resizeIdleDelay = 140;
      this.resizeIdleRICId = null;
    }

    async init() {
      const firstMsg = await waitForElement(SEL_MSG, 5000);
      if (!firstMsg) return;

      // Find a conversation root that contains ALL messages (lowest common ancestor)
      let root = null;
      try {
        const allMsgs = Array.from(document.querySelectorAll(SEL_MSG));
        if (allMsgs.length > 0) {
          // climb ancestors of the first message until an ancestor contains all messages
          let node = firstMsg.parentElement;
          while (node && node !== document.body) {
            let allInside = true;
            for (let i = 0; i < allMsgs.length; i++) {
              if (!node.contains(allMsgs[i])) { allInside = false; break; }
            }
            if (allInside) { root = node; break; }
            node = node.parentElement;
          }
          if (!root) root = firstMsg.parentElement;
        }
      } catch {}
      this.conversationContainer = root || firstMsg.parentElement || document.body;
      this.scrollContainer = getScrollableAncestor(this.conversationContainer);

      this.injectUI();
      // prepare tooltip + measurer
      this.ensureTooltip();

      // stars per conversation
      this.conversationId = extractConversationIdFromPath(location.pathname);
      this.loadStars();

      this.rebuildMarkers();
      this.attachObservers();
      this.attachScrollSync();
      this.attachInteractions();

      // Cross-tab star sync via localStorage 'storage' event (ChatGPT同款)
      this.onStorage = (e) => {
        try {
          if (!e || e.storageArea !== localStorage) return;
          const cid = this.conversationId;
          if (!cid) return;
          const expectedKey = `deepseekTimelineStars:${cid}`;
          if (e.key !== expectedKey) return;

          // Parse new star set
          let nextArr = [];
          try { nextArr = JSON.parse(e.newValue || '[]') || []; } catch { nextArr = []; }
          const nextSet = new Set(nextArr.map(x => String(x)));

          // Fast no-op check
          if (nextSet.size === this.starred.size) {
            let same = true;
            for (const id of this.starred) { if (!nextSet.has(id)) { same = false; break; } }
            if (same) return;
          }
          this.starred = nextSet;
          // Update markers
          for (let i = 0; i < this.markers.length; i++) {
            const m = this.markers[i];
            const want = this.starred.has(m.id);
            if (m.starred !== want) {
              m.starred = want;
              if (m.dotElement) {
                try {
                  m.dotElement.classList.toggle('starred', m.starred);
                  m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false');
                } catch {}
              }
            }
          }
          // Refresh tooltip if visible
          try {
            if (this.ui.tooltip?.classList.contains('visible')) {
              const currentDot = this.timelineBar.querySelector('.timeline-dot:hover, .timeline-dot:focus');
              if (currentDot) this.refreshTooltipForDot(currentDot);
            }
          } catch {}
        } catch {}
      };
      try { window.addEventListener('storage', this.onStorage); } catch {}
    }

    injectUI() {
      let bar = document.querySelector('.chatgpt-timeline-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'chatgpt-timeline-bar';
        document.body.appendChild(bar);
      }
      this.timelineBar = bar;
      let track = this.timelineBar.querySelector('.timeline-track');
      if (!track) {
        track = document.createElement('div');
        track.className = 'timeline-track';
        this.timelineBar.appendChild(track);
      }
      let content = track.querySelector('.timeline-track-content');
      if (!content) {
        content = document.createElement('div');
        content.className = 'timeline-track-content';
        track.appendChild(content);
      }
      this.track = track;
      this.trackContent = content;
      // Ensure external left-side slider exists (outside the bar)
      let slider = document.querySelector('.timeline-left-slider');
      if (!slider) {
        slider = document.createElement('div');
        slider.className = 'timeline-left-slider';
        const handle = document.createElement('div');
        handle.className = 'timeline-left-handle';
        slider.appendChild(handle);
        document.body.appendChild(slider);
      }
      this.ui.slider = slider;
      this.ui.sliderHandle = slider.querySelector('.timeline-left-handle');
    }

    ensureTooltip() {
      if (!this.ui.tooltip) {
        const tip = document.createElement('div');
        tip.className = 'timeline-tooltip';
        tip.setAttribute('role', 'tooltip');
        // Align id with ChatGPT for a11y consistency
        tip.id = 'chatgpt-timeline-tooltip';
        tip.setAttribute('aria-hidden', 'true');
        try { tip.style.boxSizing = 'border-box'; } catch {}
        document.body.appendChild(tip);
        this.ui.tooltip = tip;
      }
      if (!this.measureEl) {
        const m = document.createElement('div');
        m.setAttribute('aria-hidden', 'true');
        m.style.position = 'fixed';
        m.style.left = '-9999px';
        m.style.top = '0px';
        m.style.visibility = 'hidden';
        m.style.pointerEvents = 'none';
        m.style.boxSizing = 'border-box';
        const cs = getComputedStyle(this.ui.tooltip);
        Object.assign(m.style, {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          padding: cs.padding,
          border: cs.border,
          borderRadius: cs.borderRadius,
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          maxWidth: 'none',
          display: 'block',
          transform: 'none',
          transition: 'none'
        });
        try { m.style.webkitLineClamp = 'unset'; } catch {}
        document.body.appendChild(m);
        this.measureEl = m;
      }
    }

    rebuildMarkers() {
      if (!this.conversationContainer || !this.trackContent) return;
      // Clear dots
      try { this.trackContent.querySelectorAll('.timeline-dot').forEach(n => n.remove()); } catch {}

      const all = Array.from(this.conversationContainer.querySelectorAll(SEL_MSG));
      const list = all.filter(el => detectIsUserMessage(el, this.conversationContainer));
      if (list.length === 0) return;

      // Compute absolute Y positions relative to the scroll container (more robust than offsetTop)
      const cRect = this.scrollContainer.getBoundingClientRect();
      const st = this.scrollContainer.scrollTop;
      const yPositions = list.map(el => {
        const r = el.getBoundingClientRect();
        return (r.top - cRect.top) + st;
      });
      const firstY = yPositions[0];
      const lastY = (yPositions.length > 1) ? yPositions[yPositions.length - 1] : (firstY + 1);
      const span = Math.max(1, lastY - firstY);
      this.firstOffset = firstY;
      this.spanPx = span;

      // build stable id using user text hash + ordinal (per session scan)
      const seen = new Map();
      this.markers = list.map((el) => {
        const r = el.getBoundingClientRect();
        const y = (r.top - cRect.top) + st;
        const n = Math.max(0, Math.min(1, (y - firstY) / span));
        let id = el?.dataset?.turnId;
        if (!id) {
          const base = this.buildStableHashFromUser(el);
          const cnt = (seen.get(base) || 0) + 1; seen.set(base, cnt);
          id = `${base}-${cnt}`;
          try { el.dataset.turnId = id; } catch {}
        }
        return { id, el, n, baseN: n, dotElement: null, summary: normalizeText(el.textContent || ''), starred: this.starred.has(id) };
      });

      // bump version and compute geometry + virtual render
      this.markersVersion++;
      this.updateTimelineGeometry();
      this.syncTimelineTrackToMain();
      this.updateVirtualRangeAndRender();
      // ensure first active highlight reflects current viewport
      this.computeActiveByScroll();
      this.updateActiveDotUI();
    }

    scrollToMessage(targetEl) {
      if (!this.scrollContainer || !targetEl) return;
      const containerRect = this.scrollContainer.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const to = targetRect.top - containerRect.top + this.scrollContainer.scrollTop;
      const from = this.scrollContainer.scrollTop;
      const dist = to - from;
      const dur = 500;
      let t0 = null;
      const ease = (t, b, c, d) => {
        t /= d / 2; if (t < 1) return c / 2 * t * t + b; t--; return -c / 2 * (t * (t - 2) - 1) + b;
      };
      const step = (ts) => {
        if (t0 === null) t0 = ts;
        const dt = ts - t0;
        const v = ease(dt, from, dist, dur);
        this.scrollContainer.scrollTop = v;
        if (dt < dur) requestAnimationFrame(step); else this.scrollContainer.scrollTop = to;
      };
      requestAnimationFrame(step);
    }

    attachObservers() {
      // Rebuild when messages change (debounced lightly)
      let timer = null;
      this.mutationObserver = new MutationObserver(() => {
        try { this.ensureContainersUpToDate(); } catch {}
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(() => { this.rebuildMarkers(); }, 200);
      });
      try { this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true }); } catch {}

      this.resizeObserver = new ResizeObserver(() => {
        // recompute geometry and keep virtual range updated to avoid jank
        this.updateTimelineGeometry();
        this.syncTimelineTrackToMain();
        this.updateVirtualRangeAndRender();
        this.updateSlider();
        try { this.truncateCache?.clear(); } catch {}
        // NOTE: Keep min-gap computation within updateTimelineGeometry (long-canvas)
        // this.scheduleMinGapCorrection();
      });
      if (this.timelineBar) {
        try { this.resizeObserver.observe(this.timelineBar); } catch {}
      }

      // Theme observer: watch html/body class and common theme attributes
      try {
        if (!this.themeObserver) {
          this.themeObserver = new MutationObserver(() => {
            this.updateTimelineGeometry();
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();
            this.updateSlider();
            try { this.truncateCache?.clear(); } catch {}
            // NOTE: Avoid reapplying min-gap on short-canvas during theme toggles
            // this.scheduleMinGapCorrection();
          });
        }
        const attrs = ['class','data-theme','data-color-mode','data-color-scheme'];
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: attrs });
        try { this.themeObserver.observe(document.body, { attributes: true, attributeFilter: attrs }); } catch {}
      } catch {}

      // Visual viewport (zoom) listener
      if (window.visualViewport && !this.onVisualViewportResize) {
        this.onVisualViewportResize = () => {
          this.updateTimelineGeometry();
          this.syncTimelineTrackToMain();
          this.updateVirtualRangeAndRender();
          this.updateSlider();
          try { this.truncateCache?.clear(); } catch {}
          // NOTE: Keep geometry consistent; do not reapply min-gap here
          // this.scheduleMinGapCorrection();
        };
        try { window.visualViewport.addEventListener('resize', this.onVisualViewportResize); } catch {}
      }
    }

    attachScrollSync() {
      if (!this.scrollContainer) return;
      this.onScroll = () => this.scheduleScrollSync();
      try { this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true }); } catch {}
      // If using the document scroller, also listen on window to be safe
      const docScroll = document.scrollingElement || document.documentElement || document.body;
      if (this.scrollContainer === docScroll || this.scrollContainer === document.body || this.scrollContainer === document.documentElement) {
        try { window.addEventListener('scroll', this.onScroll, { passive: true }); } catch {}
      }
      // initial sync so first paint already aligned/highlighted
      this.scheduleScrollSync();
    }

    destroy() {
      try { this.mutationObserver?.disconnect(); } catch {}
      try { this.resizeObserver?.disconnect(); } catch {}
      if (this.scrollContainer && this.onScroll) {
        try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch {}
      }
      try { window.removeEventListener('scroll', this.onScroll); } catch {}
      this.onScroll = null;
      // remove interactions
      try { this.timelineBar?.removeEventListener('mouseover', this.onTimelineBarOver); } catch {}
      try { this.timelineBar?.removeEventListener('mouseout', this.onTimelineBarOut); } catch {}
      try { this.timelineBar?.removeEventListener('focusin', this.onTimelineBarFocusIn); } catch {}
      try { this.timelineBar?.removeEventListener('focusout', this.onTimelineBarFocusOut); } catch {}
      try { this.timelineBar?.removeEventListener('pointerdown', this.onPointerDown); } catch {}
      try { this.timelineBar?.removeEventListener('pointerleave', this.onPointerLeave); } catch {}
      try { window.removeEventListener('pointermove', this.onPointerMove); } catch {}
      try { window.removeEventListener('pointerup', this.onPointerUp); } catch {}
      try { window.removeEventListener('pointercancel', this.onPointerCancel); } catch {}
      try { window.removeEventListener('resize', this.onWindowResize); } catch {}
      try { this.themeObserver?.disconnect(); } catch {}
      if (this.onVisualViewportResize && window.visualViewport) {
        try { window.visualViewport.removeEventListener('resize', this.onVisualViewportResize); } catch {}
        this.onVisualViewportResize = null;
      }
      if (this.resizeIdleTimer) { try { clearTimeout(this.resizeIdleTimer); } catch {} this.resizeIdleTimer = null; }
      try { if (this.resizeIdleRICId && typeof cancelIdleCallback === 'function') cancelIdleCallback(this.resizeIdleRICId); } catch {}
      if (this.activeChangeTimer) { try { clearTimeout(this.activeChangeTimer); } catch {} this.activeChangeTimer = null; }
      try { this.themeObserver?.disconnect(); } catch {}
      this.onTimelineBarOver = this.onTimelineBarOut = this.onTimelineBarFocusIn = this.onTimelineBarFocusOut = null;
      this.onPointerDown = this.onPointerMove = this.onPointerUp = this.onPointerCancel = this.onPointerLeave = null;
      this.onWindowResize = null;

      // remove UI elements
      try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
      // remove slider and listeners
      try { this.timelineBar?.removeEventListener('pointerenter', this.onBarEnter); } catch {}
      try { this.timelineBar?.removeEventListener('pointerleave', this.onBarLeave); } catch {}
      try { this.ui.slider?.removeEventListener('pointerenter', this.onSliderEnter); } catch {}
      try { this.ui.slider?.removeEventListener('pointerleave', this.onSliderLeave); } catch {}
      try { this.ui.sliderHandle?.removeEventListener('pointerdown', this.onSliderDown); } catch {}
      try { this.ui.slider?.remove(); } catch {}
      this.ui.slider = null;
      this.ui.sliderHandle = null;
      try { this.ui.tooltip?.remove(); } catch {}
      try { this.measureEl?.remove(); } catch {}
      try { window.removeEventListener('storage', this.onStorage); } catch {}
      this.timelineBar = null;
      this.track = null;
      this.trackContent = null;
      this.markers = [];
    }
  }

  // --- Stage 7 helpers (min-gap + virtualization) ---
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  DeepseekTimeline.prototype.getCSSVarNumber = function(el, name, fallback) {
    try {
      const v = getComputedStyle(el).getPropertyValue(name).trim();
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : fallback;
    } catch { return fallback; }
  };

  DeepseekTimeline.prototype.applyMinGap = function(positions, minTop, maxTop, gap) {
    const n = positions.length;
    if (n === 0) return positions;
    const out = positions.slice();
    out[0] = Math.max(minTop, Math.min(positions[0], maxTop));
    for (let i = 1; i < n; i++) {
      const minAllowed = out[i - 1] + gap;
      out[i] = Math.max(positions[i], minAllowed);
    }
    if (out[n - 1] > maxTop) {
      out[n - 1] = maxTop;
      for (let i = n - 2; i >= 0; i--) {
        const maxAllowed = out[i + 1] - gap;
        out[i] = Math.min(out[i], maxAllowed);
      }
      if (out[0] < minTop) {
        out[0] = minTop;
        for (let i = 1; i < n; i++) {
          const minAllowed = out[i - 1] + gap;
          out[i] = Math.max(out[i], minAllowed);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (out[i] < minTop) out[i] = minTop;
      if (out[i] > maxTop) out[i] = maxTop;
    }
    return out;
  };

  DeepseekTimeline.prototype.detectCssVarTopSupport = function(pad, usableC) {
    try {
      if (!this.trackContent) return false;
      const test = document.createElement('button');
      test.className = 'timeline-dot';
      test.style.visibility = 'hidden';
      test.style.pointerEvents = 'none';
      const expected = pad + 0.5 * usableC;
      test.style.setProperty('--n', '0.5');
      this.trackContent.appendChild(test);
      const cs = getComputedStyle(test);
      const px = parseFloat(cs.top || '');
      test.remove();
      if (!Number.isFinite(px)) return false;
      return Math.abs(px - expected) <= 2;
    } catch { return false; }
  };

  DeepseekTimeline.prototype.updateTimelineGeometry = function() {
    if (!this.timelineBar || !this.trackContent) return;
    const H = this.timelineBar.clientHeight || 0;
    const pad = this.getCSSVarNumber(this.timelineBar, '--timeline-track-padding', 16);
    const minGap = this.getCSSVarNumber(this.timelineBar, '--timeline-min-gap', 24);
    const N = this.markers.length;
    const desiredHeight = Math.max(H, (N > 0) ? (2 * pad + Math.max(0, N - 1) * minGap) : H);
    this.contentHeight = Math.ceil(desiredHeight);
    try { this.trackContent.style.height = `${this.contentHeight}px`; } catch {}

    const usableC = Math.max(1, this.contentHeight - 2 * pad);
    const desiredY = this.markers.map(m => pad + clamp01(m.baseN ?? m.n ?? 0) * usableC);
    const adjusted = this.applyMinGap(desiredY, pad, pad + usableC, minGap);
    this.yPositions = adjusted;
    for (let i = 0; i < N; i++) {
      const n = clamp01((adjusted[i] - pad) / usableC);
      this.markers[i].n = n;
      if (this.markers[i].dotElement && !this.usePixelTop) {
        try { this.markers[i].dotElement.style.setProperty('--n', String(n)); } catch {}
      }
    }
    if (this._cssVarTopSupported === null) {
      this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableC);
      this.usePixelTop = !this._cssVarTopSupported;
    }
    // Reveal slider if scrollable
    const barH = this.timelineBar?.clientHeight || 0;
    if (this.contentHeight > barH + 1) {
      this.sliderAlwaysVisible = true;
      this.showSlider();
    } else {
      this.sliderAlwaysVisible = false;
    }
  };

  DeepseekTimeline.prototype.lowerBound = function(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  DeepseekTimeline.prototype.upperBound = function(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo - 1;
  };

  DeepseekTimeline.prototype.updateVirtualRangeAndRender = function() {
    const localVer = this.markersVersion;
    if (!this.track || !this.trackContent || this.markers.length === 0) return;
    const st = this.track.scrollTop || 0;
    const vh = this.track.clientHeight || 0;
    const buffer = Math.max(100, vh);
    const minY = st - buffer;
    const maxY = st + vh + buffer;
    const start = this.lowerBound(this.yPositions, minY);
    const end = Math.max(start - 1, this.upperBound(this.yPositions, maxY));

    // cleanup out-of-range
    let prevStart = this.visibleRange.start;
    let prevEnd = this.visibleRange.end;
    const len = this.markers.length;
    if (len > 0) {
      prevStart = Math.max(0, Math.min(prevStart, len - 1));
      prevEnd = Math.max(-1, Math.min(prevEnd, len - 1));
    }
    if (prevEnd >= prevStart) {
      for (let i = prevStart; i < Math.min(start, prevEnd + 1); i++) {
        const m = this.markers[i];
        if (m && m.dotElement) { try { m.dotElement.remove(); } catch {} m.dotElement = null; }
      }
      for (let i = Math.max(end + 1, prevStart); i <= prevEnd; i++) {
        const m = this.markers[i];
        if (m && m.dotElement) { try { m.dotElement.remove(); } catch {} m.dotElement = null; }
      }
    } else {
      try { this.trackContent.querySelectorAll('.timeline-dot').forEach(n => n.remove()); } catch {}
      this.markers.forEach(m => { m.dotElement = null; });
    }

    // create in-range
    const frag = document.createDocumentFragment();
    for (let i = start; i <= end; i++) {
      const marker = this.markers[i];
      if (!marker) continue;
      if (!marker.dotElement) {
        const dot = document.createElement('button');
        dot.className = 'timeline-dot';
        dot.dataset.targetIdx = marker.id;
        if (marker.summary) dot.setAttribute('aria-label', marker.summary);
        try { dot.setAttribute('tabindex', '0'); } catch {}
        try { dot.setAttribute('aria-describedby', 'chatgpt-timeline-tooltip'); } catch {}
        if (this.usePixelTop) {
          dot.style.top = `${Math.round(this.yPositions[i])}px`;
        } else {
          try { dot.style.setProperty('--n', String(marker.n || 0)); } catch {}
        }
        // reflect active + star state
        try { dot.classList.toggle('active', i === this.activeIdx); } catch {}
        try {
          dot.classList.toggle('starred', !!marker.starred);
          dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
        } catch {}
        dot.addEventListener('click', (e) => {
          const now = Date.now();
          if (now < (this.suppressClickUntil || 0)) { try { e.preventDefault(); e.stopPropagation(); } catch {} return; }
          try { this.scrollToMessage(marker.el); } catch {}
        });
        marker.dotElement = dot;
        frag.appendChild(dot);
      } else {
        if (this.usePixelTop) {
          marker.dotElement.style.top = `${Math.round(this.yPositions[i])}px`;
        } else {
          try { marker.dotElement.style.setProperty('--n', String(marker.n || 0)); } catch {}
        }
        try { marker.dotElement.setAttribute('aria-describedby', 'chatgpt-timeline-tooltip'); } catch {}
        try { marker.dotElement.classList.toggle('active', i === this.activeIdx); } catch {}
        try {
          marker.dotElement.classList.toggle('starred', !!marker.starred);
          marker.dotElement.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
        } catch {}
      }
    }
    // Abort stale pass if markers changed during work
    if (localVer !== this.markersVersion) return;
    if (frag.childNodes.length) this.trackContent.appendChild(frag);
    this.visibleRange = { start, end };
  };

  DeepseekTimeline.prototype.syncTimelineTrackToMain = function() {
    if (!this.track || !this.scrollContainer || !this.contentHeight) return;
    const scrollTop = this.scrollContainer.scrollTop;
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
    const span = Math.max(1, this.spanPx || 1);
    const r = clamp01((ref - (this.firstOffset || 0)) / span);
    const maxScroll = Math.max(0, this.contentHeight - (this.track.clientHeight || 0));
    const target = Math.round(r * maxScroll);
    if (Math.abs((this.track.scrollTop || 0) - target) > 1) {
      this.track.scrollTop = target;
    }
  };

  DeepseekTimeline.prototype.scheduleScrollSync = function() {
    if (this.scrollRafId !== null) return;
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = null;
      this.syncTimelineTrackToMain();
      this.updateVirtualRangeAndRender();
      this.computeActiveByScroll();
      this.updateActiveDotUI();
      this.updateSlider();
    });
  };

  // --- Stage 8: active + tooltip + star ---
  DeepseekTimeline.prototype.computeActiveByScroll = function() {
    if (!this.scrollContainer || this.markers.length === 0) return;
    const containerRect = this.scrollContainer.getBoundingClientRect();
    const scrollTop = this.scrollContainer.scrollTop;
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
    let active = 0;
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const top = m.el.getBoundingClientRect().top - containerRect.top + scrollTop;
      if (top <= ref) active = i; else break;
    }
    if (this.activeIdx !== active) {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const elapsed = now - this.lastActiveChangeTime;
      if (elapsed < this.minActiveChangeInterval) {
        this.pendingActiveIdx = active;
        if (!this.activeChangeTimer) {
          const delay = Math.max(this.minActiveChangeInterval - elapsed, 0);
          this.activeChangeTimer = setTimeout(() => {
            this.activeChangeTimer = null;
            if (typeof this.pendingActiveIdx === 'number' && this.pendingActiveIdx !== this.activeIdx) {
              this.activeIdx = this.pendingActiveIdx;
              this.updateActiveDotUI();
              this.lastActiveChangeTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }
            this.pendingActiveIdx = null;
          }, delay);
        }
      } else {
        this.activeIdx = active;
        this.updateActiveDotUI();
        this.lastActiveChangeTime = now;
      }
    }
  };

  DeepseekTimeline.prototype.updateActiveDotUI = function() {
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      if (m?.dotElement) {
        try { m.dotElement.classList.toggle('active', i === this.activeIdx); } catch {}
      }
    }
  };

  DeepseekTimeline.prototype.attachInteractions = function() {
    if (!this.timelineBar) return;
    // Tooltip events
    this.onTimelineBarOver = (e) => {
      const dot = e.target.closest?.('.timeline-dot');
      if (dot) this.showTooltipForDot(dot);
    };
    this.onTimelineBarOut = (e) => {
      const fromDot = e.target.closest?.('.timeline-dot');
      const toDot = e.relatedTarget?.closest?.('.timeline-dot');
      if (fromDot && !toDot) this.hideTooltip();
    };
    this.onTimelineBarFocusIn = (e) => {
      const dot = e.target.closest?.('.timeline-dot');
      if (dot) this.showTooltipForDot(dot);
    };
    this.onTimelineBarFocusOut = (e) => {
      const dot = e.target.closest?.('.timeline-dot');
      if (dot) this.hideTooltip();
    };
    try {
      this.timelineBar.addEventListener('mouseover', this.onTimelineBarOver);
      this.timelineBar.addEventListener('mouseout', this.onTimelineBarOut);
      this.timelineBar.addEventListener('focusin', this.onTimelineBarFocusIn);
      this.timelineBar.addEventListener('focusout', this.onTimelineBarFocusOut);
      // Prevent native drag from causing horizontal wobble
      this.timelineBar.addEventListener('dragstart', (e) => { try { e.preventDefault(); } catch {} });
    } catch {}

    // Long-press star
    this.onPointerDown = (ev) => {
      const dot = ev.target.closest?.('.timeline-dot');
      if (!dot) return;
      if (typeof ev.button === 'number' && ev.button !== 0) return;
      this.cancelLongPress();
      this.pressTargetDot = dot;
      this.pressStartPos = { x: ev.clientX, y: ev.clientY };
      try { dot.classList.add('holding'); } catch {}
      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = null;
        if (!this.pressTargetDot) return;
        const id = this.pressTargetDot.dataset.targetIdx;
        this.toggleStar(id);
        this.suppressClickUntil = Date.now() + 350;
        try { this.refreshTooltipForDot(this.pressTargetDot); } catch {}
        try { this.pressTargetDot.classList.remove('holding'); } catch {}
      }, this.longPressDuration);
    };
    this.onPointerMove = (ev) => {
      if (!this.pressTargetDot || !this.pressStartPos) return;
      const dx = ev.clientX - this.pressStartPos.x;
      const dy = ev.clientY - this.pressStartPos.y;
      if ((dx * dx + dy * dy) > (this.longPressMoveTolerance * this.longPressMoveTolerance)) {
        this.cancelLongPress();
      }
    };
    this.onPointerUp = () => { this.cancelLongPress(); };
    this.onPointerCancel = () => { this.cancelLongPress(); };
    this.onPointerLeave = (ev) => {
      const dot = ev.target.closest?.('.timeline-dot');
      if (dot && dot === this.pressTargetDot) this.cancelLongPress();
    };
    try {
      this.timelineBar.addEventListener('pointerdown', this.onPointerDown);
      window.addEventListener('pointermove', this.onPointerMove, { passive: true });
      window.addEventListener('pointerup', this.onPointerUp, { passive: true });
      window.addEventListener('pointercancel', this.onPointerCancel, { passive: true });
      this.timelineBar.addEventListener('pointerleave', this.onPointerLeave);
    } catch {}

    // Slider hover show/hide
    this.onBarEnter = () => this.showSlider();
    this.onBarLeave = () => this.hideSliderDeferred();
    this.onSliderEnter = () => this.showSlider();
    this.onSliderLeave = () => this.hideSliderDeferred();
    try {
      this.timelineBar.addEventListener('pointerenter', this.onBarEnter);
      this.timelineBar.addEventListener('pointerleave', this.onBarLeave);
      if (this.ui.slider) {
        this.ui.slider.addEventListener('pointerenter', this.onSliderEnter);
        this.ui.slider.addEventListener('pointerleave', this.onSliderLeave);
      }
    } catch {}

    // Slider drag
    this.onSliderDown = (e) => {
      if (!this.ui.sliderHandle || typeof e.button === 'number' && e.button !== 0) return;
      this.sliderDragging = true;
      this.sliderStartClientY = e.clientY;
      const rect = this.ui.sliderHandle.getBoundingClientRect();
      this.sliderStartTop = rect.top;
      try { window.addEventListener('pointermove', this.onSliderMove = (ev) => this.handleSliderDrag(ev)); } catch {}
      this.onSliderUp = () => this.endSliderDrag();
      try { window.addEventListener('pointerup', this.onSliderUp, { passive: true }); } catch {}
      this.showSlider();
    };
    try { this.ui.sliderHandle?.addEventListener('pointerdown', this.onSliderDown); } catch {}

    // Window resize: reposition tooltip if visible + keep geometry fresh
  this.onWindowResize = () => {
      if (this.ui.tooltip?.classList.contains('visible')) {
        const activeDot = this.timelineBar.querySelector('.timeline-dot:hover, .timeline-dot:focus');
        if (activeDot) {
          const tip = this.ui.tooltip;
          tip.classList.remove('visible');
          let fullText = (activeDot.getAttribute('aria-label') || '').trim();
          try {
            const id = activeDot.dataset.targetIdx;
            if (id && this.starred.has(id)) fullText = `★ ${fullText}`;
          } catch {}
          const p = this.computePlacementInfo(activeDot);
          const layout = this.truncateToThreeLines(fullText, p.width, true);
          tip.textContent = layout.text;
          this.placeTooltipAt(activeDot, p.placement, p.width, layout.height);
          if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
          this.showRafId = requestAnimationFrame(() => { this.showRafId = null; tip.classList.add('visible'); });
        }
      }
      this.updateTimelineGeometry();
      this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateSlider();
    try { this.truncateCache?.clear(); } catch {}
    // NOTE: Align with ChatGPT behavior; avoid reapplying min-gap on window resize
    // this.scheduleMinGapCorrection();
  };
    try { window.addEventListener('resize', this.onWindowResize); } catch {}
  };

  DeepseekTimeline.prototype.cancelLongPress = function() {
    if (this.longPressTimer) { try { clearTimeout(this.longPressTimer); } catch {} this.longPressTimer = null; }
    if (this.pressTargetDot) { try { this.pressTargetDot.classList.remove('holding'); } catch {} }
    this.pressTargetDot = null;
    this.pressStartPos = null;
  };

  DeepseekTimeline.prototype.loadStars = function() {
    this.starred.clear();
    const cid = this.conversationId;
    if (!cid) return;
    try {
      const raw = localStorage.getItem(`deepseekTimelineStars:${cid}`);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach(id => this.starred.add(String(id)));
    } catch {}
  };
  DeepseekTimeline.prototype.saveStars = function() {
    const cid = this.conversationId;
    if (!cid) return;
    try { localStorage.setItem(`deepseekTimelineStars:${cid}`, JSON.stringify(Array.from(this.starred))); } catch {}
  };
  DeepseekTimeline.prototype.toggleStar = function(turnId) {
    const id = String(turnId || '');
    if (!id) return;
    if (this.starred.has(id)) this.starred.delete(id); else this.starred.add(id);
    this.saveStars();
    const m = this.markers.find(mm => mm.id === id);
    if (m && m.dotElement) {
      m.starred = this.starred.has(id);
      try {
        m.dotElement.classList.toggle('starred', m.starred);
        m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false');
      } catch {}
      try { this.refreshTooltipForDot(m.dotElement); } catch {}
    }
  };

  // Tooltip helpers
  DeepseekTimeline.prototype.computePlacementInfo = function(dot) {
    const tip = this.ui.tooltip || document.body;
    const dotRect = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
    const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
    const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
    const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
    const viewportPad = 8;
    const maxW = this.getCSSVarNumber(tip, '--timeline-tooltip-max', 288);
    const minW = 160;
    const leftAvail = Math.max(0, dotRect.left - gap - viewportPad);
    const rightAvail = Math.max(0, vw - dotRect.right - gap - viewportPad);
    let placement = (rightAvail > leftAvail) ? 'right' : 'left';
    let avail = placement === 'right' ? rightAvail : leftAvail;
    const tiers = [280, 240, 200, 160];
    const hardMax = Math.max(minW, Math.min(maxW, Math.floor(avail)));
    let width = tiers.find(t => t <= hardMax) || Math.max(minW, Math.min(hardMax, 160));
    if (width < minW) {
      // try switch side
      if (placement === 'left' && rightAvail > leftAvail) {
        placement = 'right'; avail = rightAvail;
      } else if (placement === 'right' && leftAvail >= rightAvail) {
        placement = 'left'; avail = leftAvail;
      }
      const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
      width = tiers.find(t => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
    }
    width = Math.max(120, Math.min(width, maxW));
    return { placement, width };
  };

  DeepseekTimeline.prototype.truncateToThreeLines = function(text, targetWidth, wantLayout = false) {
    try {
      if (!this.measureEl || !this.ui.tooltip) return wantLayout ? { text, height: 0 } : text;
      const tip = this.ui.tooltip;
      const lineH = this.getCSSVarNumber(tip, '--timeline-tooltip-lh', 18);
      const padY = this.getCSSVarNumber(tip, '--timeline-tooltip-pad-y', 10);
      const borderW = this.getCSSVarNumber(tip, '--timeline-tooltip-border-w', 1);
      const maxH = Math.round(3 * lineH + 2 * padY + 2 * borderW);
      const ell = '…';
      const el = this.measureEl;
      const widthInt = Math.max(0, Math.floor(targetWidth));
      const rawAll = String(text || '').replace(/\s+/g, ' ').trim();
      const cacheKey = `${widthInt}|${rawAll}`;
      if (this.truncateCache && this.truncateCache.has(cacheKey)) {
        const cached = this.truncateCache.get(cacheKey);
        return wantLayout ? { text: cached, height: maxH } : cached;
      }
      el.style.width = `${widthInt}px`;
      el.textContent = rawAll;
      let h = el.offsetHeight;
      if (h <= maxH) return wantLayout ? { text: el.textContent, height: h } : el.textContent;
      const raw = el.textContent;
      let lo = 0, hi = raw.length, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        el.textContent = raw.slice(0, mid).trimEnd() + ell;
        h = el.offsetHeight;
        if (h <= maxH) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      const out = (ans >= raw.length) ? raw : (raw.slice(0, ans).trimEnd() + ell);
      el.textContent = out;
      h = el.offsetHeight;
      if (this.truncateCache) { try { this.truncateCache.set(cacheKey, out); } catch {} }
      return wantLayout ? { text: out, height: Math.min(h, maxH) } : out;
    } catch {
      return wantLayout ? { text, height: 0 } : text;
    }
  };

  DeepseekTimeline.prototype.placeTooltipAt = function(dot, placement, width, height) {
    if (!this.ui.tooltip) return;
    const tip = this.ui.tooltip;
    const dotRect = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
    const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
    const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
    const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
    const viewportPad = 8;
    let left;
    if (placement === 'left') {
      left = Math.round(dotRect.left - gap - width);
      if (left < viewportPad) {
        const altLeft = Math.round(dotRect.right + gap);
        if (altLeft + width <= vw - viewportPad) { placement = 'right'; left = altLeft; }
        else { const fitWidth = Math.max(120, vw - viewportPad - altLeft); left = altLeft; width = fitWidth; }
      }
    } else {
      left = Math.round(dotRect.right + gap);
      if (left + width > vw - viewportPad) {
        const altLeft = Math.round(dotRect.left - gap - width);
        if (altLeft >= viewportPad) { placement = 'left'; left = altLeft; }
        else { const fitWidth = Math.max(120, vw - viewportPad - left); width = fitWidth; }
      }
    }
    let top = Math.round(dotRect.top + dotRect.height / 2 - height / 2);
    top = Math.max(viewportPad, Math.min(vh - height - viewportPad, top));
    tip.style.width = `${Math.floor(width)}px`;
    tip.style.height = `${Math.floor(height)}px`;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.setAttribute('data-placement', placement);
  };

  DeepseekTimeline.prototype.showTooltipForDot = function(dot) {
    if (!this.ui.tooltip) return;
    try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; } } catch {}
    const tip = this.ui.tooltip;
    tip.classList.remove('visible');
    let fullText = (dot.getAttribute('aria-label') || '').trim();
    try { const id = dot.dataset.targetIdx; if (id && this.starred.has(id)) fullText = `★ ${fullText}`; } catch {}
    const p = this.computePlacementInfo(dot);
    const layout = this.truncateToThreeLines(fullText, p.width, true);
    tip.textContent = layout.text;
    this.placeTooltipAt(dot, p.placement, p.width, layout.height);
    tip.setAttribute('aria-hidden', 'false');
    if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
    this.showRafId = requestAnimationFrame(() => { this.showRafId = null; tip.classList.add('visible'); });
  };

  DeepseekTimeline.prototype.hideTooltip = function(immediate = false) {
    if (!this.ui.tooltip) return;
    const doHide = () => {
      this.ui.tooltip.classList.remove('visible');
      this.ui.tooltip.setAttribute('aria-hidden', 'true');
      this.tooltipHideTimer = null;
    };
    if (immediate) return doHide();
    try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); } } catch {}
    this.tooltipHideTimer = setTimeout(doHide, this.tooltipHideDelay);
  };

  DeepseekTimeline.prototype.refreshTooltipForDot = function(dot) {
    if (!this.ui?.tooltip || !dot) return;
    const tip = this.ui.tooltip;
    if (!tip.classList.contains('visible')) return;
    let fullText = (dot.getAttribute('aria-label') || '').trim();
    try { const id = dot.dataset.targetIdx; if (id && this.starred.has(id)) fullText = `★ ${fullText}`; } catch {}
    const p = this.computePlacementInfo(dot);
    const layout = this.truncateToThreeLines(fullText, p.width, true);
    tip.textContent = layout.text;
    this.placeTooltipAt(dot, p.placement, p.width, layout.height);
  };

  // Stable id (hash) for user messages based on normalized user text
  DeepseekTimeline.prototype.buildStableHashFromUser = function(el) {
    try {
      const raw = normalizeText(el?.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
      const s = raw.slice(0, 256);
      let h = 0x811c9dc5 >>> 0; // FNV-1a 32-bit
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(36);
    } catch { return Math.random().toString(36).slice(2, 8); }
  };

  // --- P1: container rebind helpers ---
  DeepseekTimeline.prototype.findConversationRootFromFirst = function(firstMsg) {
    if (!firstMsg) return null;
    try {
      const allMsgs = Array.from(document.querySelectorAll(SEL_MSG));
      let node = firstMsg.parentElement;
      while (node && node !== document.body) {
        let allInside = true;
        for (let i = 0; i < allMsgs.length; i++) {
          if (!node.contains(allMsgs[i])) { allInside = false; break; }
        }
        if (allInside) return node;
        node = node.parentElement;
      }
    } catch {}
    return firstMsg.parentElement || null;
  };

  DeepseekTimeline.prototype.ensureContainersUpToDate = function() {
    const first = document.querySelector(SEL_MSG);
    if (!first) return;
    const newRoot = this.findConversationRootFromFirst(first);
    if (newRoot && newRoot !== this.conversationContainer) {
      this.rebindConversationContainer(newRoot);
    }
  };

  DeepseekTimeline.prototype.rebindConversationContainer = function(newConv) {
    // Detach old listeners/observers tied to containers
    if (this.scrollContainer && this.onScroll) {
      try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch {}
      try { window.removeEventListener('scroll', this.onScroll); } catch {}
    }
    try { this.mutationObserver?.disconnect(); } catch {}
    try { this.resizeObserver?.disconnect(); } catch {}
    try { this.themeObserver?.disconnect(); } catch {}
    if (this.onVisualViewportResize && window.visualViewport) {
      try { window.visualViewport.removeEventListener('resize', this.onVisualViewportResize); } catch {}
      this.onVisualViewportResize = null;
    }

    this.conversationContainer = newConv;
    this.scrollContainer = getScrollableAncestor(this.conversationContainer);

    // Re-attach
    this.attachObservers();
    this.attachScrollSync();
    this.rebuildMarkers();
  };

  // --- P1: min-gap correction on idle ---
  DeepseekTimeline.prototype.scheduleMinGapCorrection = function() {
    try { if (this.resizeIdleTimer) { clearTimeout(this.resizeIdleTimer); } } catch {}
    try {
      if (this.resizeIdleRICId && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(this.resizeIdleRICId);
        this.resizeIdleRICId = null;
      }
    } catch {}
    this.resizeIdleTimer = setTimeout(() => {
      this.resizeIdleTimer = null;
      try {
        if (typeof requestIdleCallback === 'function') {
          this.resizeIdleRICId = requestIdleCallback(() => {
            this.resizeIdleRICId = null;
            this.reapplyMinGapAfterResize();
          }, { timeout: 200 });
          return;
        }
      } catch {}
      this.reapplyMinGapAfterResize();
    }, this.resizeIdleDelay);
  };

  DeepseekTimeline.prototype.reapplyMinGapAfterResize = function() {
    if (!this.timelineBar || this.markers.length === 0) return;
    const barHeight = this.timelineBar.clientHeight || 0;
    const trackPadding = this.getCSSVarNumber(this.timelineBar, '--timeline-track-padding', 16);
    const usable = Math.max(1, barHeight - 2 * trackPadding);
    const minTop = trackPadding;
    const maxTop = trackPadding + usable;
    const minGap = this.getCSSVarNumber(this.timelineBar, '--timeline-min-gap', 24);
    const desired = this.markers.map(m => minTop + (m.n ?? 0) * usable);
    const adjusted = this.applyMinGap(desired, minTop, maxTop, minGap);
    for (let i = 0; i < this.markers.length; i++) {
      const top = adjusted[i];
      const n = (top - minTop) / Math.max(1, (maxTop - minTop));
      this.markers[i].n = clamp01(n);
      try { this.markers[i].dotElement?.style.setProperty('--n', String(this.markers[i].n)); } catch {}
    }
  };

  // Slider helpers (P0)
  DeepseekTimeline.prototype.updateSlider = function() {
    if (!this.ui.slider || !this.ui.sliderHandle) return;
    if (!this.contentHeight || !this.timelineBar || !this.track) return;
    const barRect = this.timelineBar.getBoundingClientRect();
    const barH = barRect.height || 0;
    const pad = this.getCSSVarNumber(this.timelineBar, '--timeline-track-padding', 16);
    const innerH = Math.max(0, barH - 2 * pad);
    if (this.contentHeight <= barH + 1 || innerH <= 0) {
      this.sliderAlwaysVisible = false;
      try { this.ui.slider.classList.remove('visible'); this.ui.slider.style.opacity = ''; } catch {}
      return;
    }
    this.sliderAlwaysVisible = true;
    const railLen = Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
    const railTop = Math.round(barRect.top + pad + (innerH - railLen) / 2);
    const railLeftGap = 8; // gap from bar's left edge
    const sliderWidth = 12;
    const left = Math.round(barRect.left - railLeftGap - sliderWidth);
    this.ui.slider.style.left = `${left}px`;
    this.ui.slider.style.top = `${railTop}px`;
    this.ui.slider.style.height = `${railLen}px`;

    const handleH = 22;
    const maxTop = Math.max(0, railLen - handleH);
    const range = Math.max(1, this.contentHeight - barH);
    const st = this.track.scrollTop || 0;
    const r = Math.max(0, Math.min(1, st / range));
    const top = Math.round(r * maxTop);
    this.ui.sliderHandle.style.height = `${handleH}px`;
    this.ui.sliderHandle.style.top = `${top}px`;
    try { this.ui.slider.classList.add('visible'); this.ui.slider.style.opacity = ''; } catch {}
  };

  DeepseekTimeline.prototype.showSlider = function() {
    if (!this.ui.slider) return;
    this.ui.slider.classList.add('visible');
    if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} this.sliderFadeTimer = null; }
    this.updateSlider();
  };

  DeepseekTimeline.prototype.hideSliderDeferred = function() {
    if (this.sliderDragging || this.sliderAlwaysVisible) return;
    if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} }
    this.sliderFadeTimer = setTimeout(() => {
      this.sliderFadeTimer = null;
      try { this.ui.slider?.classList.remove('visible'); } catch {}
    }, this.sliderFadeDelay);
  };

  DeepseekTimeline.prototype.handleSliderDrag = function(e) {
    if (!this.sliderDragging || !this.timelineBar || !this.track) return;
    const barRect = this.timelineBar.getBoundingClientRect();
    const barH = barRect.height || 0;
    const railLen = parseFloat(this.ui.slider.style.height || '0') || Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
    const handleH = this.ui.sliderHandle.getBoundingClientRect().height || 22;
    const maxTop = Math.max(0, railLen - handleH);
    const delta = e.clientY - this.sliderStartClientY;
    let top = Math.max(0, Math.min(maxTop, (this.sliderStartTop + delta) - (parseFloat(this.ui.slider.style.top) || 0)));
    const r = (maxTop > 0) ? (top / maxTop) : 0;
    const range = Math.max(1, this.contentHeight - barH);
    this.track.scrollTop = Math.round(r * range);
    this.updateVirtualRangeAndRender();
    this.showSlider();
    this.updateSlider();
  };

  DeepseekTimeline.prototype.endSliderDrag = function() {
    this.sliderDragging = false;
    try { window.removeEventListener('pointermove', this.onSliderMove); } catch {}
    this.onSliderMove = null;
    this.onSliderUp = null;
    this.hideSliderDeferred();
  };

  // --- Entry & SPA wiring (Stage 3) ---
  let timelineActive = true;       // global on/off
  let providerEnabled = true;      // per-provider on/off (deepseek)
  let manager = null;
  let currentUrl = location.href;
  let routeCheckIntervalId = null;
  let routeListenersAttached = false;
  let initialObserver = null;
  let pageObserver = null;
  let initTimerId = null;           // delayed init timer for SPA route

  function initializeTimeline() {
    if (manager) { try { manager.destroy(); } catch {} manager = null; }
    // Remove any leftover UI before creating a new instance (align with ChatGPT)
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
    manager = new DeepseekTimeline();
    manager.init().catch(err => console.debug('[DeepseekTimeline] init failed:', err));
  }

  function cleanupGlobalObservers() {
    // Align with ChatGPT: keep route listeners and HREF polling alive.
    // Only detach heavy page-level MutationObserver; allow future SPA navigations to be detected.
    try { pageObserver?.disconnect(); } catch {}
    pageObserver = null;
    // Do not clear routeCheckIntervalId (keeps href polling active)
    // Do not touch initialObserver (bootstrap-only)
    try { if (initTimerId) { clearTimeout(initTimerId); initTimerId = null; } } catch {}
  }

  function handleUrlChange() {
    if (location.href === currentUrl) return;
    // Cancel any pending init from previous route
    try { if (initTimerId) { clearTimeout(initTimerId); initTimerId = null; } } catch {}
    currentUrl = location.href;
    if (manager) { try { manager.destroy(); } catch {} manager = null; }
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}

    const enabled = (timelineActive && providerEnabled);
    if (isConversationRouteDeepseek() && enabled) {
      // If messages already present, init immediately; otherwise, wait for them
      if (document.querySelector(SEL_MSG)) {
        initializeTimeline();
      } else {
        // debounce any previous attempt
        try { if (initTimerId) { clearTimeout(initTimerId); initTimerId = null; } } catch {}
        initTimerId = setTimeout(() => {
          initTimerId = null;
          // wait briefly for first message to appear
          try {
            waitForElement(SEL_MSG, 5000).then((el) => {
              if (el && isConversationRouteDeepseek() && (timelineActive && providerEnabled)) {
                initializeTimeline();
              }
            });
          } catch {}
        }, 300);
      }
    } else {
      cleanupGlobalObservers();
    }
  }

  // Align with ChatGPT: attach route listeners once (popstate/hashchange + href polling)
  function attachRouteListenersOnce() {
    if (routeListenersAttached) return;
    routeListenersAttached = true;
    try { window.addEventListener('popstate', handleUrlChange); } catch {}
    try { window.addEventListener('hashchange', handleUrlChange); } catch {}
    try {
      routeCheckIntervalId = setInterval(() => {
        if (location.href !== currentUrl) handleUrlChange();
      }, 800);
    } catch {}
  }

  function detachRouteListeners() {
    if (!routeListenersAttached) return;
    routeListenersAttached = false;
    try { window.removeEventListener('popstate', handleUrlChange); } catch {}
    try { window.removeEventListener('hashchange', handleUrlChange); } catch {}
    try { if (routeCheckIntervalId) { clearInterval(routeCheckIntervalId); routeCheckIntervalId = null; } } catch {}
  }

  // Boot: wait for first message to appear then init (if route matches)
  try {
    initialObserver = new MutationObserver(() => {
      if (document.querySelector(SEL_MSG)) {
        if (isConversationRouteDeepseek() && (timelineActive && providerEnabled)) initializeTimeline();
        try { initialObserver.disconnect(); } catch {}
        pageObserver = new MutationObserver(handleUrlChange);
        try { pageObserver.observe(document.body, { childList: true, subtree: true }); } catch {}
        // Ensure route listeners are attached once
        attachRouteListenersOnce();
      }
    });
    initialObserver.observe(document.body, { childList: true, subtree: true });
  } catch {}

  // Proactively attach route listeners; guarded to run only once
  attachRouteListenersOnce();

  // Read initial toggles (new keys only) and react to changes
  try {
    if (chrome?.storage?.local) {
      chrome.storage.local.get({ timelineActive: true, timelineProviders: {} }, (res) => {
        try { timelineActive = !!res.timelineActive; } catch { timelineActive = true; }
        try {
          const map = res.timelineProviders || {};
          providerEnabled = (typeof map.deepseek === 'boolean') ? map.deepseek : true;
        } catch { providerEnabled = true; }

        const enabled = timelineActive && providerEnabled;
        if (!enabled) {
          if (manager) { try { manager.destroy(); } catch {} manager = null; }
          try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
        } else {
          if (isConversationRouteDeepseek() && document.querySelector(SEL_MSG)) {
            initializeTimeline();
          }
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes) return;
        let changed = false;
        if ('timelineActive' in changes) {
          timelineActive = !!changes.timelineActive.newValue;
          changed = true;
        }
        if ('timelineProviders' in changes) {
          try {
            const map = changes.timelineProviders.newValue || {};
            providerEnabled = (typeof map.deepseek === 'boolean') ? map.deepseek : true;
            changed = true;
          } catch {}
        }
        if (!changed) return;
        const enabled = timelineActive && providerEnabled;
        if (!enabled) {
          if (manager) { try { manager.destroy(); } catch {} manager = null; }
          try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
        } else {
          if (isConversationRouteDeepseek() && document.querySelector(SEL_MSG)) {
            initializeTimeline();
          }
        }
      });
    }
  } catch {}

  // Log presence
  try { console.debug('[DeepseekTimeline] content-deepseek.js loaded (P0)'); } catch {}
})();
