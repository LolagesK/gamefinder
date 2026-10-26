# GameFinder PC v0.4.1 — публикация через GitHub

Для уже работающего Cloudflare Worker `gamefinder-pc-catalog` используйте только
`GameFinder_PC_v0.4.1_GITHUB_SAFE_PATCH.zip`, так как там НЕТ wrangler.jsonc.
Имеющийся ID базы D1 `gamefinder-catalog` останется неизменным.

После коммита в main GitHub-репозитория Cloudflare выполнит `npx wrangler deploy`.
Проверьте `/api/catalog/meta`, там должна быть версия 0.4.1 и текущий счётчик игр.

Затем в GitHub Actions вручную запустите:
`Enrich Steam games and update popularity` -> Run workflow.
Workflow использует уже установленные CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_ID,
CLOUDFLARE_API_TOKEN и сам создаёт небольшие новые таблицы game_popularity,
game_enrich_state и game_store_attempts в СУЩЕСТВУЮЩЕЙ D1.

Весь порядок с проверками — README_UPGRADE_RU.md.
