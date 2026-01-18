# Yakachokbot

Телеграм-бот для быстрой загрузки видео и аудио с разных сайтов через yt-dlp.

[![Telegram Bot](https://img.shields.io/badge/TELEGRAM-BOT-%2330A3E6?style=for-the-badge&logo=telegram)](https://t.me/yakachokbot)
![GitHub top language](https://img.shields.io/github/languages/top/uladzemer/yakachokbot?style=for-the-badge)

## Возможности

- Скачивание видео и аудио по ссылке
- Выбор качества в личных чатах
- Поддержка большинства сайтов, которые умеет yt-dlp
- Поддержка cookies.txt для сложных сайтов
- Загрузка файлов до 2 ГБ через локальный Telegram Bot API

## Установка (Docker)

1) Установите Docker: https://docs.docker.com/engine/install
2) Скопируйте `compose.yml` в пустую папку.
3) Создайте `.env` на основе `.env.example` и заполните значения.
4) Запустите:

```bash
docker compose up -d
```

## Переменные окружения

| Переменная              | Описание                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | Токен бота (получить у [BotFather][botfather])                                                                             |
| `WHITELISTED_IDS`       | Список Telegram ID пользователей через запятую, пусто = доступ всем ([getidsbot][id-bot])                                  |
| `ADMIN_ID`              | Ваш Telegram ID ([getidsbot][id-bot])                                                                                      |
| `ALLOW_GROUPS`          | Разрешить группы (`"true"` или `"false"`, по умолчанию `"false"`)                                                          |
| `TELEGRAM_API_ID`       | API ID Telegram ([инструкция][telegram-api-id])                                                                            |
| `TELEGRAM_API_HASH`     | API HASH Telegram ([инструкция][telegram-api-id])                                                                          |
| `TELEGRAM_API_ROOT`     | URL локального Telegram Bot API                                                                                            |
| `TELEGRAM_WEBHOOK_PORT` | Порт вебхука (если используете вебхук)                                                                                     |
| `TELEGRAM_WEBHOOK_URL`  | URL вебхука (если используете вебхук)                                                                                      |
| `YTDL_AUTOUPDATE`       | Автообновление yt-dlp (`"true"` или `"false"`, по умолчанию `"true"`)                                                      |
| `OPENAI_API_KEY`        | Ключ OpenAI (опционально, авто‑переводы)                                                                                   |
| `CLEANUP_INTERVAL_HOURS` | Интервал очистки временных файлов в /tmp (часы, по умолчанию 6)                                                            |
| `CLEANUP_MAX_AGE_HOURS`  | Максимальный возраст временных файлов в /tmp (часы, по умолчанию 12)                                                       |

## Файлы и хранилище

- Куки складывайте в `./yakachokbot/cookies.txt` или отправляйте в чат боту файл(ы) `cookies.txt` — бот объединит их в один список (полезно для разных площадок).
- В `./yakachokbot` также хранится `saved-translations.json`, если включены авто‑переводы.

## Как получить cookies.txt

1) Установите расширение для Chrome: https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc
2) Откройте YouTube и войдите в нужный аккаунт.
3) Нажмите на расширение и выберите экспорт в формате Netscape cookies.txt.
4) Сохраните файл как `cookies.txt` и положите его в `./yakachokbot/`.
5) Если YouTube не скачивается, дополнительно экспортируйте cookies с домена `accounts.google.com` или `google.com` (включая HttpOnly) и отправьте файл боту для объединения.
6) Перезапустите контейнер:

```bash
docker compose restart telegram-bot
```

[yt-dlp]: https://github.com/yt-dlp/yt-dlp
[telegram-api-id]: https://core.telegram.org/api/obtaining_api_id
[id-bot]: https://t.me/getidsbot
[botfather]: https://t.me/BotFather
