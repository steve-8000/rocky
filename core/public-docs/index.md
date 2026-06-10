---
title: Getting started
description: Install Rocky and start running coding agents from anywhere.
nav: Getting started
order: 1
---

# Getting started

Rocky runs your coding agents on your machine and gives you a mobile, desktop, web, and CLI client to drive them from anywhere. Two ways to install.

## Desktop app (recommended)

Download from [rocky.sh/download](https://rocky.sh/download) or the [GitHub releases page](https://github.com/getrocky/rocky/releases). Open it and you're done.

The desktop app bundles its own daemon and starts it automatically, no separate install required. On first launch you'll see a brief startup screen, then connect from your phone by scanning the QR code in Settings.

## Server / CLI

For headless machines, dev boxes, or any setup where you want the daemon running without the desktop UI:

```bash
npm install -g @getrocky/cli
rocky
```

Rocky prints a QR code in the terminal. Scan it from the mobile app, or enter the daemon address manually from another client.

Configuration and local state live under `ROCKY_HOME` (defaults to `~/.rocky`).

## Where next

- [Providers](/docs/providers), what a provider is and how Rocky wraps existing CLIs.
- [CLI reference](/docs/cli), every command.
- [GitHub repo](https://github.com/getrocky/rocky)
- [Report an issue](https://github.com/getrocky/rocky/issues)

## Prerequisites

Rocky manages other agents, it doesn't ship one. Before it's useful, install at least one provider CLI yourself and make sure it works with your credentials. See [Supported providers](/docs/supported-providers) for the full list.

You'll also want the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated, Rocky uses it for PR-aware worktrees and a few orchestration features.
