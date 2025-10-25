/**
 * Chrome Built-in AI Prompt Utility
 * Provides shared prompt-based summarization functionality for timeline nodes across all platforms
 * Uses Prompt API instead of Summarizer API for better performance and control
 */

class PromptManager {
  constructor() {
    this.promptSession = null;
    this.isAvailable = false;
    this.isInitializing = false;
    this.initPromise = null;
    this.summaryCache = new Map(); // Cache summaries by content hash

    // Configuration for summarization
    this.MIN_CHARS_FOR_SUMMARY = 50; // Only summarize texts longer than this
    this.TARGET_SUMMARY_LENGTH = 60; // Target length - aim for this
    this.MAX_SUMMARY_LENGTH = 90; // Hard limit - only truncate if over this
    this.MAX_TOKENS = 25; // Token limit for generation (allow room for complete sentences)
    this.TEMPERATURE = 0.2; // Very low temperature for focused, consistent output
    this.TOP_P = 0.8;
    this.TOP_K = 40;

    // System prompt to guide the AI for concise summaries
    this.SYSTEM_PROMPT = `This is a part of the project: chat navigator that helps users navigate different messages in a chat with AI chatbot.
    It needs to summarize and condense the user input message for easier navigation (instead of first few words of the request message).
    Your job is to summarize what the user is REQUESTING from the AI chatbot. Describe the task/question, DON'T answer the question itself and DON'T give actual output.
    Maximum 50-60 characters. Ultra-concise, plain text.

Examples (target ~60 chars, max 80 chars):
Input: "Assume a couple decides to keep having children until they have one of each sex. What is the expected number of children?"
Output: Expected kids for couple until one of each sex?

Input: "plan build a chrome extension about summarizing chat history with ai and then into bullet points or mindmaps"
Output: Chrome ext: AI chat summary to bullets/mindmaps

Input: "write an email to my advisor that I hope him to help me fill the SSN application form"
Output: Email advisor for SSN form help

Input: "are there still bugs? why it said timed out"
Output: Bugs still exist? Why timed out?

Input: "write a prompt that can generate this image"
Output: Write prompt to generate image

Rules:
- Target ~60 characters, max 80-90 characters
- Describe the task/question directly, don't answer it
- NO meta-language like "User asks", "User wants", "Question about"
- Ultra-concise: use abbrevs (ext, API, etc)
- One line, plain text only
- No "Subject:", "Hi", PRD, or document-like phrases
- No asterisks, bold, markdown, backticks`;
  }

  /**
   * Check if Prompt API is available in the browser
   * Uses the new global LanguageModel API (updated Jan 2025)
   */
  isSupported() {
    return typeof LanguageModel !== 'undefined';
  }

  /**
   * Check availability of the Prompt API
   * Returns: 'available', 'downloadable', 'downloading', or 'no'
   */
  async checkAvailability() {
    if (!this.isSupported()) {
      console.warn('[PromptUtils] LanguageModel API not found');
      return 'no';
    }

    try {
      console.log('[PromptUtils] Checking LanguageModel.availability()...');
      const availability = await LanguageModel.availability();
      console.log('[PromptUtils] Availability result:', availability);

      // availability returns: 'available', 'downloadable', 'downloading', or 'no'
      return availability;
    } catch (error) {
      console.error('[PromptUtils] Availability check failed:', error);
      return 'no';
    }
  }

