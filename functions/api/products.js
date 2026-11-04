
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function validUrl(value) {
  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;

    if (
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal")
    ) return false;

    if (
      /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
      url.hostname.startsWith("[")
    ) return false;

    if (url.port && url.port !== "80" && url.port !== "443") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

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

function getAttributes(tag) {
  const attrs = {};
  const regex = /([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attrs;
}

function normalizeImage(value, pageUrl) {
  if (!value) return null;

  value = decodeHtml(value.trim());

  if (/^(data:|blob:|javascript:)/i.test(value)) {
    return null;
  }

  try {
    const image = new URL(value, pageUrl);

    if (!["http:", "https:"].includes(image.protocol)) {
      return null;
    }

    if (/\.(svg|ico)(?:$|\?)/i.test(image.pathname)) {
      return null;
    }

    return image.href;
  } catch {
    return null;
  }
}

function parsePrice(value) {
  if (value === null || value === undefined) return null;

  let text = decodeHtml(String(value))
    .trim()
    .replace(/\s/g, "")
    .replace(/[^\d.,-]/g, "");

  if (!text || !/\d/.test(text)) return null;

  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }

  const price = Number(text);

  if (!Number.isFinite(price) || price <= 0 || price > 100000000) {
    return null;
  }

  return Math.round(price * 100) / 100;
}

// Extrai informações de produtos em JSON-LD
function extractJsonLd(html, pageUrl) {
  const scripts = html.match(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  function findProduct(data) {
    if (!data || typeof data !== "object") return null;

    if (Array.isArray(data)) {
      for (const item of data) {
        const result = findProduct(item);
        if (result) return result;
      }

      return null;
    }

    const type = data["@type"];
    const isProduct = Array.isArray(type)
      ? type.some(t => String(t).toLowerCase() === "product")
      : String(type || "").toLowerCase() === "product";

    if (isProduct) {
      let price = null;
      let image = null;

      const offers = Array.isArray(data.offers)
        ? data.offers
        : data.offers ? [data.offers] : [];

      for (const offer of offers) {
        const possiblePrices = [
          offer.price,
          offer.lowPrice,
          offer.priceSpecification?.price,
          offer.priceSpecification?.minPrice
        ];

        for (const value of possiblePrices) {
          price = parsePrice(value);
          if (price !== null) break;
        }

        if (price !== null) break;
      }

      if (data.image) {
        const images = Array.isArray(data.image)
          ? data.image
          : [data.image];

        for (const item of images) {
          const value = typeof item === "string"
            ? item
            : item?.url || item?.contentUrl;

          image = normalizeImage(value, pageUrl);
          if (image) break;
        }
      }

      if (price !== null || image) {
        return { price, image };
      }
    }

    for (const value of Object.values(data)) {
      if (value && typeof value === "object") {
        const result = findProduct(value);
        if (result) return result;
      }
    }

    return null;
  }

  for (const script of scripts) {
    const content = script
      .replace(/^<script\b[^>]*>/i, "")
      .replace(/<\/script>$/i, "");

    try {
      const result = findProduct(JSON.parse(content));
      if (result) return result;
    } catch {}
  }

  return { price: null, image: null };
}

// Extrai preço dos metadados
function extractMetaPrice(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  const acceptedNames = [
    "product:price:amount",
    "og:price:amount",
    "price",
    "product:price"
  ];

  for (const tag of tags) {
    const attrs = getAttributes(tag);

    const key = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ""
    ).toLowerCase();

    if (acceptedNames.includes(key) && attrs.content) {
      const price = parsePrice(attrs.content);
      if (price !== null) return price;
    }
  }

  return null;
}

// Extrai preço diretamente do HTML
function extractHtmlPrice(html) {
  const tags = html.match(/<[^>]+>/g) || [];

  for (const tag of tags) {
    const attrs = getAttributes(tag);

    if ((attrs.itemprop || "").toLowerCase() === "price") {
      const price = parsePrice(
        attrs.content || attrs.value || attrs["data-price"]
      );

      if (price !== null) return price;
    }
  }

  const patterns = [
    /data-price\s*=\s*["']([^"']+)["']/gi,
    /data-product-price\s*=\s*["']([^"']+)["']/gi,
    /data-sale-price\s*=\s*["']([^"']+)["']/gi,
    /data-current-price\s*=\s*["']([^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(html)) !== null) {
      const price = parsePrice(match[1]);
      if (price !== null) return price;
    }
  }

  const elements = html.match(
    /<(?:span|div|p)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:price|preco|valor)[^"']*["'][^>]*>[^<]{1,100}<\/(?:span|div|p)>/gi
  ) || [];

  for (const element of elements) {
    const content = element.replace(/<[^>]*>/g, " ");
    const price = parsePrice(content);

    if (price !== null) return price;
  }

  return null;
}

// Extrai imagem dos metadados e HTML
function extractHtmlImage(html, pageUrl) {
  const tags = html.match(/<(?:meta|link)\b[^>]*>/gi) || [];

  const properties = [
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
    "product:image"
  ];

  for (const tag of tags) {
    const attrs = getAttributes(tag);

    const key = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ""
    ).toLowerCase();

    const value = attrs.content || attrs.href;

    if (properties.includes(key) && value) {
      const image = normalizeImage(value, pageUrl);
      if (image) return image;
    }

    if (
      attrs.rel &&
      attrs.rel.toLowerCase().includes("image_src") &&
      attrs.href
    ) {
      const image = normalizeImage(attrs.href, pageUrl);
      if (image) return image;
    }
  }

  // Procura imagens diretamente nas tags img
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const value =
      attrs["data-src"] ||
      attrs["data-original"] ||
      attrs["data-lazy-src"] ||
      attrs.src;

    const image = normalizeImage(value, pageUrl);

    if (image) return image;

    if (attrs.srcset) {
      for (const source of attrs.srcset.split(",").reverse()) {
        const imageUrl = source.trim().split(/\s+/)[0];
        const result = normalizeImage(imageUrl, pageUrl);

        if (result) return result;
      }
    }
  }

  return null;
}

