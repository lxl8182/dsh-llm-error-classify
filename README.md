# dsh-llm-error-classify

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-1f6feb.svg)](https://github.com/topics/dsh-plugin)
[![platform](https://img.shields.io/badge/platform-DSH%20Web-4c8bf5.svg)](https://github.com/deepseek-ai/deepseek-harness)

**DSH 错误分类修正插件** —— 让提供方的原始报错**原样显示**，不再被 UI 替换成一句固定的「API 密钥无效」。

网关说「当前分组下没有可用渠道」，你看到的却是「API 密钥无效」，然后跑去换一个根本没问题的密钥。本插件修掉这个误导。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:lxl8182/dsh-llm-error-classify

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-llm-error-classify
```

然后**重启 dsh web**。零依赖、零构建：纯 JavaScript，无 `prepare` 脚本，不需要单独跑 `npm install`。

卸载：

```sh
dsh plugin --profile web remove dsh-llm-error-classify
```

升级 `github:` 安装：`dsh plugin --profile web update dsh-llm-error-classify`，再重启 dsh web。

## 解决什么问题

pi-ai 适配器只凭**文本**给失败分类（`llm-pi-ai/src/stream.ts` 的 `classifyPiAiError`），而它的第一条规则是：

```ts
if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
```

这条规则排在所有更具体的判断**之前**，所以任何 401/403 都变成 `AUTH`——余额耗尽、渠道被禁用、令牌无权使用该模型、IP 未白名单、以及真正的密钥错误，到达 UI 时长得一模一样。

而 `AUTH` 恰好是 UI **唯一拒绝原样渲染**的 code：

| 位置 | 行为 |
| --- | --- |
| `ui-chat/.../conversation-nodes/event-projection.ts` | `if (code === 'AUTH') return { code, message: '' }` — **清空正文** |
| `ui-trajectory/.../trajectory-event-projection.ts` | 同上，第二处 UI 表面 |
| `ui-chat/.../chat/MessageItem.tsx` | `code === 'AUTH'` → 替换为 `message.failure.auth`，即「API 密钥无效」 |
| `ui-trajectory/.../TrajectoryTable.tsx` | `errorCode === 'AUTH'` → 替换为 `details.failure.auth` |

## 它怎么修

挂到 `llm/stream` waterfall（`packages/llm/llm/src/index.ts`）。它包裹适配器原始的 chunk 迭代器，因此能在 agent loop 落盘之前看到终态 `finish` chunk，改写其中的 failure code。改在这里同时修正**持久化会话记录**和 **UI 渲染**。

规则只有一条：**凡 `code === 'AUTH'` 的终态失败，改写成 `PROVIDER_ERROR`，并保留原始文本。**

`PROVIDER_ERROR` 是刻意选的，两个集合都不在里面：

- **不在 UI 特判集合里**（特判集合为 `AUTH`、`QUOTA`、`ACCOUNT_QUOTA`、`ACCOUNT_SIGNED_OUT`、`ACCOUNT_SIGN_IN_REQUIRED`）。UI 的渲染函数对其它一切 code 都直接回落到 `message`／`error`，所以提供方原文原样显示。
- **不在默认可重试集合里**（`retry-policy.ts`：只有 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`）。行为与原先的 `AUTH` 完全一致，不会因此多出重试。

效果对照（`displayFailure` 实测输出）：

```
AUTH           -> {"code":"AUTH","message":""}                      ← 正文被清空
PROVIDER_ERROR -> {"code":"PROVIDER_ERROR","message":"当前分组下没有可用渠道"}
```

不再需要维护任何配额词表：不管网关报的是欠费、渠道还是权限，原文都会显示。这也顺带修掉了原版只认配额措辞、其余网关 403 仍误报密钥无效的盲区。

## 为什么要清洗密钥

上游清空 `AUTH` 正文是**双重目的**的（见 `event-projection.ts` 的注释）：

> Provider AUTH messages may echo a masked or partially preserved credential.
> Keep the raw diagnostic in the Session log, but never retain it in UI state.

它既是为了显示得好看，也是一道**凭证防泄漏**。改写 code 会让原文进入 UI 状态，等于拆掉这道防护，所以插件在放行前先清洗凭证形状的子串（替换为 `[redacted]`）：

- 厂商前缀密钥：`sk-…`、`sk-proj-…`、`ghp_…`、`github_pat_…`、`xoxb-…` 等；
- 消息里回显的 `Bearer <token>`。

**这里是按形状匹配，不是按值匹配**：`GenerateOptions` 不携带凭证（适配器私下解析），插件拿不到真实密钥，因此一个没有任何厂商前缀特征的裸密钥无法被识别。这是本方案已知的残留缺口——若你所用网关会回显此类密钥，请勿依赖本插件的清洗。

## 已知限制

- **不改重试行为**，也不改任何非 `AUTH` 的 code。它只做一件事：`AUTH → PROVIDER_ERROR` 加凭证清洗。
- **凭证清洗按形状匹配**（见上），无厂商前缀的裸密钥识别不了。
- 依赖宿主内部的 code 语义（UI 特判集合、默认可重试集合）。DSH 升级若改动这两个集合，需要跟着调整 `PROVIDER_ERROR_CODE` 的选择。

## 验证

逻辑层：

```sh
node test.mjs
```

- 正向：网关配额 403、无可用渠道 403、令牌无权 403、真密钥 401 —— 全部 `AUTH → PROVIDER_ERROR`；
- 反向：非 `AUTH` 的 code（`RATE_LIMIT`/`QUOTA`/`SERVER`）原样不动；
- 文本保留：渠道报错原文完整可见；
- 凭证清洗：回显的 `sk-proj-…` 与 `Bearer …` 均被抹掉；
- 结构：非 finish chunk 原样返回、`aborted` 终态同样修正。

端到端（经真实 `llm/stream` waterfall）：

```sh
DSH_REPO=/path/to/dsh-checkout node probe-e2e.mjs
```

探针插件注册一个抛出 `new LlmError(403 网关文本, 'AUTH')` 的适配器，跑 `ctx.llm.stream()`，确认终态 finish chunk 的 code 变成 `PROVIDER_ERROR`、文本保留且密钥已被抹掉。探针通过 `createRequire` 从 dsh 安装目录解析宿主包（`DSH_REPO` 指定该目录，默认为当前目录）。

## 结构

```
index.js          宿主半边：llm/stream waterfall 监听，改写终态 failure
cordis.patch.yml  bundle 层，插入宿主行 llm-error-classify
test.mjs          逻辑层检查
probe-e2e.mjs     端到端探针（需 dsh checkout）
```

## 上游修复建议

根因在宿主，本插件是绕开而非根治。彻底修法是三处小改：

1. `llm-pi-ai/src/stream.ts`：把 `isQuotaExceededError` 等更具体的判断提到 401/403 分支**之前**，并且不要仅凭「文本里有 403」就判定为认证失败；
2. `llm/src/error.ts` 的 `isQuotaExceededError`：补下划线变体（`insufficient[\s_-]+(?:user[\s_-]+)?quota`）及中文额度措辞；
3. `ui-chat` / `ui-trajectory` 的 `displayFailure`：清空正文应针对「确实回显了凭证」的情况，而不是整个 `AUTH` code——否则真实认证失败之外的一切 401/403 都会被这句固定文案盖掉。

上游修好后本插件可直接卸载。

## License

[MIT](./LICENSE)
