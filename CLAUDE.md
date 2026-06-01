# Buy Using Chat — Project Context

## What This App Does
A Shopify embedded app with a storefront chat widget that lets customers search for products and buy them through a conversational AI interface powered by Claude (claude-sonnet-4-6).

**Flow:**
1. Customer opens the floating chat widget on the storefront
2. Types a natural language query ("show me blue t-shirts")
3. Claude calls the `search_products` tool → Shopify Storefront GraphQL API
4. Claude replies with product recommendations + product cards appear
5. Customer clicks "Buy Now" → direct checkout via Shopify Cart API

---

## Architecture

```
Storefront widget (Liquid/JS)
  └─ POST /apps/chat-proxy          ← Shopify App Proxy (same-origin, no CORS)
       └─ forwards to Vercel /api/chat
            ├─ authenticate.public.appProxy(request)   ← HMAC verification
            ├─ Anthropic SDK (claude-sonnet-4-6)
            │    └─ tools: search_products, create_checkout
            │         └─ Shopify Storefront GraphQL API
            └─ returns { reply, products[], checkoutUrl }
```

### Key Files
| File | Purpose |
|------|---------|
| `app/routes/api.chat.jsx` | Main chat API — Claude agentic loop + Shopify tools |
| `extensions/theme-extension/blocks/chat-widget.liquid` | Storefront floating widget |
| `app/shopify.server.ts` | Shopify app config (auth, session storage) |
| `app/db.server.ts` | Prisma client (PostgreSQL/Neon) |
| `prisma/schema.prisma` | Session table schema (PostgreSQL) |
| `shopify.app.toml` | Shopify app config — URLs, scopes, proxy, webhooks |
| `vite.config.ts` | Vite config with `vercelPreset()` for SSR on Vercel |

---

## Infrastructure

### Vercel
- **Project:** `suvagata-roys-projects/buy-using-chat`
- **Production URL:** `https://buy-using-chat.vercel.app`
- **Project ID:** `prj_K2nCDuCUAtH82rpL5kINonnxVcke`
- **Team ID:** `team_MEcloHfmcH0uqKSqcsYvF5gm`

### Neon PostgreSQL
- **Project:** `rapid-thunder-87065416` (neon-violet-ribbon)
- **Database:** `neondb`
- Stores Shopify OAuth sessions via `PrismaSessionStorage`
- Connection strings in `.env` and Vercel env vars

### GitHub
- **Repo:** `https://github.com/productgeek82/buy-using-chat`
- **Branch:** `main`
- Vercel auto-deploys on push (once Git integration is connected in Vercel dashboard)

### Shopify
- **Partner org:** Roy Coaching and Services (ID: 220704125)
- **App ID:** 375177248769
- **Client ID / API Key:** `00e05d58bc144c26a3150e728467abea`
- **Dev store:** `roy-test-scores.myshopify.com` (password protected)
- **App proxy:** `/apps/chat-proxy` → `https://buy-using-chat.vercel.app/api/chat`
- **Auth redirect:** `https://buy-using-chat.vercel.app/auth/callback`

---

## Environment Variables

### Vercel (Production)
```
SHOPIFY_API_KEY=00e05d58bc144c26a3150e728467abea
SHOPIFY_API_SECRET=<encrypted>
SHOPIFY_APP_URL=https://buy-using-chat.vercel.app
SCOPES=write_products,write_metaobjects,write_metaobject_definitions
ANTHROPIC_API_KEY=<needs to be added>
DATABASE_URL=<neon pooled connection>
DATABASE_URL_UNPOOLED=<neon direct connection>
```

### Local `.env` (gitignored)
```
DATABASE_URL=<neon pooled>
DATABASE_URL_UNPOOLED=<neon direct>
SHOPIFY_APP_URL=https://buy-using-chat.vercel.app
SCOPES=write_products,write_metaobjects,write_metaobject_definitions
```
> `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` are injected automatically by `shopify app dev`

---

## Common Commands

### Local Development
```bash
npx shopify app dev          # Start local dev server (must run interactively in terminal)
```
> Enter store password when prompted. This installs the app on the dev store via OAuth and stores the session in Neon.

