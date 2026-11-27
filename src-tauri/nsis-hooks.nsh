; A local update never terminates the running application or its background worker.
!macro NC_REQUIRE_STOPPED NAME
  nsis_tauri_utils::FindProcess "${NAME}"
  Pop $0
  ${If} $0 = 0
    Abort "Finish running NoobClawMatrix tasks and exit the application normally, then retry."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $0
  !insertmacro NC_REQUIRE_STOPPED "noobclaw.exe"
  !insertmacro NC_REQUIRE_STOPPED "noobclaw-server.exe"
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NSIS_HOOK_PREINSTALL
!macroend
