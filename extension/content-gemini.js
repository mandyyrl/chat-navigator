(function () {
  // --- Stable selectors for Gemini ---
  // User message anchors (broadened to handle variants without data-turn-id)
  // Prefer bubble class, fall back to right-aligned container or custom element root
  const SEL_USER_BUBBLE = [
    '.user-query-bubble-with-background',
    '.user-query-container.right-align-content',
    'user-query'
  ].join(',');
  // Known scroll areas on Gemini
  const SEL_SCROLL_PRIMARY = '#chat-history.chat-history-scroll-container';
  const SEL_SCROLL_ALT = '[data-test-id="chat-history-container"].chat-history';

  // --- Phase 1: route and toggles ---
  function isConversationRouteGemini(pathname = location.pathname) {
    try {
      const segs = String(pathname || '').split('/').filter(Boolean);
      // Support /app/<id>
      const iApp = segs.indexOf('app');
      if (iApp !== -1) {
        const slug = segs[iApp + 1];
        return typeof slug === 'string' && slug.length > 0 && /^[A-Za-z0-9_-]+$/.test(slug);
      }
      // Support /gem/.../<conversationId>
      const iGem = segs.indexOf('gem');
      if (iGem !== -1 && segs.length > iGem + 1) {
        const last = segs[segs.length - 1];
        return typeof last === 'string' && last.length > 0 && /^[A-Za-z0-9_-]+$/.test(last);
      }
      return false;
    } catch { return false; }
  }

  function extractConversationIdFromPath(pathname = location.pathname) {
    try {
      const segs = String(pathname || '').split('/').filter(Boolean);
      // /app/<id>
      const iApp = segs.indexOf('app');
      if (iApp !== -1) {
        const slug = segs[iApp + 1];
        return (slug && /^[A-Za-z0-9_-]+$/.test(slug)) ? slug : null;
      }
      // /gem/.../<conversationId>  → take the last segment after 'gem'
      const iGem = segs.indexOf('gem');
      if (iGem !== -1 && segs.length > iGem + 1) {
        const tail = segs.slice(iGem + 1);
        let last = tail[tail.length - 1];
        if (last && /^[A-Za-z0-9_-]+$/.test(last)) return last;
        // Fallback: scan from end for an id-like slug
        for (let j = tail.length - 1; j >= 0; j--) {
          if (/^[A-Za-z0-9_-]+$/.test(tail[j])) return tail[j];
        }
        return tail[tail.length - 1] || null;
      }
      return null;
    } catch { return null; }
  }

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

  // --- Phase 2: scrollable detection & binding helpers ---
  function isElementScrollable(el) {
    if (!el) return false;
    try {
      const cs = getComputedStyle(el);
      const oy = (cs.overflowY || '').toLowerCase();
      const ok = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
      if (!ok && el !== document.scrollingElement && el !== document.documentElement && el !== document.body) return false;
      if ((el.scrollHeight - el.clientHeight) > 4) return true;
      const prev = el.scrollTop;
      el.scrollTop = prev + 1;
      const changed = el.scrollTop !== prev;
      el.scrollTop = prev;
      return changed;
    } catch { return false; }
  }

  function getScrollableAncestor(startEl) {
    // Prefer site-provided containers if they actually scroll and relate to conversation
    try {
      const primary = document.querySelector(SEL_SCROLL_PRIMARY);
      if (primary && (primary.contains(startEl) || startEl.contains(primary)) && isElementScrollable(primary)) return primary;
    } catch {}
    try {
      const alt = document.querySelector(SEL_SCROLL_ALT);
      if (alt && (alt.contains(startEl) || startEl.contains(alt)) && isElementScrollable(alt)) return alt;
    } catch {}
    // Then climb ancestors
    let el = startEl;
    while (el && el !== document.body) {
      if (isElementScrollable(el)) return el;
      el = el.parentElement;
    }
    const docScroll = document.scrollingElement || document.documentElement || document.body;
    return isElementScrollable(docScroll) ? docScroll : (document.documentElement || document.body);
  }

  // Find the lowest common ancestor that contains all user bubbles (robust root)
  function findConversationRootFromFirst(firstMsg) {
    if (!firstMsg) return null;
    try {
      const all = Array.from(document.querySelectorAll(SEL_USER_BUBBLE));
      let node = firstMsg.parentElement;
      while (node && node !== document.body) {
        let allInside = true;
        for (let i = 0; i < all.length; i++) {
          if (!node.contains(all[i])) { allInside = false; break; }
        }
        if (allInside) return node;
        node = node.parentElement;
      }
    } catch {}
    return firstMsg.parentElement || null;
  }

  // --- Phase 3: minimal timeline UI manager (scaffold only) ---
  class GeminiTimelineScaffold {
    constructor() {
      this.conversationContainer = null;
      this.scrollContainer = null;
      this.timelineBar = null;
      this.track = null;
      this.trackContent = null;
      this.ui = { slider: null, sliderHandle: null, tooltip: null, summarizerButton: null, incrementalButton: null };
      this.conversationId = null;
      // Phase 4: markers + endpoint mapping state
      this.markers = [];
      this.firstOffset = 0;
      this.spanPx = 1;
      // Phase 5: long canvas + virtualization
      this.contentHeight = 0;
      this.yPositions = [];
      this.visibleRange = { start: 0, end: -1 };
      this.usePixelTop = false;
      this._cssVarTopSupported = null;
      // Phase 6: interactions + linking
      this.onScroll = null;
      this.scrollRafId = null;
      this.activeIdx = -1;
      this.lastActiveChangeTime = 0;
      this.minActiveChangeInterval = 120;
      this.pendingActiveIdx = null;
      this.activeChangeTimer = null;
      // Slider interaction state
      this.sliderDragging = false;
      this.sliderFadeTimer = null;
      this.sliderFadeDelay = 1000;
      this.sliderAlwaysVisible = false;
      this.sliderStartClientY = 0;
      this.sliderStartTop = 0;
      // Delegated handlers (stable refs for add/remove)
      this.onTimelineBarClick = null;
      this.onTimelineWheel = null;
      this.onBarEnter = null;
      this.onBarLeave = null;
      this.onSliderEnter = null;
      this.onSliderLeave = null;
      this.onSliderDown = null;
      this.onSliderMove = null;
      this.onSliderUp = null;
      this.onWindowResize = null;
      // Phase 7: tooltip + truncation
      this.measureEl = null;
      this.tooltipHideDelay = 100;
      this.tooltipHideTimer = null;
      this.currentHoveredDot = null;
      this.isMouseOnLeft = false;
      this.clearStateTimer = null;
      this.showRafId = null;
      this.truncateCache = new Map();
      // Phase 8: stars + long-press
      this.starred = new Set();
      this.onStorage = null;
      this.longPressDuration = 550;
      this.longPressMoveTolerance = 6;
      this.longPressTimer = null;
      this.pressStartPos = null;
      this.pressTargetDot = null;
      this.suppressClickUntil = 0;
      // Phase 9: theme/viewport/resize observers
      this.themeObserver = null;
      this.resizeObserver = null;
      this.onVisualViewportResize = null;
      // Visibility optimization
      this.intersectionObserver = null;
      this.visibleUserTurns = new Set();
      this.markerIndexByEl = new Map();
      // Phase 9+: content mutation + debounced rebuild
      this.mutationObserver = null;
      this.rebuildTimer = null;
      // AI Summarization state
      this.aiModeEnabled = true; // Will be loaded from storage
      this.useSummarization = false;
      this.isSummarizing = false;
      this.summarizerState = 'idle';
      this._pendingSummaries = null;
    }

    async init() {
      // Wait until we see at least one user bubble before wiring
      const first = await waitForElement(SEL_USER_BUBBLE, 5000);
      if (!first) return;

      // Load AI mode setting from storage
      try {
        const result = await chrome.storage.local.get({ aiModeEnabled: true });
        this.aiModeEnabled = typeof result.aiModeEnabled === 'boolean' ? result.aiModeEnabled : true;
      } catch (error) {
        console.warn('[GeminiTimeline] Failed to load AI mode setting:', error);
        this.aiModeEnabled = true; // Default to enabled
      }

      // Bind conversation root & scroll container
      const root = findConversationRootFromFirst(first);
      this.conversationContainer = root || first.parentElement || document.body;
      this.scrollContainer = getScrollableAncestor(this.conversationContainer);
      this.conversationId = extractConversationIdFromPath(location.pathname);
      // Inject UI scaffold (no logic yet)
      this.injectUI();
      // Initialize AI Prompt Manager only if AI mode is enabled
      if (this.aiModeEnabled) {
        try {
          if (window.promptManager) {
            await window.promptManager.initialize();
          } else {
            console.warn('[GeminiTimeline] window.promptManager not found!');
          }
        } catch (error) {
          console.error('[GeminiTimeline] Prompt manager initialization error:', error);
        }
      }
      // Load stars for this conversation (Phase 8)
      try { this.loadStars(); } catch {}
      // Load summarization state BEFORE building markers
      try { await this.loadSummarizationState(); } catch {}
      // Build initial markers and compute geometry + virtualization (Phase 4–5)
      try { this.rebuildMarkersPhase4(); } catch {}
      try { this.updateTimelineGeometry(); } catch {}
      try { this.updateVirtualRangeAndRender(); } catch {}
      // Keep virtual window updated when timeline track scrolls
      try { this.track.addEventListener('scroll', () => this.updateVirtualRangeAndRender(), { passive: true }); } catch {}
      // Phase 6: wire linking + interactions
      try { this.attachScrollSync(); } catch {}
      try { this.attachInteractions(); } catch {}
      // Visibility observer (IntersectionObserver)
      try { this.attachIntersectionObserver(); } catch {}
      try { window.addEventListener('resize', this.onWindowResize = () => {
        // Reposition tooltip if visible
        try {
          if (this.ui?.tooltip?.classList.contains('visible')) {
            const activeDot = this.timelineBar?.querySelector?.('.timeline-dot:hover, .timeline-dot:focus');
            if (activeDot) {
              const tip = this.ui.tooltip;
              tip.classList.remove('visible');
              const p = this.computePlacementInfo(activeDot);
              const text = (activeDot.getAttribute('aria-label') || '').trim();
              const layout = this.truncateToThreeLines(text, p.width, true);
              tip.textContent = layout.text;
              this.placeTooltipAt(activeDot, p.placement, p.width, layout.height);
              if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
              this.showRafId = requestAnimationFrame(() => { this.showRafId = null; tip.classList.add('visible'); });
            }
          }
        } catch {}
        this.updateTimelineGeometry();
        this.updateVirtualRangeAndRender();
        this.syncTimelineTrackToMain();
        this.updateSlider();
        try { this.truncateCache?.clear(); } catch {}
      }); } catch {}
      // Phase 9: observe theme attributes on html/body
      try {
        if (!this.themeObserver) {
          this.themeObserver = new MutationObserver(() => {
            try {
              // Reposition tooltip if visible
              if (this.ui?.tooltip?.classList.contains('visible')) {
                const activeDot = this.timelineBar?.querySelector?.('.timeline-dot:hover, .timeline-dot:focus');
                if (activeDot) {
                  const tip = this.ui.tooltip; tip.classList.remove('visible');
                  const p = this.computePlacementInfo(activeDot);
                  const text = (activeDot.getAttribute('aria-label') || '').trim();
                  const layout = this.truncateToThreeLines(text, p.width, true);
                  tip.textContent = layout.text;
                  this.placeTooltipAt(activeDot, p.placement, p.width, layout.height);
                  if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
                  this.showRafId = requestAnimationFrame(() => { this.showRafId = null; tip.classList.add('visible'); });
                }
              }
            } catch {}
            this.updateTimelineGeometry();
            this.updateVirtualRangeAndRender();
            this.syncTimelineTrackToMain();
            this.updateSlider();
            try { this.truncateCache?.clear(); } catch {}
          });
        }
        const attrs = ['class','data-theme','data-color-mode','data-color-scheme'];
        try { this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: attrs }); } catch {}
        try { this.themeObserver.observe(document.body, { attributes: true, attributeFilter: attrs }); } catch {}
      } catch {}
      // Phase 9: ResizeObserver on timeline bar
      try {
        if (!this.resizeObserver && this.timelineBar) {
          this.resizeObserver = new ResizeObserver(() => {
            this.updateTimelineGeometry();
            this.updateVirtualRangeAndRender();
            this.syncTimelineTrackToMain();
            this.updateSlider();
          });
          try { this.resizeObserver.observe(this.timelineBar); } catch {}
        }
      } catch {}
      // Phase 9: visual viewport resize
      try {
        if (window.visualViewport && !this.onVisualViewportResize) {
          this.onVisualViewportResize = () => {
            this.updateTimelineGeometry();
            this.updateVirtualRangeAndRender();
            this.syncTimelineTrackToMain();
            this.updateSlider();
            try { this.truncateCache?.clear(); } catch {}
            // Reposition tooltip if visible
            try {
              if (this.ui?.tooltip?.classList.contains('visible')) {
                const activeDot = this.timelineBar?.querySelector?.('.timeline-dot:hover, .timeline-dot:focus');
                if (activeDot) {
                  const tip = this.ui.tooltip; tip.classList.remove('visible');
                  const p = this.computePlacementInfo(activeDot);
                  const text = (activeDot.getAttribute('aria-label') || '').trim();
                  const layout = this.truncateToThreeLines(text, p.width, true);
                  tip.textContent = layout.text;
                  this.placeTooltipAt(activeDot, p.placement, p.width, layout.height);
                  if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
                  this.showRafId = requestAnimationFrame(() => { this.showRafId = null; tip.classList.add('visible'); });
                }
              }
            } catch {}
          };
          try { window.visualViewport.addEventListener('resize', this.onVisualViewportResize); } catch {}
        }
      } catch {}
      try { console.debug('[GeminiTimeline] Phase 3 injected UI scaffold'); } catch {}
      // Phase 8: cross-tab star sync
      this.onStorage = (e) => {
        try {
          if (!e || e.storageArea !== localStorage) return;
          const cid = this.conversationId;
          if (!cid) return;
          const expectedKey = `geminiTimelineStars:${cid}`;
          if (e.key !== expectedKey) return;
          let nextArr = [];
          try { nextArr = JSON.parse(e.newValue || '[]') || []; } catch { nextArr = []; }
          const nextSet = new Set(nextArr.map(x => String(x)));
          if (nextSet.size === this.starred.size) {
            let same = true; for (const id of this.starred) { if (!nextSet.has(id)) { same = false; break; } }
            if (same) return;
          }
          this.starred = nextSet;
          for (let i = 0; i < this.markers.length; i++) {
            const m = this.markers[i];
            const want = this.starred.has(m.id);
            if (m.starred !== want) {
              m.starred = want;
              if (m.dotElement) {
                try { m.dotElement.classList.toggle('starred', m.starred); m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false'); } catch {}
              }
            }
          }
          try {
            if (this.ui.tooltip?.classList.contains('visible')) {
              const currentDot = this.timelineBar.querySelector('.timeline-dot:hover, .timeline-dot:focus');
              if (currentDot) this.refreshTooltipForDot(currentDot);
            }
          } catch {}
        } catch {}
      };
      try { window.addEventListener('storage', this.onStorage); } catch {}

      // Content mutation observer (append new messages, container swaps)
      try { this.attachContentObserver(); } catch {}
    }

    injectUI() {
      // Bar
      let bar = document.querySelector('.chatgpt-timeline-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'chatgpt-timeline-bar';
        document.body.appendChild(bar);
      }
      this.timelineBar = bar;
      // Track and content
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
      // External left slider (visual-only at this phase)
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
      // Tooltip element (shared id for a11y)
      if (!this.ui.tooltip) {
        const tip = document.createElement('div');
        tip.className = 'timeline-tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.id = 'chatgpt-timeline-tooltip';
        tip.setAttribute('aria-hidden', 'true');
        try { tip.style.boxSizing = 'border-box'; } catch {}
        document.body.appendChild(tip);
        this.ui.tooltip = tip;

        // Add tooltip hover handlers to keep it visible when hovering
        tip.addEventListener('mouseenter', () => {
          // Cancel any pending state clear timer
          if (this.clearStateTimer) {
            clearTimeout(this.clearStateTimer);
            this.clearStateTimer = null;
          }

          try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; } } catch {}
          // When entering tooltip, switch to original text
          if (!this.isMouseOnLeft && this.currentHoveredDot) {
            this.isMouseOnLeft = true;
            this.updateTooltipTextForDot(this.currentHoveredDot);
          }
        });
        tip.addEventListener('mouseleave', (e) => {
          // Check if leaving to go back to the dot
          const toDot = e.relatedTarget?.closest?.('.timeline-dot');
          if (toDot && toDot === this.currentHoveredDot) {
            // Going back to dot, switch back to summary
            this.isMouseOnLeft = false;
            this.updateTooltipTextForDot(this.currentHoveredDot);
          } else {
            // Leaving entirely, hide tooltip
            this.hideTooltip();
            this.currentHoveredDot = null;
            this.isMouseOnLeft = false;
          }
        });
        // Create hidden measurer for truncation
        try {
          const m = document.createElement('div');
          m.setAttribute('aria-hidden', 'true');
          m.style.position = 'fixed';
          m.style.left = '-9999px';
          m.style.top = '0px';
          m.style.visibility = 'hidden';
          m.style.pointerEvents = 'none';
          m.style.boxSizing = 'border-box';
          const cs = getComputedStyle(tip);
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
        } catch {}
      }
      // Inject AI Summarizer button only if AI mode is enabled
      if (this.aiModeEnabled && !this.ui.summarizerButton) {
        const summarizerBtn = document.createElement('button');
        summarizerBtn.className = 'timeline-summarizer-button';
        summarizerBtn.setAttribute('aria-label', 'Generate AI summaries for timeline');
        summarizerBtn.setAttribute('title', 'Generate AI summaries');
        summarizerBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          <path d="M8 10h8M8 14h4"/>
        </svg>
        <span class="progress-text"></span>`;
        document.body.appendChild(summarizerBtn);
        this.ui.summarizerButton = summarizerBtn;

        // Summarizer button click handler with toggle functionality
        summarizerBtn.addEventListener('click', async () => {
          if (this.isSummarizing) return;

          // Toggle functionality
          if (this.summarizerState === 'idle') {
            await this.applySummarizationToAllMarkers();
          } else if (this.summarizerState === 'completed') {
            // Check if there are new unsummarized markers
            const hasUnsummarizedMarkers = this.markers.some(m => !m.aiSummary);
            if (hasUnsummarizedMarkers) {
              await this.applySummarizationToAllMarkers();
            } else {
              this.switchToOriginalText();
            }
          } else if (this.summarizerState === 'original') {
            this.switchToAISummaries();
          }
        });
      }

      // Create incremental summarize button only if AI mode is enabled
      if (this.aiModeEnabled && !this.ui.incrementalButton) {
        // Clean up any existing stray buttons first
        try {
          const existingBtn = document.querySelector('.timeline-incremental-button');
          if (existingBtn) existingBtn.remove();
        } catch {}

        const incrementalBtn = document.createElement('button');
        incrementalBtn.className = 'timeline-incremental-button';
        incrementalBtn.setAttribute('aria-label', 'Summarize new messages');
        incrementalBtn.setAttribute('title', 'Summarize new messages');
        incrementalBtn.style.display = 'none'; // Hidden by default, shown when needed
        incrementalBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        <span class="count-badge">0</span>`;
        document.body.appendChild(incrementalBtn);
        this.ui.incrementalButton = incrementalBtn;

        // Click handler: incrementally summarize new markers
        incrementalBtn.addEventListener('click', async () => {
          if (this.isSummarizing) return;
          await this.applySummarizationToAllMarkers();
        });
      }
    }

    destroy() {
      // Remove listeners
      try { this.timelineBar?.removeEventListener('click', this.onTimelineBarClick); } catch {}
      try { this.timelineBar?.removeEventListener('wheel', this.onTimelineWheel); } catch {}
      try { this.timelineBar?.removeEventListener('mouseover', this.onTimelineBarOver); } catch {}
      try { this.timelineBar?.removeEventListener('mouseout', this.onTimelineBarOut); } catch {}
      try { this.timelineBar?.removeEventListener('mousemove', this.onTimelineBarMove); } catch {}
      try { this.timelineBar?.removeEventListener('focusin', this.onTimelineBarFocusIn); } catch {}
      try { this.timelineBar?.removeEventListener('focusout', this.onTimelineBarFocusOut); } catch {}
      try { this.timelineBar?.removeEventListener('pointerenter', this.onBarEnter); } catch {}
      try { this.timelineBar?.removeEventListener('pointerleave', this.onBarLeave); } catch {}
      try { this.ui.slider?.removeEventListener('pointerenter', this.onSliderEnter); } catch {}
      try { this.ui.slider?.removeEventListener('pointerleave', this.onSliderLeave); } catch {}
      try { this.ui.sliderHandle?.removeEventListener('pointerdown', this.onSliderDown); } catch {}
      try { this.timelineBar?.removeEventListener('pointerdown', this.onPointerDown); } catch {}
      try { this.timelineBar?.removeEventListener('pointerleave', this.onPointerLeave); } catch {}
      try { window.removeEventListener('pointermove', this.onPointerMove); } catch {}
      try { window.removeEventListener('pointerup', this.onPointerUp); } catch {}
      try { window.removeEventListener('pointercancel', this.onPointerCancel); } catch {}
      try { window.removeEventListener('resize', this.onWindowResize); } catch {}
      try { this.scrollContainer?.removeEventListener('scroll', this.onScroll); } catch {}
      try { window.removeEventListener('scroll', this.onScroll); } catch {}
      try { window.removeEventListener('storage', this.onStorage); } catch {}
      try { this.mutationObserver?.disconnect(); } catch {}
      this.mutationObserver = null;
      if (this.rebuildTimer) { try { clearTimeout(this.rebuildTimer); } catch {} this.rebuildTimer = null; }
      try { this.timelineBar?.remove(); } catch {}
      try { this.ui.slider?.remove(); } catch {}
      try { this.ui.tooltip?.remove(); } catch {}
      // Remove summarizer button and incremental button
      try { this.ui.summarizerButton?.remove(); } catch {}
      try { this.ui.incrementalButton?.remove(); } catch {}
      // Clean up any stray buttons
      try {
        const straySummarizer = document.querySelector('.timeline-summarizer-button');
        if (straySummarizer) straySummarizer.remove();
      } catch {}
      try {
        const strayIncremental = document.querySelector('.timeline-incremental-button');
        if (strayIncremental) strayIncremental.remove();
      } catch {}
      this.timelineBar = null;
      this.track = null;
      this.trackContent = null;
      this.ui.slider = null;
      this.ui.sliderHandle = null;
      this.ui.tooltip = null;
      this.ui.summarizerButton = null;
      this.ui.incrementalButton = null;
      this.conversationContainer = null;
      this.scrollContainer = null;
      if (this.tooltipHideTimer) { try { clearTimeout(this.tooltipHideTimer); } catch {} this.tooltipHideTimer = null; }
      if (this.clearStateTimer) { try { clearTimeout(this.clearStateTimer); } catch {} this.clearStateTimer = null; }
      if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} this.sliderFadeTimer = null; }
      if (this.longPressTimer) { try { clearTimeout(this.longPressTimer); } catch {} this.longPressTimer = null; }
      if (this.activeChangeTimer) { try { clearTimeout(this.activeChangeTimer); } catch {} this.activeChangeTimer = null; }
      if (this.scrollRafId !== null) { try { cancelAnimationFrame(this.scrollRafId); } catch {} this.scrollRafId = null; }
      if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
      try { this.measureEl?.remove(); } catch {}
    }

    // --- Phase 9+: content observer & rebind ---
    attachContentObserver() {
      if (!this.conversationContainer) return;
      try { this.mutationObserver?.disconnect(); } catch {}
      this.mutationObserver = new MutationObserver(() => {
        try { this.ensureContainersUpToDate(); } catch {}
        if (this.rebuildTimer) { try { clearTimeout(this.rebuildTimer); } catch {} }
        this.rebuildTimer = setTimeout(() => { this.rebuildAndRefresh(); }, 250);
      });
      try { this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true }); } catch {}
    }

    rebuildAndRefresh() {
      try { this.rebuildMarkersPhase4(); } catch {}
      try { this.updateTimelineGeometry(); } catch {}
      try { this.updateVirtualRangeAndRender(); } catch {}
      try { this.syncTimelineTrackToMain(); } catch {}
      try { this.updateSlider(); } catch {}
      try { this.updateIntersectionObserverTargets(); } catch {}
      // Ensure active index and UI are applied after a rebuild
      try { this.computeActiveByScroll(); } catch {}
      try { this.updateActiveDotUI(); } catch {}
    }

    ensureContainersUpToDate() {
      try {
        const first = document.querySelector(SEL_USER_BUBBLE);
        if (!first) return;
        const newRoot = findConversationRootFromFirst(first);
        if (newRoot && newRoot !== this.conversationContainer) {
          this.rebindConversationContainer(newRoot);
        }
      } catch {}
    }

    rebindConversationContainer(newConv) {
      // Detach old listeners bound to old containers
      try { this.scrollContainer?.removeEventListener('scroll', this.onScroll); } catch {}
      try { window.removeEventListener('scroll', this.onScroll); } catch {}
      try { this.mutationObserver?.disconnect(); } catch {}

      // Bind new containers
      this.conversationContainer = newConv;
      this.scrollContainer = getScrollableAncestor(this.conversationContainer);

      // Re-attach scroll sync & observer
      this.attachScrollSync();
      this.attachContentObserver();
      // Rebuild markers and refresh geometry
      this.rebuildAndRefresh();
    }

    // --- Phase 4: markers + endpoint mapping ---
    clamp01(x) { return Math.max(0, Math.min(1, x)); }

    extractUserSummary(el) {
      try {
        const line = el.querySelector('.query-text .query-text-line');
        if (line && line.textContent) return String(line.textContent).replace(/\s+/g, ' ').trim();
      } catch {}
      try { return String(el.textContent || '').replace(/\s+/g, ' ').trim(); } catch { return ''; }
    }

    buildStableHashFromUser(el) {
      try {
        const t = this.extractUserSummary(el) || '';
        let h = 2166136261 >>> 0; // FNV-1a like
        for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(36);
      } catch { return Math.random().toString(36).slice(2, 8); }
    }

    hasUserText(el) {
      try {
        const line = el.querySelector('.query-text .query-text-line');
        if (line && typeof line.textContent === 'string' && line.textContent.trim().length > 0) return true;
      } catch {}
      try {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return t.length > 0;
      } catch { return false; }
    }

    collectUserNodes() {
      const root = this.conversationContainer || document;
      // Priority 1: bubble itself
      try {
        const bubbles = Array.from(root.querySelectorAll('.user-query-bubble-with-background')).filter(n => this.hasUserText(n));
        if (bubbles.length) return bubbles;
      } catch {}
      // Priority 2: right-aligned user container
      try {
        const rights = Array.from(root.querySelectorAll('.user-query-container.right-align-content')).filter(n => this.hasUserText(n));
        if (rights.length) return rights;
      } catch {}
      // Priority 3: custom element
      try {
        const tags = Array.from(root.querySelectorAll('user-query')).filter(n => this.hasUserText(n));
        return tags;
      } catch { return []; }
    }

    rebuildMarkersPhase4() {
      if (!this.conversationContainer || !this.trackContent || !this.scrollContainer) return;
      // Clear previous dots
      try { this.trackContent.querySelectorAll('.timeline-dot').forEach(n => n.remove()); } catch {}

      const nodes = this.collectUserNodes();
      if (nodes.length === 0) return;

      // Compute absolute Y relative to scroll container
      const cRect = this.scrollContainer.getBoundingClientRect();
      const st = this.scrollContainer.scrollTop;
      const ys = nodes.map(el => {
        const r = el.getBoundingClientRect();
        return (r.top - cRect.top) + st;
      });
      const firstY = ys[0];
      const lastY = (ys.length > 1) ? ys[ys.length - 1] : (firstY + 1);
      const span = Math.max(1, lastY - firstY);
      this.firstOffset = firstY;
      this.spanPx = span;

      // Preserve existing AI summaries from old markers
      const oldMarkerMap = new Map();
      try {
        for (const oldMarker of this.markers) {
          if (oldMarker?.id) {
            oldMarkerMap.set(oldMarker.id, oldMarker);
          }
        }
      } catch {}

      const seen = new Map();
      try { this.markerIndexByEl?.clear(); } catch {}
      this.markers = nodes.map((el, i) => {
        const y = ys[i];
        const n0 = this.clamp01((y - firstY) / span);
        let id = null;
        try { id = el.getAttribute('data-turn-id') || null; } catch {}
        if (!id) {
          const base = this.buildStableHashFromUser(el);
          const cnt = (seen.get(base) || 0) + 1; seen.set(base, cnt);
          id = `${base}-${cnt}`;
          try { el.setAttribute('data-turn-id', id); } catch {}
        }
        const starred = this.starred.has(String(id));

        // Extract original text
        const originalText = this.extractUserSummary(el);

        // Check if we have an existing marker with AI summary (only if AI mode is enabled)
        const oldMarker = oldMarkerMap.get(id);
        let aiSummary = this.aiModeEnabled ? (oldMarker?.aiSummary || null) : null;

        // Apply pending summaries if available (from localStorage on page load) - only if AI mode is enabled
        if (this.aiModeEnabled && !aiSummary && this._pendingSummaries && this._pendingSummaries[id]) {
          aiSummary = this._pendingSummaries[id];
        }

        // Use AI summary if we're in AI mode and AI mode is enabled, otherwise use original
        const summary = (this.aiModeEnabled && this.useSummarization && aiSummary) ? aiSummary : originalText;

        const marker = {
          id,
          el,
          n: n0,
          baseN: n0,
          dotElement: null,
          starred,
          summary: summary,
          originalText: originalText,
          aiSummary: aiSummary
        };
        try { this.markerIndexByEl?.set(el, i); } catch {}
        return marker;
      });

      // Clear pending summaries after applying them
      if (this._pendingSummaries) {
        this._pendingSummaries = null;
      }

      // Check if there are unsummarized markers and update incremental button
      if (this.summarizerState === 'completed' || this.summarizerState === 'original') {
        try { this.updateIncrementalSummarizeButton(); } catch {}
      }

      try { console.debug(`[GeminiTimeline] Phase 4 markers=${this.markers.length}, spanPx=${this.spanPx}`); } catch {}
    }

    // --- Phase 5: long canvas geometry + virtualization ---
    getCSSVarNumber(el, name, fallback) {
      try {
        const v = getComputedStyle(el).getPropertyValue(name).trim();
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
      } catch { return fallback; }
    }

    applyMinGap(positions, minTop, maxTop, gap) {
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
    }

    detectCssVarTopSupport(pad, usableC) {
      try {
        if (!this.trackContent) return false;
        const test = document.createElement('button');
        test.className = 'timeline-dot';
        test.style.visibility = 'hidden';
        test.style.pointerEvents = 'none';
        test.setAttribute('aria-hidden', 'true');
        const expected = pad + 0.5 * usableC;
        test.style.setProperty('--n', '0.5');
        this.trackContent.appendChild(test);
        const cs = getComputedStyle(test);
        const px = parseFloat(cs.top || '');
        test.remove();
        if (!Number.isFinite(px)) return false;
        return Math.abs(px - expected) <= 2;
      } catch { return false; }
    }

    updateTimelineGeometry() {
      if (!this.timelineBar || !this.trackContent) return;
      const H = this.timelineBar.clientHeight || 0;
      const pad = this.getCSSVarNumber(this.timelineBar, '--timeline-track-padding', 16);
      const minGap = this.getCSSVarNumber(this.timelineBar, '--timeline-min-gap', 24);
      const N = this.markers.length;
      const desired = Math.max(H, (N > 0 ? (2 * pad + Math.max(0, N - 1) * minGap) : H));
      this.contentHeight = Math.ceil(desired);
      try { this.trackContent.style.height = `${this.contentHeight}px`; } catch {}

      const usableC = Math.max(1, this.contentHeight - 2 * pad);
      const desiredY = this.markers.map(m => pad + this.clamp01(m.baseN ?? m.n ?? 0) * usableC);
      const adjusted = this.applyMinGap(desiredY, pad, pad + usableC, minGap);
      this.yPositions = adjusted;
      for (let i = 0; i < N; i++) {
        const n = this.clamp01((adjusted[i] - pad) / usableC);
        this.markers[i].n = n;
        if (this.markers[i].dotElement && !this.usePixelTop) {
          try { this.markers[i].dotElement.style.setProperty('--n', String(n)); } catch {}
        }
      }
      if (this._cssVarTopSupported === null) {
        this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableC);
        this.usePixelTop = !this._cssVarTopSupported;
      }
      // Slider visibility hint (appear when scrollable)
      const barH = this.timelineBar?.clientHeight || 0;
      this.sliderAlwaysVisible = this.contentHeight > barH + 1;
      this.updateSlider();
    }

    lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
    upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; } return lo - 1; }

    updateVirtualRangeAndRender() {
      if (!this.track || !this.trackContent || this.markers.length === 0) return;
      const st = this.track.scrollTop || 0;
      const vh = this.track.clientHeight || 0;
      const buffer = Math.max(100, vh);
      const minY = st - buffer;
      const maxY = st + vh + buffer;
      const start = this.lowerBound(this.yPositions, minY);
      const end = Math.max(start - 1, this.upperBound(this.yPositions, maxY));

      let prevStart = this.visibleRange.start;
      let prevEnd = this.visibleRange.end;
      const len = this.markers.length;
      if (len > 0) { prevStart = Math.max(0, Math.min(prevStart, len - 1)); prevEnd = Math.max(-1, Math.min(prevEnd, len - 1)); }
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

      const frag = document.createDocumentFragment();
      for (let i = start; i <= end; i++) {
        const marker = this.markers[i];
        if (!marker) continue;
        if (!marker.dotElement) {
          const dot = document.createElement('button');
          dot.className = 'timeline-dot';
          dot.dataset.targetIdx = marker.id;
          try { dot.setAttribute('tabindex', '0'); } catch {}
          try { dot.setAttribute('aria-label', marker.summary || this.extractUserSummary(marker.el)); } catch {}
          try { dot.setAttribute('aria-describedby', 'chatgpt-timeline-tooltip'); } catch {}
          if (this.usePixelTop) { dot.style.top = `${Math.round(this.yPositions[i])}px`; }
          else { try { dot.style.setProperty('--n', String(marker.n || 0)); } catch {} }
          // Apply current active state immediately on creation
          try { dot.classList.toggle('active', i === this.activeIdx); } catch {}
          try { dot.classList.toggle('starred', !!marker.starred); dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false'); } catch {}
          marker.dotElement = dot;
          frag.appendChild(dot);
        } else {
          if (this.usePixelTop) { marker.dotElement.style.top = `${Math.round(this.yPositions[i])}px`; }
          else { try { marker.dotElement.style.setProperty('--n', String(marker.n || 0)); } catch {} }
          // Keep active state in sync for already mounted dots
          try { marker.dotElement.classList.toggle('active', i === this.activeIdx); } catch {}
          try { marker.dotElement.classList.toggle('starred', !!marker.starred); marker.dotElement.setAttribute('aria-pressed', marker.starred ? 'true' : 'false'); } catch {}
        }
      }
      if (frag.childNodes.length) this.trackContent.appendChild(frag);
      this.visibleRange = { start, end };
    }

    // --- Phase 6: linking + interactions ---
    attachScrollSync() {
      if (!this.scrollContainer) return;
      this.onScroll = () => this.scheduleScrollSync();
      try { this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true }); } catch {}
      const docScroll = document.scrollingElement || document.documentElement || document.body;
      if (this.scrollContainer === docScroll || this.scrollContainer === document.body || this.scrollContainer === document.documentElement) {
        try { window.addEventListener('scroll', this.onScroll, { passive: true }); } catch {}
      }
      this.scheduleScrollSync();
    }

    scheduleScrollSync() {
      if (this.scrollRafId !== null) return;
      this.scrollRafId = requestAnimationFrame(() => {
        this.scrollRafId = null;
        this.syncTimelineTrackToMain();
        this.updateVirtualRangeAndRender();
        this.computeActiveByScroll();
        this.updateSlider();
      });
    }

    syncTimelineTrackToMain() {
      if (!this.track || !this.scrollContainer || !this.contentHeight) return;
      const scrollTop = this.scrollContainer.scrollTop;
      const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
      const span = Math.max(1, this.spanPx || 1);
      const r = this.clamp01((ref - (this.firstOffset || 0)) / span);
      const maxScroll = Math.max(0, this.contentHeight - (this.track.clientHeight || 0));
      const target = Math.round(r * maxScroll);
      if (Math.abs((this.track.scrollTop || 0) - target) > 1) this.track.scrollTop = target;
    }

    computeActiveByScroll() {
      if (!this.scrollContainer || this.markers.length === 0) return;
      const containerRect = this.scrollContainer.getBoundingClientRect();
      const scrollTop = this.scrollContainer.scrollTop;
      const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
      let active = 0;
      if (this.visibleUserTurns && this.visibleUserTurns.size > 0) {
        let bestIdx = -1;
        let bestScore = Infinity;
        for (const el of this.visibleUserTurns) {
          const idx = this.markerIndexByEl?.get(el);
          if (typeof idx !== 'number') continue;
          const m = this.markers[idx]; if (!m) continue;
          const top = m.el.getBoundingClientRect().top - containerRect.top + scrollTop;
          const dy = ref - top;
          const score = (dy >= 0) ? dy : Math.abs(dy) + 10000;
          if (score < bestScore) { bestScore = score; bestIdx = idx; }
        }
        if (bestIdx >= 0) active = bestIdx; else {
          for (let i = 0; i < this.markers.length; i++) {
            const m = this.markers[i];
            const top = m.el.getBoundingClientRect().top - containerRect.top + scrollTop;
            if (top <= ref) active = i; else break;
          }
        }
      } else {
        for (let i = 0; i < this.markers.length; i++) {
          const m = this.markers[i];
          const top = m.el.getBoundingClientRect().top - containerRect.top + scrollTop;
          if (top <= ref) active = i; else break;
        }
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
    }

    // --- Visibility observer helpers ---
    attachIntersectionObserver() {
      try { this.intersectionObserver?.disconnect(); } catch {}
      try { this.visibleUserTurns?.clear(); } catch {}
      const opts = { root: this.scrollContainer || null, rootMargin: "-40% 0px -59% 0px", threshold: 0.0 };
      try {
        this.intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const el = entry.target;
            if (entry.isIntersecting) this.visibleUserTurns.add(el); else this.visibleUserTurns.delete(el);
          }
          this.scheduleScrollSync();
        }, opts);
      } catch { this.intersectionObserver = null; }
      this.updateIntersectionObserverTargets();
    }

    updateIntersectionObserverTargets() {
      if (!this.intersectionObserver) return;
      try { this.intersectionObserver.disconnect(); } catch {}
      try { this.visibleUserTurns.clear(); } catch {}
      for (let i = 0; i < this.markers.length; i++) {
        const el = this.markers[i]?.el;
        if (el) { try { this.intersectionObserver.observe(el); } catch {} }
      }
    }

    updateActiveDotUI() {
      for (let i = 0; i < this.markers.length; i++) {
        const m = this.markers[i];
        if (m?.dotElement) { try { m.dotElement.classList.toggle('active', i === this.activeIdx); } catch {} }
      }
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
      const ease = (t, b, c, d) => { t /= d/2; if (t < 1) return c/2*t*t + b; t--; return -c/2*(t*(t-2)-1)+b; };
      const step = (ts) => {
        if (t0 === null) t0 = ts;
        const dt = ts - t0;
        const v = ease(dt, from, dist, dur);
        this.scrollContainer.scrollTop = v;
        if (dt < dur) requestAnimationFrame(step); else this.scrollContainer.scrollTop = to;
      };
      requestAnimationFrame(step);
    }

    attachInteractions() {
      if (!this.timelineBar) return;
      // Click: jump to message
      this.onTimelineBarClick = (e) => {
        const dot = e.target.closest?.('.timeline-dot');
        if (!dot) return;
        const now = Date.now();
        if (now < (this.suppressClickUntil || 0)) { try { e.preventDefault(); e.stopPropagation(); } catch {} return; }
        const id = dot.dataset.targetIdx;
        const m = this.markers.find(x => x.id === id);
        if (m?.el) this.scrollToMessage(m.el);
      };
      try { this.timelineBar.addEventListener('click', this.onTimelineBarClick); } catch {}

      // Wheel: control main scroll
      this.onTimelineWheel = (e) => {
        try { e.preventDefault(); } catch {}
        const delta = e.deltaY || 0;
        this.scrollContainer.scrollTop += delta;
        this.scheduleScrollSync();
        this.showSlider();
      };
      try { this.timelineBar.addEventListener('wheel', this.onTimelineWheel, { passive: false }); } catch {}

      // Tooltip interactions
      this.onTimelineBarOver = (e) => { const dot = e.target.closest?.('.timeline-dot'); if (dot) this.showTooltipForDot(dot); };
      this.onTimelineBarOut = (e) => {
        const fromDot = e.target.closest?.('.timeline-dot');
        const toDot = e.relatedTarget?.closest?.('.timeline-dot');

        // Don't hide if moving from dot to another dot
        if (fromDot && !toDot) {
          // Use a delay before clearing state to give tooltip mouseenter time to fire
          if (this.clearStateTimer) {
            clearTimeout(this.clearStateTimer);
          }
          this.clearStateTimer = setTimeout(() => {
            this.hideTooltip();
            this.currentHoveredDot = null;
            this.isMouseOnLeft = false;
            this.clearStateTimer = null;
          }, 200);
        }
      };
      this.onTimelineBarMove = (e) => {
        if (!this.currentHoveredDot || !this.ui.tooltip) return;

        // Check if mouse is over the tooltip box
        const tooltipRect = this.ui.tooltip.getBoundingClientRect();
        const mouseX = e.clientX;
        const mouseY = e.clientY;

        const wasOnLeft = this.isMouseOnLeft;
        this.isMouseOnLeft = (
          mouseX >= tooltipRect.left &&
          mouseX <= tooltipRect.right &&
          mouseY >= tooltipRect.top &&
          mouseY <= tooltipRect.bottom
        );

        // Only update if the state changed
        if (wasOnLeft !== this.isMouseOnLeft) {
          this.updateTooltipTextForDot(this.currentHoveredDot);
        }
      };
      this.onTimelineBarFocusIn = (e) => { const dot = e.target.closest?.('.timeline-dot'); if (dot) this.showTooltipForDot(dot); };
      this.onTimelineBarFocusOut = (e) => { const dot = e.target.closest?.('.timeline-dot'); if (dot) this.hideTooltip(); };
      try {
        this.timelineBar.addEventListener('mouseover', this.onTimelineBarOver);
        this.timelineBar.addEventListener('mouseout', this.onTimelineBarOut);
        this.timelineBar.addEventListener('mousemove', this.onTimelineBarMove);
        this.timelineBar.addEventListener('focusin', this.onTimelineBarFocusIn);
        this.timelineBar.addEventListener('focusout', this.onTimelineBarFocusOut);
      } catch {}

      // Slider hover visibility
      this.onBarEnter = () => this.showSlider();
      this.onBarLeave = () => this.hideSliderDeferred();
      this.onSliderEnter = () => this.showSlider();
      this.onSliderLeave = () => this.hideSliderDeferred();
      try {
        this.timelineBar.addEventListener('pointerenter', this.onBarEnter);
        this.timelineBar.addEventListener('pointerleave', this.onBarLeave);
        this.ui.slider?.addEventListener('pointerenter', this.onSliderEnter);
        this.ui.slider?.addEventListener('pointerleave', this.onSliderLeave);
      } catch {}

      // Slider drag
      this.onSliderDown = (e) => {
        if (!this.ui.sliderHandle || (typeof e.button === 'number' && e.button !== 0)) return;
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

      // Long-press star (Phase 8)
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
        if ((dx*dx + dy*dy) > (this.longPressMoveTolerance*this.longPressMoveTolerance)) this.cancelLongPress();
      };
      this.onPointerUp = () => { this.cancelLongPress(); };
      this.onPointerCancel = () => { this.cancelLongPress(); };
      this.onPointerLeave = (ev) => { const dot = ev.target.closest?.('.timeline-dot'); if (dot && dot === this.pressTargetDot) this.cancelLongPress(); };
      try {
        this.timelineBar.addEventListener('pointerdown', this.onPointerDown);
        window.addEventListener('pointermove', this.onPointerMove, { passive: true });
        window.addEventListener('pointerup', this.onPointerUp, { passive: true });
        window.addEventListener('pointercancel', this.onPointerCancel, { passive: true });
        this.timelineBar.addEventListener('pointerleave', this.onPointerLeave);
      } catch {}
    }

    updateSlider() {
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
      const railLeftGap = 8;
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
    }

    showSlider() {
      if (!this.ui.slider) return;
      this.ui.slider.classList.add('visible');
      if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} this.sliderFadeTimer = null; }
      this.updateSlider();
    }

    hideSliderDeferred() {
      if (this.sliderDragging || this.sliderAlwaysVisible) return;
      if (this.sliderFadeTimer) { try { clearTimeout(this.sliderFadeTimer); } catch {} }
      this.sliderFadeTimer = setTimeout(() => {
        this.sliderFadeTimer = null;
        try { this.ui.slider?.classList.remove('visible'); } catch {}
      }, this.sliderFadeDelay);
    }

    handleSliderDrag(e) {
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
    }

    endSliderDrag() {
      this.sliderDragging = false;
      try { window.removeEventListener('pointermove', this.onSliderMove); } catch {}
      this.onSliderMove = null;
      this.onSliderUp = null;
      this.hideSliderDeferred();
    }

    // --- Phase 7: Tooltip helpers ---
    computePlacementInfo(dot) {
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
        if (placement === 'left' && rightAvail > leftAvail) { placement = 'right'; avail = rightAvail; }
        else if (placement === 'right' && leftAvail >= rightAvail) { placement = 'left'; avail = leftAvail; }
        const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
        width = tiers.find(t => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
      }
      width = Math.max(120, Math.min(width, maxW));
      return { placement, width };
    }

    truncateToThreeLines(text, targetWidth, wantLayout = false) {
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
        try { this.truncateCache?.set(cacheKey, out); } catch {}
        return wantLayout ? { text: out, height: Math.min(h, maxH) } : out;
      } catch { return wantLayout ? { text, height: 0 } : text; }
    }

    placeTooltipAt(dot, placement, width, height) {
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
    }

    showTooltipForDot(dot) {
      if (!this.ui.tooltip) return;
      try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; } } catch {}

      // Cancel any pending state clear timer
      if (this.clearStateTimer) {
        clearTimeout(this.clearStateTimer);
        this.clearStateTimer = null;
      }

      // Track the current hovered dot
      this.currentHoveredDot = dot;

      const tip = this.ui.tooltip;
      tip.classList.remove('visible');
      let fullText = (dot.getAttribute('aria-label') || '').trim();
      let isAISummary = false;

      // Add or remove 'ai-summary' class based on whether we're showing AI-generated text
      try {
        const id = dot.dataset.targetIdx;
        const marker = this.markers.find(m => m.id === id);

        // Determine which text to show based on mouse position and AI mode
        if (marker) {
          // If user is hovering to the left and we're in AI mode, show original text
          if (this.useSummarization && this.isMouseOnLeft && marker.originalText) {
            fullText = marker.originalText;
            isAISummary = false; // Not showing AI summary when on left
          } else if (this.useSummarization && marker.aiSummary) {
            // Normal behavior: show AI summary when in AI mode
            isAISummary = true;
          }
        }

        if (id && this.starred.has(id)) fullText = `★ ${fullText}`;

        if (isAISummary) {
          tip.classList.add('ai-summary');
        } else {
          tip.classList.remove('ai-summary');
        }
      } catch {}

      const p = this.computePlacementInfo(dot);
      const layout = this.truncateToThreeLines(fullText, p.width, true);
      tip.textContent = layout.text;
      this.placeTooltipAt(dot, p.placement, p.width, layout.height);
      tip.setAttribute('aria-hidden', 'false');
      if (this.showRafId !== null) { try { cancelAnimationFrame(this.showRafId); } catch {} this.showRafId = null; }
      this.showRafId = requestAnimationFrame(() => { this.showRafId = null; tip.classList.add('visible'); });
    }

    hideTooltip(immediate = false) {
      if (!this.ui.tooltip) return;
      const doHide = () => { this.ui.tooltip.classList.remove('visible'); this.ui.tooltip.setAttribute('aria-hidden', 'true'); this.tooltipHideTimer = null; };
      if (immediate) return doHide();
      try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); } } catch {}
      this.tooltipHideTimer = setTimeout(doHide, this.tooltipHideDelay);
    }

    refreshTooltipForDot(dot) {
      const tip = this.ui.tooltip;
      if (!tip || !tip.classList.contains('visible')) return;
      let fullText = (dot.getAttribute('aria-label') || '').trim();
      try { const id = dot.dataset.targetIdx; if (id && this.starred.has(id)) fullText = `★ ${fullText}`; } catch {}

      // Add or remove 'ai-summary' class based on whether we're showing AI-generated text
      try {
        const id = dot.dataset.targetIdx;
        const marker = this.markers.find(m => m.id === id);
        if (marker && this.useSummarization && marker.aiSummary) {
          tip.classList.add('ai-summary');
        } else {
          tip.classList.remove('ai-summary');
        }
      } catch {}

      const p = this.computePlacementInfo(dot);
      const layout = this.truncateToThreeLines(fullText, p.width, true);
      tip.textContent = layout.text;
      this.placeTooltipAt(dot, p.placement, p.width, layout.height);
    }

    // Update tooltip text based on mouse position (hover-to-left feature)
    updateTooltipTextForDot(dot) {
      const tip = this.ui.tooltip;
      if (!tip || !tip.classList.contains('visible')) return;

      let fullText = (dot.getAttribute('aria-label') || '').trim();
      let isAISummary = false;
      try {
        const id = dot.dataset.targetIdx;
        const marker = this.markers.find(m => m.id === id);

        // Determine which text to show based on mouse position and AI mode
        if (marker) {
          // If user is hovering to the left and we're in AI mode, show original text
          if (this.useSummarization && this.isMouseOnLeft && marker.originalText) {
            fullText = marker.originalText;
            isAISummary = false; // Not showing AI summary when on left
          } else if (this.useSummarization && marker.aiSummary) {
            // Normal behavior: show AI summary when in AI mode
            isAISummary = true;
          }
        }

        if (id && this.starred.has(id)) fullText = `★ ${fullText}`;

        if (isAISummary) {
          tip.classList.add('ai-summary');
        } else {
          tip.classList.remove('ai-summary');
        }
      } catch {}

      const p = this.computePlacementInfo(dot);
      const layout = this.truncateToThreeLines(fullText, p.width, true);
      tip.textContent = layout.text;
      this.placeTooltipAt(dot, p.placement, p.width, layout.height);
    }

    // Phase 8: star persistence
    loadStars() {
      this.starred.clear();
      const cid = this.conversationId;
      if (!cid) return;
      try {
        const raw = localStorage.getItem(`geminiTimelineStars:${cid}`);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(id => this.starred.add(String(id)));
      } catch {}
    }
    saveStars() {
      const cid = this.conversationId;
      if (!cid) return;
      try { localStorage.setItem(`geminiTimelineStars:${cid}`, JSON.stringify(Array.from(this.starred))); } catch {}
    }
    toggleStar(turnId) {
      const id = String(turnId || '');
      if (!id) return;
      if (this.starred.has(id)) this.starred.delete(id); else this.starred.add(id);
      this.saveStars();
      const m = this.markers.find(mm => mm.id === id);
      if (m && m.dotElement) {
        m.starred = this.starred.has(id);
        try { m.dotElement.classList.toggle('starred', m.starred); m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false'); } catch {}
        try { this.refreshTooltipForDot(m.dotElement); } catch {}
      }
    }

    cancelLongPress() {
      if (this.longPressTimer) { try { clearTimeout(this.longPressTimer); } catch {} this.longPressTimer = null; }
      if (this.pressTargetDot) { try { this.pressTargetDot.classList.remove('holding'); } catch {} }
      this.pressTargetDot = null;
      this.pressStartPos = null;
    }

    // --- AI Summarization Methods ---

    // Save AI summarization state for current conversation
    saveSummarizationState() {
      const cid = this.conversationId;
      if (!cid) return;
      try {
        const state = {
          summarizerState: this.summarizerState,
          useSummarization: this.useSummarization,
          summaries: {}
        };
        // Save AI summaries for each marker
        for (const marker of this.markers) {
          if (marker.aiSummary) {
            state.summaries[marker.id] = marker.aiSummary;
          }
        }
        localStorage.setItem(`geminiTimelineSummaries:${cid}`, JSON.stringify(state));
      } catch (error) {
        console.debug('[GeminiTimeline] Failed to save summarization state:', error);
      }
    }

    // Load AI summarization state for current conversation
    async loadSummarizationState() {
      const cid = this.conversationId;
      if (!cid) return;
      try {
        const raw = localStorage.getItem(`geminiTimelineSummaries:${cid}`);
        if (!raw) return;

        const state = JSON.parse(raw);
        if (!state) return;

        // Restore state
        this.summarizerState = state.summarizerState || 'idle';
        this.useSummarization = state.useSummarization || false;

        // Restore AI summaries to markers (markers may not be built yet, so we'll apply after recalc)
        if (state.summaries && typeof state.summaries === 'object') {
          this._pendingSummaries = state.summaries;
        }

        // Update button UI to reflect restored state
        this.updateSummarizerButtonUI();
      } catch (error) {
        console.error('[GeminiTimeline] Failed to load summarization state:', error);
      }
    }

    // Update summarizer button UI based on current state
    updateSummarizerButtonUI() {
      if (!this.ui.summarizerButton) return;

      const svg = this.ui.summarizerButton.querySelector('svg');
      const progressText = this.ui.summarizerButton.querySelector('.progress-text');

      try {
        // Remove all state classes first
        this.ui.summarizerButton.classList.remove('idle', 'processing', 'completed', 'original');

        // Hide progress text by default
        if (progressText) progressText.style.display = 'none';
        if (svg) svg.style.display = 'block';

        if (this.summarizerState === 'completed') {
          this.ui.summarizerButton.classList.add('completed');
          this.ui.summarizerButton.setAttribute('title', 'Switch to original text');
          if (svg) {
            svg.innerHTML = `<path d="M20 6L9 17l-5-5"/>`;
          }
        } else if (this.summarizerState === 'original') {
          this.ui.summarizerButton.classList.add('original');
          this.ui.summarizerButton.setAttribute('title', 'Switch to AI summaries');
          if (svg) {
            svg.innerHTML = `<path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>`;
          }
        } else {
          // idle state
          this.ui.summarizerButton.classList.add('idle');
          this.ui.summarizerButton.setAttribute('title', 'Generate AI summaries');
          if (svg) {
            svg.innerHTML = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              <path d="M8 10h8M8 14h4"/>`;
          }
        }
      } catch (error) {
        console.debug('[GeminiTimeline] Failed to update button UI:', error);
      }
    }

    // Update incremental summarize button (shows count of unsummarized markers)
    updateIncrementalSummarizeButton() {
      // Count markers that don't have AI summaries
      const unsummarizedCount = this.markers.filter(m => !m.aiSummary).length;
      const summarizedCount = this.markers.filter(m => m.aiSummary).length;

      // Only show if:
      // 1. We've completed at least one full summarization (state is 'completed' or 'original')
      // 2. There are some markers WITH AI summaries (meaning we did summarize before)
      // 3. There are NEW markers without AI summaries
      const shouldShow = (this.summarizerState === 'completed' || this.summarizerState === 'original')
                        && summarizedCount > 0
                        && unsummarizedCount > 0;

      if (!this.ui.incrementalButton || !this.ui.summarizerButton) return;

      try {
        if (shouldShow) {
          // Position button to the right of summarizer button (closer to timeline bar), vertically centered
          const summarizerRect = this.ui.summarizerButton.getBoundingClientRect();
          this.ui.incrementalButton.style.top = `${summarizerRect.top + (summarizerRect.height / 2) - 9}px`; // 9 = half of button height (18px)
          this.ui.incrementalButton.style.left = `${summarizerRect.right + 6}px`; // 6px gap from summarizer button

          // Update the count badge
          const badge = this.ui.incrementalButton.querySelector('.count-badge');
          if (badge) {
            badge.textContent = unsummarizedCount;
          }
          this.ui.incrementalButton.style.display = 'flex';
          this.ui.incrementalButton.setAttribute('title', `Summarize ${unsummarizedCount} new message${unsummarizedCount > 1 ? 's' : ''}`);
        } else {
          this.ui.incrementalButton.style.display = 'none';
        }
      } catch (error) {
        console.debug('[GeminiTimeline] Failed to update incremental summarize button:', error);
      }
    }

    async applySummarizationToAllMarkers() {
      if (!window.promptManager || !window.promptManager.isAvailable) {
        console.warn('[GeminiTimeline] Prompt API not available');
        alert('AI Prompt API is not available. Make sure you are using Chrome with the AI features enabled.');
        return;
      }

      if (this.isSummarizing) return;

      this.isSummarizing = true;
      this.summarizerState = 'processing';

      const progressText = this.ui.summarizerButton?.querySelector('.progress-text');
      const svg = this.ui.summarizerButton?.querySelector('svg');

      // Show processing state on button
      if (this.ui.summarizerButton) {
        try {
          this.ui.summarizerButton.classList.remove('idle', 'completed', 'original');
          this.ui.summarizerButton.classList.add('processing');
          this.ui.summarizerButton.setAttribute('disabled', 'true');
          this.ui.summarizerButton.setAttribute('title', 'Processing summaries...');
          // Hide icon, show percentage
          if (svg) svg.style.display = 'none';
          if (progressText) {
            progressText.style.display = 'block';
            progressText.textContent = '0%';
          }
        } catch {}
      }

      try {
        // Identify markers that need summarization (don't have AI summary yet)
        const markersNeedingSummary = [];
        const markerIndices = [];

        for (let i = 0; i < this.markers.length; i++) {
          if (!this.markers[i].aiSummary) {
            markersNeedingSummary.push(this.markers[i]);
            markerIndices.push(i);
          }
        }

        const totalToProcess = markersNeedingSummary.length;

        if (totalToProcess === 0) {
          this.useSummarization = true;
          this.summarizerState = 'completed';
          this.saveSummarizationState();

          // Update button immediately
          if (this.ui.summarizerButton) {
            try {
              this.ui.summarizerButton.classList.remove('processing');
              this.ui.summarizerButton.classList.add('completed');
              this.ui.summarizerButton.removeAttribute('disabled');
              this.ui.summarizerButton.setAttribute('title', 'Switch to original text');
              if (svg) {
                svg.style.display = 'block';
                svg.innerHTML = `<path d="M20 6L9 17l-5-5"/>`;
              }
              if (progressText) {
                progressText.style.display = 'none';
              }
            } catch {}
          }
          this.isSummarizing = false;
          return;
        }

        let completedCount = 0;

        // Process only new markers that need summarization
        for (let i = 0; i < markersNeedingSummary.length; i++) {
          const marker = markersNeedingSummary[i];
          const originalIndex = markerIndices[i];

          try {
            const summary = await window.promptManager.summarize(marker.originalText || marker.summary);

            // Update the marker with AI summary
            marker.aiSummary = summary;
            marker.summary = summary;

            // Update dot's aria-label if it exists
            if (marker.dotElement) {
              try {
                marker.dotElement.setAttribute('aria-label', summary);
              } catch {}
            }

            completedCount++;
          } catch (error) {
            console.warn('[GeminiTimeline] Failed to summarize marker', originalIndex, error);
            completedCount++;
          }

          // Update progress percentage
          const percentage = Math.round((completedCount / totalToProcess) * 100);
          if (progressText) {
            progressText.textContent = `${percentage}%`;
          }
        }

        this.useSummarization = true;
        this.summarizerState = 'completed';

        // Save summarization state to localStorage
        this.saveSummarizationState();

        // Update button to completed state (green with checkmark)
        if (this.ui.summarizerButton) {
          try {
            this.ui.summarizerButton.classList.remove('processing');
            this.ui.summarizerButton.classList.add('completed');
            this.ui.summarizerButton.removeAttribute('disabled');
            this.ui.summarizerButton.setAttribute('title', 'Switch to original text');
            // Show checkmark icon
            if (svg) {
              svg.style.display = 'block';
              svg.innerHTML = `<path d="M20 6L9 17l-5-5"/>`;
            }
            if (progressText) {
              progressText.style.display = 'none';
            }
          } catch {}
        }

        // Hide incremental button since all markers are now summarized
        this.updateIncrementalSummarizeButton();

        // Force tooltip refresh if visible
        try {
          if (this.ui.tooltip?.classList.contains('visible')) {
            const currentDot = this.timelineBar?.querySelector('.timeline-dot:hover, .timeline-dot:focus');
            if (currentDot) {
              this.refreshTooltipForDot(currentDot);
            }
          }
        } catch {}

      } catch (error) {
        console.debug('[GeminiTimeline] Summarization failed:', error);
        this.summarizerState = 'idle';

        // Reset button state on error
        if (this.ui.summarizerButton) {
          try {
            this.ui.summarizerButton.classList.remove('processing', 'completed');
            this.ui.summarizerButton.removeAttribute('disabled');
            this.ui.summarizerButton.setAttribute('title', 'Generate AI summaries');
            if (svg) {
              svg.style.display = 'block';
              svg.innerHTML = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <path d="M8 10h8M8 14h4"/>`;
            }
            if (progressText) {
              progressText.style.display = 'none';
            }
          } catch {}
        }
      } finally {
        this.isSummarizing = false;
      }
    }

    switchToOriginalText() {
      // Update all markers to use original text
      for (let i = 0; i < this.markers.length; i++) {
        const marker = this.markers[i];
        marker.summary = marker.originalText;

        // Update dot's aria-label if it exists
        if (marker.dotElement) {
          try {
            marker.dotElement.setAttribute('aria-label', marker.originalText);
          } catch {}
        }
      }

      this.useSummarization = false;
      this.summarizerState = 'original';

      // Save summarization state to localStorage
      this.saveSummarizationState();

      // Update button state
      const svg = this.ui.summarizerButton?.querySelector('svg');
      if (this.ui.summarizerButton) {
        try {
          this.ui.summarizerButton.classList.remove('completed');
          this.ui.summarizerButton.classList.add('original');
          this.ui.summarizerButton.setAttribute('title', 'Switch to AI summaries');
          // Show original text icon (undo icon)
          if (svg) {
            svg.innerHTML = `<path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>`;
          }
        } catch {}
      }

      // Force tooltip refresh if visible
      try {
        if (this.ui.tooltip?.classList.contains('visible')) {
          const currentDot = this.timelineBar?.querySelector('.timeline-dot:hover, .timeline-dot:focus');
          if (currentDot) {
            this.refreshTooltipForDot(currentDot);
          }
        }
      } catch {}
    }

    switchToAISummaries() {
      // Update all markers to use AI summaries (already cached)
      for (let i = 0; i < this.markers.length; i++) {
        const marker = this.markers[i];
        if (marker.aiSummary) {
          marker.summary = marker.aiSummary;

          // Update dot's aria-label if it exists
          if (marker.dotElement) {
            try {
              marker.dotElement.setAttribute('aria-label', marker.aiSummary);
            } catch {}
          }
        }
      }

      this.useSummarization = true;
      this.summarizerState = 'completed';

      // Save summarization state to localStorage
      this.saveSummarizationState();

      // Update button back to completed state
      const svg = this.ui.summarizerButton?.querySelector('svg');
      if (this.ui.summarizerButton) {
        try {
          this.ui.summarizerButton.classList.remove('original');
          this.ui.summarizerButton.classList.add('completed');
          this.ui.summarizerButton.setAttribute('title', 'Switch to original text');
          // Show checkmark icon
          if (svg) {
            svg.innerHTML = `<path d="M20 6L9 17l-5-5"/>`;
          }
        } catch {}
      }

      // Force tooltip refresh if visible
      try {
        if (this.ui.tooltip?.classList.contains('visible')) {
          const currentDot = this.timelineBar?.querySelector('.timeline-dot:hover, .timeline-dot:focus');
          if (currentDot) {
            this.refreshTooltipForDot(currentDot);
          }
        }
      } catch {}
    }
  }

  // --- Bootstrap wiring (Phase 1) ---
  let timelineActive = true;   // global switch
  let providerEnabled = true;  // gemini provider switch
  let manager = null;
  let currentUrl = location.href;
  let routeListenersAttached = false;
  let routeCheckIntervalId = null;
  let initialObserver = null;
  let pageObserver = null;
  let initTimerId = null;

  function initializeTimeline() {
    if (manager) { try { manager.destroy(); } catch {} manager = null; }
    // Clean any leftovers
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
    manager = new GeminiTimelineScaffold();
    manager.init().catch(err => console.debug('[GeminiTimeline] init failed (Phase 1–3):', err));
  }

  function handleUrlChange() {
    if (location.href === currentUrl) return;
    try { if (initTimerId) { clearTimeout(initTimerId); initTimerId = null; } } catch {}
    currentUrl = location.href;
    if (manager) { try { manager.destroy(); } catch {} manager = null; }
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
    const enabled = (timelineActive && providerEnabled);
    if (isConversationRouteGemini() && enabled) {
      initTimerId = setTimeout(() => {
        initTimerId = null;
        // Only init when we do see a user bubble (guarded in init too)
        if (isConversationRouteGemini() && (timelineActive && providerEnabled)) initializeTimeline();
      }, 300);
    } else {
      // keep observers minimal; nothing else to do off-route
    }
  }

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

  // Bootstrap when first user bubble appears; then manage SPA transitions
  try {
    initialObserver = new MutationObserver(() => {
      if (document.querySelector(SEL_USER_BUBBLE)) {
        if (isConversationRouteGemini() && (timelineActive && providerEnabled)) initializeTimeline();
        try { initialObserver.disconnect(); } catch {}
        pageObserver = new MutationObserver(handleUrlChange);
        try { pageObserver.observe(document.body, { childList: true, subtree: true }); } catch {}
        attachRouteListenersOnce();
      }
    });
    initialObserver.observe(document.body, { childList: true, subtree: true });
  } catch {}

  attachRouteListenersOnce();

  // Storage toggles (global and per-provider)
  try {
    if (chrome?.storage?.local) {
      chrome.storage.local.get({ timelineActive: true, timelineProviders: {} }, (res) => {
        try { timelineActive = !!res.timelineActive; } catch { timelineActive = true; }
        try {
          const map = res.timelineProviders || {};
          providerEnabled = (typeof map.gemini === 'boolean') ? map.gemini : true;
        } catch { providerEnabled = true; }
        const enabled = timelineActive && providerEnabled;
        if (!enabled) {
          if (manager) { try { manager.destroy(); } catch {} manager = null; }
          try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
          try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
          try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
        } else if (isConversationRouteGemini() && document.querySelector(SEL_USER_BUBBLE)) {
          initializeTimeline();
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes) return;
        let changed = false;
        if ('timelineActive' in changes) { timelineActive = !!changes.timelineActive.newValue; changed = true; }
        if ('timelineProviders' in changes) {
          try {
            const map = changes.timelineProviders.newValue || {};
            providerEnabled = (typeof map.gemini === 'boolean') ? map.gemini : true;
            changed = true;
          } catch {}
        }
        if ('aiModeEnabled' in changes) {
          const newAiModeEnabled = typeof changes.aiModeEnabled.newValue === 'boolean' ? changes.aiModeEnabled.newValue : true;
          // Update AI mode and show/hide AI buttons
          if (manager) {
            const oldAiModeEnabled = manager.aiModeEnabled;
            manager.aiModeEnabled = newAiModeEnabled;

            if (oldAiModeEnabled !== newAiModeEnabled) {
              // Show or hide AI summarizer buttons
              if (newAiModeEnabled) {
                // Reinitialize Prompt API when AI mode is turned back on
                (async () => {
                  try {
                    if (window.promptManager) {
                      await window.promptManager.initialize();
                    }
                  } catch (error) {
                    console.error('[GeminiTimeline] Failed to reinitialize prompt manager:', error);
                  }
                })();

                // Re-inject AI buttons if they don't exist
                if (!manager.ui.summarizerButton) {
                  manager.injectUI();
                }
                if (manager.ui.summarizerButton) {
                  manager.ui.summarizerButton.style.display = '';
                }
                if (manager.ui.incrementalButton) {
                  manager.ui.incrementalButton.style.display = manager.ui.incrementalButton.dataset.shouldShow === 'true' ? '' : 'none';
                }
                // If we have AI summaries, switch back to them
                if (manager.summarizerState === 'completed' || manager.summarizerState === 'original') {
                  manager.switchToAISummaries();
                }
              } else {
                // Hide AI buttons and switch to original text
                if (manager.ui.summarizerButton) {
                  manager.ui.summarizerButton.style.display = 'none';
                }
                if (manager.ui.incrementalButton) {
                  manager.ui.incrementalButton.style.display = 'none';
                }
                // Force all markers to show original text
                manager.useSummarization = false;
                for (let i = 0; i < manager.markers.length; i++) {
                  const marker = manager.markers[i];
                  marker.summary = marker.originalText;
                  if (marker.dotElement) {
                    try {
                      marker.dotElement.setAttribute('aria-label', marker.originalText);
                    } catch {}
                  }
                }
                // Update tooltip if visible
                try {
                  if (manager.ui.tooltip?.classList.contains('visible')) {
                    const currentDot = manager.timelineBar?.querySelector('.timeline-dot:hover, .timeline-dot:focus');
                    if (currentDot) {
                      manager.refreshTooltipForDot(currentDot);
                    }
                  }
                } catch {}
              }
            }
          }
        }
        if (!changed) return;
        const enabled = timelineActive && providerEnabled;
        if (!enabled) {
          if (manager) { try { manager.destroy(); } catch {} manager = null; }
          try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
          try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
          try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
        } else if (isConversationRouteGemini() && document.querySelector(SEL_USER_BUBBLE)) {
          initializeTimeline();
        }
      });
    }
  } catch {}

  try { console.debug('[GeminiTimeline] content-gemini.js loaded (Phase 1–3)'); } catch {}
})();
      
