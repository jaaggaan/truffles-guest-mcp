import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { OUTLETS, findOutlet, isOtherBrand } from "./outlets.js";

const PORT = Number(process.env.PORT || 8080);
const NAME = process.env.MCP_SERVER_NAME || "truffles-guest";

let dbClient = null;
function supabase() {
  if (dbClient) return dbClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  dbClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { fetch: globalThis.fetch }
  });
  return dbClient;
}

const digitsOnly = (v) => String(v || "").replace(/\D/g, "");
const json = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const text = (message) => ({ content: [{ type: "text", text: message }] });

/** Guest times are Bengaluru wall clock (IST, UTC+05:30). Render's TZ is UTC. */
function istDateTime(date, time) {
  const raw = `${date}T${String(time || "").padEnd(5, "0")}:00+05:30`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatIst(d) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(d);
}

const PUBLIC_BASE = (process.env.RENDER_EXTERNAL_URL || "https://truffles-guest-mcp.onrender.com").replace(/\/$/, "");
const PAY_CODE = "paidonline";

async function fetchDishImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mime = String(res.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!mime.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 700000) return null;
    return { mimeType: mime, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

const BUSY = ["occupied", "awaiting_payment", "reserved"];

function createMcpServer() {
  const server = new McpServer({ name: NAME, version: "1.0.0" });
  const db = () => supabase();

  server.registerTool(
    "list_outlets",
    {
      title: "List Truffles outlets",
      description:
        "List Truffles Bengaluru outlets. If the guest named another restaurant, still call this and explain we currently only serve Truffles.",
      inputSchema: { query: z.string().optional().describe("Area name, e.g. Koramangala") }
    },
    async ({ query }) => {
      if (isOtherBrand(query)) {
        return json({
          served: false,
          message:
            "This assistant currently only serves Truffles in Bengaluru. It cannot book other restaurants. Offer a Truffles outlet instead.",
          outlets: OUTLETS
        });
      }
      const matches = findOutlet(query);
      return json({ city: "Bengaluru", brand: "Truffles", outlets: matches.length ? matches : OUTLETS });
    }
  );

  server.registerTool(
    "view_menu",
    {
      title: "View menu",
      description:
        "Show the Truffles menu WITH dish photos. Always display the returned images so the guest can pick items, then call create_prebook. After pre-book, share payment_link and tell them to type paidonline when payment is done.",
      inputSchema: {
        outlet: z.string().describe("Outlet area, e.g. Indiranagar"),
        search: z.string().optional().describe("Optional item name or category filter")
      }
    },
    async ({ outlet, search }) => {
      if (isOtherBrand(outlet)) {
        return text(
          "We currently only serve Truffles in Bengaluru. Pick a Truffles outlet (Koramangala, Indiranagar, St. Marks, JP Nagar, …) to see the menu."
        );
      }
      let { data, error } = await db()
        .from("menu_items")
        .select("id, item_name, price, available, veg, image_url, category_id, menu_categories(category_name)")
        .limit(80);
      if (error) {
        const retry = await db()
          .from("menu_items")
          .select("id, item_name, price, available, veg, image_url")
          .limit(80);
        data = retry.data;
        error = retry.error;
      }
      if (error) return text(`Menu read failed: ${error.message}`);
      const needle = String(search || "").toLowerCase();
      const items = (data || [])
        .filter((row) => row.available !== false)
        .filter((row) => {
          if (!needle) return true;
          const cat = String(row.menu_categories?.category_name || "").toLowerCase();
          return String(row.item_name || "").toLowerCase().includes(needle) || cat.includes(needle);
        })
        .map((row) => ({
          id: row.id,
          name: row.item_name,
          price: Number(row.price) || 0,
          veg: row.veg,
          category: row.menu_categories?.category_name || null,
          image_url: row.image_url || null
        }));
      const branch = findOutlet(outlet)[0] || OUTLETS[0];
      const withPhotos = items.filter((i) => i.image_url).slice(0, 12);
      const photos = await Promise.all(withPhotos.map((i) => fetchDishImage(i.image_url)));
      const content = [
        {
          type: "text",
          text: JSON.stringify(
            {
              outlet: branch,
              how_to_order:
                "Show every dish photo below. Guest picks names and qty. Then create_prebook. Share payment_link. When they type paidonline, call confirm_payment.",
              items
            },
            null,
            2
          )
        }
      ];
      withPhotos.forEach((item, idx) => {
        const img = photos[idx];
        if (img) {
          content.push({ type: "image", mimeType: img.mimeType, data: img.data });
        }
        content.push({
          type: "text",
          text: `${item.name} — ₹${item.price}${item.veg ? " (veg)" : ""} [${item.category || "Menu"}]`
        });
      });
      return { content };
    }
  );

  server.registerTool(
    "check_table_availability",
    {
      title: "Check table availability",
      description: "Find free Truffles tables for a party size. Uses restaurant_tables + open reservations.",
      inputSchema: {
        outlet: z.string().optional(),
        party_size: z.number(),
        date: z.string().describe("YYYY-MM-DD"),
        time: z.string().describe("HH:MM 24h")
      }
    },
    async ({ party_size, date, time }) => {
      const start = istDateTime(date, time);
      if (!start) return text("Use date YYYY-MM-DD and time HH:MM (Bengaluru time).");
      const end = new Date(start.getTime() + 90 * 60 * 1000);

      const { data: tables, error: tErr } = await db()
        .from("restaurant_tables")
        .select("id, table_number, status")
        .order("table_number");
      if (tErr) return text(`Table read failed: ${tErr.message}`);

      const { data: holds } = await db()
        .from("reservations")
        .select("id, table_id, start_time, end_time, status")
        .eq("status", "confirmed");

      const available = (tables || []).filter((table) => {
        if (BUSY.includes(String(table.status || "").toLowerCase())) return false;
        const clash = (holds || []).some((row) => {
          if (row.table_id !== table.id) return false;
          const rowStart = new Date(row.start_time).getTime();
          const rowEnd = row.end_time ? new Date(row.end_time).getTime() : rowStart + 90 * 60 * 1000;
          return rowStart < end.getTime() && rowEnd > start.getTime();
        });
        return !clash;
      });

      return json({
        brand: "Truffles",
        timezone: "Asia/Kolkata",
        display: formatIst(start),
        date,
        time,
        party_size,
        available: available.map((t) => ({
          table_id: t.id,
          table_number: t.table_number,
          status: t.status
        }))
      });
    }
  );

  server.registerTool(
    "book_table",
    {
      title: "Book a table",
      description:
        "Create a confirmed Truffles reservation. Requires name and 10-digit phone. Writes reservations + restaurant_tables so POS updates.",
      inputSchema: {
        table_number: z.number(),
        customer_name: z.string(),
        customer_phone: z.string(),
        party_size: z.number(),
        date: z.string(),
        time: z.string(),
        outlet: z.string().optional()
      }
    },
    async (args) => {
      const phone = digitsOnly(args.customer_phone).slice(-10);
      if (phone.length !== 10) return text("Need a 10-digit Indian mobile number.");
      const start = istDateTime(args.date, args.time);
      if (!start) return text("Use date YYYY-MM-DD and time HH:MM (Bengaluru time).");
      const end = new Date(start.getTime() + 90 * 60 * 1000);

      const { data: table, error: tErr } = await db()
        .from("restaurant_tables")
        .select("id, table_number, status")
        .eq("table_number", args.table_number)
        .maybeSingle();
      if (tErr) return text(tErr.message);
      if (!table) return text(`Table ${args.table_number} not found.`);
      if (BUSY.includes(String(table.status || "").toLowerCase())) {
        return text(`Table ${args.table_number} is already reserved or occupied. Pick another table.`);
      }

      const payload = {
        customer_name: args.customer_name,
        customer_phone: phone,
        table_id: table.id,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        guest_count: args.party_size,
        status: "confirmed"
      };
      const { data: booked, error: bErr } = await db().from("reservations").insert([payload]).select();
      if (bErr) return text(`Reservation failed: ${bErr.message}`);

      await db()
        .from("restaurant_tables")
        .update({
          status: "reserved",
          customer_name: args.customer_name,
          customer_phone: phone
        })
        .eq("id", table.id);

      return json({
        ok: true,
        timezone: "Asia/Kolkata",
        display: formatIst(start),
        message: `Reserved Truffles table ${args.table_number} for ${args.customer_name} at ${formatIst(start)} (Bengaluru time). POS will refresh.`,
        reservation: booked?.[0]
      });
    }
  );

  server.registerTool(
    "create_prebook",
    {
      title: "Pre-book food",
      description:
        "Hold menu items before the guest sits. Writes an orders row with is_preorder true and no table yet. POS pre-order queue can assign a table later.",
      inputSchema: {
        outlet: z.string().optional(),
        customer_name: z.string(),
        customer_phone: z.string(),
        items: z
          .array(
            z.object({
              name: z.string(),
              qty: z.number().default(1),
              price: z.number().optional()
            })
          )
          .min(1)
      }
    },
    async (args) => {
      const phone = digitsOnly(args.customer_phone).slice(-10);
      if (phone.length !== 10) return text("Need a 10-digit Indian mobile number.");

      const { data: menu } = await db().from("menu_items").select("id, item_name, price");
      const lines = args.items.map((item) => {
        const want = String(item.name || "").toLowerCase();
        const match = (menu || []).find((m) => {
          const have = String(m.item_name || "").toLowerCase();
          return have === want || have.includes(want) || want.includes(have);
        });
        const price = Number(item.price ?? match?.price ?? 0);
        const qty = Number(item.qty || 1);
        return {
          id: match?.id || item.name,
          menuItemId: match?.id,
          name: match?.item_name || item.name,
          price,
          qty,
          customizations: []
        };
      });
      const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);
      const ticket = `MCP-${Date.now().toString().slice(-6)}`;
      const branch = findOutlet(args.outlet)[0];
      const paymentLink = `${PUBLIC_BASE}/pay?ticket=${encodeURIComponent(ticket)}&amount=${encodeURIComponent(String(total))}&name=${encodeURIComponent(args.customer_name)}`;

      const fullPayload = {
        customer_name: args.customer_name,
        customer_phone: phone,
        table_id: null,
        items: lines,
        total_amount: total,
        total,
        order_status: "New",
        payment_status: "Pending",
        is_preorder: true,
        preorder_ticket: ticket,
        notes: `MCP pre-book${branch ? ` | ${branch.name}` : ""}`
      };

      let { data, error } = await db().from("orders").insert([fullPayload]).select();
      if (error) {
        const { total_amount, ...rest } = fullPayload;
        const retry = await db().from("orders").insert([{ ...rest, total }]).select();
        data = retry.data;
        error = retry.error;
      }
      if (error) return text(`Pre-book failed: ${error.message}`);

      return json({
        ok: true,
        ticket,
        total,
        payment_link: paymentLink,
        payment_code: PAY_CODE,
        message: `Pre-booked for ${args.customer_name}, ticket ${ticket}, total ₹${total}. Share this payment link: ${paymentLink}. Tell the guest: after paying, type exactly "${PAY_CODE}" in this chat. Then call confirm_payment.`,
        order: data?.[0]
      });
    }
  );

  server.registerTool(
    "confirm_payment",
    {
      title: "Confirm payment",
      description:
        "Mark a pre-book as paid. Call this when the guest types paidonline (the success code) after opening the payment link.",
      inputSchema: {
        code: z.string().describe("Guest typed this. Success code is paidonline"),
        ticket: z.string().optional().describe("MCP ticket e.g. MCP-123456"),
        customer_phone: z.string().optional()
      }
    },
    async (args) => {
      const typed = String(args.code || "").toLowerCase().replace(/\s+/g, "");
      if (typed !== PAY_CODE) {
        return json({
          ok: false,
          message: `That is not the success code. Ask the guest to type ${PAY_CODE} after they open the payment link.`
        });
      }
      const ticket = String(args.ticket || "").trim();
      const phone = digitsOnly(args.customer_phone).slice(-10);
      let q = db().from("orders").select("*").eq("is_preorder", true).order("created_at", { ascending: false }).limit(10);
      if (ticket) q = q.eq("preorder_ticket", ticket);
      else if (phone) q = q.eq("customer_phone", phone);
      const { data, error } = await q;
      if (error) return text(`Payment lookup failed: ${error.message}`);
      const order = (data || [])[0];
      if (!order) return text("No matching pre-book found. Need the ticket or the same phone used to order.");

      const { data: updated, error: uErr } = await db()
        .from("orders")
        .update({
          payment_status: "Paid",
          notes: `${order.notes || ""} | paid=${PAY_CODE}`
        })
        .eq("id", order.id)
        .select();
      if (uErr) return text(`Could not mark paid: ${uErr.message}`);

      return json({
        ok: true,
        status: "successful",
        message: `Payment successful for ticket ${order.preorder_ticket}. ₹${order.total || order.total_amount || 0} received (code ${PAY_CODE}). POS pre-order queue can assign a table.`,
        order: updated?.[0]
      });
    }
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: NAME, endpoints: ["/mcp", "/pay"] });
});

