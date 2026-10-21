# DSH WorkBuddy Connect (Fixed)

> **第三方修复分支 / Third-party fixed fork**
>
> 本仓库是 [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 的第三方衍生版本，遵循其 MIT 许可证，保留原作者署名。
>
> **本分支解决的问题**：WorkBuddy 网关自 2026-10-20 起对非官方客户端做渠道校验，请求的系统提示词若以其它客户端的身份签名开头（如 DeepSeek Harness 的 `You are an AI agent powered by DeepSeek Harness.`），上游会返回 HTTP 400 / code 11128「请求被拦截，请重新发送」，导致在 DSH 中使用 WorkBuddy 模型完全不可用。
>
> **修复内容**：
> 1. `prepareChatBody()` 新增 `neutralizeRejectedSystemSignature()`——识别被拒的系统提示词开头签名，在其前面插入一句无害前缀，正文原样保留。
> 2. `prepareCnChatBody()` 补齐 `developer`→`system` 归一化与签名规避，使 CN 区与国际区的防护一致。
> 3. 新增回归测试 `tests/issue-144-system-signature.spec.ts`。
>
> **重要声明**：原项目作者已声明停止维护，并表示尊重 WorkBuddy 对官方客户端与第三方接入的区分。本分支仅作技术研究与本地自救用途，使用前请自行评估 WorkBuddy 的使用条款；商业或办公场景请优先使用官方 WorkBuddy 客户端。
>
> 原项目 README 与完整文档见下方（[English](./README.en.md) | 中文），原项目停止维护公告见 [原文 README](./README.upstream.md)。

---
# DSH WorkBuddy Connect

[English](./README.en.md) | 中文

## 停止维护公告

2026 年 10 月 20 日起，WorkBuddy 开始限制非官方客户端发出的请求。单从技术角度看，这类校验不难跨越。不过，送的模型额度既然附带了使用场地要求，WorkBuddy 已明确希望区分官方客户端与第三方接入，本项目尊重这一边界，不再继续适配。使用官方 WorkBuddy 客户端当然最安全。

同时，由于个人时间和精力有限，本项目即日起停止维护：不再处理新功能请求与 PR，不再提供更新、兼容性修复及问题支持。项目仓库计划于 **2026 年 10 月 22 日下线**。

非常感谢大家这段时间的使用、反馈和贡献，也谢谢每一位帮忙测试、排查问题和提交 PR 的朋友。特别高兴这个小插件曾给大家带来便利！

---

将已登录的 WorkBuddy / WorkBuddy AI 桌面应用中可用的模型接入 DeepSeek Harness；两版分别显示各自的模型分组，并沿用各自的账号登录与积分。

## 安装

**前置**：本机已安装并登录 WorkBuddy（国内版）或 WorkBuddy AI 桌面 App。插件直接复用 App 的登录状态，账号切换自动跟随，两版互不影响。

**推荐：把安装交给本机已有的 Agent**——任何具备终端与文件操作能力的助手（DSH Agent、Codex、Claude Code、Cursor 等）都可以，把下面这段话原样发给它：

```text
请帮我安装并验证 DSH（DeepSeek Harness）插件 dsh-workbuddy-connect（项目地址：https://github.com/corrinehu/dsh-workbuddy-connect）：
先阅读项目 README，确认我实际使用的界面（Web / Desktop / TUI）与 DSH 内核版本，桌面版以 App 内置核心为准，不要用独立 CLI 的版本代替；
再按版本对应关系从 npm 正式包安装（0.2.1-rc.2→0.7.9、0.2.1-rc.1→0.7.7、0.2.0-rc.2→0.7.6、rc.1→0.7.0、0.1.5–0.1.7→0.6.5），优先走本机受支持的非插件市场渠道；部分 Desktop 发行版（尤其官方 Electron 版）的 profile 由 App 管理，各发行版规则未必相同，先确认我所用的发行版，再探查其合规的安装方式，但不得绕过其校验；
任何本地文件或配置改动，先征得我同意并做好备份；
装完后验证模型选择器里出现 WorkBuddy 分组，并陪我完成一次简短对话；
若 Desktop 安装仍因 generation 校验失败（如 @types/retry 误报），请如实报告、参照上游 dataelement/dsh-desktop#688，并建议我改用独立的 Web / TUI，不要修改依赖包或绕过校验。
```

内核与插件版本速查（完整对应表见文末「版本兼容与历史版本」）：

| DSH 内核 | 推荐插件版 |
|---|---|
| 0.2.1-rc.2 | 0.7.9（npm latest） |
| 0.2.1-rc.1 | 0.7.7 |
| 0.2.0-rc.2 | 0.7.6 |
| 0.2.0-rc.1 | 0.7.0 |
| 0.1.5 – 0.1.7 | 0.6.5 |

<details>
<summary>手动安装（命令行，仅 Web / TUI）</summary>

```sh
# Web（按实际内核固定版本，示例为 0.2.1-rc.2 → 0.7.9；也可用 github:corrinehu/dsh-workbuddy-connect 从源码安装）
dsh plugin --profile web add dsh-workbuddy-connect@0.7.9
dsh web

# TUI（示例为 0.1.x 内核；该 profile 需用 pnpm 11 安装，如 npx pnpm@11）
dsh plugin --profile dsh-tui add dsh-workbuddy-connect@0.6.5
dsh --profile dsh-tui
```

</details>

> **TUI 版本搭配**：终端壳 `@deepseek-harness-tui/dsh-tui` 需 0.10.0-beta.5 及以上，更早版本装本插件会启动失败（`events is not iterable`）；推理档位的手动检测仅 Web / Desktop 提供，TUI 没有。

> **Desktop**：部分 Desktop 发行版（尤其官方 Electron 版）的 `desktop` profile 由 App 管理，官方版会直接拒绝独立 CLI 的 `--profile desktop`；其他发行版规则未必相同，请先检查你所用的发行版，不要盲用独立 CLI 的 `--profile desktop`。可以让 Agent 探查是否有合规的非市场安装路径，但不保证可行；切勿盲改 App 管理的目录或绕过其校验。

**验证**：重启对应界面后，模型选择器出现「WorkBuddy / WorkBuddy AI」分组（只装一版就只验对应一组），并从分组里选一个模型完成一次简短对话、能正常回复，才算安装成功。

## 功能

- **开箱即用**：安装并启用插件后即可在 DSH 中直接使用，无需额外配置。

![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)

- **国内版与国际版并存**：国内版显示为「WorkBuddy」分组，国际版（WorkBuddy AI）显示为「WorkBuddy AI」分组，两版的模型、账号和积分互不混用。各自只跟随对应 App 的登录状态：只装国际版就只出现 WorkBuddy AI，两版都装则两组并存，退出一版则对应分组消失。设置里两张卡片分别展示各自账号与余额。

![WorkBuddy AI 模型出现在 DSH 模型选择器中](assets/5.png)

- **图片输入**：大部分模型支持在对话里直接粘贴或拖入图片（GLM-5.3-Flash、DeepSeek-V4 系列等）；少数纯文字模型（如 GLM-5.1、GLM-5.2）会明确提示不支持。

- **推理档位**：WorkBuddy 明确声明的档位会直接显示，例如 GLM-5.3 和 GLM-5.3-Flash 可选 low / high / max。未声明档位的模型可在 Web 和 Desktop 的模型选择器中手动检测（发送少量请求，可能消耗积分）；未检测或没有可用档位的模型使用 WorkBuddy 默认档位。

- **余额速览**：选中 WorkBuddy / WorkBuddy AI 模型时，输入框底部在模型选择器旁显示当前账号的剩余积分（如 `WB.3,401（积分）`、国际版 `WB AI.3,401（积分）`）。积分不自动轮询（每次读取都是真实计费查询），挂载时读取一次后可点积分文字前方的 ↻ 手动刷新。切换会话时组件可能短暂隐藏，模型选择就绪后自动恢复；即使模型没有推理档位检测入口或余额读取失败，刷新按钮仍保留。

- **信息查看与检测**：设置 → 插件 → 对应卡片可查看账号、令牌有效期、剩余积分和模型优惠，也可手动刷新模型列表并查看当前列表来自上游还是内置兜底，或对可检测模型手动检测推理档位。DSH 0.1.5 的入口在「设置 → 插件」，0.1.6+ 移到主界面左侧栏「插件」面板（workbuddy-connect → 查看）；「设置 → 模型」页两代都不显示 WorkBuddy 条目，属有意设计。

- **模型显隐**：两张卡片的「上下文窗口」标签里可勾选要在模型选择器中显示的模型。隐藏配置按登录账号分别保存：切换账号自动切换各自配置，切回后恢复；新账号和新上架模型默认显示。隐藏只影响选择器中的可选性，正在使用该模型的已有会话不受影响。

![上下文窗口列表里的模型显隐（DSH 0.1.6+ 插件配置页）](assets/6.png)

同一份界面在 DSH 0.1.5 的设置卡片中原样生效：

![DSH 0.1.5 设置卡片中的模型显隐](assets/7.png)

- **企业账号积分**：国内版企业账号（`enterpriseId` 非空）走企业计费接口读取周期额度，卡片显示「企业额度」与周期重置时间。

- **费率比例**：每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与输入框的模型下拉都能看到；倍率仅用于显示，不影响实际请求。

- **徽章展示**：促销徽章（限时免费、夜间折扣）直接跟在模型名后（如 `Hy4 preview · x0.00 · 限时免费`），设置卡片会汇总当前有优惠的模型，数据以 WorkBuddy 服务端为准、每次启动 DSH 时同步。国际版促销来自服务端 `modelPromotions`（含生效时段），过期后徽章自动撤销；由于服务端把折后价直接写进模型的倍率字段，原价无法还原，此时该模型倍率显示为「价格未知 — 刷新后更新」，而不是继续显示折扣价或「免费」。

![设置卡片显示插件](assets/2.png)

卡片展开后分「状态 / 上下文 / 明细」三个标签：状态页展示账号、令牌有效期、合计积分、模型列表来源与推理档位检测；上下文页列出各模型上下文窗口，国际版可在这里关闭「使用上游声明的最大上下文窗口」（默认开启，DSH 按上游最大窗口安排上下文压缩；关闭后改用上游默认窗口，偏好持久化）；明细页合并展示同名积分包的余量与模型优惠。国内版与国际版各有一张自己的卡片。

![设置卡片显示账号与剩余积分](assets/3.png)

## 推理档位为什么这样设计

WorkBuddy 中模型的推理档位信息目前分散在上游接口与客户端自身的私有 UI 逻辑中，且模型目录变化很快。若插件根据经验为所有未声明模型补齐统一档位，就需要持续追赶这些未公开、没有稳定契约的产品逻辑。

![设置档位](assets/4.png)


实测还发现，有些模型虽然接受 `reasoning_effort` 参数，却可能忽略未知值并回退到默认行为；一次请求返回成功，并不能证明某个档位真实可用。

因此，对于没有声明档位的模型，Web 和 Desktop 采用用户主动授权触发、动态获取档位的方式：先确认上游会校验该参数，再逐项确认哪些规范档位被接受。检测会发送少量请求，可能消耗积分；结果只表示当前上游接受该档位，不承诺它一定改变推理效果、速度或积分消耗。

## 命令行

`dsh plugin --profile <web|dsh-tui> exec dsh-workbuddy-connect status`：登录状态与剩余积分（`--json` 输出机器可读格式；另有 `doctor` 诊断、`logout` 清理凭据）。`desktop` profile 一般由桌面 App 管理，CLI（含 `exec`）对其不可用（见安装章节的 Desktop 说明）。

默认操作国内版；加 `--provider workbuddy-ai` 操作国际版：

```sh
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

`logout` 只删除该版插件自留的凭据副本，不动桌面 App 自己的登录，也不承诺一定让模型分组消失（App 的凭据文件仍在时依然生效）。

## 配置

重试策略是插件配置项（`cordis.yml` 中 `llm-workbuddy` 的插件配置），国内版与国际版共用同一份；只在插件加载时读取一次，改完需重载或重启 DSH 才生效。

```yaml
llm-workbuddy:
  retryPolicy:
    mode: normal
    maxRetries: 15
    backoff:
      initialDelayMs: 2000
      maxDelayMs: 30000
```

- **省略整个 `retryPolicy` 即保持原行为**。显式配置时，`mode` 必填；其余可选字段按所选模式补齐默认值。未配置时沿用 `dsh-llm` 默认值——`mode: normal`、5 次重试、500 ms 起翻倍、10 s 封顶。默认值合计只有约 **15.5 秒的退避等待**（抖动区间约 14–17 秒），每次请求自身的耗时另计，因此它不构成「在固定时间窗口内必然恢复」的保证。
- **上面的示例**最多会排入约 360 秒退避（抖动上限约 396 秒），每次请求耗时再加在其上，适合覆盖数分钟级的上游中断；但同样不保证在某个固定窗口内恢复，中断更久时仍需调大 `maxRetries` 或换线路。
- `mode: always` 表示**不设次数上限**，一直重试到成功、取消或插件卸载；它不是默认值，也不会因省略配置而被启用，只有在明确接受「请求可能长时间不返回」时才使用。

## 已知限制

- 在 macOS 的 DSH Web / Desktop / TUI 下验证通过（0.3.2 起要求 `0.1.5-rc.1`+、Node 22+；TUI 需终端界面插件 `0.10.0-beta.5` 及以上，见安装章节说明）。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE`（国际版为 `WORKBUDDY_AI_AUTH_FILE`）指定实际位置。
- **加密桌面凭据的解密程序定位**：解密程序在 macOS 与 Windows 上会自动探测。Windows 的路径优先级为：进程中的显式配置 → 注册表配置（先用户环境变量，再系统环境变量）→ 默认安装位置 → 卸载记录自动发现；显式配置无效时会报错，不会静默换用另一个安装。国内版默认位置为 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`，国际版尚无已验证的默认位置。可用 `WORKBUDDY_ELECTRON_BIN`（国内版）或 `WORKBUDDY_AI_ELECTRON_BIN`（国际版）指定可执行文件。进程变量缺失、为空或仅含空白时，Windows 会异步查询注册表；未命中的结果不缓存，因此运行中新增配置后可重试解析，实际卡片交互仍待 Windows 实机验证。成功命中的配置按实例缓存；若要改用另一个仍有效的安装路径，请完全退出并重启 DSH。macOS / Linux 设置环境变量后仍需完全重启；Linux 无法自动发现，需显式指定。WSL 下调用 Windows 侧解密程序时，插件会自动把子进程 `WSLENV` 中的 `ELECTRON_RUN_AS_NODE` 条目规范化为单一安全旗标（含 `/w` 转发、不做路径转换，其余条目原样保留），无需手动设置。此改动已通过离线回归测试，尚未完成 WSL2 / Windows 真机验证。
- **国际版的模型目录来自 App 界面接口**：服务端按 User-Agent 分流下发，属私有实现，上游改动可能使其失效。届时插件按「本账号上次成功目录 → 内置目录」降级，并在卡片上标明来源（实时 / 已保存 / 内置）、更新时间与失败原因，但不能保证长期兼容。国内版目录走官方 CLI 同款接口，不受此影响。
- **国际版仍未覆盖的环境**：Windows / WSL / Linux 下国际版 App 的版本读取尚未找到可靠来源，会退回最近保存的版本或内置值。macOS 上已通过真实 shim 验证 GPT 系完整回复、工具调用与续轮。
- **无凭据时的行为变化**：某版 App 从未登录、也没留下插件自留副本时，该版模型分组不再显示。此前国内版会显示一份内置兜底列表，但那些模型选了必然报错。
- **企业账号积分目前仅覆盖国内版**：国际版企业账号的计费接口尚未验证，仍按个人版接口读取；待有实测结论后再扩展。企业账号分支在本机无法自测（开发机为个人账号），依据官方 App 的接口契约实现，欢迎企业账号用户反馈实测结果。
- **设置入口随 DSH 版本而异**：旧版设置服务使用 `installSection`，新版使用 SettingsForms。0.7.9 在 DSH 0.2.1-rc.2 上恢复国际版「使用上游声明的最大上下文窗口」开关，默认开启；关闭后使用上游默认窗口，设置在重启后保留。只有本插件的可写设置入口就绪后才显示开关，等待期间仍使用默认的最大窗口。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。

## 版本兼容与历史版本

插件版本必须与 DSH 内核匹配，不匹配的组合会导致 DSH 启动失败；桌面版按其内置核心选择插件版本。npm 上的最新版不一定适合你，以实际内核的匹配关系为准：

| DSH 内核 | 推荐插件版 | 注意事项 |
|---|---|---|
| `0.2.1-rc.2` | `0.7.9` | 仅适配这一内核；`0.2.0-rc.2` 与 `0.2.1-rc.2` 不同，请核对 App 内置版本。 |
| `0.2.1-rc.1` | `0.7.7` | 内核升级到 `@earendil-works/pi-ai` 1.3.0，插件同步自带 1.3.0，历史遗留的 0.87.1 overrides 必须移除（见下方 pi-ai 说明）。 |
| `0.2.0-rc.2` | `0.7.6` | 上一代内核线；修复企业账号模型目录缺项与国际版对话被渠道校验拦截，勿停留在有注册表回归的 0.7.2。 |
| `0.2.0-rc.1` | `0.7.0` | 0.7.1 起不再支持 rc.1，请停留本版。 |
| `0.1.5` – `0.1.7` | `0.6.5` | 旧内核最终版；0.7.0 起仅面向 0.2.0。 |
| `0.1.2-rc.1` | `0.3.1` | 更早旧线，仅历史维护。 |
| `0.1.1-rc.2` | `0.2.6` | 更早旧线，仅历史维护。 |

历次更新（完整记录见 [releases](https://github.com/corrinehu/dsh-workbuddy-connect/releases)）：

- **0.7.9**：恢复 DSH 0.2.1-rc.2 上国际版最大上下文窗口开关，修复延迟初始化及设置持久化（PR [#172](https://github.com/corrinehu/dsh-workbuddy-connect/pull/172)，by @1Dreamer666）；避免本地服务绑定到 fetch 禁用端口导致国际版 502（PR [#164](https://github.com/corrinehu/dsh-workbuddy-connect/pull/164)，by @Xiong-Ziyi）；同名积分包合并展示，减少重复条目。
- **0.7.8**：适配 DSH 0.2.1-rc.2；将官方原子写入工具打包到插件，避免依赖宿主暴露该模块；更新国内模型目录快照，区分 Hy3 / Hy3-X；优化推理检测结果展示，调整积分刷新按钮位置并修正悬停提示。感谢 @chenpiyanghappy 的 PR [#156](https://github.com/corrinehu/dsh-workbuddy-connect/pull/156)。
- **0.7.7**：适配 DSH 0.2.1-rc.1 内核：peer 收窄到 0.2.1-rc.1，插件自带的 `@earendil-works/pi-ai` 随内核升级到 1.3.0（profile 级历史遗留的 0.87.1 overrides 必须移除，否则插件无法加载）；修复国际版与国内版推理档位检测停留「检测未完成」——上游把档位拒绝码改拼为 `invalid_parameter_value`（[#143](https://github.com/corrinehu/dsh-workbuddy-connect/issues/143) / [#148](https://github.com/corrinehu/dsh-workbuddy-connect/issues/148)，PR [#145](https://github.com/corrinehu/dsh-workbuddy-connect/pull/145)）；修复中文 Windows 控制台下注册表缺键诊断因 GBK 编码被误判（zh-CN 实机验证）。
- **0.7.6**：修复企业账号模型目录缺少 `glm-5.3-flashx`（[#123](https://github.com/corrinehu/dsh-workbuddy-connect/issues/123)），修复国际版对话请求被上游渠道校验拦截（[#139](https://github.com/corrinehu/dsh-workbuddy-connect/issues/139) / [#142](https://github.com/corrinehu/dsh-workbuddy-connect/issues/142)）。
- **0.7.5**：修复切换会话后输入框余额与刷新按钮消失（[#125](https://github.com/corrinehu/dsh-workbuddy-connect/issues/125) / [#132](https://github.com/corrinehu/dsh-workbuddy-connect/issues/132)），修复 WSL 调用 Windows 凭据解密程序的环境转发（[#133](https://github.com/corrinehu/dsh-workbuddy-connect/issues/133)），README 收录社区项目（[#130](https://github.com/corrinehu/dsh-workbuddy-connect/issues/130)）。
- **0.7.4**：Windows 诊断与稳定性改进：注册表子进程输出超限准确分类、跨平台测试假设修正（[#62](https://github.com/corrinehu/dsh-workbuddy-connect/issues/62)），安装说明重排。
- **0.7.3**：修复 Windows 非默认安装路径下注册表自动发现失败（[#105](https://github.com/corrinehu/dsh-workbuddy-connect/issues/105)）。
- **0.7.2**：pi-ai 改为插件自带依赖，并修复推理字段请求被拒（[#92](https://github.com/corrinehu/dsh-workbuddy-connect/issues/92)）；该版存在 Windows 注册表回归，请使用 0.7.4 或更新的正式版本。
- **0.7.1**：收窄 pi-ai 依赖范围。
- **0.7.0**：适配 DSH 0.2.0 的设置服务改造，不再支持 0.1.x。
- **0.6.5**：0.1.x 线最终版本。

固定版本安装示例：`dsh plugin --profile web add dsh-workbuddy-connect@0.7.9`。

**pi-ai 版本按内核线区分，不能混**：0.2.1-rc.1 / rc.2 内核线（分别对应插件 0.7.7 / 0.7.8–0.7.9）已升级到 `@earendil-works/pi-ai` 1.3.0（由插件自带），profile 级历史遗留的 `overrides: {'@earendil-works/pi-ai': '0.87.1'}` **必须移除**，否则插件会因加载到旧一代 pi-ai 而启动失败；0.2.0-rc.2 内核线（插件 0.7.6）仍要求 `^0.87.1`，在这条线上**不要**把 profile 级的 pi-ai 升到 1.x，第三方插件管理器的「可更新」提示不校验 peer 约束、不能照做（[#86](https://github.com/corrinehu/dsh-workbuddy-connect/issues/86)）。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy／WorkBuddy AI 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。
- **第三方接入存在账号风险。** 官方服务条款对未经授权的第三方接入设有限制。使用本项目可能导致账号或功能受限、账号封禁、服务暂停或终止。能够正常调用、正常扣费，不代表获得官方授权或不存在账号风险。
- 请充分了解上述风险，并自行决定是否安装和使用。因使用本项目产生的账号限制、额度损失、服务中断等后果，由使用者自行承担；如不能接受，请使用官方客户端。
- 本项目不保证服务持续可用、账号不受限制或积分展示始终准确。开发者无法控制平台的限制、处罚或服务调整。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。

## 相关项目 / 社区生态

- **[dsh-workbuddy-switcher](https://github.com/ddGuo/dsh-workbuddy-switcher)**：社区维护的 WorkBuddy 账号管理与切换插件。
- **[hana-workbuddy-connect](https://github.com/miaoyongxu/hana-workbuddy-connect)**：社区维护的非官方适配项目，复用 `dsh-workbuddy-connect` 的部分实现，为 HanaAgent 接入 WorkBuddy / WorkBuddy AI 模型。

适用版本与安装要求请参阅各项目说明。以上项目均由第三方独立维护；收录不代表官方背书，也不构成本插件内部接口的稳定性或兼容性承诺。

## 致谢

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照。

## 许可证

[MIT](./LICENSE)
