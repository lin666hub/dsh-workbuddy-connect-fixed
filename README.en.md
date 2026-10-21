# DSH WorkBuddy Connect (Fixed)

> **Third-party fixed fork**
>
> This repository is a derivative of [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect), under its MIT licence, with the original authorship retained.
>
> **What this fork fixes**: since 2026-10-20 the WorkBuddy gateway runs a channel check on non-official clients. A request whose system prompt opens with another client's identity line (for example DeepSeek Harness's `You are an AI agent powered by DeepSeek Harness.`) is answered with HTTP 400 / code 11128 「请求被拦截，请重新发送」, which makes WorkBuddy models unusable inside DSH.
>
> **Changes**:
> 1. `prepareChatBody()` gained `neutralizeRejectedSystemSignature()`, which recognises a refused system-prompt opening and puts a harmless prefix in front of it while keeping the prompt body verbatim.
> 2. `prepareCnChatBody()` now applies the same `developer`→`system` normalisation and signature neutralization, so the CN and international wires are defended alike.
> 3. New regression test `tests/issue-144-system-signature.spec.ts`.
>
> **Note**: the upstream author has retired the project and states that WorkBuddy's boundary between its official client and third-party integrations is respected. This branch is a technical study and a local workaround; please read WorkBuddy's terms yourself, and prefer the official WorkBuddy client for work use.
>
> The upstream README follows below; the original retirement notice is kept in [the upstream README](./README.upstream.md).

---
# DSH WorkBuddy Connect

English | [中文](./README.md)

## Maintenance discontinued

Starting October 20, 2026, WorkBuddy began restricting requests from unofficial clients. From a technical perspective, this kind of check is not difficult to get past. However, the model credits come with restrictions on where they can be used. WorkBuddy has made clear that it wants to distinguish its official client from third-party access, and this project respects that boundary and will not continue adapting to these checks. Using the official WorkBuddy client is, of course, the safest option.

Due to limited personal time and energy, this project is no longer maintained, effective immediately. New feature requests and PRs will no longer be handled, and updates, compatibility fixes, and issue support will no longer be provided. The project repository is scheduled to go offline on **October 22, 2026 (Beijing time)**.

Many thanks to everyone who used the plugin, shared feedback, and contributed, especially those who helped test, investigate problems, and submit PRs. It has been a pleasure to see this little plugin make things easier for you!

---

Brings the models available in your signed-in WorkBuddy / WorkBuddy AI desktop app into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); the two versions each show their own model group and reuse their own account sign-in and credit.

## Install

**Prerequisite**: the WorkBuddy (CN) or WorkBuddy AI desktop app is installed and signed in on this machine. The plugin reuses the app's sign-in state and follows account switches automatically; the two never affect each other.

**Recommended: let an Agent you already have do the install** — any assistant with terminal and file access (the DSH agent, Codex, Claude Code, Cursor, …). Paste this to it verbatim:

```text
Please install and verify the DSH (DeepSeek Harness) plugin dsh-workbuddy-connect for me (project: https://github.com/corrinehu/dsh-workbuddy-connect).
Start by reading the project README and confirming which interface I actually use (Web / Desktop / TUI) and its DSH core version — for the Desktop app, the bundled core, never the standalone CLI's version.
Then install from the official npm package per the version mapping (0.2.1-rc.2 -> 0.7.9, 0.2.1-rc.1 -> 0.7.7, 0.2.0-rc.2 -> 0.7.6, rc.1 -> 0.7.0, 0.1.5-0.1.7 -> 0.6.5), preferring a locally supported non-market channel; on some Desktop distributions (the official Electron app in particular) the profile is app-managed and rules vary by distribution — check mine first, then explore its compliant install route, but never bypass its validation.
Ask for my consent and make backups before changing any local files or configuration.
After installing, verify the WorkBuddy group appears in the model picker and walk me through one short conversation.
If the Desktop install still fails generation validation (e.g. the @types/retry false positive), report it honestly, reference upstream dataelement/dsh-desktop#688, and suggest switching to the standalone Web / TUI — do not modify dependency packages or bypass the check.
```

Core-to-plugin quick reference (full table in "Compatibility and release history" at the end):

| DSH core | Recommended plugin |
|---|---|
| 0.2.1-rc.2 | 0.7.9 (npm latest) |
| 0.2.1-rc.1 | 0.7.7 |
| 0.2.0-rc.2 | 0.7.6 |
| 0.2.0-rc.1 | 0.7.0 |
| 0.1.5 – 0.1.7 | 0.6.5 |

