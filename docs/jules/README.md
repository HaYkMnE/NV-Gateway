# Руководство по 3-Агентному Автономному Циклу Jules (Архитектурная спецификация — Отключено)

> **ВНИМАНИЕ:** Автономный цикл Jules в настоящее время **ОТКЛЮЧЕН** (`AUTONOMOUS_LOOP_ENABLED != true`) и никогда не подключался к рабочей среде. Данная документация сохранена исключительно в качестве архитектурного описания и проектного справочника. Не пытайтесь включать или «чинить» интеграцию в коде.

## 1. Обзор Архитектуры 3-Агентного Цикла

Автономная система Jules на базе Google Jules AI Agents и GitHub Actions реализует полный цикл непрерывного мониторинга, разработки и контроля качества исходного кода.

```
                     +---------------------------+
                     |    1. Log Analyst         |
                     |   (Мозг / The Brain)      |
                     +-------------+-------------+
                                   |
                         Создает Issue с JSON
                                   v
                     +---------------------------+
                     |    2. Developer           |
                     |   (Руки / The Hands)      |
                     +-------------+-------------+
                                   |
                         Создает Pull Request
                                   v
                     +---------------------------+
                     |    3. Bug Hunter          |
                     |  (Страж / The Gatekeeper) |
                     +---------------------------+
```

---

### Описание Ролей Агентов

#### 1. Log Analyst (Мозг / The Brain)
- **Файл workflow**: `.github/workflows/autonomous-analysis.yml`
- **Режим работы**: Запускается по расписанию (cron) или по событию `workflow_dispatch`.
- **Обязанности**: 
  - Анализирует файлы телеметрии (например, `telemetry-bundle.json`) в корне репозитория на предмет ошибок сети (502/504), таймаутов и сбоев.
  - В случае чистого лога выполняет упреждающий аудит репозитория: поиск технического долга, узких мест производительности и нарушений архитектуры.
  - Формирует строгий JSON-пайлоад по схеме `.jules/schemas/analyst-to-developer.schema.json` и автоматически создает задачу (GitHub Issue) для разработчика.

#### 2. Developer (Руки / The Hands)
- **Файл workflow**: `.github/workflows/autonomous-developer.yml`
- **Режим работы**: Реактивный, триггерится событием `issues: [opened]`.
- **Обязанности**:
  - Считывает JSON-структуру задачи из созданного Issue.
  - Запускает локальное окружение, пишет регрессионный тест, воспроизводящий или проверяющий проблему.
  - Реализует исправляющий код или оптимизацию.
  - Формирует Pull Request (PR) в ветку `main` с обязательным предоставлением доказательств с точными хэшами коммитов (Exact-SHA Evidence).

#### 3. Bug Hunter (Страж / The Gatekeeper)
- **Файл workflow**: `.github/workflows/autonomous-change.yml`
- **Режим работы**: Реактивный, триггерится событиями `pull_request: [opened, synchronize, reopened]`.
- **Обязанности**:
  - Выполняет двухэтапную проверку полученного PR: сначала проходит шаг `build-and-test`.
  - Запускает агента Bug Hunter (`google-labs-code/jules-action@v1.0.0` или REST API).
  - Применяет **Правило 2 чистых прогонов (2 CLEAN passes)** на неизмененном дереве кода.
  - При обнаружении дефектов оставляет отзыв в PR с запросом изменений (Request Changes). При успешном прохождении всех тестов — утверждает PR (Approve).

---

## 2. Разбор 5 Критических Ловушек (Critical Traps) и Способы Их Обхода

При развертывании и эксплуатации автономного цикла Jules возникают 5 ключевых технических ловушек. Ниже приведен детальный разбор причин и решений для каждой.

### Ловушка 1: Ошибка HTTP 404 / Несуществующий Action Reference / Mismatch REST Endpoints
* **Симптомы**: Ошибка `Action google-labs-code/jules-invoke@v1.0.0 not found` (404) в логах GitHub Actions или статус ответа `HTTP 404` при запросе к `jules.googleapis.com`.
* **Причина**: Использование устаревшего или некорректного имени экшена (например, `jules-invoke@v1` вместо официального) либо обращения к устаревшим REST эндпоинтам.
* **Решение**:
  1. В YAML-файлах задействовать официальный экшен: **`google-labs-code/jules-action@v1.0.0`**.
  2. При прямом вызове REST API применять актуальную конечную точку `https://jules.googleapis.com/v1alpha/sessions` с передачей API-ключа в заголовке `X-Goog-Api-Key: ${JULES_KEY}`.

