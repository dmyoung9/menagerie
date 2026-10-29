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
var
  RemoveSettings, RemoveEngines, RemoveModels, RemoveCache, RemoveLogs: Boolean;

function StateDirectory(): String;
begin
  Result := GetEnv('MENAGERIE_STATE');
  if Result = '' then begin
    Result := GetEnv('LOCALAPPDATA');
    if Result = '' then Result := ExpandConstant('{localappdata}');
    Result := AddBackslash(Result) + 'Menagerie';
  end;
end;

function AnyDataSelected(): Boolean;
begin
  Result := RemoveSettings or RemoveEngines or RemoveModels or RemoveCache or RemoveLogs;
end;

function DataCheckbox(Form: TSetupForm; Caption: String; Top: Integer): TNewCheckBox;
begin
  Result := TNewCheckBox.Create(Form);
  Result.Parent := Form;
  Result.Caption := Caption;
  Result.SetBounds(ScaleX(20), ScaleY(Top), ScaleX(520), ScaleY(24));
  Result.Checked := False;
end;

function SelectDataRemoval(): Boolean;
var
  Form: TSetupForm;
  Description: TNewStaticText;
  DirectoryLabel: TNewStaticText;
  DirectoryEdit: TNewEdit;
  Settings, Engines, Models, Cache, Logs: TNewCheckBox;
  ContinueButton, CancelButton: TNewButton;
begin
  if UninstallSilent() then begin
    RemoveSettings := ExpandConstant('{param:REMOVESETTINGS|0}') = '1';
    RemoveEngines := ExpandConstant('{param:REMOVEENGINES|0}') = '1';
    RemoveModels := ExpandConstant('{param:REMOVEMODELS|0}') = '1';
    RemoveCache := ExpandConstant('{param:REMOVECACHE|0}') = '1';
    RemoveLogs := ExpandConstant('{param:REMOVELOGS|0}') = '1';
    Result := not AnyDataSelected() or (ExpandConstant('{param:CONFIRMDATAREMOVAL|0}') = '1');
    if not Result then
      SuppressibleMsgBox('Data removal requires /CONFIRMDATAREMOVAL=1. No data was removed.', mbError, MB_OK, IDOK);
    Exit;
  end;
  Form := CreateCustomForm(600, 448, True, True);
  try
    Form.Caption := 'Menagerie data removal';
    Form.Position := poScreenCenter;
    Description := TNewStaticText.Create(Form);
    Description.Parent := Form;
    Description.AutoSize := False;
    Description.WordWrap := True;
    Description.SetBounds(ScaleX(20), ScaleY(16), ScaleX(560), ScaleY(140));
    Description.Caption := 'Application files will be uninstalled. All user data is retained unless you select it below.' + #13#10 + #13#10 +
      'Selected files are permanently deleted, not moved to the Recycle Bin. External model locations are never followed. Other custom state directories are not searched.' + #13#10 + #13#10 +
      'Deleting settings loses saved references. Deleting engines/models while keeping settings leaves missing-file references that you must repair.';
    DirectoryLabel := TNewStaticText.Create(Form);
    DirectoryLabel.Parent := Form;
    DirectoryLabel.Caption := 'Data directory (only this location):';
    DirectoryLabel.SetBounds(ScaleX(20), ScaleY(162), ScaleX(560), ScaleY(18));
    DirectoryEdit := TNewEdit.Create(Form);
    DirectoryEdit.Parent := Form;
    DirectoryEdit.SetBounds(ScaleX(20), ScaleY(184), ScaleX(560), ScaleY(24));
    DirectoryEdit.ReadOnly := True;
    DirectoryEdit.Text := StateDirectory();
    Settings := DataCheckbox(Form, 'Settings, model/engine references, history and registry backups', 220);
    Engines := DataCheckbox(Form, 'Menagerie-managed engines and source-build installations', 248);
    Models := DataCheckbox(Form, 'Downloaded models (only Menagerie models\hf)', 276);
    Cache := DataCheckbox(Form, 'Engine/application caches (separate from model downloads)', 304);
    Logs := DataCheckbox(Form, 'Application and runtime logs', 332);
    ContinueButton := TNewButton.Create(Form);
    ContinueButton.Parent := Form;
    ContinueButton.Caption := 'Continue';
    ContinueButton.SetBounds(ScaleX(380), ScaleY(396), ScaleX(96), ScaleY(28));
    ContinueButton.ModalResult := mrOk;
    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.Caption := 'Cancel';
    CancelButton.SetBounds(ScaleX(484), ScaleY(396), ScaleX(96), ScaleY(28));
    CancelButton.ModalResult := mrCancel;
    CancelButton.Cancel := True;
    CancelButton.Default := True;
    Form.ActiveControl := CancelButton;
    Result := Form.ShowModal() = mrOk;
    if Result then begin
      RemoveSettings := Settings.Checked;
      RemoveEngines := Engines.Checked;
      RemoveModels := Models.Checked;
      RemoveCache := Cache.Checked;
      RemoveLogs := Logs.Checked;
    end;
  finally
    Form.Free();
  end;
end;

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
  Result := SelectDataRemoval();
  if Result then Result := StopApplication();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Parameters, Report: String;
begin
  // This event runs only after the uninstaller's final confirmation, before
  // application executables are removed. Upgrade never executes this path.
  if (CurUninstallStep = usUninstall) and AnyDataSelected() then begin
    Report := ExpandConstant('{tmp}\menagerie-data-removal.txt');
    Parameters := 'remove-data --confirm --state ' + AddQuotes(StateDirectory()) + ' --report ' + AddQuotes(Report);
    if RemoveSettings then Parameters := Parameters + ' --remove settings';
    if RemoveEngines then Parameters := Parameters + ' --remove engines';
    if RemoveModels then Parameters := Parameters + ' --remove models';
    if RemoveCache then Parameters := Parameters + ' --remove cache';
    if RemoveLogs then Parameters := Parameters + ' --remove logs';
    if not Exec(ExpandConstant('{app}\menagerie-cli.exe'), Parameters, '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      SuppressibleMsgBox('Some selected data could not be removed safely and may remain at ' + StateDirectory() + '. See the private report at ' + Report + ' before closing this uninstaller. Application removal will continue.', mbError, MB_OK, IDOK);
  end;
end;
