# GameFinder PC v0.3.4 — публикация полноценного Worker с D1

Это репозиторий сайта + серверного Worker. **Не загружай папку `dist` отдельно через Upload Assets**: так получится снова только статический Worker, у которого нельзя добавить D1 binding.

## Публикация через Cloudflare + GitHub/GitLab без локального Wrangler

1. Cloudflare Dashboard → Storage & databases → D1 → `gamefinder-catalog` → Overview: скопируй **Database ID (UUID)**, он не является паролем.
2. Открой файл `wrangler.jsonc` и замени `PASTE_DATABASE_UUID_HERE` на свой ID D1. Оставь `name: gamefinder-pc-catalog`, если именно так назван существующий Worker. Переменная `DB` должна остаться без изменений.
3. Создай приватный репозиторий на GitHub или GitLab. Добавь туда *содержимое* этой папки, сохранив структуру (директории `worker/`, `shared/`, `dist/` и файл `wrangler.jsonc` должны лежать в корне).
4. Cloudflare → Workers & Pages → открой **существующий** `gamefinder-pc-catalog` → Settings → Builds → Connect → выбери репозиторий. Если Connect недоступен, создай новый Worker из репозитория (адрес будет новый). Build command: пусто, Deploy command: `npx wrangler deploy`, Root directory: `/`.
5. После успешной публикации открой `https://<worker>.<account>.workers.dev/api/catalog/meta`. Ожидается JSON с `available:true`, `mode:"d1"`, `total` равным числу строк в D1.

### Что уже настроено
- `main`: `./worker/index.mjs` — серверный JavaScript-код для API поиска.
- `assets.directory`: `./dist` — статические файлы интерфейса.
- `assets.binding`: `ASSETS`, `run_worker_first`: [`/api/*`] — правильная работа API и сайта.
- `d1_databases`: `DB` → `gamefinder-catalog`, ID нужно вписать самостоятельно до первого деплоя.

**Не публикуй один `dist/` через Drag & Drop.** Он не содержит Worker entrypoint. Существующие другие сайты Cloudflare затронуты не будут, если не менять их Workers или routes.

## Если в D1 ещё нет таблицы games
В D1 Console выполнить `d1-import/000_schema.sql`, затем `d1-import/001_games.sql`. Следует убедиться, что структура таблиц соответствует этим файлам. Для уже заполненной D1 повторно ничего выполнять не нужно.

## Важно
Полноценного доступа к вашему Cloudflare из этого чата нет — пакет проверен локально, но публикацию делает сам Cloudflare после подключения репозитория. Данные игр на сайте запрашиваются через `/api/catalog`.
