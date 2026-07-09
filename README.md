![logo](apps/web/public/logo.jpg)

[![GitHub stars](https://img.shields.io/github/stars/thirdbase1/Entry?style=social)](https://github.com/thirdbase1/Entry/stargazers) &ensp;
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) &ensp;
[![Discord](https://img.shields.io/badge/Discord-Join-blue)](https://discord.gg/your-discord-invite)
[![Demo](https://img.shields.io/badge/Demo-Entry-yellow)](https://entry.io)

# 👋 Entry

> **Open-source alternative to Claude Agent SDK, ChatGPT Agents, and Manus.**

Agentic AI systems, such as Claude Agent SDK (Claude Code) or ChatGPT Agents, can perform meaningful real-world tasks by operating computers, browsers, and phones just like humans. Open source would enhance their capabilities.

[**Entry**](https://entry.io/) is an open Agentic AI you can use or modify. Chat with cutting-edge models while our multi-agent system completes your tasks.

Play with it, deploy it, enhance it, or use it as the foundation for your next dedicated agent. We welcome all contributions.

---

## ✨ Key Features

- **💡 Idea**
  Have your own highly customizable Agentic AI that integrates OpenAI, Claude, Gemini, and open-source models to work together seamlessly!

- **💬 Stop prompt-chasing. Start decision-making**
  Spec & context engineering give agents structure to plan, score, and surface options. You stay in control of the final call. Achieve more, struggle less.

- **🔔 Multi-agent collaboration**
  Instead of chatting with a single AI, all the frontier models collaborate together to finish your task with our multi-agent framework.

- **🏠 Self-hostable**
  Open source and free to modify.

---

## 🏗️ Stack

Entry is a Next.js / Vercel monorepo:

- **`apps/web`** — Next.js 16 App Router: auth, chat UI, doc/library workspace, onboarding, sharing.
- **`apps/agent`** — the eve agent runtime: chat orchestration, tool execution, durable sessions.
- **`packages/*`** — shared infra: `db` (Prisma/Postgres), `auth` (Better Auth), `cache`, `queue`, `ws`, `ai` (model gateway, sandbox, browser tools), `mail`, `oauth`, `copilot` (RAG search).

## 💻 How to deploy

See [`DEPLOY.md`](./DEPLOY.md) for the full guide (env vars, database setup, OAuth, and the exact Vercel CLI/dashboard steps). Quick version:

```sh
git clone https://github.com/thirdbase1/Entry.git
cd Entry
cp .env.example .env   # fill in your values
npm install
npm run db:deploy      # apply Prisma migrations
npm run build           # runs db:deploy + next build --webpack
```

Then deploy with the Vercel CLI or by connecting the repo in the Vercel dashboard — `vercel.json` is already configured.

## 🤝 Contributing

We welcome all contributions, ideas, and improvements!
Open issues or pull requests — no bureaucracy, just collaboration.

---

## 🌐 Community

Join our community to connect with other developers, share feedback, and showcase your projects.

> [Discord →](https://discord.gg/WM7PkxUaP4)

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=thirdbase1/Entry&type=Date)](https://star-history.com/#thirdbase1/Entry&Date)

---

## 💙 Acknowledgements

Entry builds upon the ideas of projects like [AFFiNE](https://github.com/toeverything/AFFiNE), and the broader open-source agentic AI community.

Special thanks to everyone advancing human–AI collaboration.

---

© 2026 Entry Contributors.
Licensed under [Apache 2.0](https://opensource.org/licenses/Apache-2.0).
