
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
  "americanas.com.br",
  "aliexpress.com"
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
  return ALLOWED_STORES.some(domain =>
    hostname === domain || hostname.endsWith("." + domain)
  );
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

// Extrai os atributos de uma tag HTML
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

// Valida e normaliza a imagem
function normalizeImage(value, pageUrl) {
  if (!value) return null;

  value = decodeHtml(value.trim());

  if (
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("javascript:")
  ) {
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

// Extrai imagens de JSON-LD
function extractJsonLd(html, pageUrl) {
  const scripts = html.match(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  function findImage(data) {
    if (!data || typeof data !== "object") return null;

    if (Array.isArray(data)) {
      for (const item of data) {
        const result = findImage(item);
        if (result) return result;
      }

      return null;
    }

    if (data["@graph"]) {
      const result = findImage(data["@graph"]);
      if (result) return result;
    }

    const type = data["@type"];

    const isProduct = Array.isArray(type)
      ? type.includes("Product")
      : type === "Product";

    if (isProduct && data.image) {
      const images = Array.isArray(data.image)
        ? data.image
        : [data.image];

      for (const item of images) {
        const value = typeof item === "string"
          ? item
          : item?.url || item?.contentUrl;

        const result = normalizeImage(value, pageUrl);

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
      const data = JSON.parse(content);
      const result = findImage(data);

      if (result) return result;

    } catch {}
  }

  return null;
}

// Extrai imagens dos metadados e HTML
function extractImage(html, pageUrl) {
  const tags = html.match(/<(?:meta|link)\b[^>]*>/gi) || [];

  const candidates = [];

  // 1. Metadados Open Graph, Twitter e Product
  const priorityProperties = [
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
    "product:image",
    "image"
  ];

  for (const tag of tags) {
    const attrs = getAttributes(tag);

    const key = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ""
    ).toLowerCase();

    const content = attrs.content || attrs.href;

    if (
      content &&
      priorityProperties.includes(key)
    ) {
      candidates.push({
        priority: priorityProperties.indexOf(key),
        url: content
      });
    }

    // 2. Imagem alternativa da página
    if (
      attrs.rel &&
      attrs.rel.toLowerCase().includes("image_src") &&
      attrs.href
    ) {
      candidates.push({
        priority: 6,
        url: attrs.href
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);

  for (const candidate of candidates) {
    const image = normalizeImage(candidate.url, pageUrl);

    if (image) return image;
  }

  // 3. Dados estruturados do produto
  const jsonLdImage = extractJsonLd(html, pageUrl);

  if (jsonLdImage) return jsonLdImage;

  // 4. Imagens encontradas diretamente no HTML
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

    // 5. Imagens em srcset
    if (attrs.srcset) {
      const sources = attrs.srcset.split(",");

      for (const source of sources.reverse()) {
        const imageUrl = source.trim().split(/\s+/)[0];
        const result = normalizeImage(imageUrl, pageUrl);

        if (result) return result;
      }
    }
  }

  return null;
}

// Consulta a página do produto
async function getProductImage(url) {
  let currentUrl = new URL(url);

  if (!allowedHost(currentUrl.hostname)) {
    return null;
  }

  try {
    for (let i = 0; i < 4; i++) {
      const response = await fetch(currentUrl.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",

          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
        }
      });

      // Tratar redirecionamentos
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");

        if (!location) return null;

        const nextUrl = new URL(location, currentUrl);

        if (
          !["http:", "https:"].includes(nextUrl.protocol) ||
          !allowedHost(nextUrl.hostname)
        ) {
          return null;
        }

        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) return null;

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        return null;
      }

      // Limitar leitura da página a aproximadamente 1 MB
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

      return extractImage(html, currentUrl.href);
    }

  } catch (error) {
    console.log(
      "Erro ao buscar imagem:",
      error.message
    );
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
        return json({
          error: "Nome inválido."
        }, 400);
      }

      if (!url || url.length > 2048) {
        return json({
          error: "Link inválido."
        }, 400);
      }

      let parsedUrl;

      try {
        parsedUrl = new URL(url);
      } catch {
        return json({
          error: "Informe uma URL válida."
        }, 400);
      }

      if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        parsedUrl.username ||
        parsedUrl.password
      ) {
        return json({
          error: "URL não permitida."
        }, 400);
      }

      if (!Number.isFinite(target) || target <= 0) {
        return json({
          error: "Preço desejado inválido."
        }, 400);
      }

      // Buscar imagem
      const imageUrl = await getProductImage(url);

      const store = parsedUrl.hostname;

      const result = await env.DB.prepare(`
        INSERT INTO products (
          name,
          url,
          target_price,
          store,
          image_url
        )
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        name,
        url,
        target,
        store,
        imageUrl
      ).run();

      return json({
        success: true,
        id: result.meta.last_row_id,
        image_found: Boolean(imageUrl),
        image_url: imageUrl,
        message: imageUrl
          ? "Produto cadastrado com imagem!"
          : "Produto cadastrado, mas a imagem não foi encontrada."
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
