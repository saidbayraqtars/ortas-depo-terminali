; Terminaller bu bilgisayardaki sunucuya bağlanır: Windows Güvenlik Duvarı'nda programa gelen bağlantı izni.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Ortas Depo Yonetici"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Ortas Depo Yonetici" dir=in action=allow program="$INSTDIR\OrtasDepoYonetici.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Ortas Depo Yonetici"'
!macroend
