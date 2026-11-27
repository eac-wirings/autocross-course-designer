; Track Builder was called "Autocross Course Designer" before 1.0. Windows keys
; installs by product name, so installing Track Builder would leave the old
; app (and its shortcuts) behind. After a successful install, remove the old
; one silently. Course data is kept: it lives under the unchanged app identifier.
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $R9 "$LOCALAPPDATA\Autocross Course Designer"
  IfFileExists "$R9\uninstall.exe" 0 old_app_done
    ExecWait '"$R9\uninstall.exe" /S _?=$R9'
    Delete "$R9\uninstall.exe"
    RMDir "$R9"
  old_app_done:
!macroend
