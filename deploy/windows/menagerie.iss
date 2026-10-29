#ifndef AppVersion
  #error AppVersion must be passed by the release build
#endif
#ifndef PayloadDir
  #error PayloadDir must be passed by the release build
#endif

[Setup]
AppId={{B420E046-AF92-4534-B165-059AD27C3E42}
AppName=Menagerie
AppVersion={#AppVersion}
AppPublisher=Menagerie contributors
DefaultDirName={localappdata}\Programs\Menagerie
DefaultGroupName=Menagerie
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Menagerie.exe
OutputBaseFilename=menagerie-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
LicenseFile=..\..\LICENSE
SetupLogging=yes

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Menagerie"; Filename: "{app}\Menagerie.exe"
Name: "{group}\Stop Menagerie"; Filename: "{app}\Menagerie.exe"; Parameters: "stop"

[Run]
Filename: "{app}\Menagerie.exe"; Description: "Open Menagerie"; Flags: postinstall nowait skipifsilent

[Code]
function StopApplication(): Boolean;
var
  Code: Integer;
  Application: String;
begin
  Application := ExpandConstant('{app}\Menagerie.exe');
  Result := True;
  if FileExists(Application) then
    Result := Exec(Application, 'stop --no-browser', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Result then
    MsgBox('Menagerie could not be stopped safely. Stop it and retry; no user data has been removed.', mbError, MB_OK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopApplication() then
    Result := 'Close Menagerie before updating.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopApplication();
end;

// User state is deliberately outside {app}. No uninstall-delete rule touches it.
