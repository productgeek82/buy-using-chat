import { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// Product search via Storefront API
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
              edges {
                node {
                  id
                  availableForSale
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function handleSearch(storefront, query) {
  const data = await storefront.graphql(SEARCH_QUERY, {
    variables: { query },
  });

  const { search } = await data.json();
  const edges = search?.edges ?? [];

  if (edges.length === 0) {
    return Response.json({ products: [], message: "No products found. Try a different search." });
  }

  const products = edges.map(({ node }) => {
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

  return Response.json({ products });
}

// ---------------------------------------------------------------------------
// Checkout via Storefront Cart API
// ---------------------------------------------------------------------------
const CREATE_CART_MUTATION = `#graphql
  mutation cartCreate($variantId: ID!) {
    cartCreate(input: {
      lines: [{ merchandiseId: $variantId, quantity: 1 }]
    }) {
      cart {
        checkoutUrl
      }
      userErrors { field message }
    }
  }
`;

async function handleCheckout(storefront, variantId) {
  const data = await storefront.graphql(CREATE_CART_MUTATION, {
    variables: { variantId },
  });

  const { cartCreate } = await data.json();

  if (cartCreate?.userErrors?.length > 0) {
    return Response.json(
      { error: cartCreate.userErrors.map((e) => e.message).join(", ") },
      { status: 400 }
    );
  }

  const continueUrl = cartCreate?.cart?.checkoutUrl;
  if (!continueUrl) {
    return Response.json({ error: "Could not create checkout." }, { status: 502 });
  }

  return Response.json({ continueUrl });
}

// ---------------------------------------------------------------------------
// Loader — handles GET requests (App Proxy health check / browser navigation)
// ---------------------------------------------------------------------------
export const loader = async () => {
  return Response.json({ status: "ok" });
};

// ---------------------------------------------------------------------------
// Action — entry point for App Proxy POST requests
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

    const { intent, query, variantId } = body;

    if (intent === "search") {
      if (!query || typeof query !== "string") {
        return Response.json({ error: "`query` string is required" }, { status: 400 });
      }
      return handleSearch(storefront, query.trim());
    }

    if (intent === "checkout") {
      if (!variantId || typeof variantId !== "string") {
        return Response.json({ error: "`variantId` string is required" }, { status: 400 });
      }
      return handleCheckout(storefront, variantId);
    }

    return Response.json(
      { error: `Unknown intent "${intent}". Expected "search" or "checkout".` },
      { status: 400 }
    );
  } catch (err) {
    console.error("api.chat error:", err);
    return Response.json({ error: err?.message ?? "Internal server error" }, { status: 500 });
  }
};
