
const ALLOWED_STORES = [
  "amazon.com.br",
  "mercadolivre.com.br",
  "kabum.com.br",
  "terabyteshop.com.br",
  "pichau.com.br",
  "magazineluiza.com.br",
  "shopee.com.br",
  "carrefour.com.br",
  "casasbahia.com.br",
  "americanas.com.br"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function allowedHost(hostname) {
  return ALLOWED_STORES.some(
    domain => hostname === domain || hostname.endsWith("." + domain)
  );
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractImage(html, pageUrl) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const property = tag.match(
      /\b(?:property|name)\s*=\s*["']([^"']+)["']/i
    );

    const content = tag.match(
      /\bcontent\s*=\s*["']([^"']+)["']/i
    );

    if (!property || !content) continue;

    const key = property[1].toLowerCase();

    if (
      key === "og:image" ||
      key === "og:image:url" ||
      key === "twitter:image"
    ) {
      try {
        const imageUrl = new URL(
          decodeHtml(content[1]),
          pageUrl
        );

        if (
          ["http:", "https:"].includes(imageUrl.protocol)
        ) {
          return imageUrl.href;
        }
      } catch {}
    }
  }

  return null;
}

async function getProductImage(url) {
  let currentUrl = new URL(url);

  if (!allowedHost(currentUrl.hostname)) return null;

  try {
    for (let i = 0; i < 4; i++) {
      const response = await fetch(currentUrl.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": "Mozilla/5.0 PriceTracker/1.0",
          "Accept": "text/html"
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");

        if (!location) return null;

        const nextUrl = new URL(location, currentUrl);

        if (
          !["http:", "https:"].includes(nextUrl.protocol) ||
          !allowedHost(nextUrl.hostname)
        ) return null;

        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) return null;

      const contentType = response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) return null;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = "";

      while (html.length < 1000000) {
        const { done, value } = await reader.read();

        if (done) break;

        html += decoder.decode(value, { stream: true });
      }

      await reader.cancel();

      return extractImage(html, currentUrl.href);
    }
  } catch (error) {
    console.log("Não foi possível obter a imagem:", error.message);
  }

  return null;
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json({ error: "Banco de dados não conectado." }, 500);
    }

    if (request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT id, name, url, target_price, current_price,
               image_url, store, active, created_at, last_checked_at
        FROM products
        WHERE active = 1
        ORDER BY created_at DESC
      `).all();

      return json(result.results);
    }

    if (request.method === "POST") {
      const data = await request.json();

      const name = String(data.name || "").trim();
      const url = String(data.url || "").trim();
      const target = Number(data.target_price);

      if (!name || name.length > 200) {
        return json({ error: "Nome inválido." }, 400);
      }

      if (!url || url.length > 2048) {
        return json({ error: "Link inválido." }, 400);
      }

      let parsedUrl;

      try {
        parsedUrl = new URL(url);
      } catch {
        return json({ error: "Informe uma URL válida." }, 400);
      }

      if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        parsedUrl.username ||
        parsedUrl.password
      ) {
        return json({ error: "URL não permitida." }, 400);
      }

      if (!Number.isFinite(target) || target <= 0) {
        return json({ error: "Preço desejado inválido." }, 400);
      }

      const imageUrl = await getProductImage(url);
      const store = parsedUrl.hostname;

      const result = await env.DB.prepare(`
        INSERT INTO products
          (name, url, target_price, store, image_url)
        VALUES (?, ?, ?, ?, ?)
      `).bind(name, url, target, store, imageUrl).run();

      return json({
        success: true,
        id: result.meta.last_row_id,
        image_found: Boolean(imageUrl),
        message: imageUrl
          ? "Produto cadastrado com imagem!"
          : "Produto cadastrado. Imagem não encontrada."
      }, 201);
    }

    if (request.method === "DELETE") {
      const id = Number(
        new URL(request.url).searchParams.get("id")
      );

      if (!Number.isInteger(id) || id <= 0) {
        return json({ error: "ID inválido." }, 400);
      }

      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM price_history WHERE product_id = ?"
        ).bind(id),

        env.DB.prepare(
          "DELETE FROM products WHERE id = ?"
        ).bind(id)
      ]);

      return json({ success: true });
    }

    return json({ error: "Método não permitido." }, 405);

  } catch (error) {
    console.error(error);
    return json({
      error: "Erro interno ao processar a solicitação."
    }, 500);
  }
}
