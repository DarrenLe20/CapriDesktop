; Cyberpunk 2077 look for the NSIS installer (included by electron-builder, see electron-builder.yml).
; Colors and texts are defined in customWelcomePage because it is inserted before any other page,
; which is where MUI2 reads its interface settings. The texts are LangStrings declared in
; customHeader, which runs after the languages are loaded.

!macro customWelcomePage
  !define MUI_BGCOLOR "0A0A0F"
  !define MUI_TEXTCOLOR "FCEE0A"
  !define MUI_INSTFILESPAGE_COLORS "FCEE0A 0A0A0F"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
  !define MUI_WELCOMEPAGE_TITLE "$(capriWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(capriWelcomeText)"
  !define MUI_FINISHPAGE_TITLE "$(capriFinishTitle)"
  !define MUI_FINISHPAGE_TEXT "$(capriFinishText)"
  !define MUI_FINISHPAGE_RUN_TEXT "$(capriFinishRun)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Same finish page electron-builder builds by default, plus a show callback: the "run Capri" checkbox
; is drawn by the Windows theme, which ignores MUI_TEXTCOLOR and left its text dark on the dark
; background. Dropping the theme on that one control lets SetCtlColors paint it.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW capriFinishShow
  !insertmacro MUI_PAGE_FINISH

  ; Defined after the page because MUI_PAGE_FINISH is what declares $mui.FinishPage.Run
  Function capriFinishShow
    StrCpy $0 $mui.FinishPage.Run
    System::Call 'UxTheme::SetWindowTheme(p r0, w "", w "")'
    SetCtlColors $0 "FCEE0A" "0A0A0F"
  FunctionEnd
!macroend

!macro customUnWelcomePage
  !define MUI_BGCOLOR "0A0A0F"
  !define MUI_TEXTCOLOR "FF003C"
  !define MUI_INSTFILESPAGE_COLORS "FF003C 0A0A0F"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
  !define MUI_WELCOMEPAGE_TITLE "$(capriUnTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(capriUnText)"
  !define MUI_FINISHPAGE_TITLE "$(capriUnFinishTitle)"
  !define MUI_FINISHPAGE_TEXT "$(capriUnFinishText)"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; Only when the user uninstalls by hand: an update also runs the old uninstaller, and it must keep everything.
; cyber-companion is left out on purpose: it's the data of whoever runs her from source too.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent capriKeepData
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(capriUnDeleteData)" IDNO capriKeepData
    SetShellVarContext current
    RMDir /r "$APPDATA\capridesktop"
    RMDir /r "$APPDATA\Cyber Companion"
    capriKeepData:
  ${endIf}
!macroend

!macro customHeader
  LangString capriWelcomeTitle ${LANG_SPANISHINTERNATIONAL} "Capri se está conectando a tu PC"
  LangString capriWelcomeTitle ${LANG_ENGLISH} "Capri is jacking into your PC"
  LangString capriWelcomeText ${LANG_SPANISHINTERNATIONAL} "Este asistente va a instalar a Capri, Project Capricorn: tu compañera netrunner de escritorio.$\r$\n$\r$\nCuando termine, Capri se presenta, te pregunta cómo llamarte y prepara su voz y su cerebro.$\r$\n$\r$\nAgarrate, choom: se viene el caos."
  LangString capriWelcomeText ${LANG_ENGLISH} "This wizard will install Capri, Project Capricorn: your netrunner desktop companion.$\r$\n$\r$\nWhen it's done, Capri introduces herself, asks what to call you and sets up her voice and brain.$\r$\n$\r$\nBuckle up, choom: chaos incoming."
  LangString capriFinishTitle ${LANG_SPANISHINTERNATIONAL} "Capri está online"
  LangString capriFinishTitle ${LANG_ENGLISH} "Capri is online"
  LangString capriFinishText ${LANG_SPANISHINTERNATIONAL} "La instalación terminó.$\r$\n$\r$\nCapri te está esperando en el escritorio para presentarse."
  LangString capriFinishText ${LANG_ENGLISH} "Installation complete.$\r$\n$\r$\nCapri is waiting on your desktop to introduce herself."
  LangString capriFinishRun ${LANG_SPANISHINTERNATIONAL} "Despertar a Capri ahora"
  LangString capriFinishRun ${LANG_ENGLISH} "Wake Capri up now"
  LangString capriUnTitle ${LANG_SPANISHINTERNATIONAL} "¿Desconectar a Capri?"
  LangString capriUnTitle ${LANG_ENGLISH} "Disconnect Capri?"
  LangString capriUnText ${LANG_SPANISHINTERNATIONAL} "Este asistente va a quitar a Capri de tu PC.$\r$\n$\r$\nTu nombre, los dibujos que aprendió y su configuración quedan guardados por si volvés, choom."
  LangString capriUnText ${LANG_ENGLISH} "This wizard will remove Capri from your PC.$\r$\n$\r$\nYour name, the drawings she learned and her settings stay saved in case you come back, choom."
  LangString capriUnFinishTitle ${LANG_SPANISHINTERNATIONAL} "Link terminado"
  LangString capriUnFinishTitle ${LANG_ENGLISH} "Link terminated"
  LangString capriUnDeleteData ${LANG_SPANISHINTERNATIONAL} "¿Borrar también tus datos de Capri?$\r$\n$\r$\nSe borran tus memorias, ajustes, macros y API keys, y no se puede deshacer. Los modelos de Ollama no se tocan."
  LangString capriUnFinishText ${LANG_SPANISHINTERNATIONAL} "Capri se desconectó de tu PC. Nos vemos en Night City."
  LangString capriUnDeleteData ${LANG_ENGLISH} "Delete your Capri data too?$\r$\n$\r$\nThis deletes your memories, settings, macros and API keys, and can't be undone. Ollama's models aren't touched."
  LangString capriUnFinishText ${LANG_ENGLISH} "Capri has disconnected from your PC. See you in Night City."
  LangString capriWelcomeTitle ${LANG_JAPANESE} "カプリがあなたのPCに接続しています"
  LangString capriWelcomeText ${LANG_JAPANESE} "このウィザードは、デスクトップの相棒ネットランナー、カプリ (Project Capricorn) をインストールします。$\r$\n$\r$\n完了後、カプリが自己紹介し、呼び名を聞いて、声と頭脳を準備します。$\r$\n$\r$\nしっかりつかまって、チューマ。カオスが来るよ。"
  LangString capriFinishTitle ${LANG_JAPANESE} "カプリ、オンライン"
  LangString capriFinishText ${LANG_JAPANESE} "インストールが完了しました。$\r$\n$\r$\nカプリがデスクトップで自己紹介を待っています。"
  LangString capriFinishRun ${LANG_JAPANESE} "今すぐカプリを起こす"
  LangString capriUnTitle ${LANG_JAPANESE} "カプリを切断しますか？"
  LangString capriUnText ${LANG_JAPANESE} "このウィザードはカプリをPCから削除します。$\r$\n$\r$\n名前、覚えた絵、設定は、戻ってきたときのために保存されます、チューマ。"
  LangString capriUnFinishTitle ${LANG_JAPANESE} "リンク終了"
  LangString capriUnDeleteData ${LANG_JAPANESE} "カプリのデータも削除しますか?$\r$\n$\r$\n記憶、設定、マクロ、APIキーが削除され、元に戻せません。Ollamaのモデルはそのまま残ります。"
  LangString capriUnFinishText ${LANG_JAPANESE} "カプリはPCから切断されました。ナイトシティでまた会おう。"
!macroend
