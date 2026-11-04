function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json({ error: "Banco de dados não conectado." }, 500);
    }

    // LISTAR PRODUTOS
    if (request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT id, name, url, target_price, current_price,
               store, active, created_at, last_checked_at
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

      if (!url || url.length > 2048) {
        return json({ error: "Link inválido." }, 400);
      }

      let parsedUrl;

      try {
        parsedUrl = new URL(url);
      } catch {
        return json({ error: "Informe uma URL válida." }, 400);
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return json({ error: "O link precisa usar HTTP ou HTTPS." }, 400);
      }

      if (!Number.isFinite(target) || target <= 0) {
        return json({ error: "Informe um preço desejado válido." }, 400);
      }

      const store = parsedUrl.hostname;

      const result = await env.DB.prepare(`
        INSERT INTO products (name, url, target_price, store)
        VALUES (?, ?, ?, ?)
      `).bind(name, url, target, store).run();

      return json({
        success: true,
        id: result.meta.last_row_id,
        message: "Produto cadastrado!"
      }, 201);
    }

    // EXCLUIR PRODUTO
    if (request.method === "DELETE") {
      const id = Number(new URL(request.url).searchParams.get("id"));

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

      return json({ success: true, message: "Produto excluído." });
    }

    return json({ error: "Método não permitido." }, 405);

  } catch (error) {
    console.error(error);
    return json({ error: "Erro interno ao processar a solicitação." }, 500);
  }
}
