# OpenShell

<p align="center">
  <img src="frontend/public/logo.svg" width="96" height="96" alt="OpenShell Logo" />
</p>

<p align="center">
  <strong>Next-Generation Enterprise-Grade Lightweight Open-Source SSH/SFTP Client & E2EE Sync Service</strong><br />
  <em>Zero Speed Limit · Minimalist Design · Cross-Platform · 100% Free & Open-Source · Zero-Knowledge Security</em>
</p>

<p align="center">
  <a href="https://github.com/fieecbin-source/openshell/releases"><img src="https://img.shields.io/github/v/release/fieecbin-source/openshell?color=0071e3&style=flat-square" alt="GitHub Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-orange?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/Rust-1.80%2B-red?style=flat-square&logo=rust" alt="Rust" />
  <img src="https://img.shields.io/badge/Tauri-v2-cyan?style=flat-square&logo=tauri" alt="Tauri" />
  <img src="https://img.shields.io/badge/E2EE-Argon2id%20%2B%20AES--256--GCM-green?style=flat-square" alt="Security" />
</p>

<p align="center">
  <strong>English</strong> | <a href="README.md"><strong>简体中文</strong></a>
</p>

---

## 💡 Why OpenShell?

Many existing terminal clients (such as FinalShell, Xshell, MobaXterm, Termius) suffer from bloat, artificial bandwidth/speed limits behind paywalls, high memory consumption, or untrusted closed-source sync mechanisms. **OpenShell** is crafted specifically for DevOps engineers, backend developers, and systems administrators who demand speed, aesthetic simplicity, and uncompromising security:

1. **⚡ Zero Speed Limits & Blazing Performance**: Powered by a Rust core + WebGL GPU accelerated rendering engine. Millisecond cold starts, fluid scrolling, and zero subscription speed throttling.
2. **🎯 Clean, Minimalist & Focused**: Free of ads, intrusive telemetry, or commercial upsells. Focuses purely on terminal sessions, SFTP management, port tunneling, and real-time agentless metrics.
3. **🔒 Zero-Knowledge End-to-End Encryption (E2EE)**: Host credentials and keys are encrypted locally using **Argon2id** and **AES-256-GCM**. Self-hosted sync servers only see opaque ciphertexts—even if the server database is compromised, your connection credentials remain unreadable.
4. **🌐 True Cross-Platform Experience**: First-class packages for Windows, macOS (Universal: Apple Silicon & Intel), and Linux, including portable no-install zip releases.
5. **🪶 Effortless Self-Hosted Cloud Sync**: A single standalone server binary supporting single-user automatic bootstrap mode without email requirements, ready for systemd or Docker deployment.

---

## 🌟 Key Features

### 1. Robust Terminal & Multi-Protocol Dispatch
- **Multi-Protocol**: Native support for SSH (Password, Key with Passphrase, Keyboard Interactive, SSH-Agent, Jump Host / ProxyJump), Local Shell (PowerShell, CMD, WSL, bash, zsh), and Serial connections.
- **Seamless Layout Switching**: Effortlessly switch between full Terminal, Vertical/Horizontal Split View, and standalone SFTP file manager without dropping connections.
- **Tabs & Fullscreen Mode**: Immersive terminal experience with `F11` / `Esc` fullscreen toggle, inline double-click tab renaming, tab drag-and-drop reordering, quick duplication, and accidental closure protection.
- **Font Scaling & Shortcuts**: Zoom fonts dynamically with `Ctrl/Cmd +`, `Ctrl/Cmd -`, and reset with `Ctrl/Cmd 0`. Right-click instant clear screen.

### 2. Interactive SFTP File Manager
- **Chunked Streaming Transfers**: Built on `russh-sftp` with 64 KiB chunked streaming, supporting pause, resume, and real-time transfer rate stats.
- **OSC 7 Working Directory Sync**: Automatically aligns SFTP directories when you `cd` in the terminal.
- **Direct Remote File Editing**: Built-in lightweight code editor with instant upload on `Ctrl+S`.

