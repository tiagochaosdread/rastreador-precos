
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

// Verifica se a URL pode ser consultada
function validUrl(value) {
  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }

    if (url.username || url.password) {
      return false;
    }

    if (
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal")
    ) {
      return false;
    }

    // Bloqueia IPs literais para evitar acesso a redes privadas
    if (
      /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
      url.hostname.startsWith("[")
    ) {
      return false;
    }

    // Permite apenas portas HTTP e HTTPS convencionais
    if (url.port && url.port !== "80" && url.port !== "443") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// Decodifica entidades HTML comuns
function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

// Extrai atributos de uma tag HTML
function getAttributes(tag) {
  const attrs = {};

  const regex =
    /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attrs;
}

// Converte preços brasileiros ou numéricos para número
function parsePrice(value) {
  if (value === null || value === undefined) {
    return null;
  }

  let text = decodeHtml(String(value))
    .trim()
    .replace(/\s/g, "")
    .replace(/[^\d.,-]/g, "");

  if (!text || !/\d/.test(text)) {
    return null;
  }

  // Formato brasileiro: 1.234,56
  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      // Formato internacional: 1,234.56
      text = text.replace(/,/g, "");
    }
  } else if (text.includes(",")) {
    // Formato brasileiro: 1234,56
    text = text.replace(",", ".");
  }

  const price = Number(text);

  if (!Number.isFinite(price) || price <= 0 || price > 100000000) {
    return null;
  }

  return Math.round(price * 100) / 100;
}

// Extrai preço dos dados estruturados Schema.org
function extractJsonLd(html) {
  const scripts = html.match(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  function findProductPrice(data) {
    if (!data || typeof data !== "object") {
      return null;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        const result = findProductPrice(item);
        if (result !== null) return result;
      }

      return null;
    }

    const type = data["@type"];

    const isProduct = Array.isArray(type)
      ? type.some(t => String(t).toLowerCase() === "product")
      : String(type || "").toLowerCase() === "product";

    if (isProduct) {
      const offers = Array.isArray(data.offers)
        ? data.offers
        : data.offers
          ? [data.offers]
          : [];

      for (const offer of offers) {
        const possiblePrices = [
          offer.price,
          offer.lowPrice,
          offer.priceSpecification?.price,
          offer.priceSpecification?.minPrice
        ];

        for (const value of possiblePrices) {
          const price = parsePrice(value);
          if (price !== null) return price;
        }
      }
    }

    // Procura produtos dentro de @graph ou outras estruturas
    for (const value of Object.values(data)) {
      if (value && typeof value === "object") {
        const result = findProductPrice(value);
        if (result !== null) return result;
      }
    }

    return null;
  }

  for (const script of scripts) {
    const content = script
      .replace(/^<script\b[^>]*>/i, "")
      .replace(/<\/script>$/i, "");

    try {
      const data = JSON.parse(content);
      const price = findProductPrice(data);

      if (price !== null) return price;
    } catch {}
  }

  return null;
}

// Extrai preços de metadados HTML
function extractMetaPrice(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  const acceptedNames = [
    "product:price:amount",
    "og:price:amount",
    "price",
    "product:price",
    "twitter:label1"
  ];

  for (const tag of tags) {
    const attrs = getAttributes(tag);

    const key = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ""
    ).toLowerCase();

    if (
      acceptedNames.includes(key) &&
      attrs.content
    ) {
      const price = parsePrice(attrs.content);

      if (price !== null) return price;
    }
  }

  return null;
}

// Extrai preços de atributos e elementos HTML
function extractHtmlPrice(html) {
  // 1. Tags com itemprop="price"
  const tags = html.match(/<[^>]+>/g) || [];

  for (const tag of tags) {
    const attrs = getAttributes(tag);

    if (
      (attrs.itemprop || "").toLowerCase() === "price"
    ) {
      const value =
        attrs.content ||
        attrs.value ||
        attrs["data-price"];

      const price = parsePrice(value);

      if (price !== null) return price;
    }
  }

  // 2. Atributos de preço comuns em lojas virtuais
  const attributePatterns = [
    /data-price\s*=\s*["']([^"']+)["']/gi,
    /data-product-price\s*=\s*["']([^"']+)["']/gi,
    /data-sale-price\s*=\s*["']([^"']+)["']/gi,
    /data-current-price\s*=\s*["']([^"']+)["']/gi
  ];

  for (const pattern of attributePatterns) {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      const price = parsePrice(match[1]);

      if (price !== null) return price;
    }
  }

  // 3. Elementos cujo class ou id indica preço
  const priceElements = html.match(
    /<(?:span|div|p)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:price|preco|valor)[^"']*["'][^>]*>[^<]{1,100}<\/(?:span|div|p)>/gi
  ) || [];

  for (const element of priceElements) {
    const content = element
      .replace(/<[^>]*>/g, " ")
      .trim();

    const price = parsePrice(content);

    if (price !== null) return price;
  }

  return null;
}

