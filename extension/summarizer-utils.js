/**
 * Chrome Built-in AI Summarizer Utility
 * Provides shared summarization functionality for timeline nodes across all platforms
 */

class SummarizerManager {
  constructor() {
    this.summarizerInstance = null;
    this.isAvailable = false;
    this.isInitializing = false;
    this.initPromise = null;
    this.summaryCache = new Map(); // Cache summaries by content hash
    this.downloadProgress = 0;
  }

  /**
   * Check if Summarizer API is available in the browser
   * Uses the new global Summarizer API (updated Jan 2025)
   */
  isSupported() {
    return typeof Summarizer !== 'undefined';
  }

  /**
   * Check availability and configuration support
   * Returns: 'available', 'downloadable', 'downloading', or 'no'
   */
  async checkAvailability() {
    if (!this.isSupported()) {
      console.warn('[SummarizerUtils] Summarizer API not found');
      return 'no';
    }

    try {
      console.log('[SummarizerUtils] Checking Summarizer.availability()...');
      const availability = await Summarizer.availability();
      console.log('[SummarizerUtils] Availability result:', availability);

      // availability returns: 'available', 'downloadable', 'downloading', or 'no'
      return availability;
    } catch (error) {
      console.error('[SummarizerUtils] Availability check failed:', error);
      return 'no';
    }
  }

  /**
   * Initialize the summarizer instance
   * Uses 'headline' type for concise timeline node labels
   */
  async initialize() {
    // Return existing initialization promise if already initializing
    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    // Return immediately if already initialized
    if (this.isAvailable && this.summarizerInstance) {
      return true;
    }

    this.isInitializing = true;

    this.initPromise = (async () => {
      try {
        console.log('[SummarizerUtils] Starting initialization...');

        if (!this.isSupported()) {
          console.warn('[SummarizerUtils] Summarizer API not supported - typeof Summarizer:', typeof Summarizer);
          this.isAvailable = false;
          return false;
        }

        console.log('[SummarizerUtils] Summarizer API found, checking availability...');

        // Check availability
        const availability = await this.checkAvailability();

        if (availability === 'no' || availability === 'unavailable') {
          console.warn('[SummarizerUtils] Summarizer not available:', availability);
          this.isAvailable = false;
          return false;
        }

        console.log('[SummarizerUtils] Availability status:', availability);

        // Create summarizer with headline type for concise labels
        const options = {
          type: 'headline',
          format: 'plain-text',
          length: 'short',
          outputLanguage: 'en' // Specify output language to avoid warning
        };

        console.log('[SummarizerUtils] Creating Summarizer with options:', options);

        // Create the summarizer using global Summarizer.create() (will download model if needed)
        this.summarizerInstance = await Summarizer.create(options);
        this.isAvailable = true;

        console.log('[SummarizerUtils] ✅ Summarizer initialized successfully!');
        return true;

      } catch (error) {
        console.error('[SummarizerUtils] ❌ Failed to initialize summarizer:', error);
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
   * Summarize text to a concise headline
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

    // Check cache first
    const cacheKey = this.hashText(normalizedText);
    if (this.summaryCache.has(cacheKey)) {
      return this.summaryCache.get(cacheKey);
    }

    // Fallback to truncated original text if summarizer not available
    if (!this.isAvailable || !this.summarizerInstance) {
      const fallback = this.truncateText(normalizedText, options.maxLength || 100);
      this.summaryCache.set(cacheKey, fallback);
      return fallback;
    }

    try {
      // Use the summarizer to generate headline
      const summary = await this.summarizerInstance.summarize(normalizedText, {
        context: options.context || 'Generate a concise headline for a chat message'
      });

      const trimmedSummary = String(summary || '').trim();
      const result = trimmedSummary || this.truncateText(normalizedText, options.maxLength || 100);

      // Cache the result
      this.summaryCache.set(cacheKey, result);

      return result;

    } catch (error) {
      console.debug('[SummarizerUtils] Summarization failed, using fallback:', error);
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
   * Destroy the summarizer instance and clean up
   */
  async destroy() {
    if (this.summarizerInstance) {
      try {
        await this.summarizerInstance.destroy();
      } catch (error) {
        console.debug('[SummarizerUtils] Error destroying summarizer:', error);
      }
      this.summarizerInstance = null;
    }
    this.isAvailable = false;
    this.isInitializing = false;
    this.initPromise = null;
    this.clearCache();
  }
}

// Create a singleton instance
const summarizerManager = new SummarizerManager();

// Export for use in content scripts
if (typeof window !== 'undefined') {
  window.summarizerManager = summarizerManager;
}
