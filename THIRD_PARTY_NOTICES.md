# OpenShell 第三方开源许可证声明（THIRD_PARTY_NOTICES.md）

> 本文件记录 OpenShell 跨平台桌面客户端及其服务端所使用的开源第三方依赖、版本及许可证信息。  
> 经洁净室合规与许可证安全审计（TASK-P1-M5-3）：
> - **严禁强传染性协议**：**0 项** GPL / AGPL 组件进入客户端发布产物。
> - **商业与开源友好**：所有运行时与客户端直接依赖均采用宽松许可证（MIT / Apache-2.0 / BSD / ISC / Zlib）。

---

## 1. 核心 Rust 运行时依赖清单

| Crate 名称 | 许可协议 | 用途说明 |
|---|---|---|
| `tauri` (v2.x) | MIT OR Apache-2.0 | 跨平台桌面应用宿主框架 |
| `tauri-plugin-dialog` | MIT OR Apache-2.0 | 系统原生文件与消息模态框 |
| `tauri-plugin-opener` | MIT OR Apache-2.0 | 外部默认浏览器与应用打开器 |
| `russh` (v0.64.1) | Apache-2.0 | 纯 Rust 异步 SSH 2.0 协议客户端栈 |
| `russh-sftp` (v3.0.1) | Apache-2.0 | 纯 Rust SFTP 协议客户端与文件流通道 |
| `tokio` (v1.x) | MIT | 异步网络运行时与多线程执行器 |
| `rusqlite` (v0.32) | MIT | SQLite 本地加密/关系存储绑定库 |
| `argon2` (v0.5) | MIT OR Apache-2.0 | Argon2id 密码哈希与主密码 KDF 密钥派生 |
| `chacha20poly1305` (v0.10) | MIT OR Apache-2.0 | XChaCha20-Poly1305 AEAD 认证加密套件 |
| `zeroize` (v1.x) | Apache-2.0 OR MIT | 内存敏感密钥离开作用域后硬件级零化清理 |
| `serde` / `serde_json` | MIT OR Apache-2.0 | 高性能序列化与反序列化引擎 |
| `axum` (v0.7) | MIT | 自建同步与中继服务端 Web 框架 |
| `sqlx` (v0.8) | MIT OR Apache-2.0 | 异步数据库连接池与查询驱动 |
| `tracing` / `tracing-subscriber` | MIT | 结构化异步日志与观测框架 |
| `ulid` (v1.x) | MIT | 单调可排序高并发唯一 ID 生成器 |
| `parking_lot` (v0.12) | MIT OR Apache-2.0 | 紧凑高效无毒死锁检测同步原语 |

---

## 2. 核心前端依赖清单

| 包名称 | 许可协议 | 用途说明 |
|---|---|---|
| `react` / `react-dom` (v18.3.1) | MIT | 前端响应式组件库 |
| `@xterm/xterm` (v5.5.0) | MIT | 终端核心仿真器 |
| `@xterm/addon-webgl` (v0.18.0) | MIT | WebGL 终端 GPU 硬件加速渲染器 |
| `@xterm/addon-fit` (v0.10.0) | MIT | 终端窗口尺寸自适应插件 |
| `@xterm/addon-search` (v0.15.0) | MIT | 终端回滚缓冲区增量/正则高亮查找插件 |
| `@xterm/addon-web-links` (v0.11.0) | MIT | 终端超链接自动识别与安全打开 |
| `@tanstack/react-virtual` (v3.10.8) | MIT | 100+ 会话列表平滑 60fps 虚拟滚动引擎 |
| `zustand` (v5.0.1) | MIT | 轻量前端原子化状态管理库 |
| `i18next` / `react-i18next` | MIT | 国际化双语切换系统 |
| `tailwindcss` (v3.4.14) | MIT | 现代原子化 CSS 样式框架 |
| `vite` (v5.4.10) | MIT | 前端本地开发与构建打包引擎 |
| `vitest` (v2.1.4) | MIT | 前端单元测试框架 |

---

## 3. 标准许可证正文索引

### MIT License
```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License Version 2.0
```text
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

<!-- AI-CATALOG-AND-LOGO-NOTICES -->

---

## 4. AI 厂商目录与品牌 Logo

### 4.1 models.dev 数据快照

- **项目**：models.dev（<https://models.dev>，源码仓库 <https://github.com/anomalyco/models.dev>）
- **许可证**：MIT
- **用途**：构建期由 `openshell-xtask` 拉取 <https://models.dev/api.json>，生成厂商 / 模型目录快照并内置于 OpenShell 二进制；运行时优先使用内置快照，外网失败时自动回退。
- **声明**：数据按“原样（AS IS）”提供，OpenShell 不背书其准确性、完整性或时效性。

### 4.2 @lobehub/icons-static-svg 品牌图标

- **项目**：LobeHub Icons（<https://github.com/lobehub/lobe-icons>）
- **许可证**：MIT
- **用途**：构建期下载厂商 SVG 图标并内置于设置页、模型选择器与 AI 模式 Logo 流星特效；部分缺失图标由 models.dev（MIT）补充。
- **商标声明**：文中出现的所有厂商名称、Logo 与商标均归其各自权利人所有。本项目仅在识别与展示场景中按原样式使用，不构成任何隶属、赞助、担保或背书关系。
- **回退图标**：当厂商图标缺失或安全校验未通过时，使用 OpenShell 自绘的赛博朋克风格 AI 核心 SVG，随本项目源码以 MIT OR Apache-2.0 授权发布。
