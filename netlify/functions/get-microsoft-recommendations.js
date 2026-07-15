export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { customerName, products } = await req.json();
    if (!customerName || !Array.isArray(products) || products.length === 0) {
      return new Response(JSON.stringify({ error: "Missing data" }), { status: 400 });
    }

    const productList = [...products].sort().join(", ");
    const prompt = `You are a seasoned and expert Microsoft Cloud Solution Provider (CSP) advisor. A customer named "${customerName}" currently uses these products: ${productList}

     Recommend 3-4 other Microsoft products they should consider as logical extensions of their current stack. For each product, include 2-3 key reasons why it fits their stack.

     Format each recommendation as:

     Product Name
      - Reason 1
      - Reason 2

     Be concise, direct, and specific to their use case. No flowery language.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.CR_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error("Claude API error:", error);
      return new Response(JSON.stringify({ error: error.error?.message || "API failed" }), { status: 500 });
    }

    const data = await response.json();
    return new Response(JSON.stringify({ content: data.content[0].text }), { status: 200 });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};