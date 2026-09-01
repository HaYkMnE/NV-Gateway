# Руководство по устранению ошибок Jules (Архитектурный справочник — Отключено)

> **ВНИМАНИЕ:** Автономный цикл Jules в настоящее время **ОТКЛЮЧЕН** и никогда не подключался. Данный документ содержит архивные описания типовых сценариев и предназначен исключительно для архитектурно-справочного использования.

В данном руководстве описаны причины, симптомы, способы диагностики и решения 5 распространенных ошибок, возникающих при настройке и использовании Google Jules в GitHub Actions и локальном окружении.

---

## Содержание

1. [Ошибка 1: 404 NOT_FOUND при обращении к /v1alpha/sessions](#ошибка-1-404-not_found-при-обращении-к-v1alphasessions)
2. [Ошибка 2: Exit Code 126 в GitHub Actions](#ошибка-2-exit-code-126-в-github-actions)
3. [Ошибка 3: Бесконечный цикл выполнения после работы роли Analyst](#ошибка-3-бесконечный-цикл-выполнения-после-работы-роли-analyst)
4. [Ошибка 4: ENOENT: no such file or directory, mkdtemp 'C:\OPENCODE-SANDBOX\...'](#ошибка-4-enoent-no-such-file-or-directory-mkdtemp-copencode-sandbox)
5. [Ошибка 5: 401 Unauthorized при проверке API-ключа](#ошибка-5-401-unauthorized-при-проверке-api-ключа)

---

## Ошибка 1: 404 NOT_FOUND при обращении к `/v1alpha/sessions`

### Симптомы
При выполнении REST-запроса к Google Jules API на создание сессии (`/v1alpha/sessions`) возвращается ошибка со статусом HTTP 404:
```json
{
  "error": {
    "code": 404,
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND"
  }
}
```

### Причина
GitHub App Jules установлен в аккаунте GitHub, но целевой репозиторий не выбран и не разрешен в настройках источника на веб-портале [jules.google.com](https://jules.googleapis.com/) ("Configure repos for @user"). Без этого запрос не может идентифицировать данный репозиторий как доступный источник (source).

### Диагностика
Выполните REST-запрос к API для получения списка доступных источников:
```bash
curl -H "x-goog-api-key: YOUR_JULES_API_KEY" https://jules.googleapis.com/v1alpha/sources
```
Если ответ возвращает пустой список `{}` или в списке отсутствует целевой репозиторий, проблема заключается в настройках подключения.

### Решение
1. Перейдите в веб-интерфейс [jules.google.com](https://jules.googleapis.com/).
2. Откройте настройки доступа к репозиториям (**"Configure repos for @username"**).
3. Выберите целевой репозиторий вручную.
4. Нажмите кнопку **Save**.
5. Проверьте повторно доступность репозитория через `curl` и убедитесь в наличии репозитория в списке источников.

---

## Ошибка 2: Exit Code 126 в GitHub Actions

### Симптомы
При выполнении шага `google-labs-code/jules-action` (или `google-labs-code/jules-invoke`) шаг завершается с ошибкой:
```text
Process completed with exit code 126.
```

### Причина
Шаг в workflow запускается на операционной системе Windows (`runs-on: windows-latest`). Экшен `google-labs-code/jules-action` представляет собой Linux bash-скрипт, который не поддерживается для выполнения в среде Windows.

### Диагностика
Проверьте поле конфигурации workflow (`.github/workflows/*.yml`):
```yaml
jobs:
  jules-job:
    runs-on: windows-latest  # Вызывает ошибку 126
```

### Решение
Измените операционную систему запуска раннера на Ubuntu Linux:
```yaml
jobs:
  jules-job:
    runs-on: ubuntu-latest  # Поддерживает Linux-экшены
```

---

## Ошибка 3: Бесконечный цикл выполнения после работы роли Analyst

### Симптомы
Автоматический процесс перезапускается снова после выполнения задачи Analyst. Выполнение задачи Developer (Developer workflow) не запускается или перезапускает воркфлоу повторно.

### Причина
Триггер в событиях API, завязанный на использование дефолтного `secrets.GITHUB_TOKEN`, не запускает последующие workflow из-за встроенного ограничения безопасности GitHub Actions на рекурсивный вызов (anti-loop protection).

### Диагностика
Проверьте переменные окружения в соответствующем workflow:
```yaml
env:
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}  # Вызывает блокировку триггера
```

### Решение
1. Создайте Classic PAT в GitHub (**Settings -> Developer Settings -> Personal access tokens -> Tokens (classic)**).
2. Включите необходимые области доступа (**scopes**):
   - `repo`
   - `workflow`
3. Сохраните токен в секретах репозитория под именем `JULES_GITHUB_PAT` (**Settings -> Secrets and variables -> Actions**).
4. Измените значение токена в workflow:
```yaml
env:
  GH_TOKEN: ${{ secrets.JULES_GITHUB_PAT }}
```

---

## Ошибка 4: ENOENT: no such file or directory, mkdtemp 'C:\OPENCODE-SANDBOX\...'

### Симптомы
При запуске тестов на Linux CI-раннерах возникает ошибка создания директории:
```text
Error: ENOENT: no such file or directory, mkdtemp 'C:OPENCODE-SANDBOX	est-xxxxxx'
```

### Причина
В исходном коде или тесте используется хардкод пути к файловой системе Windows (`C:\OPENCODE-SANDBOX`), недоступный на Linux.

### Диагностика
Найдите место создания временного пути Windows в исходном коде:
```javascript
// Ошибка: захардкожен путь Windows
const tempDir = fs.mkdtempSync('C:\\OPENCODE-SANDBOX\\test-');
```

### Решение
Замените захардкоженный путь на кроссплатформенный вариант через `os.tmpdir()`:
```javascript
const os = require('os');
const path = require('path');
const fs = require('fs');

// Исправлено: использование системного temp-каталога
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
```

---

## Ошибка 5: 401 Unauthorized при проверке API-ключа

### Симптомы
Запрос к API Google Jules завершается ошибкой с кодом ответа 401:
```json
{
  "error": {
    "code": 401,
    "message": "Request payload will not be processed because API key is invalid or expired.",
    "status": "UNAUTHENTICATED"
  }
}
```

### Причина
API-ключ Google Jules недействителен (неверный, истек срок действия или удален из консоли).

### Диагностика
Проверьте валидность через `curl`:
```bash
curl -i -H "x-goog-api-key: YOUR_JULES_API_KEY" https://jules.googleapis.com/v1alpha/sources
```
Получение ответа `HTTP/1.1 401 Unauthorized` подтверждает недействительность ключа.

### Решение
1. Перевыпустите API-ключ в сервисной консоли [jules.google.com](https://jules.googleapis.com/).
2. Обновите секрет `JULES_API_KEY` в настройках GitHub (**Settings -> Secrets and variables -> Actions**).
3. Перезапустите завершившийся ошибкой шаг workflow.
