(() => {
  const q = (s, r=document) => r.querySelector(s);

  // Translation strings
  const translations = {
    en: {
      'header.title': 'Conversation Timeline',
      'language.code': 'EN',
      'section.websites': 'Websites',
      'github.text': 'Based On',
      'github.desc': 'This GitHub Project',
      'aria.globalToggle': 'Enable timeline for all sites',
      'aria.chatgptToggle': 'Enable ChatGPT timeline',
      'aria.geminiToggle': 'Enable Gemini timeline',
      'aria.deepseekToggle': 'Enable DeepSeek timeline',
      'aria.github': 'Based on this GitHub project'
    },
    zh: {
      'header.title': '会话时间轴',
      'language.code': '中文',
      'section.websites': '网站',
      'github.text': '基于',
      'github.desc': '此 GitHub 项目',
      'aria.globalToggle': '启用全部站点时间轴',
      'aria.chatgptToggle': '启用 ChatGPT 时间轴',
      'aria.geminiToggle': '启用 Gemini 时间轴',
      'aria.deepseekToggle': '启用 DeepSeek 时间轴',
      'aria.github': '基于此 GitHub 项目'
    }
  };

  let currentLang = 'en'; // Default to English

  const applyTranslations = (lang) => {
    const t = translations[lang] || translations.en;

    // Update text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (t[key]) {
        el.textContent = t[key];
      }
    });

    // Update aria-label attributes
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      if (t[key]) {
        el.setAttribute('aria-label', t[key]);
      }
    });

    // Update HTML lang attribute
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  };

  document.addEventListener('DOMContentLoaded', () => {
    const globalToggle = q('#globalToggle');
    const providerToggle = q('#provider-chatgpt-toggle');
    const deepseekToggle = q('#provider-deepseek-toggle');
    const geminiToggle = q('#provider-gemini-toggle');
    const langToggle = q('#langToggle');

    if (!globalToggle || !providerToggle || !deepseekToggle || !geminiToggle || !langToggle) return;

    const applyGlobal = (val) => {
      globalToggle.checked = !!val;
      document.body.classList.toggle('global-off', !val);
      providerToggle.disabled = !val;
      deepseekToggle.disabled = !val;
      geminiToggle.disabled = !val;
    };
    const applyProvider = (val) => {
      providerToggle.checked = !!val;
    };
    const applyDeepseek = (val) => {
      deepseekToggle.checked = !!val;
    };
    const applyGemini = (val) => {
      geminiToggle.checked = !!val;
    };

    // Read stored state (including language preference)
    try {
      chrome.storage.local.get({
        timelineActive: true,
        timelineProviders: {},
        language: 'en' // Default to English
      }, (res) => {
        const active = !!res.timelineActive;
        const chatgptVal = (res.timelineProviders && typeof res.timelineProviders.chatgpt === 'boolean') ? !!res.timelineProviders.chatgpt : true;
        const deepseekVal = (res.timelineProviders && typeof res.timelineProviders.deepseek === 'boolean') ? !!res.timelineProviders.deepseek : true;
        const geminiVal = (res.timelineProviders && typeof res.timelineProviders.gemini === 'boolean') ? !!res.timelineProviders.gemini : true;

        currentLang = res.language || 'en';
        applyTranslations(currentLang);

        applyGlobal(active);
        applyProvider(chatgptVal);
        applyDeepseek(deepseekVal);
        applyGemini(geminiVal);

        // Re-enable transitions after initial state is applied and painted
        requestAnimationFrame(() => { requestAnimationFrame(() => { try { document.body.classList.remove('boot'); } catch {} }); });
      });
    } catch {}

    // Language toggle
    langToggle.addEventListener('click', () => {
      currentLang = currentLang === 'en' ? 'zh' : 'en';
      applyTranslations(currentLang);
      try { chrome.storage.local.set({ language: currentLang }); } catch {}
    });

    // Write on change
    globalToggle.addEventListener('change', () => {
      const enabled = !!globalToggle.checked;
      try { chrome.storage.local.set({ timelineActive: enabled }); } catch {}
      document.body.classList.toggle('global-off', !enabled);
      providerToggle.disabled = !enabled;
      deepseekToggle.disabled = !enabled;
      geminiToggle.disabled = !enabled;
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

    deepseekToggle.addEventListener('change', () => {
      const enabled = !!deepseekToggle.checked;
      try {
        chrome.storage.local.get({ timelineProviders: {} }, (res) => {
          const map = res.timelineProviders || {};
          map.deepseek = enabled;
          try { chrome.storage.local.set({ timelineProviders: map }); } catch {}
        });
      } catch {}
    });

    geminiToggle.addEventListener('change', () => {
      const enabled = !!geminiToggle.checked;
      try {
        chrome.storage.local.get({ timelineProviders: {} }, (res) => {
          const map = res.timelineProviders || {};
          map.gemini = enabled;
          try { chrome.storage.local.set({ timelineProviders: map }); } catch {}
        });
      } catch {}
    });
  });
})();
