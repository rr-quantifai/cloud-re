export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { products } = await req.json();
    if (!Array.isArray(products) || products.length === 0) {
      return new Response(JSON.stringify({ error: "Missing products" }), { status: 400 });
    }

    const productList = [...products].sort().join(", ");
    const prompt = `You are an expert Microsoft Cloud Solution Provider advisor. A customer currently uses: ${productList}

Identify the 3-4 highest-value Microsoft products to upsell or cross-sell to this specific customer. Prioritize by commercial impact and logical fit with their existing stack. For each, give 2 sharp reasons grounded in what they already use — not generic product descriptions.

Output ONLY the recommendations in exactly this format, no title, no intro, no closing note:

**Product Name**
- Reason specific to their current stack (one line)
- Reason specific to their current stack (one line)`;

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