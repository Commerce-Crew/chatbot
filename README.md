# CommerceCrew Chatbot Middleware (Multi-tenant)

Multi-tenant middleware that serves the Shopware 6 chatbot plugin and proxies to Dify. Tenants are resolved by domain (Origin/Referer) and/or a CommerceCrew-issued middleware API key.

## Architecture

```
├── index.js                 # Entry point
├── src/
│   ├── app.js              # Express app + routing
│   ├── config/             # Env config
│   ├── db/                 # Postgres + schema
│   ├── middleware/         # Tenant resolution, auth
│   ├── repositories/       # DB access helpers
│   ├── routes/             # API + admin dashboard
│   ├── services/           # Dify + Shopware + tracking
│   └── utils/              # Logging helpers
├── scripts/
│   └── seed-tenant.js       # Seed/Update a tenant from .env
├── docker-compose.yml
└── CCChatbot/               # Shopware plugin
```

## Quick start

1. Configure `.env` (DB + Dify/Shopware + first tenant)
2. Start services:
   ```bash
   docker-compose up -d --build
   ```
3. Initialize schema:
   ```bash
   psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f src/db/schema.sql
   ```
4. Seed first tenant:
   ```bash
   npm run seed:tenant
   ```
   This reads from `.env` and auto-generates `TENANT_API_KEY` if missing.
   

   This runs the migration inside the Postgres container (no local psql needed):
   ```
      docker exec -i ccchatmiddleware-db psql -U postgres -d ccchatmiddleware < src/db/schema.sql
   
    ```
Then seed your first tenant:
   
   ```
      npm run seed:tenant
   ```

## Admin dashboard

Basic-auth protected UI to manage tenants:

```
https://cbshop.commerce-crew.com/admin
```

Environment variables:
- `ADMIN_USER`
- `ADMIN_PASS`

## Tenant resolution

1. **API Key** (preferred): `x-cc-api-key`, `x-api-key`, or `Authorization: Bearer <key>`
2. **Origin/Referer**: matches `allowed_origins` array in DB
3. **Shop ID** (multi-shop): `x-cc-shop-id` to select a specific shop under a tenant

## Context token (Storefront)

The **context token** (`sw-context-token`) identifies the guest or customer session in Shopware and is required for cart, checkout, and order APIs. It must not be exposed in HTML.

- **Plugin**: The Shopware CCChatbot plugin exposes a **same-origin** endpoint (e.g. `/ccchatbot/context` or `/de/ccchatbot/context` when using a language prefix). The storefront fetches the token via XHR from this endpoint; the token is never rendered in the page.
- **URL**: The plugin uses Twig `path('frontend.ccchatbot.context')` so the context URL is correct for the current storefront (including language prefix in Shopware 6.x).
- **Middleware**: The storefront sends the token in the request body (`context_token`) or header (`sw-context-token`) when calling the middleware. The middleware uses it to call Shopware Store API (cart summary, orders when logged in, etc.). **Adding to cart does not require login**; guests can add items. Only order history and reordering require a logged-in customer.

## Shopware plugin settings

The plugin only needs:
- `middlewareUrl`
- `middlewareApiKey` (CommerceCrew-issued)

The Dify API key stays in the middleware only.

Multi-shop support:
- The Shopware plugin sends `x-cc-shop-id` using the current sales channel ID.
- Configure per-shop `shopware_url`, `shopware_access_key`, and `allowed_origins` in `tenant_shops`.

Per-shop Dify support:
- Set `dify_url`, `dify_api_key`, `dify_agent_id`, and `dify_instructions` on each shop.
- If not set, the tenant-level Dify settings are used as fallback.
- Optional advanced fields: `dify_inputs` and `model_config` (JSON) per shop.

Bulk import shops:
- Use `/admin/shops/import` to pull sales channels from Shopware Store API.
- Imported shops are keyed by sales channel ID and can auto-fill `allowed_origins` from channel domains.

Optional: Opening hours from Google
- Set `GOOGLE_PLACES_API_KEY` in the middleware environment to enable opening hours via Google Place Details.
- In the plugin config, set "Opening hours source" to "From Google" and enter the Google Place ID; the chatbot will then answer Öffnungszeiten using Google data.

Store pages (Contact, Return policy, About us):
- The plugin can use CMS landing pages: set the landing page UUIDs in plugin config (Contact page, Return policy page, About us page). The storefront fetches text from these pages for the AI context. Fallback text fields are used when no page ID is set.

## Shop chatbot feature ideas

### Customer-facing
- Product discovery by intent (e.g., "gift for runner") with filters and comparisons
- Compatibility checks (parts, accessories, bundles) with upsell suggestions
- Order status, delivery ETA, and tracking link retrieval
- Returns and exchanges guidance with policy-aware steps
- Guided checkout help (shipping, payment, tax, discount codes)
- Store FAQ with rich answers (size guide, warranty, care instructions)
- In-stock alerts and back-in-stock notifications
- Multilingual support and tone personalization

### Shop owner value
- Lead capture for high-intent chats (email/phone opt-in)
- Abandoned cart recovery nudges and follow-ups
- Insights dashboard: top questions, conversion, and drop-off points
- Content gap detection (missing FAQ or product info)
- Auto-tag conversations for support escalation
- Campaign-aware messaging (promos, seasonal bundles)
- A/B testing of chatbot prompts and responses
- GDPR-compliant data controls and retention policies

## Implemented feature endpoints

Customer-facing:
- `POST /api/products/compare` compare multiple products by ID/SKU/name
- `POST /api/orders/tracking` fetch tracking codes for last order or by order number

Owner-facing:
- `POST /api/leads` capture lead/contact requests with optional product interest
- `GET /admin/leads` basic-auth UI to view captured leads
- `POST /api/shop/info` shipping & payment methods (for shop info like shipping costs). Optional body `google_place_id` fetches opening hours from Google Places when `GOOGLE_PLACES_API_KEY` is set in env.

Language support:
- Send `language` (e.g. "de-DE", "en-US") in `/api/chat/stream` to have Dify respond in that language.
- For Shopware data, send `sw-language-id` (Shopware language UUID) or `language_id` in `/api/shop/info`.

## Database backup & restore

### Backup (dump.sql)
```bash
pg_dump -h localhost -U postgres -d ccchatmiddleware > dump.sql
```

Docker variant:
```bash
docker exec -t ccchatmiddleware-db pg_dump -U postgres -d ccchatmiddleware > dump.sql
```

### Restore
```bash
psql -h localhost -U postgres -d ccchatmiddleware < dump.sql
```

Docker variant:
```bash
cat dump.sql | docker exec -i ccchatmiddleware-db psql -U postgres -d ccchatmiddleware
```

## App backup strategy

Back up:
- `.env` (secrets + tenant seed values)
- `docker-compose.yml`
- `dump.sql` (Postgres data)

These three files allow full restore of the middleware + tenant data.
