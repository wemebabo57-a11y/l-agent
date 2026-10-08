# 插件执行面审计（0.1.3 P0-2）

审计范围：`src/main/plugins/index.ts`、`src/main/plugins/worker.mjs`、
`src/renderer/src/components/PluginView.tsx`、manifest 校验（index.ts 120~170 行）。
结论：**面板侧隔离良好；worker 侧权限是"君子协定"，不是沙箱。**

## 1. 进程与权限矩阵

| 执行面 | 跑在哪里 | 能调什么 | 隔离手段 | 结论 |
|---|---|---|---|---|
| main（工具调用） | 独立子进程（Electron as Node + worker.mjs） | 经 stdout 协议向宿主请求：workspace.read/search/write（宿主按 manifest 权限二次校验） | 独立进程（崩溃不连累主进程）+ env  scrub（仅 PATH/SystemRoot/TEMP/TMP+LAGENT_*）+ 入口路径 containment + 超时强杀 | 进程级隔离 OK |
| main（自身能力） | 同上，同一进程 | **全部 Node 内建**：`node:fs`、`node:child_process`、全局 `fetch`，与用户同等 OS 权限 | **无**：`import(entry)` 与插件代码同进程，无 require 拦截 | **最高风险**：恶意插件可绕过 `api` 对象直接读盘/联网/起进程，manifest 权限对其无效 |
| panel（面板调用 invoke） | 同上子进程 | 同 main + 需 `ui` 权限才放行 | 同 main | 同上 |
| panel（渲染） | 渲染进程 `<iframe sandbox="allow-scripts allow-forms" src="lagent-plugin://…">` | 无宿主 API（无 `allow-same-origin`，独立 origin + 自身 CSP） | iframe 沙箱 | 良好：拿不到密钥与本地数据 |
| 工具注册 | 主进程模型工具集 | 以 `plugin_<id>_<tool>` 注册，风险取 max（声明值，权限下限），执行走 `permissions.decide` + 用户审批 | 风险只许上调不许下调；与内置工具重名不覆盖 | 良好：实际执行仍受档位约束 |

## 2. 缓解措施（已落地）

1. manifest 强校验：version 须 x.y.z、工具 ≤ 12 个、未知权限安装时直接拒绝。
2. 风险下限：`riskFromPermissions` 取 floor，声明 risk 只能上调。
3. 插件工具调用走同一套 `decide` + 确认卡片（含宿主桥 `handlePluginRequest` 的权限二次校验）。
4. 子进程 env scrub + 超时强杀 + stdout 结构化错误优先于退出码。

## 3. 残留风险与收紧方向（0.2.0 前必须二选一）

- **R1（高）**：worker 内插件代码可直调 Node 能力。收紧方向：(a) 安装时静态扫描 `index.ts` 的 `import from 'node:*'/child_process/fetch` 并告警；(b) worker 侧用 `vm` + 受限 require 白名单跑插件（工作量大）；(c) 文档明确"只安装信任来源插件" + 安装确认页展示权限清单（最小成本，建议先做 c）。
- **R2（中）**：`network` 未声明时只替换了 `api.fetch`，全局 `fetch` 仍可用——属于 R1 的子集，随 R1 修。
- **R3（低）**：面板 `allow-scripts` 允许插件跑 JS，但无 same-origin，数据外泄需经用户交互或网络（网络不受限，见 R1）。

## 4. 本次 0.1.3 动作

只输出本矩阵，不改执行语义（避免在发版前动高危路径）。建议 0.2.0 做 (c)+(a)。
