!macro customInit
  DetailPrint "Closing running BoardRunner instances..."
  nsExec::ExecToLog 'taskkill /IM "BoardRunner.exe" /F'
  Sleep 1000
!macroend

!macro customInstall
  DetailPrint "BoardRunner installed to $INSTDIR"
!macroend

!macro customUnInit
  DetailPrint "Closing running BoardRunner instances before uninstall..."
  nsExec::ExecToLog 'taskkill /IM "BoardRunner.exe" /F'
  Sleep 1000
!macroend
