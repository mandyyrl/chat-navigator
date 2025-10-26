<p align="center">
  <img src="public/preview.png" alt="Squirrel Jump Preview">
</p>

# 🕰 Squirrel Jump - AI Chat Timeline Navigator

Chrome's built-in AI Prompt API now powers the timeline, turning every user prompt into a crisp headline you can scan at a glance.

## 🚀 What's New in This Branch

- Leverages Google Chrome's on-device `Prompt API` to headline every chat question in the timeline
- Adds a floating "Generate AI summaries" control and an incremental refresh button for new messages
- Caches summaries locally so repeat visits feel instant and offline-friendly
- Falls back to smart truncation whenever the Prompt API is unavailable

## 📖 Overview

Squirrel Jump augments your ChatGPT, DeepSeek, and Google Gemini conversations with an interactive timeline that keeps long threads manageable. Clickable markers mirror each exchange in the conversation, while AI-generated headlines help you understand context without scrolling.

## 🤖 Chrome Prompt API Integration

<a name="enable-chrome-ai"></a>
### 🔧 How to Enable Chrome's Built-in AI

To use AI-powered message summaries, you need to enable Chrome's built-in Gemini Nano and Prompt API:

**Step 1: Enable Gemini Nano and Prompt API**

1. Navigate to `chrome://flags/#optimization-guide-on-device-model` and select **"Enabled BypassPerfRequirement"**
   - This bypasses performance checks that might prevent Gemini Nano download
2. Go to `chrome://flags/#prompt-api-for-gemini-nano` and select **"Enabled"**
3. **Relaunch Chrome**

**Step 2: Verify Installation**

- After relaunch, Chrome will download the on-device model (~1 GB) in the background
- The first time you click the AI summarize button, you may see a download progress indicator
- Once ready, summaries will be generated instantly and locally on your device

### Requirements

- Chrome 138+ (Canary/Dev recommended for latest features)
- ~1 GB of disk space for the on-device model
- Sufficient local storage to cache model files and timeline summaries

### How Summaries Are Generated

- The first time you tap the AI button, Chrome may download the prompt model; progress is shown on the button
- Headline-style summaries are produced locally with Chrome's Prompt API
- Summaries are cached per message content hash, so revisiting the same thread is instant
- If the API throws an error or is unsupported, the extension gracefully falls back to trimmed message text

### Using Summaries in the Timeline

- Click the sparkle-style button floating beside the timeline to generate or toggle AI headlines
- A smaller "Summarize new messages" badge appears when fresh messages arrive; tap it to headline just the new items
- Toggle back to the original message text at any point if you prefer the raw content
- All controls work independently per site, so you can enable summaries on ChatGPT but leave DeepSeek untouched

## 🔒 Privacy & Local Processing

- Summarization never leaves your device; all prompts stay inside Chrome's sandboxed AI runtime
- Cached summaries remain in local extension storage and can be cleared by Chrome whenever you reset site data
- No additional external APIs, servers, or analytics are contacted by the summarizer flow

---

## ✨ Features

- **🌐 Multi-Platform Support**: Works seamlessly on **ChatGPT**, **DeepSeek**, and **Google Gemini**
- **🤖 AI-Powered Summaries**: Uses Chrome's built-in Prompt API to generate concise message previews (when available)
- **📍 Clickable Markers**: Instantly jump to any point in the conversation via clickable markers for each message
- **⭐ Star Messages**: Long-press a message to star it, and see it highlighted on the timeline. Stars are saved locally and persist across sessions
- **🌗 Auto-Theming**: Automatically adapts to the light/dark theme of each platform
- **⚙️ Full Control**: A simple popup menu allows you to enable or disable the timeline globally or for each site individually
- **🌍 Bilingual Support**: Switch between English and Chinese in the popup interface

---

## 🧩 How to Install (Chrome / Edge)

### 🛠 Manual Installation

This method allows you to use the latest version immediately, without waiting for the Chrome Web Store review process.

1. Download this repository and locate the `extension/` folder.
2. In your browser, go to: `chrome://extensions/`
3. Enable “Developer Mode” (top right).
4. Click **“Load unpacked”**.
5. Select the `extension/` folder to install.

> After installation, open any ChatGPT, DeepSeek, or Gemini conversation and the timeline and summarizing button will appear on the right.

## 🔗 Related Projects

This project builds upon the excellent work of the open-source community. Special thanks to [@Reborn14](https://github.com/Reborn14) for the original implementation that inspired this version.

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE).