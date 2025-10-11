(() => {
  const q = (s, r=document) => r.querySelector(s);
  document.addEventListener('DOMContentLoaded', () => {
    const globalToggle = q('#globalToggle');
    const providerToggle = q('#provider-chatgpt-toggle');
    if (!globalToggle || !providerToggle) return;

    const applyGlobal = (val) => {
      globalToggle.checked = !!val;
      document.body.classList.toggle('global-off', !val);
      providerToggle.disabled = !val;
    };
    const applyProvider = (val) => {
      providerToggle.checked = !!val;
    };

    // Read stored state (new keys only)
    try {
      chrome.storage.local.get({ timelineActive: true, timelineProviders: {} }, (res) => {
        const active = !!res.timelineActive;
        const chatgptVal = (res.timelineProviders && typeof res.timelineProviders.chatgpt === 'boolean')
          ? !!res.timelineProviders.chatgpt
          : true;
        applyGlobal(active);
        applyProvider(chatgptVal);
        // Re-enable transitions after initial state is applied and painted
        requestAnimationFrame(() => { requestAnimationFrame(() => { try { document.body.classList.remove('boot'); } catch {} }); });
      });
    } catch {}

    // Write on change
    globalToggle.addEventListener('change', () => {
      const enabled = !!globalToggle.checked;
      try { chrome.storage.local.set({ timelineActive: enabled }); } catch {}
      document.body.classList.toggle('global-off', !enabled);
      providerToggle.disabled = !enabled;
    });

    providerToggle.addEventListener('change', () => {
      const enabled = !!providerToggle.checked;
      try {
        chrome.storage.local.get({ timelineProviders: {} }, (res) => {
          const map = res.timelineProviders || {};
          map.chatgpt = enabled;
          try { chrome.storage.local.set({ timelineProviders: map }); } catch {}
        });
      } catch {}
    });
  });
})();
