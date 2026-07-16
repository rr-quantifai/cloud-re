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
    const prompt = `I am a Microsoft Cloud Solution Provider. My customer currently uses the following Microsoft products: ${productList}. What other Microsoft products can I sell to them? Be short and direct

Output ONLY the recommendations, no title, no introduction, no closing note, in exactly this format:

**Product Name**
- Reason it fits
- Reason it fits`;

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