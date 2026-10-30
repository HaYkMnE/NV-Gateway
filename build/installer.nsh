# NV-Gateway custom NSIS include.
#
# Wired through electron-builder.yml `nsis.include`. Resolved relative to the
# default buildResources directory (build/), so this file is the `installer.nsh`
# electron-builder picks up without any other config.
#
# Two upstream behaviours are corrected here. Both were measured by reading the
# shipping templates (first in app-builder-lib 24.13.3; line refs re-checked against 26.18.0), not guessed.

# ─────────────────────────────────────────────────────────────────────────────
# 1. UNINSTALL: remove the app's autostart entry.
#
# MEASURED DEFECT: uninstalling leaves
#   HKCU\Software\Microsoft\Windows\CurrentVersion\Run\electron.app.NV-Gateway
# behind. Grepping every template under app-builder-lib/templates/nsis for
# `CurrentVersion\Run` returns nothing, and the repo ships no custom .nsh, so
# nothing ever removed it. The orphaned value survives the uninstall and points
# at an executable that no longer exists: Windows tries to launch it at every
# logon, fails, and the user is left with a broken autostart they cannot find in
# any UI.
#
# The value is written by Electron's app.setLoginItemSettings (src/main/index.ts
# calls it with loginItemPath(app.getPath("exe"))), so its name is Electron's
# fixed "electron.app.<productName>" form and its data is the quoted exe path.
#
# ONLY this app's values are touched: the value name is the full literal, never
# a prefix match, and the parent key is never deleted.
#
# StartupApproved is the second half: Windows records the user's
# enable/disable choice for each Run entry under Explorer\StartupApproved\Run.
# Leaving that behind means a future install of the same app inherits a stale
# "disabled" bit and silently never starts at logon.
# ─────────────────────────────────────────────────────────────────────────────
!macro customUnInstall
  # REAL UNINSTALL ONLY. An update also runs this macro: the new installer runs
  # the PREVIOUS version's uninstaller with --updated (installUtil.nsh:205-206,
  # "always pass --updated flag"). The app writes the Run value only when the
  # user flips the switch (src/main/index.ts setLoginItemSettings) and never
  # re-creates it at startup, so deleting it here on an update silently dropped
  # the user's autostart on every update. ${isUpdated} is defined for the
  # uninstaller too: NsisTarget.js:688 emits it via scriptGenerator.flags([
  # "updated", ...]) into the shared header that both the installer and the
  # BUILD_UNINSTALLER pass compile (NsisTarget.js:688, :461/:487), and the template
  # itself uses it in the uninstall section (uninstaller.nsh:224).
  ${ifNot} ${isUpdated}
    # Per-user autostart: this is where Electron writes, and it is the only place
    # that matters here — nsis.perMachine is false, so the installer never creates
    # a machine-wide entry.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.NV-Gateway"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.NV-Gateway"

    # Defensive mirror for a machine-wide install of the same app (an older or
    # hand-made one). Deleting an absent value is a no-op, so this costs nothing
    # when the value was never there. The registry view is left exactly as
    # check64BitAndSetRegView set it: the uninstaller's own key deletion runs
    # before this macro and must not have its view changed underneath it.
    #
    # ClearErrors is load-bearing, not tidiness. DeleteRegValue on a value that does
    # not exist sets the NSIS error flag, and this mirror is EXPECTED to find nothing
    # on the normal per-user install (nsis.perMachine is false, so nothing ever
    # writes an HKLM Run value). Without clearing it, the flag is still set when the
    # uninstaller continues, and electron-builder's own uninstall section aborts or
    # reports a failed uninstall on a completely healthy install — every per-user
    # uninstall would look broken. Clearing the flag after the expected-absent delete
    # leaves the following HKLM delete to set it again if IT fails, so a real error
    # is still visible.
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.NV-Gateway"
    ClearErrors
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.NV-Gateway"
    ClearErrors
  ${endIf}
!macroend

# ─────────────────────────────────────────────────────────────────────────────
# 2. INSTALL: guarantee the desktop shortcut exists.
#
# MEASURED DEFECT: `createDesktopShortcut: true` is present in
# electron-builder.yml, yet no NV-Gateway.lnk exists on the desktop.
#
# The config value is NOT the bug, so changing it would not fix anything. Read
# out of the shipping templates:
#
#   app-builder-lib/out/options/CommonWindowsInstallerConfiguration.js
#     convertToDesktopShortcutCreationPolicy: true -> FRESH_INSTALL
#     (only the string "always" yields ALWAYS; false yields NEVER)
#
#   templates/nsis/installSection.nsh:40-50
#     $keepShortcuts starts "false" and becomes "true" only when
#     $isTryToKeepShortcuts == "true" AND the registry says KeepShortcuts AND
#     the exe already exists. installUtil.nsh:86-92 sets $isTryToKeepShortcuts
#     to "true" ONLY when the run is an UPDATE (${isUpdated}) — with
#     allowToChangeInstallationDirectory: true, a fresh install forces "false".
#
#   templates/nsis/include/installer.nsh:216-247 (addDesktopLink)
#     keepShortcuts == "false"  -> CreateShortCut, unconditionally.
#     keepShortcuts == "true"   -> rename an existing link, or recreate it ONLY
#                                  ${ifNot} ${isUpdated}.
#
# So on an UPDATE, an absent desktop link is deliberately never recreated. That
# is exactly the observed state: the registry carries KeepShortcuts=true
# (HKCU\Software\<appId>), the install directory holds the app, and the desktop
# has no link. Every installer-driven update therefore keeps it missing forever.
# `createDesktopShortcut: always` does not help either: it only defines
# RECREATE_DESKTOP_SHORTCUT, which reaches the same ${ifNot} ${isUpdated} guard.
#
# This macro runs at the end of the install section (installSection.nsh:81-83),
# after addDesktopLink has had its turn, so it only fills in a link that is
# genuinely absent. An existing link — including one the user moved or renamed
# within the same name — is left exactly as it is.
#
# $DESKTOP is resolved by NSIS through the shell's own known folder, so a
# OneDrive-redirected desktop is followed automatically; there is no hardcoded
# path here to drift from it.
# ─────────────────────────────────────────────────────────────────────────────
!macro customInstall
  ; Respect an explicit "never". electron-builder defines
  ; DO_NOT_CREATE_DESKTOP_SHORTCUT at COMPILE time when the config says false,
  ; and ${isNoDesktopShortcut} is a RUNTIME flag the user can pass. Either one
  ; means the link must not exist, so this repair must not override them.
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      ${ifNot} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endIf}
    ${endIf}
  !endif
!macroend
