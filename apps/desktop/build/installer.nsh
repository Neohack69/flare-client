; ===========================================================================
; installer.nsh — custom NSIS include (electron-builder `nsis.include`).
;
; WHY (найдено на машине владельца — taskbar показывал «Electron» + иконку
; Electron): «застрявший» ярлык
;   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk
; указывал на electron.exe из node_modules, но нёс НАШ AppUserModelId
; `dev.flightlog.desktop`. Windows группирует кнопку taskbar по AUMID и берёт
; имя/иконку группы из ярлыка → установленный Flare отображался как «Electron».
; Удаление этого ярлыка (и перезапуск Explorer) чинило — exe/окно/класс были ок.
;
; Поэтому при установке/обновлении/удалении сносим легаси-ярлыки, способные
; перехватить наш AUMID: dev-ярлык «Electron» и старый бренд «Touchdown Moment»
; — в меню «Пуск» ($SMPROGRAMS) и на рабочем столе ($DESKTOP). Текущий
; `Flare.lnk` НЕ трогаем (имя не совпадает). Идемпотентно, молча, некритично:
; `IfFileExists` + `Delete` (удаление отсутствующего файла ничего не делает).
; ===========================================================================

!macro flightlogRemoveLegacyAumidShortcuts
  ; Относительные переходы (+2), а не метки: макрос вставляется и в
  ; инсталлятор, и в деинсталлятор (иначе дубли меток ломают компиляцию).
  ; `IfFileExists ... 0 +2`: файл есть → 0 (без перехода) → Delete; нет → +2
  ; (пропустить Delete).
  IfFileExists "$SMPROGRAMS\Electron.lnk" 0 +2
    Delete "$SMPROGRAMS\Electron.lnk"
  IfFileExists "$SMPROGRAMS\Touchdown Moment.lnk" 0 +2
    Delete "$SMPROGRAMS\Touchdown Moment.lnk"
  IfFileExists "$DESKTOP\Electron.lnk" 0 +2
    Delete "$DESKTOP\Electron.lnk"
  IfFileExists "$DESKTOP\Touchdown Moment.lnk" 0 +2
    Delete "$DESKTOP\Touchdown Moment.lnk"
!macroend

!macro customInstall
  !insertmacro flightlogRemoveLegacyAumidShortcuts
!macroend

!macro customUnInstall
  !insertmacro flightlogRemoveLegacyAumidShortcuts
!macroend
