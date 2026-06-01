import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are a helpful shopping assistant for this Shopify store. \
Help customers find products using the search_products tool. \
When a customer wants to buy a product, use create_checkout to generate a checkout URL. \
Be concise and friendly. Always search before recommending products.`;

// MCP-style tools Claude uses to interact with the Shopify catalog
const TOOLS = [
  {
    name: "search_products",
    description:
      "Search the Shopify store catalog for products matching a query. Returns titles, prices, images, and variant IDs.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Product search query (e.g. 'blue cotton t-shirt', 'running shoes')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_checkout",
    description:
      "Create a direct checkout URL for a specific product variant. Use only when the customer explicitly wants to buy.",
    input_schema: {
      type: "object",
      properties: {
        variantId: {
          type: "string",
          description: "Shopify variant GID (e.g. gid://shopify/ProductVariant/123456789)",
        },
      },
      required: ["variantId"],
    },
  },
];

// ---------------------------------------------------------------------------
// Storefront API helpers
// ---------------------------------------------------------------------------
const SEARCH_QUERY = `#graphql
  query searchProducts($query: String!) {
    search(query: $query, types: PRODUCT, first: 5) {
      edges {
        node {
          ... on Product {
            id
            title
            handle
            featuredImage { url altText }
            priceRange {
              minVariantPrice { amount currencyCode }
            }
            variants(first: 1) {
              edges { node { id availableForSale } }
            }
          }
        }
      }
    }
  }
`;

const CART_MUTATION = `#graphql
  mutation cartCreate($variantId: ID!) {
    cartCreate(input: {
      lines: [{ merchandiseId: $variantId, quantity: 1 }]
    }) {
      cart { checkoutUrl }
      userErrors { field message }
    }
  }
`;

async function searchProducts(storefront, query) {
  const res = await storefront.graphql(SEARCH_QUERY, { variables: { query } });
  const { search } = await res.json();

  return (search?.edges ?? []).map(({ node }) => {
    const variant = node.variants?.edges?.[0]?.node;
    const price = node.priceRange?.minVariantPrice;
    return {
      title: node.title,
      handle: node.handle,
      variantId: variant?.id ?? null,
      availableForSale: variant?.availableForSale ?? false,
      price: price ? parseFloat(price.amount) : null,
      currency: price?.currencyCode ?? "USD",
      imageUrl: node.featuredImage?.url ?? null,
    };
  });
}

async function createCheckout(storefront, variantId) {
  const res = await storefront.graphql(CART_MUTATION, { variables: { variantId } });
  const { cartCreate } = await res.json();

  if (cartCreate?.userErrors?.length > 0) {
    throw new Error(cartCreate.userErrors.map((e) => e.message).join(", "));
  }

  return { checkoutUrl: cartCreate?.cart?.checkoutUrl ?? null };
}

// ---------------------------------------------------------------------------
// Agentic loop — Claude calls tools until it has a final text response
// ---------------------------------------------------------------------------
async function runAgenticLoop(storefront, messages) {
  const foundProducts = [];
  let checkoutUrl = null;
  let currentMessages = messages;

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: currentMessages,
    tools: TOOLS,
  });

  while (response.stop_reason === "tool_use") {
    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      try {
        if (block.name === "search_products") {
          const products = await searchProducts(storefront, block.input.query);
          foundProducts.push(...products);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(products),
          });
        } else if (block.name === "create_checkout") {
          const result = await createCheckout(storefront, block.input.variantId);
          checkoutUrl = result.checkoutUrl;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: err.message }),
          is_error: true,
        });
      }
    }

    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ];

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: currentMessages,
      tools: TOOLS,
    });
  }

  const reply = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return { reply, products: foundProducts, checkoutUrl };
}

// ---------------------------------------------------------------------------
// Loader — GET health check for App Proxy
// ---------------------------------------------------------------------------
export const loader = async () => Response.json({ status: "ok" });

// ---------------------------------------------------------------------------
// Action — App Proxy POST entry point
// ---------------------------------------------------------------------------
export const action = async ({ request }) => {
  try {
    const { storefront } = await authenticate.public.appProxy(request);

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    // Direct checkout (Buy Now button — no LLM needed)
    if (body.intent === "checkout") {
      if (!body.variantId) {
        return Response.json({ error: "variantId required" }, { status: 400 });
      }
      const result = await createCheckout(storefront, body.variantId);
      return Response.json({ continueUrl: result.checkoutUrl });
    }

    // Chat — send messages to Claude with Shopify tools
    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: "messages array is required" }, { status: 400 });
    }

    const result = await runAgenticLoop(storefront, messages);
    return Response.json(result);
  } catch (err) {
    console.error("api.chat error:", err);
    return Response.json({ error: err?.message ?? "Internal error" }, { status: 500 });
  }
};
