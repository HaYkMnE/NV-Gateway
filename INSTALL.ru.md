# Установка NV Gateway в Windows

**English version:** [INSTALL.md](INSTALL.md)

> **Рекомендуется: установка из PowerShell.** Установка из PowerShell пропускает предупреждение браузера о загрузке и окно SmartScreen «Система Windows защитила ваш компьютер», потому что загрузки из командной строки не помечаются как полученные из интернета. Антивирусную проверку она **не** пропускает: Microsoft Defender всё равно проверяет установщик. Скрипт сверяет SHA256 файла с SHA256SUMS.txt и ставит программу только для текущего пользователя, без прав администратора. Настройки безопасности он не меняет. Важно: если в Windows 11 включён Smart App Control, Windows всё равно может заблокировать неподписанный установщик.

Все файлы скачиваются только с [github.com/HaYkMnE/NV-Gateway/releases](https://github.com/HaYkMnE/NV-Gateway/releases).

## Способ 1 (рекомендуется): одна команда

Откройте **PowerShell** (права администратора не нужны) и выполните:

```powershell
irm https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/install.ps1 | iex
```

Скрипт ([install.ps1](install.ps1), около 130 строк с комментариями) делает следующее:

1. Определяет последний релиз.
2. Скачивает `NV-Gateway-Setup-<версия>.exe` и `SHA256SUMS.txt` во временную папку.
3. Сравнивает SHA256 установщика со строкой для этого файла в `SHA256SUMS.txt`. Если хеш не совпал, удаляет файл и останавливается.
4. Запускает установщик в тихом режиме для текущего пользователя: `/S /currentuser`.
5. Проверяет установку, удаляет временную папку и выводит дальнейшие шаги.

Скрипт не запрашивает права администратора, не трогает Microsoft Defender и политику выполнения и не отправляет телеметрию.

## Способ 2: сначала прочитать скрипт

```powershell
irm https://raw.githubusercontent.com/HaYkMnE/NV-Gateway/main/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Необязательные параметры:

| Параметр | Что делает |
|---|---|
| `-Version <версия>` | Ставит указанную версию вместо последней. |
| `-InstallDir "D:\Apps\NV-Gateway"` | Ставит в другую папку (абсолютный путь, без кавычек внутри). |
| `-WhatIf` | Только скачивает и проверяет. Ничего не устанавливает. |

`-ExecutionPolicy Bypass` действует только на этот один процесс PowerShell и никуда не сохраняется. Он нужен потому, что в клиентских версиях Windows по умолчанию действует политика `Restricted`, которая запрещает любые `.ps1`-файлы. `Set-ExecutionPolicy` не нужен. Способу 1 флаг не нужен: политика выполнения касается файлов скриптов, а `irm … | iex` выполняет скачанный текст как команду, а не как файл.

## Способ 3: вручную, без скрипта

В **cmd** задайте `V` — нужную версию (тег релиза без буквы `v`), затем выполните остальное:

```bat
set "V=<версия>"
curl.exe -L -o "%TEMP%\NV-Gateway-Setup-%V%.exe" https://github.com/HaYkMnE/NV-Gateway/releases/download/v%V%/NV-Gateway-Setup-%V%.exe
curl.exe -L -o "%TEMP%\SHA256SUMS.txt" https://github.com/HaYkMnE/NV-Gateway/releases/download/v%V%/SHA256SUMS.txt
certutil -hashfile "%TEMP%\NV-Gateway-Setup-%V%.exe" SHA256
type "%TEMP%\SHA256SUMS.txt"
"%TEMP%\NV-Gateway-Setup-%V%.exe" /S /currentuser
```

Последнюю строку выполняйте, только если хеш от `certutil` совпал со строкой установщика в `SHA256SUMS.txt`.

В PowerShell используйте `$env:TEMP` вместо `%TEMP%`, а хеш проверяйте так:

```powershell
(Get-FileHash "$env:TEMP\NV-Gateway-Setup-<версия>.exe" -Algorithm SHA256).Hash
```

Чтобы поставить в другую папку, добавьте `/D=D:\Apps\NV-Gateway` **последним** аргументом, без кавычек.

## Способ 4: скачать в браузере

1. Скачайте `NV-Gateway-Setup-<версия>.exe` со [страницы релизов](https://github.com/HaYkMnE/NV-Gateway/releases/latest).
2. Браузер может предупредить, что файл скачивают редко. Выберите «Сохранить».
3. Запустите файл. Если появится окно **«Система Windows защитила ваш компьютер»**, нажмите **«Подробнее»**, затем **«Выполнить в любом случае»**.

## Почему Windows предупреждает?

Установщик пока не подписан сертификатом разработчика. Такой сертификат стоит денег, а для неподписанного файла SmartScreen набирает репутацию заново с каждой новой версией, поэтому свежий релиз начинает без репутации. Браузеры помечают скачанные файлы как полученные из интернета. SmartScreen проверяет такие файлы и предупреждает о незнакомых неподписанных программах. Предупреждение означает «неизвестный издатель». Оно не означает, что найден вирус.

### Smart App Control (Windows 11)

Если включён Smart App Control, Windows блокирует неподписанные программы без хорошей репутации. Это касается всех способов выше, включая PowerShell. Отключать Smart App Control ради установки NV Gateway мы не советуем.

### Microsoft Defender всё равно проверяет файл

Все способы выше влияют только на то, появится ли окно SmartScreen. Антивирус Microsoft Defender всё равно проверяет установщик и установленную программу. Если Defender когда-нибудь отметит NV Gateway, пожалуйста, [создайте issue](https://github.com/HaYkMnE/NV-Gateway/issues). Не добавляйте исключения.

## Проверка

- Хеш установщика: сравните `Get-FileHash <файл> -Algorithm SHA256` (или `certutil -hashfile <файл> SHA256`) с `SHA256SUMS.txt` из того же релиза.
- Установленная версия:

  ```powershell
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\9987d4f1-2bc8-5c81-b43e-1d2d04b8b929').DisplayVersion
  ```

`SHA256SUMS.txt` лежит в том же релизе GitHub, что и установщик. Проверка ловит повреждённую или подменённую загрузку, но не защищает от взлома самого релиза.

Код NV Gateway открыт, поэтому установщик можно собрать и самому: см. [Сборка из исходников](README.ru.md#сборка-из-исходников).

## После установки

Запустите **NV Gateway** из меню «Пуск». По умолчанию программа слушает порты **12000** и **12001** на localhost. Настройка описана в [README](README.ru.md).

## Удаление

- **Параметры → Приложения → Установленные приложения → NV-Gateway → Удалить**, или
- запустите `Uninstall NV-Gateway.exe` в папке установки. Для тихого удаления добавьте `/currentuser /S`. Точная команда:

  ```powershell
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\9987d4f1-2bc8-5c81-b43e-1d2d04b8b929').QuietUninstallString
  ```

Деинсталлятор удаляет программу. Настройки и данные остаются в `%APPDATA%\NV-Gateway`. Если хотите удалить и их, удалите эту папку вручную.
