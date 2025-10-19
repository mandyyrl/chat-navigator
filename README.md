<p align="center">
  <img src="public/preview.png" alt="Plugin Preview">
</p>

# 🕰 Squirrel Jump - AI Chat Timeline Navigator

> 🇨🇳 查看中文版：[README.zh-CN.md](./README.zh-CN.md)

## 🙏 Acknowledgement

This project is largely based on [ChatGPT Conversation Timeline](https://github.com/Reborn14/chatgpt-conversation-timeline) by [@Reborn14](https://github.com/Reborn14), which was inspired by the timeline navigation interface from Google AI Studio. We extend our gratitude for the excellent foundation and design.

---

## 📖 Overview

Squirrel Jump enhances your AI chat experience by adding a smart scrollbar and interactive timeline to your conversations on **ChatGPT**, **DeepSeek**, and **Google Gemini**. Like a squirrel jumping from branch to branch, you can effortlessly navigate through your conversation history with a single click.

This extension provides:
- **Interactive Timeline Navigation**: A visual timeline bar on the right side of your chat interface with clickable markers for each message
- **AI-Powered Summarization**: Leverage Chrome's built-in AI Summarizer API to generate concise previews of messages
- **Enhanced Navigation**: Quickly understand conversation structure and jump to any point instantly

---

## 🤖 Built-in AI Summarizer API

One of the standout features of Squirrel Jump is its integration with **Chrome's Built-in AI Summarizer API**. This experimental API allows the extension to:

- **Generate Message Previews**: Automatically create concise headlines for each message on the timeline
- **On-Device Processing**: All summarization happens locally in your browser using Chrome's built-in AI model - no data is sent to external servers
- **Incremental Summarization**: Summarize new messages as they appear in the conversation
- **Smart Caching**: Summaries are cached to improve performance and reduce redundant processing

### How It Works

The extension uses the global `Summarizer` API (available in Chrome with AI features enabled):

The summarizer automatically downloads the required AI model on first use (if not already available) and processes all content locally on your device.

### Requirements for AI Features

- Chrome 127+ (Canary/Dev channel recommended for latest features)
- Built-in AI features enabled (chrome://flags/#optimization-guide-on-device-model)
- Sufficient disk space for the AI model (~1GB)

> **Note**: Even without the AI Summarizer API, the extension still works perfectly - it will fall back to showing truncated message text.

---

## ✨ Features

- **🌐 Multi-Platform Support**: Works seamlessly on **ChatGPT**, **DeepSeek**, and **Google Gemini**
- **🤖 AI-Powered Summaries**: Uses Chrome's built-in Summarizer API to generate concise message previews (when available)
- **📍 Clickable Markers**: Instantly jump to any point in the conversation via clickable markers for each message
- **⭐ Star Messages**: Long-press a message to star it, and see it highlighted on the timeline. Stars are saved locally and persist across sessions
- **🌗 Auto-Theming**: Automatically adapts to the light/dark theme of each platform
- **⚙️ Full Control**: A simple popup menu allows you to enable or disable the timeline globally or for each site individually
- **🌍 Bilingual Support**: Switch between English and Chinese in the popup interface

---

## 🧩 How to Install (Chrome / Edge)

### ✅ Recommended: Install from Chrome Web Store

👉 [Install from Chrome Web Store](https://chromewebstore.google.com/detail/ickndngbbabdllekmflaaogkpmnloalg?utm_source=item-share-cb)

---

### 🛠 Manual Installation (Get new features faster)

This method allows you to use the latest version immediately, without waiting for the Chrome Web Store review process.

1. Download this repository and locate the `extension/` folder.
2. In your browser, go to: `chrome://extensions/`
3. Enable “Developer Mode” (top right).
4. Click **“Load unpacked”**.
5. Select the `extension/` folder to install.

> After installation, open any ChatGPT, DeepSeek, or Gemini conversation and the timeline will appear on the right.

## 🔗 Related Projects

This project builds upon the excellent work of the open-source community. Special thanks to [@Reborn14](https://github.com/Reborn14) for the original implementation that inspired this enhanced version.

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE).