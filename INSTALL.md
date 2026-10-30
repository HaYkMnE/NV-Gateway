# Installing NV Gateway on Windows

**Русская версия:** [INSTALL.ru.md](INSTALL.ru.md)

> **Recommended: install from PowerShell.** Installing from PowerShell skips the browser's download warning and the "Windows protected your PC" (SmartScreen) prompt, because command-line downloads aren't tagged as coming from the internet. It does **not** skip antivirus: Microsoft Defender still scans the installer. The script checks the file's SHA256 against SHA256SUMS.txt and installs for your user only, without admin rights. It doesn't change any security settings. Note: if Smart App Control is on (Windows 11), Windows may still block the unsigned installer.

All downloads come from [github.com/HaYkMnE/NV-Gateway/releases](https://github.com/HaYkMnE/NV-Gateway/releases).

## Option 1 (recommended): one command

Open **PowerShell** (no admin needed) and run:

```powershell
irm https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/install.ps1 | iex
```

The script ([install.ps1](install.ps1), about 130 lines with comments) does this:

1. Finds the latest release.
2. Downloads `NV-Gateway-Setup-<version>.exe` and `SHA256SUMS.txt` into a temporary folder.
3. Compares the installer's SHA256 with the line for that file in `SHA256SUMS.txt`. On a mismatch it deletes the file and stops.
4. Runs the installer silently for your user: `/S /currentuser`.
5. Checks the install, deletes the temporary folder and prints the next steps.

It does not request admin rights, does not touch Microsoft Defender or the execution policy, and sends no telemetry.

## Option 2: review the script first

```powershell
irm https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Optional parameters:

| Parameter | Meaning |
|---|---|
| `-Version <version>` | Install a specific version instead of the latest. |
| `-InstallDir "D:\Apps\NV-Gateway"` | Install into a different folder (absolute path, no quotes inside). |
| `-WhatIf` | Download and verify only. Nothing is installed. |

`-ExecutionPolicy Bypass` applies only to this one PowerShell process and is not saved. It is needed because Windows client editions default to the `Restricted` policy, which blocks every `.ps1` file. You do not need `Set-ExecutionPolicy`. Option 1 needs no flag: the execution policy applies to script files, and `irm … | iex` runs the downloaded text as a command, not as a file.

## Option 3: manual, without a script

In **cmd**, set `V` to the version you want (the release tag without the leading `v`), then run the rest:

```bat
set "V=<version>"
curl.exe -L -o "%TEMP%\NV-Gateway-Setup-%V%.exe" https://github.com/HaYkMnE/NV-Gateway/releases/download/v%V%/NV-Gateway-Setup-%V%.exe
curl.exe -L -o "%TEMP%\SHA256SUMS.txt" https://github.com/HaYkMnE/NV-Gateway/releases/download/v%V%/SHA256SUMS.txt
certutil -hashfile "%TEMP%\NV-Gateway-Setup-%V%.exe" SHA256
type "%TEMP%\SHA256SUMS.txt"
"%TEMP%\NV-Gateway-Setup-%V%.exe" /S /currentuser
```

Run the last line only if the hash printed by `certutil` matches the installer's line in `SHA256SUMS.txt`.

In PowerShell, use `$env:TEMP` instead of `%TEMP%` and check the hash with:

```powershell
(Get-FileHash "$env:TEMP\NV-Gateway-Setup-<version>.exe" -Algorithm SHA256).Hash
```

To install into another folder, add `/D=D:\Apps\NV-Gateway` as the **last** argument, without quotes.

## Option 4: download in the browser

1. Download `NV-Gateway-Setup-<version>.exe` from the [releases page](https://github.com/HaYkMnE/NV-Gateway/releases/latest).
2. The browser may warn that the file is not commonly downloaded. Choose to keep it.
3. Run it. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**.

## Why does Windows warn?

The installer is not code-signed yet. Code-signing certificates cost money, and SmartScreen also builds reputation for each new version of an unsigned file, so a new release starts with no reputation. Browsers mark downloaded files as coming from the internet. SmartScreen checks marked files and warns about unsigned ones it does not recognize. The warning means "unknown publisher". It does not mean malware was found.

### Smart App Control (Windows 11)

If Smart App Control is turned on, Windows blocks unsigned programs that do not have a good reputation. This applies to every install method above, including PowerShell. We do not recommend turning Smart App Control off to install NV Gateway.

### Microsoft Defender still scans the file

Every method above only changes whether the SmartScreen prompt appears. Microsoft Defender Antivirus still scans the installer and the installed app. If Defender ever flags NV Gateway, please [open an issue](https://github.com/HaYkMnE/NV-Gateway/issues). Do not add exclusions.

## Verify

- Installer hash: compare `Get-FileHash <file> -Algorithm SHA256` (or `certutil -hashfile <file> SHA256`) with `SHA256SUMS.txt` from the same release.
- Installed version:

  ```powershell
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\9987d4f1-2bc8-5c81-b43e-1d2d04b8b929').DisplayVersion
  ```

`SHA256SUMS.txt` is published on the same GitHub release as the installer. The check catches a corrupted or swapped download. It cannot protect against a compromised release.

NV Gateway is open source, so you can also build the installer yourself: see [Build from source](DEVELOPMENT.md#build-from-source).

## After installing

Start **NV Gateway** from the Start menu. By default it listens on ports **12000** and **12001** on localhost. See the [README](README.md) for setup.

## Uninstall

- **Settings → Apps → Installed apps → NV-Gateway → Uninstall**, or
- run `Uninstall NV-Gateway.exe` in the install folder. For a silent uninstall, add `/currentuser /S`. To find the exact command:

  ```powershell
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\9987d4f1-2bc8-5c81-b43e-1d2d04b8b929').QuietUninstallString
  ```

The uninstaller removes the program. Your settings and data stay in `%APPDATA%\NV-Gateway`. Delete that folder by hand if you want to remove them too.
