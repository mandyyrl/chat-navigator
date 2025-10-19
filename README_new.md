<p align="center">
  <img src="public/preview.png" alt="Squirrel Jump Preview">
</p>

# 🕰 Squirrel Jump - AI Chat Timeline Navigator

Chrome’s built-in AI Summarizer now powers the timeline, turning every user prompt into a crisp headline you can scan at a glance.

## 🚀 What's New in This Branch

- Leverages Google Chrome’s on-device `Summarizer` API to headline every chat question in the timeline
- Adds a floating “Generate AI summaries” control and an incremental refresh button for new messages
- Caches summaries locally so repeat visits feel instant and offline-friendly
- Falls back to smart truncation whenever the Summarizer API is unavailable

## 📖 Overview

Squirrel Jump augments your ChatGPT, DeepSeek, and Google Gemini conversations with an interactive timeline that keeps long threads manageable. Clickable markers mirror each exchange in the conversation, while AI-generated headlines help you understand context without scrolling.

## 🤖 Chrome Summarizer Integration

### Requirements

- Chrome 128+ (Dev/Canary recommended for the latest AI features)
- `chrome://flags/#optimization-guide-on-device-model` enabled so Chrome can download the on-device model (~1 GB)
- Sufficient local storage to cache model files and timeline summaries
- Extension permissions granted for the chat domains you want to summarize

### How Summaries Are Generated

- The first time you tap the AI button, Chrome may download the summarizer model; progress is shown on the button
- Headline-style summaries are produced locally with `Summarizer.create({ type: 'headline', length: 'short' })`
- Summaries are cached per message content hash, so revisiting the same thread is instant
- If the API throws an error or is unsupported, the extension gracefully falls back to trimmed message text

### Using Summaries in the Timeline

- Click the sparkle-style button floating beside the timeline to generate or toggle AI headlines
- A smaller “Summarize new messages” badge appears when fresh messages arrive; tap it to headline just the new items
- Toggle back to the original message text at any point if you prefer the raw content
- All controls work independently per site, so you can enable summaries on ChatGPT but leave DeepSeek untouched

## 🔒 Privacy & Local Processing

- Summarization never leaves your device; all prompts stay inside Chrome’s sandboxed AI runtime
- Cached summaries remain in local extension storage and can be cleared by Chrome whenever you reset site data
- No additional external APIs, servers, or analytics are contacted by the summarizer flow

## 🧩 Installation

### Recommended: Chrome Web Store

Install the published build for automatic updates: https://chromewebstore.google.com/detail/ickndngbbabdllekmflaaogkpmnloalg

### Manual (Load Unpacked)

1. Clone or download this repository and locate the `extension/` directory
2. Open `chrome://extensions/` and enable Developer Mode
3. Choose “Load unpacked” and select the `extension/` folder
4. Open ChatGPT, DeepSeek, or Gemini to see the timeline and AI headlines in action

## 💡 Tips & Limitations

- Summaries currently output in English; they fall back to the original message text for other languages
- Message length matters: extremely short prompts may appear unchanged even after summarization
- Ensure Chrome stays open while the model downloads; interrupting the process can postpone availability
- If you disable the feature per site in the popup, the summarizer button hides until you re-enable it

## 🙏 Credits & License

Based on the excellent “ChatGPT Conversation Timeline” project by @Reborn14 and modernized for Chrome’s AI stack. Released under the MIT License — see `LICENSE` for details.