### Ловушка 2: Ошибка Exit Code 126 (Permission Denied / Denied Execution)
* **Симптомы**: Завершение шага CI с кодом `Process completed with exit code 126`.
* **Причина**: В Linux-окружении (`ubuntu-latest`) у запускаемых скриптов или бинарных утилит отсутствуют флаги исполнения (`chmod +x`), либо утилита запускается напрямую без shell-интерпретатора.
* **Решение**:
  1. Перед вызовом скриптов добавлять шаг назначения прав: `run: chmod +x ./scripts/*.sh`.
  2. Запускать скрипты Node/TypeScript через соответствующие интерпретаторы: `npx tsx scripts/.../script.ts` или `node script.js`.

### Ловушка 3: Бесконечный Цикл PAT (PAT Loop Protection / Infinite Triggering)
* **Симптомы**: Бот Jules создает PR или Issue, что заново вызывает `on: pull_request` или `on: issues`, приводя к зацикливанию вызовов workflows и мгновенному исчерпанию лимитов API.
* **Причина**: Стандартный `GITHUB_TOKEN` не вызывает повторные триггеры GitHub Actions. Однако при использовании стороннего Personal Access Token (`JULES_GITHUB_PAT`) все действия, совершенные с этим PAT, GitHub трактует как пользовательские события и снова запускает воркфлоу.
* **Решение**:
  1. Внедрять строгую фильтрацию по актору в условии джоба: `if: github.actor != 'jules-bot' && vars.AUTONOMOUS_LOOP_ENABLED == 'true'`.
  2. При автоматическом создании коммитов и PR добавлять метку `[skip ci]` в заголовок коммита.
  3. Проверять переменную окружения `vars.AUTONOMOUS_LOOP_ENABLED` в каждом джобе.