  /**
   * Initialize the prompt session
   */
  async initialize() {
    // Return existing initialization promise if already initializing
    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    // Return immediately if already initialized
    if (this.isAvailable && this.promptSession) {
      return true;
    }

    this.isInitializing = true;

    this.initPromise = (async () => {
      try {
        console.log('[PromptUtils] Starting initialization...');

        if (!this.isSupported()) {
          console.warn('[PromptUtils] Prompt API not supported');
          this.isAvailable = false;
          return false;
        }

        console.log('[PromptUtils] Prompt API found, checking availability...');

        // Check availability
        const availability = await this.checkAvailability();

        if (availability === 'no' || availability === 'unavailable') {
          console.warn('[PromptUtils] Prompt API not available:', availability);
          this.isAvailable = false;
          return false;
        }

        console.log('[PromptUtils] Availability status:', availability);

        // Create prompt session with system prompt
        const options = {
          systemPrompt: this.SYSTEM_PROMPT,
          temperature: this.TEMPERATURE,
          topK: this.TOP_K
        };

        console.log('[PromptUtils] Creating LanguageModel session with options:', options);

        // Create the session (will download model if needed)
        this.promptSession = await LanguageModel.create(options);
        this.isAvailable = true;

        console.log('[PromptUtils] ✅ Prompt session initialized successfully!');
        return true;

      } catch (error) {
        console.error('[PromptUtils] ❌ Failed to initialize prompt session:', error);
        this.isAvailable = false;
        return false;
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Generate a simple hash from text for caching
   */
  hashText(text) {
    try {
      let hash = 0;
      const str = String(text || '').slice(0, 500); // Use first 500 chars for hash
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return hash.toString(36);
    } catch {
      return Math.random().toString(36).slice(2);
    }
  }

  /**
   * Summarize text to a concise, action-oriented phrase
   * @param {string} text - The text to summarize
   * @param {object} options - Optional parameters
   * @returns {Promise<string>} - The summary or original text (fallback)
   */
  async summarize(text, options = {}) {
    const normalizedText = String(text || '').trim();

    // Return empty for empty input
    if (!normalizedText) {
      return '';
    }

    // For short questions, use the original text as-is (no need to summarize)
    if (normalizedText.length <= this.MIN_CHARS_FOR_SUMMARY) {
      console.debug('[PromptUtils] Text is short enough, using original:', normalizedText.length, 'chars');
      return normalizedText;
    }

    // Check cache first
    const cacheKey = this.hashText(normalizedText);
    if (this.summaryCache.has(cacheKey)) {
      return this.summaryCache.get(cacheKey);
    }

    // Fallback to truncated original text if prompt session not available
    if (!this.isAvailable || !this.promptSession) {
      const fallback = this.truncateText(normalizedText, options.maxLength || 100);
      this.summaryCache.set(cacheKey, fallback);
      return fallback;
    }

    try {
      // Check for [IMAGE] or [*.pdf] prefix and strip it before summarization
      const hasImagePrefix = normalizedText.startsWith('[IMAGE]');
      const pdfPrefixMatch = normalizedText.match(/^\[([^\]]+\.pdf)\]\s*/i);
      const hasPdfPrefix = pdfPrefixMatch !== null;
      const pdfPrefix = hasPdfPrefix ? pdfPrefixMatch[1] : '';

      let textToSummarize = normalizedText;
      if (hasImagePrefix) {
        textToSummarize = normalizedText.slice(7).trim();
      } else if (hasPdfPrefix) {
        textToSummarize = normalizedText.slice(pdfPrefixMatch[0].length).trim();
      }

      // Construct the user prompt
      const userPrompt = `Summarize the request directly. Target ~60 chars, max 80 chars. Ultra-concise. Use abbrevs. Don't answer. Plain text only. Complete sentence, no ellipsis. No meta-language.

Text: ${textToSummarize}

Summary:`;

      // Use the prompt session to generate summary
      const summary = await this.promptSession.prompt(userPrompt, {
        maxTokens: this.MAX_TOKENS,
        topK: this.TOP_K
      });

      let trimmedSummary = String(summary || '').trim();

      // Remove any line breaks and extra whitespace
      trimmedSummary = trimmedSummary.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s+/g, ' ');

      // Remove any ellipsis the AI might have added - we want complete sentences
      trimmedSummary = trimmedSummary.replace(/[…\.]{1,3}$/g, '').trim();

      // Only truncate if way over the hard limit (90+ chars)
      if (trimmedSummary.length > this.MAX_SUMMARY_LENGTH) {
        // Find the last complete word before hard limit
        const lastSpace = trimmedSummary.lastIndexOf(' ', this.MAX_SUMMARY_LENGTH);
        if (lastSpace > this.MAX_SUMMARY_LENGTH * 0.7) {
          trimmedSummary = trimmedSummary.substring(0, lastSpace).trim();
        }
        // Otherwise keep it even if over - better complete than truncated
      }

      // Prepend [IMAGE] or [PDF] back if it was present
      let result = trimmedSummary || this.truncateText(textToSummarize, options.maxLength || 100);
      if (hasImagePrefix) {
        result = `[IMAGE] ${result}`;
      } else if (hasPdfPrefix) {
        result = `[${pdfPrefix}] ${result}`;
      }

      // Cache the result
      this.summaryCache.set(cacheKey, result);

      // Log the summary for debugging
      const hasSuspiciousEnding = normalizedText.endsWith('...') || normalizedText.endsWith('…');
      console.log('[PromptUtils] 📝 Original text (' + normalizedText.length + ' chars' + (hasSuspiciousEnding ? ' - WARNING: ends with ...' : '') + '):', normalizedText);
      console.log('[PromptUtils] ✅ Generated summary (' + result.length + ' chars):', result);

      return result;

    } catch (error) {
      console.debug('[PromptUtils] Summarization failed, using fallback:', error);
      const fallback = this.truncateText(normalizedText, options.maxLength || 100);
      this.summaryCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * Batch summarize multiple texts
   * @param {Array<string>} texts - Array of texts to summarize
   * @param {object} options - Optional parameters
   * @returns {Promise<Array<string>>} - Array of summaries
   */
  async summarizeBatch(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    // Process in parallel for better performance
    const promises = texts.map(text => this.summarize(text, options));
    return Promise.all(promises);
  }

  /**
   * Simple text truncation fallback
   */
  truncateText(text, maxLength = 100) {
    const str = String(text || '').replace(/\s+/g, ' ').trim();
    if (str.length <= maxLength) {
      return str;
    }
    return str.slice(0, maxLength).trimEnd() + '…';
  }

  /**
   * Clear the summary cache
   * Call this when changing conversations or when needed
   */
  clearCache() {
    this.summaryCache.clear();
  }

  /**
   * Destroy the prompt session and clean up
   */
  async destroy() {
    if (this.promptSession) {
      try {
        await this.promptSession.destroy();
      } catch (error) {
        console.debug('[PromptUtils] Error destroying prompt session:', error);
      }
      this.promptSession = null;
    }
    this.isAvailable = false;
    this.isInitializing = false;
    this.initPromise = null;
    this.clearCache();
  }
}

// Create a singleton instance
const promptManager = new PromptManager();

// Export for use in content scripts
if (typeof window !== 'undefined') {
  window.promptManager = promptManager;
}