### Deploy
```bash
# Deploy app to Vercel
npx vercel deploy --prod

# Deploy Shopify config + theme extension
npx shopify app deploy --allow-updates

# Both together (do Vercel first)
npx vercel deploy --prod && npx shopify app deploy --allow-updates
```

### Database
```bash
# Push schema changes to Neon (no migration file needed)
DATABASE_URL="..." DATABASE_URL_UNPOOLED="..." npx prisma db push

# Generate Prisma client
npx prisma generate
```

### Environment Variables
```bash
npx vercel env add ANTHROPIC_API_KEY production   # Add/update a Vercel env var
npx vercel env ls                                  # List all env vars
npx vercel env pull .env.local                    # Pull Vercel env vars locally
```

---

## Known Issues & Solutions

### App Proxy returns HTML (`<!doctype`) instead of JSON
**Cause:** One of:
1. App Proxy URL in Partner Dashboard points to a dead Cloudflare tunnel (from a previous `shopify app dev` session)
2. App not installed on the store (OAuth not completed against Vercel URL)
3. Store is password-protected and browser doesn't have the session cookie

**Fix:**
1. Stop `shopify app dev` if running
2. Run `npx shopify app deploy --allow-updates` to reset proxy URL to Vercel
3. Verify proxy URL in Partner Dashboard → App proxy section shows `https://buy-using-chat.vercel.app/api/chat`
4. Enter the store password in your browser before testing the widget

### `shopify app dev` URL override
`shopify app dev` sets `automatically_update_urls_on_dev = true` in the TOML, which overwrites the App Proxy URL to the tunnel. **Always run `shopify app deploy --allow-updates` after stopping `shopify app dev`** to restore Vercel URLs.

### OAuth / App Installation
- `shopify app dev` handles OAuth automatically — it stores the session in Neon (via `DATABASE_URL` in `.env`)
- Direct browser navigation to `/auth?shop=...` returns 410 — don't use this; use `shopify app dev` instead
- The Partner Dashboard "Test on development store" flow fails due to iframe restrictions on `accounts.shopify.com`

### Prisma / Database
- Schema uses PostgreSQL (`TIMESTAMP(3)`) not SQLite (`DATETIME`)
- The old migration SQL was SQLite-specific; it was fixed and marked as applied via `prisma migrate resolve --applied`
- For schema changes: use `prisma db push` (simpler than migrations for this project)

### Vercel SSR Routes returning 404
- **Cause:** Missing `vercelPreset()` in `vite.config.ts`
- **Fixed:** `@vercel/react-router` package added, `vercelPreset()` added to Vite plugins

### `ANTHROPIC_API_KEY` not set
- Claude calls will fail silently or error
- Add via: `npx vercel env add ANTHROPIC_API_KEY production`
- Then redeploy: `npx vercel deploy --prod`

---

## Shopify App Proxy — How It Works
- Storefront URL: `https://roy-test-scores.myshopify.com/apps/chat-proxy`
- Shopify adds HMAC params to the URL and forwards to: `https://buy-using-chat.vercel.app/api/chat`
- `authenticate.public.appProxy(request)` verifies the HMAC using `SHOPIFY_API_SECRET`
- Returns a `storefront` client for authenticated Storefront API calls
- **Requires:** App installed on the store (OAuth completed) + store password entered in browser

## Claude + Shopify Tool Architecture
Claude uses two MCP-style tools defined in `api.chat.jsx`:

| Tool | Description | Implementation |
|------|-------------|----------------|
| `search_products` | Searches catalog by query | Storefront GraphQL `search` query |
| `create_checkout` | Creates checkout URL for a variant | Storefront GraphQL `cartCreate` mutation |

The agentic loop runs until `stop_reason !== "tool_use"`, then returns:
```json
{ "reply": "Claude's text", "products": [...], "checkoutUrl": "..." }
```

Prompt caching is enabled on the system prompt (`cache_control: { type: "ephemeral" }`).

---

## Theme Extension
- **Handle:** `chat-widget`
- **Location:** `extensions/theme-extension/blocks/chat-widget.liquid`
- Must be added in the Shopify theme editor (Online Store → Themes → Customize → Add block → Apps → Chat Widget)
- Configurable: widget title, placeholder text, accent color
- Maintains conversation history in JS (`history` array) for multi-turn Claude context
- "Buy Now" button triggers direct checkout (no LLM call) for speed