// Analisa a página e retorna preço e imagem
function extractProductData(html, pageUrl) {
  const structured = extractJsonLd(html, pageUrl);

  const price =
    structured.price ??
    extractMetaPrice(html) ??
    extractHtmlPrice(html);

  const image =
    structured.image ??
    extractHtmlImage(html, pageUrl);

  return { price, image };
}

// Consulta a página do produto
async function getProductData(url) {
  let currentUrl = new URL(url);

  if (!validUrl(currentUrl.href)) {
    return { price: null, image: null };
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

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");

        if (!location) break;

        const nextUrl = new URL(location, currentUrl);

        if (!validUrl(nextUrl.href)) break;

        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        console.log("Página retornou status:", response.status);
        break;
      }

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) break;

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

      const result = extractProductData(html, currentUrl.href);

      console.log("Resultado da extração:", {
        price_found: result.price !== null,
        image_found: result.image !== null
      });

      return result;
    }
  } catch (error) {
    console.log("Erro ao consultar produto:", error.message);
  }

  return { price: null, image: null };
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
          image_url,
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
        return json({ error: "Nome inválido." }, 400);
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

      // Busca preço e imagem
      const productData = await getProductData(url);

      const store = new URL(url).hostname;

      const result = await env.DB.prepare(`
        INSERT INTO products (
          name,
          url,
          target_price,
          current_price,
          image_url,
          store,
          last_checked_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        name,
        url,
        target,
        productData.price,
        productData.image,
        store,
        productData.price !== null
          ? new Date().toISOString()
          : null
      ).run();

      const productId = result.meta.last_row_id;

      // Registra o primeiro preço no histórico
      if (productData.price !== null) {
        await env.DB.prepare(`
          INSERT INTO price_history (product_id, price)
          VALUES (?, ?)
        `).bind(productId, productData.price).run();
      }

      return json({
        success: true,
        id: productId,
        current_price: productData.price,
        image_url: productData.image,
        price_found: productData.price !== null,
        image_found: productData.image !== null,
        message: "Produto cadastrado com sucesso."
      }, 201);
    }

    // EXCLUIR PRODUTO
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