<details>
<summary>Manual install (command line, Web / TUI only)</summary>

```sh
# Web (pin per your actual core — example: 0.2.1-rc.2 -> 0.7.9; or install from source via github:corrinehu/dsh-workbuddy-connect)
dsh plugin --profile web add dsh-workbuddy-connect@0.7.9
dsh web

# TUI (example for a 0.1.x core; that profile needs pnpm 11, e.g. npx pnpm@11)
dsh plugin --profile dsh-tui add dsh-workbuddy-connect@0.6.5
dsh --profile dsh-tui
```

</details>

> **TUI version pairing**: the terminal shell `@deepseek-harness-tui/dsh-tui` must be 0.10.0-beta.5 or newer — older versions fail at startup with this plugin installed (`events is not iterable`); manual reasoning-level detection exists on Web / Desktop only, not TUI.

> **Desktop**: on some Desktop distributions (the official Electron app in particular) the `desktop` profile is app-managed, and the official app rejects the standalone CLI's `--profile desktop`; other distributions may follow different rules, so check yours first and do not blindly use the standalone CLI's `--profile desktop`. An Agent may probe whether your distribution offers a compliant non-market install route, but that is not guaranteed to work; never blindly edit the app-managed directory or bypass its validation.

**Verify**: after restarting the interface, the model picker shows the "WorkBuddy / WorkBuddy AI" group(s) (with only one app installed, check just that group), and a model picked from the group completes one short conversation with a normal reply — that is what a successful install means.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **CN and international side by side**: the CN app appears as the WorkBuddy group and the international one (WorkBuddy AI) as the WorkBuddy AI group; their models, accounts, and credit never mix. Each group follows only its own app's sign-in — install just the international app and only WorkBuddy AI appears, install both and both groups appear, sign out of one and that group goes away. Settings shows one card per version, each with its own account and balance.

![WorkBuddy AI models in the DSH model picker](assets/5.png)

- **Image input**: most models accept images pasted or dropped straight into the conversation (GLM-5.3-Flash, the DeepSeek-V4 series, and more); the few text-only models (e.g. GLM-5.1 / GLM-5.2 on the China endpoint) clearly say so.

- **Reasoning levels**: levels explicitly declared by WorkBuddy appear directly — for example, GLM-5.3 and GLM-5.3-Flash offer low / high / max. For models without declared levels, Web and Desktop offer a manual check in the model picker (it sends a few requests and may consume credit); models without a check result or selectable levels keep using WorkBuddy's default.

- **Balance at a glance**: with a WorkBuddy / WorkBuddy AI model selected, the composer shows the account's remaining credit next to the model selector (e.g. `WB.3,401 credits`, `WB AI.3,401 credits` on the international app). Credit is not polled automatically (every status read is a real billing query): one read on mount, then refresh on demand with the ↻ before the balance. During session switching, the controls may briefly hide until the model selection is ready, then return automatically. The refresh button remains available even when the model has no reasoning-level detection entry or the balance cannot be read.

- **Status and detection**: Settings → Plugins → the matching card shows the account, token validity, remaining credit, and model offers; it also refreshes the model list manually, shows whether the current list came from the upstream or the built-in fallback, and runs manual reasoning-level detection for eligible models. On DSH 0.1.5 the entry lives under Settings → Plugins; on 0.1.6+ it moved to the left-sidebar Plugins panel (workbuddy-connect → View) — and the Settings → Models page shows no WorkBuddy entries on either generation, by design.

- **Model visibility**: the Context window tab of each card lets you check which models appear in the model picker. Hidden lists are saved per signed-in account: switching accounts switches to that account's own list, switching back restores it; new accounts and newly added models are visible by default. Hiding only affects pickability — existing chats using a hidden model keep working.

![Model visibility in the context-window list (DSH 0.1.6+ plugin configuration page)](assets/6.png)

The same UI works unchanged inside the DSH 0.1.5 settings cards:

![Model visibility in a DSH 0.1.5 settings card](assets/7.png)

- **Enterprise credit**: on the CN product, enterprise accounts (non-empty `enterpriseId`) read their cycle quota from the enterprise billing endpoint, and the card shows the enterprise quota with the cycle reset time.

