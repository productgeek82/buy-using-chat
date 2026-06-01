import { authenticate } from "../shopify.server";

const STORE_MCP_URL = "https://roy-test-scores.myshopify.com/api/mcp";

// UCP profile URL — the App Proxy public surface of this app.
// Swap for your real tunnel/production URL once deployed.
const UCP_PROFILE_URL =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/apps/chat-proxy`
    : "https://roy-test-scores.myshopify.com/apps/chat-proxy";

/**
 * POST a single JSON-RPC 2.0 call to the store's MCP endpoint and return
 * the parsed response. Throws if the HTTP layer itself fails.
 */
async function callMcp(payload) {
  const res = await fetch(STORE_MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

/**
 * Pull the first text block out of an MCP tools/call result and try to
 * JSON-parse it. Returns { parsed, raw } — parsed is null if it isn't JSON.
 */
function extractContent(mcpResponse) {
  const content = mcpResponse?.result?.content ?? [];
  const raw = content.find((c) => c.type === "text")?.text ?? "";
  try {
    return { parsed: JSON.parse(raw), raw };
  } catch {
    return { parsed: null, raw };
  }
}

// ---------------------------------------------------------------------------
// Catalog search
// ---------------------------------------------------------------------------
async function handleSearch(query) {
  const mcpResponse = await callMcp({
    jsonrpc: "2.0",
    id: "search-1",
    method: "tools/call",
    params: {
      name: "search_shop_catalog",
      arguments: { query },
    },
  });

  const { parsed, raw } = extractContent(mcpResponse);

  // MCP may return an array of products or a single product object.
  if (parsed) {
    const products = Array.isArray(parsed) ? parsed : [parsed];
    return Response.json({ products });
  }

  // Tool returned prose (no structured products found).
  return Response.json({ products: [], message: raw });
}

// ---------------------------------------------------------------------------
// Direct checkout — skips cart entirely via the Checkout MCP tool.
// ---------------------------------------------------------------------------
async function handleCheckout(variantId) {
  const mcpResponse = await callMcp({
    jsonrpc: "2.0",
    id: "checkout-1",
    method: "tools/call",
    params: {
      // _meta is mandatory for UCP-aware checkout agents.
      _meta: { profile: UCP_PROFILE_URL },
      name: "create_checkout",
      arguments: {
        // Shopify Checkout MCP expects the Storefront GID for the variant.
        line_items: [{ merchandiseId: variantId, quantity: 1 }],
      },
    },
  });

  if (mcpResponse?.result?.isError) {
    return Response.json(
      { error: "MCP reported an error", detail: mcpResponse.result },
      { status: 502 }
    );
  }

  const { parsed, raw } = extractContent(mcpResponse);

  // The checkout URL may live under several different key names depending on
  // the MCP server version — check all plausible locations.
  const continueUrl =
    parsed?.continue_url ??
    parsed?.checkoutUrl ??
    parsed?.checkout_url ??
    parsed?.webUrl ??
    mcpResponse?.result?.checkoutUrl ??
    null;

  if (!continueUrl) {
    return Response.json(
      {
        error:
          "No checkout URL found in MCP response. " +
          "Inspect `raw` and adjust key extraction above.",
        raw,
        mcpResponse,
      },
      { status: 502 }
    );
  }

  return Response.json({ continueUrl });
}

// ---------------------------------------------------------------------------
// Remix action — entry point for the App Proxy POST requests.
// ---------------------------------------------------------------------------
export const action = async ({ request }) => {
  // Validates the Shopify HMAC signature injected by the App Proxy.
  // Throws a 401 Response automatically if the signature is invalid.
  await authenticate.public.appProxy(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const { intent, query, variantId } = body;

  if (intent === "search") {
    if (!query || typeof query !== "string") {
      return Response.json({ error: "`query` string is required" }, { status: 400 });
    }
    return handleSearch(query.trim());
  }

  if (intent === "checkout") {
    if (!variantId || typeof variantId !== "string") {
      return Response.json(
        { error: "`variantId` (Storefront GID) string is required" },
        { status: 400 }
      );
    }
    return handleCheckout(variantId);
  }

  return Response.json(
    { error: `Unknown intent "${intent}". Expected "search" or "checkout".` },
    { status: 400 }
  );
};
