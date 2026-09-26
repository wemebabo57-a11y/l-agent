# lagent

多模型接入 / Skill 管理 / 工作区管理 / GitHub 直连编辑的 AI Agent 桌面工具。
能真的读写文件、执行命令、操作屏幕并查看画面。

## 目录结构

```
src/                  源码（唯一需要手写的地方）
  main/               主进程：IPC、工具实现、供应商适配、插件宿主
  preload/            contextBridge 白名单（渲染进程只能碰这里暴露的 API）
  renderer/           React 界面
  shared/             只有类型契约，主进程与渲染进程共用
installer/lagent.iss  Inno Setup 安装包脚本
scripts/              开发、测试、打包、审计脚本
out/                  编译中间产物（electron-vite 输出，不入库）
dist/                 最终打包产物（免安装目录 + 安装包，不入库）
```

## 开发

```bash
npm install
npm run dev          # 启动开发模式
npm run app          # 用真实用户数据启动一次
```

## 校验

```bash
npm run verify       # typecheck → 单元 → 权限 → 插件 → 构建 → 冒烟
npm run test:package # 打包产物实测（需先 npm run dist）
node scripts/ui-audit.mjs   # 界面审计：截图 + DOM 度量，报告写进 shots/
```

`verify` 全绿是提交的前提。`test:package` 单独跑，因为它依赖 `dist/` 已构建。

## 打包 Windows

```bash
npm run dist         # → dist/win-unpacked/（免安装目录，已带全部依赖）
npm run iss          # → dist/lagent-<版本>-setup.exe（安装包）
```

`npm run iss` 需要本机装有 [Inno Setup 6](https://jrsoftware.org/isdl.php)；
脚本会自动从常见路径与注册表里找 `ISCC.exe`，也可以用环境变量 `ISCC` 指定。

安装包会装到 `%LOCALAPPDATA%\Programs\lagent`，因此不需要管理员权限。
卸载时**不会**删除 `%APPDATA%\lagent`（里面是设置与 API Key）；
交互式卸载会问一次，静默卸载一律保留。

### 两个环境注意事项

- **不要开 asar。** 插件宿主用真实文件路径去 `spawn` `out/main/worker.mjs`
  （见 `src/main/plugins/index.ts`），而 `spawn` 不走 Electron 的 asar 补丁，
  打进归档会直接 ENOENT。
- **`ELECTRON_RUN_AS_NODE` 必须删除而不是置空。** 本机 shell 里这个变量是被设上的，
  它会让 Electron 退化成纯 Node（`app`/`protocol` 变成 undefined）。C++ 侧用
  `getenv` 判断，置空字符串仍然算"已设置"，所以只能 `delete env.ELECTRON_RUN_AS_NODE`。
  `scripts/dev.mjs` 等脚本都已处理。

## 权限模型

三档权限：`full`（完全权限）/ `workspace`（仅工作区内改动）/ `smart`（按风险自动判断）。

工具的固有风险由实现代码静态声明（`ToolRisk`），**模型无法自我改写**；
模型只能在调用时通过 `risk_level` / `risk_reason` 参数把提示等级往上抬。