### 3. Agentless Server Monitor Dashboard
- **Zero-Agent Telemetry**: Periodically inspects Linux `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `df -P`, and `ps -eo` over the existing SSH connection without installing any remote agent daemon.
- **Seamless Toggling**: Switch between your active shell and the full monitoring dashboard without terminating or losing terminal session history.
- **Visual Analytics**: Real-time charts for multi-core CPU usage, RAM/Swap utilization, network I/O throughput, mounted disk storage, and top running processes.

### 4. Port Forwarding & Tunnels
- **Unified Tunneling**: Local port forwarding (`-L`), Remote reverse forwarding (`-R`), and Dynamic SOCKS5 proxy (`-D` RFC 1928/1929).
- **SOCKS5 Authentication**: Supports No-Auth and RFC 1929 username/password verification.
- **Security Audit Alerts**: Warns when binding to wildcard `0.0.0.0` or `::` to prevent accidental public exposure.

### 5. Cross-Platform Cloud Sync & Self-Hosting
- **Single-User Auto-Bootstrap**: Self-hosted servers automatically initialize single-user accounts upon startup, enabling fast username-based login without tedious email registration.
- **Conflict Resolution**: Transparent optimistic concurrency and dirty state detection with single-click local sync reset.
- **Production Ready**: Includes systemd unit templates, Docker Compose files, and automated reverse proxy examples with TLS certificates.

---

## 📦 Download Packages

Download the latest official releases from [GitHub Releases](https://github.com/fieecbin-source/openshell/releases):

| Platform | Format | Description / Architecture |
| :--- | :--- | :--- |
| **Windows** | `.exe` (NSIS Installer) | Windows 10 / 11 / Server (x86_64) |
| **Windows** | `.zip` (**Portable Release**) | Standalone executable, no admin privileges required |
| **macOS** | `.dmg` (Universal Installer) | Native binary for Apple Silicon (M1/M2/M3/M4) & Intel |
| **macOS** | `.zip` (**Portable Release**) | Contains `OpenShell.app`, drag and drop anywhere |
| **Linux** | `.AppImage` | Standalone executable across popular Linux distros |
| **Linux** | `.deb` | Package for Debian / Ubuntu / Mint |
| **Server** | `.tar.gz` (Linux Standalone) | Contains `openshell-server`, `deploy/` and setup scripts |

Every release includes an official `SHA256SUMS.txt` checksum manifest.

---

## 🚀 Quick Start: Self-Hosted Sync Server

Use a Linux x86_64 server binary, systemd and an existing HTTPS reverse proxy. Deployment transfers only server runtime files.

**Current limitation:** domain, username and password support login; the desktop path still needs integration for cross-device vault import and applying decrypted business records. Successful login does not establish complete synchronization.

### Option 1: Systemd Service (Recommended)

```bash
# Prepare /opt/openshell/deploy/.env using the full guide.
# Actions → Deploy Server (Self-Hosted Sync) → Run workflow.
# Leave deploy unchecked to build/test only; check it to install the server artifact.
```

### Option 2: Docker Compose

```bash
cd deploy
cp .env.example .env
docker compose up -d --build openshell-server
```

See the [personal server guide](docs/SYNC.md) for installation, domain/TLS setup, GitHub Secrets, CI/CD, Docker migration and current sync limitations.

---

## ⌨️ Useful Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| `Ctrl + K` / `Cmd + K` | Open Command Palette (search sessions, direct connect, themes) |
| `F11` | Toggle Immersive Fullscreen Mode |
| `Esc` | Exit Fullscreen / Close Monitor Dashboard and return to terminal |
| `Ctrl + +` / `Cmd + +` | Zoom In Terminal Font Size |
| `Ctrl + -` / `Cmd + -` | Zoom Out Terminal Font Size |
| `Ctrl + 0` / `Cmd + 0` | Reset Terminal Font Size |
| `Ctrl + F` / `Cmd + F` | Search within terminal scrollback |
| Double-click Tab | Rename current terminal tab |

---

## 🛠️ Development & Contributing

Please refer to our [CONTRIBUTING.md](CONTRIBUTING.md) guide for details on development setup, code standards, testing, and pull request procedures.

```bash
# 1. Install frontend dependencies
cd frontend
npm install

# 2. Start frontend dev server
npm run dev

# 3. Launch Tauri desktop app in dev mode
cd ..
npm run tauri dev
```

---

## 📄 License & Policies

- **License**: Released under the [Apache License 2.0](LICENSE).
- **Code of Conduct**: We adhere to the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
- **Security Policy**: Detailed vulnerability disclosure instructions can be found in [SECURITY.md](SECURITY.md).

