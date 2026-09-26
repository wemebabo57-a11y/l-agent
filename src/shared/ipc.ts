/**
 * IPC 通道名。主进程与 preload 共用，避免字符串手写错漏。
 * 约定：invoke 通道用于请求-响应；event 通道用于主进程推送。
 */
export const CH = {
  /* 设置 */
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  /* 供应商 */
  providerList: 'provider:list',
  providerSave: 'provider:save',
  providerDelete: 'provider:delete',
  providerTest: 'provider:test',
  providerModels: 'provider:models',

  /* 会话 */
  sessionList: 'session:list',
  sessionGet: 'session:get',
  sessionCreate: 'session:create',
  sessionDelete: 'session:delete',
  sessionRename: 'session:rename',
  sessionClear: 'session:clear',
  sessionSave: 'session:save',
  /**
   * 主进程 → 渲染进程的会话变更推送。
   * 没有它时，助手回复写盘后渲染进程只能靠「再点一次会话」重新拉取，
   * 表现为消息被吞掉。
   */
  sessionChanged: 'session:changed',

  /* 聊天 */
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatEvent: 'chat:event',
  chatApprovalRespond: 'chat:approvalRespond',

  /* 用量 */
  usageList: 'usage:list',
  usageStats: 'usage:stats',
  usageClear: 'usage:clear',

  /* 工作区 */
  wsList: 'workspace:list',
  wsAdd: 'workspace:add',
  wsPick: 'workspace:pick',
  wsRemove: 'workspace:remove',
  wsTree: 'workspace:tree',
  wsRead: 'workspace:read',
  wsWrite: 'workspace:write',
  wsSearch: 'workspace:search',
  wsReveal: 'workspace:reveal',

  /* Skill */
  skillList: 'skill:list',
  skillImportFiles: 'skill:importFiles',
  skillImportFolder: 'skill:importFolder',
  skillImportZip: 'skill:importZip',
  skillToggle: 'skill:toggle',
  skillDelete: 'skill:delete',
  skillRead: 'skill:read',

  /* 插件 */
  pluginList: 'plugin:list',
  pluginImportFolder: 'plugin:importFolder',
  pluginImportZip: 'plugin:importZip',
  pluginToggle: 'plugin:toggle',
  pluginDelete: 'plugin:delete',
  pluginInvoke: 'plugin:invoke',
  pluginPanel: 'plugin:panel',
  pluginReveal: 'plugin:reveal',

  /* 屏幕 */
  screenList: 'screen:list',
  /** 手动截一张（设置页预览用），与模型工具路径分开 */
  screenCapture: 'screen:capture',
  screenActiveWindow: 'screen:activeWindow',
  screenTest: 'screen:test',

  /* GitHub */
  ghAuthState: 'github:authState',
  ghSetToken: 'github:setToken',
  ghLogout: 'github:logout',
  ghRepos: 'github:repos',
  ghRepoTree: 'github:repoTree',
  ghReadFile: 'github:readFile',
  ghBranches: 'github:branches',
  ghCommit: 'github:commit',
  ghBlobToWorkspace: 'github:blobToWorkspace',
  ghSearchRepos: 'github:searchRepos',
  ghCreateRelease: 'github:createRelease',
  ghListReleases: 'github:listReleases',

  /* 系统 */
  appInfo: 'app:info',
  openExternal: 'app:openExternal'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