### Ловушка 4: Матрица Операционных Систем (OS Runner Matrix Mismatch)
* **Симптомы**: Тесты или сборка падают с ошибками отсутствия команд (`mkdir`, `rm`, `cat`), различий в разделителях путей (`/` vs `\`) или несовместимости бинарников Electron/Node.
* **Причина**: Воркфлоу `autonomous-change.yml` запускает шаг сборки на `windows-latest` (требуется для специфичных Windows-сборок GUI/Electron и взаимодействия с `C:\OPENCODE-SANDBOX`), в то время как Analyst и Developer исполняются на `ubuntu-latest`.
* **Решение**:
  1. Использовать кроссплатформенные утилиты Node.js (`path.join()`, `fs.mkdirSync()`) вместо жестко завязанных shell-команд ОС.
  2. На Windows-раннерах явно указывать `shell: powershell` или `bash`.
  3. Для скриптов очистки и создания папок использовать утилиты типа `mkdir -p` (поддерживается в Git Bash / PowerShell 7+).

### Ловушка 5: Пути Песочницы C:\OPENCODE-SANDBOX (Sandbox Paths Mismatch)
* **Симптомы**: Ошибка `ENOENT: no such file or directory, open 'C:\OPENCODE-SANDBOX\...'` при запуске на Ubuntu-раннере.
* **Причина**: Твердо заданные абсолютные Windows-пути `C:\OPENCODE-SANDBOX` в коде тестов или скриптах сборки, которые не существуют в окружении Linux.
* **Решение**:
  1. Реализовать динамическое определение директории песочницы:
     ```javascript
     const sandboxDir = process.platform === 'win32' 
       ? 'C:\\OPENCODE-SANDBOX' 
       : '/tmp/opencode-sandbox';
     ```
  2. В шагах GitHub Actions гарантировать создание каталога перед сборкой:
     - На Windows: `run: mkdir -p C:\OPENCODE-SANDBOX`
     - На Linux: `run: mkdir -p /tmp/opencode-sandbox`

---

## 3. Пошаговая Инструкция по Настройке UI (Click Paths)

Для полноценной работы автономного цикла необходимо выполнить настройку в портале Google Jules и в настройках репозитория GitHub.

### Часть А: Настройка API-ключей в jules.google.com

1. Откройте браузер и перейдите по адресу: **[https://jules.google.com](https://jules.google.com)**
2. Выполните вход (Sign In) с помощью вашей учетной записи Google / Google Cloud.
3. В правом верхнем углу кликните по аватару профиля и выберите **Settings** (Настройки).
4. В левом боковом меню перейдите в раздел **API Keys & Integrations** (API-ключи и Интеграции).
5. Нажмите синюю кнопку **Generate New API Key** (Создать новый API-ключ).
6. Создайте 3 отдельных ключа для разделения полномочий и логирования:
   - Ключ 1: Назовите `Jules-Log-Analyst` -> нажмите **Create** -> Скопируйте значение.
   - Ключ 2: Назовите `Jules-Developer` -> нажмите **Create** -> Скопируйте значение.
   - Ключ 3: Назовите `Jules-Bug-Hunter` -> нажмите **Create** -> Скопируйте значение.
7. Сохраните полученные строки API-ключей во временный защищенный буфер.

---

### Часть Б: Создание GitHub Personal Access Token (PAT)

1. Откройте **[https://github.com](https://github.com)** и войдите в свой аккаунт.
2. Кликните на аватар профиля в правом верхнем углу -> выберите **Settings**.
3. Прокрутите меню слева до самого низа и нажмите **Developer settings**.
4. Выберите пункт **Personal access tokens** -> нажмите **Tokens (classic)**.
5. Нажмите кнопку **Generate new token** -> выберите **Generate new token (classic)**.
6. Заполните поля:
   - **Note**: `JULES_AUTONOMOUS_LOOP_PAT`
   - **Expiration**: Выберите `No expiration` или нужный срок.
   - **Select scopes** (выберите галочками):
     - `repo` (Full control of private repositories) — полный доступ к репозиторию.
     - `workflow` (Update GitHub Action workflows) — возможность управления воркфлоу.
     - `write:packages` — запись пакетов (при необходимости).
     - `issues:write` — создание и редактирование задач.
     - `pull_requests:write` — управление PR.
7. Нажмите зеленую кнопку **Generate token** внизу страницы.
8. **Важно**: Скопируйте токен (начинается с `ghp_`). Он отображается только один раз!

---

### Часть В: Конфигурация Secrets и Variables в GitHub Репозитории

1. Перейдите на главную страницу вашего репозитория: `https://github.com/<owner>/<repo>`.
2. В верхнем меню репозитория кликните на вкладку **Settings** (Настройки репозитория).
3. В левом боковом меню разверните пункт **Secrets and variables** и выберите **Actions**.

#### Добавление Секретов (Repository Secrets):
1. В секции **Repository secrets** нажмите кнопку **New repository secret**.
2. Добавьте 4 секрета по очереди:

   * **Секрет 1**:
     - Name: `JULES_GITHUB_PAT`
     - Secret: Вставьте скопированный токен GitHub PAT (`ghp_...`).
     - Нажмите **Add secret**.

   * **Секрет 2**:
     - Name: `JULES_LOG_ANALYST_API_KEY`
     - Secret: Вставьте API-ключ для Log Analyst из jules.google.com.
     - Нажмите **Add secret**.

   * **Секрет 3**:
     - Name: `JULES_DEVELOPER_API_KEY`
     - Secret: Вставьте API-ключ для Developer из jules.google.com.
     - Нажмите **Add secret**.

   * **Секрет 4**:
     - Name: `JULES_BUG_HUNTER_API_KEY`
     - Secret: Вставьте API-ключ для Bug Hunter из jules.google.com.
     - Нажмите **Add secret**.

#### Добавление Переменных (Repository Variables):
1. На этой же странице переключитесь на вкладку **Variables** (рядом с Secrets).
2. Нажмите кнопку **New repository variable**.
3. Заполните поля:
   - Name: `AUTONOMOUS_LOOP_ENABLED`
   - Value: `true`
4. Нажмите **Add variable**.

---

## 4. Проверка и Ручной Запуск (Verification & Run)

1. Откройте вкладку **Actions** в репозитории GitHub.
2. В левом списке воркфлоу выберите **Autonomous Analysis**.
3. Нажмите кнопку **Run workflow** -> выберите ветку `main` -> нажмите **Run workflow**.
4. Убедитесь, что воркфлоу успешно создаст задачу (Issue) и запустит автономную цепочку обработки.
