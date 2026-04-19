# CrofAI Provider for GitHub Copilot

> **Community extension** — not affiliated with or officially supported by CrofAI.

**Powerful models. Crazy cheap pricing.** — directly inside GitHub Copilot Chat.

CrofAI gives you access to the best open-weight models at the cheapest prices on the market. This extension wires them into VS Code's native model picker so you can use them anywhere GitHub Copilot Chat works — chat, agent mode, inline edits, and more.

---

## Quick Start

**1. Get your API key**

Sign up at [crof.ai](https://crof.ai/dashboard) and copy your API key from the dashboard.

Free models are available with no credit card required.

**2. Set your API key in VS Code**

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
CrofAI: Manage CrofAI Provider
```

Paste your API key and press Enter. The key is stored securely using VS Code's built-in secret storage — never in plain text.

**3. Pick a model in Copilot Chat**

Open Copilot Chat (`Cmd+Shift+I` / `Ctrl+Shift+I`), click the model picker, and select any **CrofAI** model from the list.

**4. Start chatting**

That's it. Ask questions, get code completions, use agent mode — everything works through GitHub Copilot Chat's standard interface.

---

## Features

### Wide model selection
Choose from 14+ open-weight models across multiple model families:

| Model | Context | Pricing | Notes |
|---|---|---|---|
| Kimi K2.5 | 262K | $0.35↑ / $1.70↓ /M | Vision |
| Kimi K2.5 Lightning | 131K | $1.00↑ / $3.00↓ /M | Vision + Reasoning |
| GLM 5.1 | 202K | $0.45↑ / $2.10↓ /M | |
| GLM 5.1 Precision | 202K | $0.80↑ / $2.90↓ /M | Higher quality |
| Qwen3.5 397B A17B | 262K | $0.35↑ / $1.75↓ /M | Vision + Reasoning |
| DeepSeek V3.2 | 163K | $0.28↑ / $0.38↓ /M | |
| **Qwen3.5 9B** | 262K | **Free** | Vision + Reasoning |
| **GLM 4.7 Flash** | 202K | **Free** | |

### Inline reasoning effort picker
For reasoning-capable models, select effort level directly in the model picker — no separate settings required.

Levels: **No Thinking** · **Low** · **Medium** · **High**

### Vision support
Send images in chat with Kimi, Gemma, and Qwen models. Attach screenshots, diagrams, or code images directly in Copilot Chat.

### Tool calling & agent mode
Full tool calling support — works with Copilot's built-in agent tools (file edits, terminal, search) and custom MCP tools.

### Live usage display
Credits and remaining daily requests shown in the status bar. Click to see full usage details.

### Per-model temperature
Fine-tune temperature per model via `CrofAI: Configure Model Temperature`.

---

## CrofAI Plans

| Plan | Price | Daily Requests |
|---|---|---|
| Free | $0 | Pay-per-token |
| Hobby | $5/mo | 500 |
| Pro | $10/mo | 1,000 |
| Scale | $50/mo | 7,500 |

See full pricing at [crof.ai](https://crof.ai).

---

## Commands

| Command | Description |
|---|---|
| `CrofAI: Manage CrofAI Provider` | Set or update your API key |
| `CrofAI: Show Usage` | Show current credits and request quota |
| `CrofAI: Refresh Models` | Force reload the model list |
| `CrofAI: Configure Model Temperature` | Set per-model temperature |
| `CrofAI: Configure Reasoning Effort` | Set per-model reasoning effort override |

---

## Requirements

- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) — required for model chat UI
- [CrofAI account](https://crof.ai) — free tier available

---

## Privacy

Your API key is stored in VS Code's encrypted `SecretStorage` and never written to settings files or logs. Requests go directly from your machine to `crof.ai` — no data passes through any third-party proxy.

---

## License

[EUPL-1.2](LICENSE)