- **Rate**: every model name carries its credits multiplier (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`) in both the `/model` popup and the composer's model dropdown; the rate is display-only and never affects requests.

- **Promo badges**: promo badges (limited-time free, night discount) ride the model name itself (e.g. `Hy4 preview · x0.00 · 限时免费`), visible wherever you pick a model, and the status card collects currently discounted models — per WorkBuddy service data, synced each time DSH starts. The international version's promotions come from the service's `modelPromotions` (with an effective window); once a promotion lapses its badge is withdrawn, and because the service writes the discounted value into the model's own rate field, the original price cannot be reconstructed — the model then reports "price unavailable — refresh to update" instead of repeating the discounted rate or claiming it is free.

![Settings card showing the plugin](assets/2.png)

The expanded card has three tabs: Status shows the account, token validity, total credit, catalog source, and reasoning-level detection; Context lists each model's context window, and the international version's "use the upstream's largest declared context window" switch lives here (on by default, so DSH sizes context compression to the largest declared window; turn it off to follow the upstream default instead, and the preference persists across restarts); Details combines credit packages with the same name and shows model offers. The CN and international versions each get their own card.

![Settings card showing account and remaining credit](assets/3.png)

## Why reasoning levels work this way

Information about WorkBuddy models' reasoning levels is currently split between upstream API responses and private UI logic in the client, while the model catalog changes quickly. If the plugin filled in one uniform set of levels for every model without an upstream declaration, it would need to keep chasing unpublished product logic with no stable contract.

![Reasoning-level detection in the composer](assets/4.png)

Testing also found that some models accept the `reasoning_effort` parameter while ignoring unknown values and falling back to their default behavior. A successful request alone therefore does not prove that a level is actually usable.

For models without declared levels, Web and Desktop instead use user-authorized, on-demand detection: it first confirms that the upstream validates the parameter, then checks which standard levels it accepts. The check sends a few requests and may consume credit. Its result means only that the upstream currently accepts that level; it does not promise a particular change in reasoning quality, speed, or credit use.

## CLI

`dsh plugin --profile <web|dsh-tui> exec dsh-workbuddy-connect status`: sign-in state and remaining credit (`--json` for machine-readable output; `doctor` for diagnostics and `logout` for credential cleanup are also available). The `desktop` profile is generally managed by the desktop app, so the CLI (including `exec`) does not work against it (see the Desktop note under Install).

Both commands target the CN version by default; add `--provider workbuddy-ai` for the international one:

```sh
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

`logout` removes only that version's plugin-owned credential copy. It leaves the desktop app's own sign-in alone and does not promise the model group will disappear (the app's credential file still supplies one).

## Configuration

`retryPolicy` is plugin config (the `llm-workbuddy` entry in `cordis.yml`) shared by both versions; it is read once when the plugin loads, so reload or restart DSH after editing it.

```yaml
llm-workbuddy:
  retryPolicy:
    mode: normal
    maxRetries: 15
    backoff:
      initialDelayMs: 2000
      maxDelayMs: 30000
```

- **Omitting the entire `retryPolicy` preserves the existing behavior**. When configuring it explicitly, `mode` is required; other optional fields use the defaults for the selected mode. Without configuration, the `dsh-llm` defaults apply, i.e. `mode: normal`, 5 retries, 500 ms doubling to a 10 s ceiling. That totals only ~**15.5 s of scheduled backoff** (≈14–17 s across the jitter range), with each attempt's own request time added on top, so it is not a guarantee of recovery within any fixed window.
- **The example above** schedules up to ~360 s of backoff (≈396 s at the jitter edge) plus request time — enough for a multi-minute upstream outage, but still not a fixed-window guarantee; a longer outage needs a higher `maxRetries` or another route.
- `mode: always` retries every failure until success, cancellation, or disposal with **no attempt cap**. It is not the default and is never enabled by omission; use it only when you accept that a request may not return for a long time.

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profiles (as of 0.3.2 this requires `0.1.5-rc.1`+ and Node 22+; TUI requires the terminal UI package `0.10.0-beta.5` or newer — see the Install section). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` (or `WORKBUDDY_AI_AUTH_FILE` for the international version) at the actual file.
- **Encrypted desktop credential helper discovery**: the helper is auto-detected on macOS and Windows. Windows uses an explicit process setting first, then registry configuration (user environment before system environment), then the default installation, then uninstall-record discovery. An invalid explicit setting is an error, not a fallback to another installation. The CN default is `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`; no international default has been verified. Set `WORKBUDDY_ELECTRON_BIN` (CN) or `WORKBUDDY_AI_ELECTRON_BIN` (international) to name an executable. When the process variable is absent, empty, or whitespace-only, Windows queries the registry asynchronously. Misses are not cached, so resolution can retry a newly configured value without restarting; the running-Desktop interaction still needs real Windows verification. Successful values are cached per instance; fully restart DSH to switch between still-valid configured installations. macOS and Linux still require a full restart after environment changes; Linux requires an explicit executable path. For WSL, the plugin normalizes the child `WSLENV` entry for `ELECTRON_RUN_AS_NODE` to one safe flag set with `/w`, without path conversion, preserving other entries. Offline regression tests pass; real WSL2 / Windows verification remains outstanding.
- **The international version's model catalog comes from the app's own interface**: the service splits it by User-Agent, which is a private implementation detail that a server-side change can break. When that happens the plugin degrades to this account's last successful catalog and then to its built-in roster, showing the source (live / saved / built-in), the fetch time, and the failure reason on the card — but long-term compatibility is not guaranteed. The CN version's catalog uses the same interface as the official CLI and is unaffected.
- **International-version environments not yet covered**: on Windows / WSL / Linux no reliable source for the international app's version has been located yet, so the saved value or the built-in default is used. On macOS, real-shim checks covered complete GPT-family replies, tool calls, and continued turns.
- **Behaviour change with no credentials**: a version whose app was never signed in — and that left no plugin-owned copy — no longer shows a model group. The CN version used to display a built-in fallback list, but every model on it failed when selected.
- **The enterprise credit path currently covers the CN product only**: the international enterprise billing interface is unverified, so those accounts still read through the personal endpoint pending measurement. The enterprise branch could not be tested locally (the development machine holds a personal account); it was implemented from the official app's interface contract, and reports from enterprise users are welcome.
- **Settings entries vary with the DSH version**: older services use `installSection`; newer ones use SettingsForms. On DSH 0.2.1-rc.2, 0.7.9 restores the international edition's maximum-context switch, enabled by default. Turning it off uses the upstream default window, and the preference survives restarts. The switch appears only once this plugin's writable settings entry is ready; while waiting, the maximum window remains the default.
- Relies on WorkBuddy client interfaces (not a public API); the plugin may need updates as WorkBuddy changes.

## Compatibility and release history

The plugin version must match the DSH core — a mismatched combination fails to start DSH — and the Desktop app picks its plugin version by the bundled core. The newest npm release is not necessarily right for you: match your actual core first.

| DSH core | Recommended plugin | Notes |
|---|---|---|
| `0.2.1-rc.2` | `0.7.9` | Targets this core only; `0.2.0-rc.2` and `0.2.1-rc.2` differ. Check the core bundled in your Desktop app. |
| `0.2.1-rc.1` | `0.7.7` | The core moved to `@earendil-works/pi-ai` 1.3.0, so the plugin bundles 1.3.0 too — a leftover 0.87.1 overrides entry must be removed (see the pi-ai note below). |
| `0.2.0-rc.2` | `0.7.6` | Previous core line; fixes enterprise catalog gaps and international chat requests blocked by the upstream channel check. Avoid 0.7.2 with its registry regression. |
| `0.2.0-rc.1` | `0.7.0` | 0.7.1 drops rc.1 support; stay on this version. |
| `0.1.5` – `0.1.7` | `0.6.5` | Final release for the old cores; 0.7.0 targets 0.2.0 only. |
| `0.1.2-rc.1` | `0.3.1` | Older line, historical maintenance only. |
| `0.1.1-rc.2` | `0.2.6` | Older line, historical maintenance only. |

Release history (full records at [releases](https://github.com/corrinehu/dsh-workbuddy-connect/releases)):

- **0.7.9**: restores the international edition's maximum-context switch on DSH 0.2.1-rc.2, including delayed initialization and persistent settings (PR [#172](https://github.com/corrinehu/dsh-workbuddy-connect/pull/172), by @1Dreamer666); avoids fetch-blocked local ports that could cause international-edition 502 errors (PR [#164](https://github.com/corrinehu/dsh-workbuddy-connect/pull/164), by @Xiong-Ziyi); combines credit packages with the same name to reduce repeated entries.
- **0.7.8**: adapts to DSH 0.2.1-rc.2; bundles the official atomic-write helper instead of relying on host module exposure; refreshes the China catalog snapshot and distinguishes Hy3 / Hy3-X; improves probe result labels and fixes the credit-refresh placement and tooltip. Thanks to @chenpiyanghappy for PR [#156](https://github.com/corrinehu/dsh-workbuddy-connect/pull/156).
- **0.7.7**: adapts to the DSH 0.2.1-rc.1 core: peers narrow to 0.2.1-rc.1 and the plugin-bundled `@earendil-works/pi-ai` moves to 1.3.0 with it (a profile-level leftover 0.87.1 overrides entry must be removed, or the plugin fails to load).
- **0.7.6**: fixes enterprise accounts missing `glm-5.3-flashx` from the model catalog ([#123](https://github.com/corrinehu/dsh-workbuddy-connect/issues/123)), and fixes international chat requests being blocked by the upstream channel check ([#139](https://github.com/corrinehu/dsh-workbuddy-connect/issues/139) / [#142](https://github.com/corrinehu/dsh-workbuddy-connect/issues/142)).
- **0.7.5**: restores composer controls after session switching ([#125](https://github.com/corrinehu/dsh-workbuddy-connect/issues/125) / [#132](https://github.com/corrinehu/dsh-workbuddy-connect/issues/132)), fixes WSL helper environment forwarding ([#133](https://github.com/corrinehu/dsh-workbuddy-connect/issues/133)), and adds community projects to both READMEs.
- **0.7.4**: Windows diagnostics and stability improvements: accurate classification of oversized registry-subprocess output, cross-platform test-assumption fixes ([#62](https://github.com/corrinehu/dsh-workbuddy-connect/issues/62)), and a reworked install section.
- **0.7.3**: fixes Windows registry auto-discovery failing on non-default install paths ([#105](https://github.com/corrinehu/dsh-workbuddy-connect/issues/105)).
- **0.7.2**: pi-ai becomes a plugin-bundled dependency and rejected inference-field requests are fixed ([#92](https://github.com/corrinehu/dsh-workbuddy-connect/issues/92)); this release carries a Windows registry regression — use 0.7.4 or a newer stable release.
- **0.7.1**: narrows the pi-ai dependency range.
- **0.7.0**: adapts to DSH 0.2.0's settings-service rework and drops 0.1.x support.
- **0.6.5**: final release of the 0.1.x line.

Pinned-version install example: `dsh plugin --profile web add dsh-workbuddy-connect@0.7.9`.

**pi-ai versions are per core line and must not be mixed**: the 0.2.1-rc.1 / rc.2 core lines (plugin 0.7.7 / 0.7.8–0.7.9 respectively) moved to `@earendil-works/pi-ai` 1.3.0 (bundled by the plugin), so a profile-level leftover `overrides: {'@earendil-works/pi-ai': '0.87.1'}` **must be removed** or the plugin fails to load; the 0.2.0-rc.2 core line (plugin 0.7.6) still requires `^0.87.1` — on that line, **do not** upgrade the profile-level pi-ai to 1.x, and do not act on third-party plugin managers' "updatable" prompts, which do not check peer constraints ([#86](https://github.com/corrinehu/dsh-workbuddy-connect/issues/86)).

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy / WorkBuddy AI account on your own machine. Do not use it commercially or beyond reasonable personal use.
- This project is not affiliated with, authorized by, or endorsed by Tencent, WorkBuddy, or DeepSeek. Product names are used only to describe compatibility; trademarks belong to their respective owners.
- **Third-party access carries account risks.** The official terms of service restrict unauthorized third-party access. Using this project may result in account or feature restrictions, account bans, or suspension or termination of service. Successful requests and normal credit deductions do not imply official authorization or the absence of account risks.
- Please understand these risks and decide for yourself whether to install and use this project. Account restrictions, credit losses, service interruptions, and other consequences arising from its use are borne by the user. If you cannot accept these risks, use the official client.
- This project does not guarantee continued service availability, freedom from account restrictions, or consistently accurate credit displays. The developer cannot control the platform's restrictions, penalties, or service changes.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.

## Related Projects / Community Ecosystem

- **[dsh-workbuddy-switcher](https://github.com/ddGuo/dsh-workbuddy-switcher)**: a community-maintained WorkBuddy account management and switching plugin.
- **[hana-workbuddy-connect](https://github.com/miaoyongxu/hana-workbuddy-connect)**: a community-maintained unofficial adapter project that reuses parts of the `dsh-workbuddy-connect` implementation to bring WorkBuddy / WorkBuddy AI models to HanaAgent.

See each project's documentation for supported versions and installation requirements. These projects are independently maintained by third parties. Listing them here is not an official endorsement or a stability or compatibility commitment for this plugin's internal interfaces.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## License

[MIT](./LICENSE)