app.get("/pay", (req, res) => {
  const ticket = String(req.query.ticket || "MCP");
  const amount = String(req.query.amount || "0");
  const name = String(req.query.name || "Guest");
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Truffles pay ${ticket}</title>
<style>
  body{margin:0;font-family:Georgia,serif;background:#F8F6F0;color:#234A3B;padding:32px}
  .card{max-width:420px;margin:40px auto;background:#fff;border:1px solid #d9d0c3;padding:28px}
  h1{font-size:22px;margin:0 0 8px}
  .amt{font-size:32px;color:#8B6B4A;margin:16px 0}
  code{background:#234A3B;color:#F8F6F0;padding:4px 8px}
  p{line-height:1.5}
</style></head>
<body>
  <div class="card">
    <h1>Truffles Bengaluru</h1>
    <p>Pre-order for ${name.replace(/[<>]/g, "")}</p>
    <p>Ticket <strong>${ticket.replace(/[<>]/g, "")}</strong></p>
    <div class="amt">₹${amount.replace(/[<>]/g, "")}</div>
    <p>This is a test payment page. After you are done, go back to Claude and type exactly:</p>
    <p><code>${PAY_CODE}</code></p>
    <p>Claude will mark this pre-order as paid.</p>
  </div>
</body></html>`);
});

async function handleMcp(req, res) {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp]", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

app.post("/mcp", handleMcp);
app.get("/mcp", async (req, res) => {
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) {
    res.json({
      ok: true,
      service: NAME,
      hint: "This is the MCP endpoint for Cursor/Claude. Open /health in a browser. Paste this /mcp URL into Cursor MCP settings."
    });
    return;
  }
  await handleMcp(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`${NAME} listening on 0.0.0.0:${PORT}/mcp`);
});
