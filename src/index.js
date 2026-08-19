import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { OUTLETS, findOutlet, isOtherBrand } from "./outlets.js";
import { catalogPhotoUrl, fetchInlineImage } from "./photos.js";
import { registerFashionTools, shoppersDb } from "./fashion.js";
import { mountOAuth } from "./oauth.js";

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

function isPaidOnline(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "") === PAY_CODE;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
        "Show the Truffles menu. Photos are returned as real image bytes in this tool result (inline in chat). Do not convert them to markdown links. Guest picks items, then create_prebook. Share the Razorpay payment link as a button/label. If they later say paid online, call confirm_payment.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
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
      const filtered = (data || [])
        .filter((row) => row.available !== false)
        .filter((row) => {
          if (!needle) return true;
          const cat = String(row.menu_categories?.category_name || "").toLowerCase();
          return String(row.item_name || "").toLowerCase().includes(needle) || cat.includes(needle);
        });

      const items = filtered.map((row, idx) => {
        const category = row.menu_categories?.category_name || "Menu";
        const image_url = catalogPhotoUrl(row.image_url, row.item_name, category, idx);
        return {
          id: row.id,
          name: row.item_name,
          price: Number(row.price) || 0,
          veg: row.veg,
          category,
          image_url
        };
      });

      const writes = [];
      for (let i = 0; i < filtered.length; i++) {
        const row = filtered[i];
        const nextUrl = items[i].image_url;
        const prev = String(row.image_url || "").trim();
        if (row.id && nextUrl && prev !== nextUrl) {
          writes.push(db().from("menu_items").update({ image_url: nextUrl }).eq("id", row.id));
        }
      }
      if (writes.length) Promise.allSettled(writes).catch(() => {});

      const branch = findOutlet(outlet)[0] || OUTLETS[0];
      const byCat = new Map();
      for (const item of items) {
        const key = item.category || "Menu";
        if (!byCat.has(key)) byCat.set(key, []);
        byCat.get(key).push(item);
      }
      let listing = `Truffles menu — ${branch.name}\nPhotos are attached in this message (from menu_items.image_url). Payment stays a link after you pre-book.\n\n`;
      for (const [cat, rows] of byCat) {
        listing += `## ${cat}\n`;
        for (const item of rows) {
          listing += `• ${item.name} — ₹${item.price}${item.veg ? " (veg)" : ""}\n`;
        }
        listing += "\n";
      }

      const photoItems = (needle ? items : items.slice(0, 4)).slice(0, 4);
      listing += needle
        ? `Showing up to ${photoItems.length} dish photo(s) for “${search}”.`
        : "Showing 4 dish photos. Name a dish or category to see more pictures.";

      const images = [];
      for (const item of photoItems) {
        const block = await fetchInlineImage(item.image_url);
        if (block) images.push(block);
      }

      return {
        content: [{ type: "text", text: listing }, ...images]
      };
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
      const paymentLink = `${PUBLIC_BASE}/r/${encodeURIComponent(ticket)}`;

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
        razorpay_label: "Pay securely with Razorpay",
        guest_message: `Pre-order confirmed for ${args.customer_name}. Ticket ${ticket}. Total ₹${total}. Ask them to complete payment with Razorpay using this link: ${paymentLink}. Do not mention any code or tell them what to type next.`,
        message: `Pre-order saved. Share payment_link as a Razorpay pay button. If the guest later says paid online, call confirm_payment. Never instruct them to type a code.`
      });
    }
  );

  server.registerTool(
    "confirm_payment",
    {
      title: "Confirm payment",
      description:
        "Mark a pre-book as paid. Call this when the guest says they paid, paid online, or paidonline. Do not tell the guest to type a code.",
      inputSchema: {
        code: z.string().optional().describe("Whatever the guest said, e.g. paid online"),
        ticket: z.string().optional().describe("MCP ticket e.g. MCP-123456"),
        customer_phone: z.string().optional()
      }
    },
    async (args) => {
      const saidPaid = !args.code || isPaidOnline(args.code) || /paid/i.test(String(args.code || ""));
      if (!saidPaid) {
        return json({ ok: false, message: "Guest has not confirmed payment yet." });
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
        message: `Payment successful for ticket ${order.preorder_ticket}. ₹${order.total || order.total_amount || 0} received. Tell the guest payment is successful. Do not mention a code.`,
        order: updated?.[0]
      });
    }
  );

  registerFashionTools(server, { text, publicBase: PUBLIC_BASE });

  return server;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
mountOAuth(app);

const photosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "photos");
app.use(
  "/photos",
  express.static(photosDir, {
    fallthrough: false,
    maxAge: "7d",
    setHeaders(res) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    }
  })
);

