; Inno Setup Script for Solframe Studio with Complete Branding
; Designed & Crafted by Protik

#define MyAppName "Solframe Studio"
; Pass /DMyAppVersion=x.y.z on the ISCC command line to override — the
; fallback here only applies when this script is compiled standalone,
; e.g. by double-clicking it in the Inno Setup IDE. build-installer.js
; always passes the real version from package.json.
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "Protik"
#define MyAppURL "https://github.com/Protik1810/Solframe-Studio"
#define MyAppExeName "Solframe Studio.exe"

[Setup]
AppId={{C8E28B93-9F7C-4C75-8D4F-1B2F7E4193A1}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
DefaultGroupName={#MyAppName}
OutputDir={#SourcePath}installer-output
OutputBaseFilename=Solframe-Studio-Setup-{#MyAppVersion}
SetupIconFile={#SourcePath}electron\icon.ico
WizardImageFile={#SourcePath}public\wizard-large.bmp
WizardSmallImageFile={#SourcePath}public\wizard-small.bmp
LicenseFile={#SourcePath}TERMS.txt
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourcePath}release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\resources\backend\win\cuda\7zr.exe"; Parameters: "x -y -o""{app}\resources\backend\win\cuda"" ""{app}\resources\backend\win\cuda\cuda-runtime.7z"""; Flags: runhidden
Filename: "{cmd}"; Parameters: "/C del /q ""{app}\resources\backend\win\cuda\cuda-runtime.7z"""; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent