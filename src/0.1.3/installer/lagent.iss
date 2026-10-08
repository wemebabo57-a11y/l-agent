; ---------------------------------------------------------------------------
; lagent 安装包脚本（Inno Setup 6）
;
; 用法：
;   1) 先产出免安装目录：npm run dist        → dist/win-unpacked/
;   2) 再编译安装包：     npm run iss        → dist/lagent-<版本>-setup.exe
;
; 依赖 dist/win-unpacked 里已经带全部运行时（Electron + 应用代码），
; 本脚本只做"搬运 + 快捷方式 + 卸载"，不做任何二次打包。
; ---------------------------------------------------------------------------

#define AppName        "lagent"
#define AppVersion     "0.1.3"
#define AppPublisher   "lagent"
#define AppExeName     "lagent.exe"
#define SourceDir      "..\dist\win-unpacked"

[Setup]
AppId={{8F3C1D42-5A7B-4E19-9C63-2B7E4A0D5F81}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
; 默认装到用户目录，避免申请管理员权限（Electron 应用不需要写系统目录）
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; 免安装目录里带的是 64 位 Electron
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 需要管理员权限吗？装到 localappdata 就不需要，用最低权限运行更安全
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename={#AppName}-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}
; 关掉"安装前请关闭程序"的强制检查体验更顺，但仍保留重启检测
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: unchecked

[Files]
; 整个免安装目录原样复制（含 locales、resources/app 等）
; 排除掉构建调试信息，不必发给用户
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "builder-debug.yml,*.pdb"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; 装完可以直接启动；postinstall 表示在安装向导最后一页执行
Filename: "{app}\{#AppExeName}"; Description: "立即启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 这里不需要额外清理：{app} 下所有文件都是安装时铺进去的，
; Inno 卸载时会自己删干净。运行期数据都在 %APPDATA%\lagent，
; 不在 {app} 里，也不在这里删（见下面 CurUninstallStepChanged）。

[Code]
// 判断是否静默卸载。
// 必须自己扫命令行：静默模式下 MsgBox 不会显示，而是直接以"默认按钮"返回，
// 早期版本因此把 MB_YESNO 的默认值（是）当成用户选择，静默卸载会**悄悄删掉**
// 用户的 API Key 与设置。这里改成静默时一律不删。
function IsSilentUninstall(): Boolean;
var
  I: Integer;
  S: String;
begin
  Result := False;
  for I := 1 to ParamCount do
  begin
    S := Uppercase(ParamStr(I));
    if (S = '/SILENT') or (S = '/VERYSILENT') or (S = '/SUPPRESSMSGBOXES') then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if IsSilentUninstall() then
      Exit; // 静默卸载：保留用户数据，不弹窗也不删

    // MB_DEFBUTTON2：默认落在"否"，即使用户直接回车也是保守选择
    if MsgBox('是否同时删除本地配置与密钥？' + #13#10 + #13#10 +
              '选择"否"将保留 %APPDATA%\lagent 下的设置、供应商与 API Key，' +
              '重新安装后可以继续使用。',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{userappdata}\lagent'), True, True, True);
    end;
  end;
end;