function razorpayCheckoutPage({ ticket, amount, name }) {
  const t = escapeHtml(ticket);
  const a = escapeHtml(amount);
  const n = escapeHtml(name);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Razorpay Checkout</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#eef2f6;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1a1a1a}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .sheet{width:100%;max-width:420px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 16px 48px rgba(15,23,42,.18)}
  .top{background:#072654;color:#fff;padding:18px 20px;display:flex;justify-content:space-between;align-items:center}
  .brand{font-weight:700;letter-spacing:.4px}
  .rzp{font-size:13px;opacity:.85}
  .amt{padding:20px 20px 8px;font-size:28px;font-weight:700}
  .meta{padding:0 20px 16px;color:#5b6573;font-size:13px;line-height:1.5}
  .field{padding:0 20px 12px}
  .field label{display:block;font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
  .field input{width:100%;border:1px solid #d7dee8;border-radius:8px;padding:10px 12px;font-size:14px}
  .methods{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 20px 16px}
  .m{border:1px solid #d7dee8;border-radius:8px;padding:10px;font-size:13px;text-align:center;cursor:pointer}
  .m.on{border-color:#3395ff;background:#f0f7ff;color:#072654;font-weight:600}
  .pay{margin:8px 20px 20px;width:calc(100% - 40px);border:0;border-radius:8px;background:#3395ff;color:#fff;font-size:16px;font-weight:700;padding:14px;cursor:pointer}
  .foot{padding:0 20px 18px;text-align:center;font-size:11px;color:#8a93a0}
  .ok{display:none;padding:48px 24px;text-align:center}
  .ok h2{margin:12px 0 8px;color:#0f9d58}
  .dot{width:64px;height:64px;border-radius:50%;background:#0f9d58;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:32px}
</style>
</head><body>
<div class="wrap">
  <div class="sheet" id="box">
    <div class="top"><div class="brand">Truffles</div><div class="rzp">Razorpay</div></div>
    <div id="form">
      <div class="amt">₹${a}</div>
      <div class="meta">Order ${t}<br>Paying as ${n}<br>Truffles Hospitality · Bengaluru</div>
      <div class="field"><label>Contact</label><input placeholder="10-digit mobile" /></div>
      <div class="field"><label>Email</label><input placeholder="email@example.com" /></div>
      <div class="methods">
        <div class="m on" onclick="sel(this)">UPI</div>
        <div class="m" onclick="sel(this)">Cards</div>
        <div class="m" onclick="sel(this)">Netbanking</div>
        <div class="m" onclick="sel(this)">Wallet</div>
      </div>
      <button class="pay" onclick="pay()">Pay ₹${a}</button>
      <div class="foot">Secured by Razorpay · Test checkout</div>
    </div>
    <div class="ok" id="ok">
      <div class="dot">✓</div>
      <h2>Payment successful</h2>
      <p>₹${a} received for order ${t}.</p>
    </div>
  </div>
</div>
<script>
function sel(el){document.querySelectorAll('.m').forEach(function(n){n.classList.remove('on')});el.classList.add('on')}
function pay(){document.getElementById('form').style.display='none';document.getElementById('ok').style.display='block'}
</script>
</body></html>`;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: NAME,
    brands: ["truffles-food", "shoppers-stop-fashion"],
    endpoints: ["/mcp", "/r/:ticket", "/ss/:orderId", "/oauth/register"],
  });
});

app.get("/r/:ticket", async (req, res) => {
  const ticket = String(req.params.ticket || "");
  let amount = "0";
  let name = "Guest";
  try {
    const { data } = await supabase()
      .from("orders")
      .select("customer_name, total, total_amount, preorder_ticket")
      .eq("preorder_ticket", ticket)
      .maybeSingle();
    if (data) {
      name = data.customer_name || name;
      amount = String(data.total ?? data.total_amount ?? 0);
    }
  } catch (err) {
    console.error("[pay lookup]", err);
  }
  res.type("html").send(razorpayCheckoutPage({ ticket, amount, name }));
});

app.get("/ss/:orderId", async (req, res) => {
  const orderId = String(req.params.orderId || "");
  let amount = "0";
  let name = "Guest";
  try {
    const { data } = await shoppersDb()
      .from("orders")
      .select("customer_name, total_amount, order_id")
      .eq("order_id", orderId)
      .maybeSingle();
    if (data) {
      name = data.customer_name || name;
      amount = String(data.total_amount ?? 0);
    }
  } catch (err) {
    console.error("[ss pay lookup]", err);
  }
  const html = razorpayCheckoutPage({ ticket: orderId, amount, name }).replaceAll("Truffles", "Shoppers Stop");
  res.type("html").send(html);
});

app.get("/pay", (req, res) => {
  res.type("html").send(
    razorpayCheckoutPage({
      ticket: req.query.ticket || "MCP",
      amount: req.query.amount || "0",
      name: req.query.name || "Guest"
    })
  );
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