// Executa as estratégias de extração
function extractPrice(html) {
  return (
    extractJsonLd(html) ??
    extractMetaPrice(html) ??
    extractHtmlPrice(html)
  );
}

// Busca o preço na página do produto
async function getProductPrice(url) {
  let currentUrl = new URL(url);

  if (!validUrl(currentUrl.href)) {
    return null;
  }

  try {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(currentUrl.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",

          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
        }
      });

      // Trata redirecionamentos
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");

        if (!location) return null;

        const nextUrl = new URL(location, currentUrl);

        if (!validUrl(nextUrl.href)) {
          return null;
        }

        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        console.log("Página retornou status:", response.status);
        return null;
      }

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        return null;
      }

      // Limita a leitura da página a aproximadamente 1 MB
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let html = "";
      let size = 0;

      try {
        while (size < 1000000) {
          const { done, value } = await reader.read();

          if (done) break;

          size += value.length;

          html += decoder.decode(value, {
            stream: true
          });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }

      const price = extractPrice(html);

      console.log(
        price !== null
          ? "Preço encontrado: " + price
          : "Nenhum preço identificado."
      );

      return price;
    }
  } catch (error) {
    console.log("Erro ao consultar produto:", error.message);
  }

  return null;
}

// API PRINCIPAL
export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json({
        error: "Banco de dados não conectado."
      }, 500);
    }

    // LISTAR PRODUTOS
    if (request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT
          id,
          name,
          url,
          target_price,
          current_price,
          store,
          active,
          created_at,
          last_checked_at
        FROM products
        WHERE active = 1
        ORDER BY created_at DESC
      `).all();

      return json(result.results);
    }

    // CADASTRAR PRODUTO
    if (request.method === "POST") {
      const data = await request.json();

      const name = String(data.name || "").trim();
      const url = String(data.url || "").trim();
      const target = Number(data.target_price);

      if (!name || name.length > 200) {
        return json({
          error: "Nome inválido."
        }, 400);
      }

      if (!url || url.length > 2048 || !validUrl(url)) {
        return json({
          error: "Informe uma URL HTTP ou HTTPS válida."
        }, 400);
      }

      if (!Number.isFinite(target) || target <= 0) {
        return json({
          error: "Preço desejado inválido."
        }, 400);
      }

      const parsedUrl = new URL(url);

      // Busca o preço atual
      const currentPrice = await getProductPrice(url);

      const store = parsedUrl.hostname;

      // Salva o produto
      const result = await env.DB.prepare(`
        INSERT INTO products (
          name,
          url,
          target_price,
          current_price,
          store,
          last_checked_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        name,
        url,
        target,
        currentPrice,
        store,
        currentPrice !== null ? new Date().toISOString() : null
      ).run();

      const productId = result.meta.last_row_id;

      // Registra o primeiro preço no histórico
      if (currentPrice !== null) {
        await env.DB.prepare(`
          INSERT INTO price_history (
            product_id,
            price
          )
          VALUES (?, ?)
        `).bind(productId, currentPrice).run();
      }

      return json({
        success: true,
        id: productId,
        current_price: currentPrice,
        price_found: currentPrice !== null,
        message: currentPrice !== null
          ? "Produto cadastrado e preço identificado!"
          : "Produto cadastrado, mas não foi possível identificar o preço."
      }, 201);
    }

    // EXCLUIR PRODUTO
    if (request.method === "DELETE") {
      const id = Number(
        new URL(request.url).searchParams.get("id")
      );

      if (!Number.isInteger(id) || id <= 0) {
        return json({
          error: "ID inválido."
        }, 400);
      }

      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM price_history WHERE product_id = ?"
        ).bind(id),

        env.DB.prepare(
          "DELETE FROM products WHERE id = ?"
        ).bind(id)
      ]);

      return json({
        success: true,
        message: "Produto excluído."
      });
    }

    return json({
      error: "Método não permitido."
    }, 405);

  } catch (error) {
    console.error("Erro na API:", error);

    return json({
      error: "Erro interno ao processar a solicitação."
    }, 500);
  }
}
