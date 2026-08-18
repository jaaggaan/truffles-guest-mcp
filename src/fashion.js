import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fetchInlineImage } from "./photos.js";

const SHOPPERS_URL = (process.env.SHOPPERS_SUPABASE_URL || "https://stnunolvbdvbhwolrnnd.supabase.co").replace(
  /\/$/,
  ""
);
const SHOPPERS_KEY =
  process.env.SHOPPERS_SUPABASE_ANON_KEY || "sb_publishable_lb5pkUjGApbO0gjZDwz70w_kPLLQLxA";

let shoppersClient = null;
function shoppersDb() {
  if (!shoppersClient) {
    shoppersClient = createClient(SHOPPERS_URL, SHOPPERS_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return shoppersClient;
}

function digits(v) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}

function inr(n) {
  const x = Math.round(Number(n) || 0);
  return `₹${x.toLocaleString("en-IN")}`;
}

export function registerFashionTools(server, { text, publicBase }) {
  const payUrl = (orderId) => `${String(publicBase).replace(/\/$/, "")}/ss/${encodeURIComponent(orderId)}`;

  server.registerTool(
    "search_fashion",
    {
      title: "Search Shoppers Stop fashion",
      description:
        "Shoppers Stop only (separate DB from Truffles). Search shirts, pants, watches, bags, beauty. Photos are real image bytes in this result — do not turn them into markdown links. Then create_fashion_order and send_fashion_payment_link.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().describe("e.g. watch, nike, gucci, bag"),
        limit: z.number().optional().describe("Max items, default 3")
      }
    },
    async ({ query, limit }) => {
      const cap = Math.min(Math.max(Number(limit) || 3, 1), 4);
      const { data, error } = await shoppersDb().from("products").select("*").order("sku");
      if (error) return text(`Shoppers Stop catalog read failed: ${error.message}`);
      const needle = String(query || "").toLowerCase();
      const matches = (data || []).filter((p) => JSON.stringify(p).toLowerCase().includes(needle)).slice(0, cap);
      if (!matches.length) {
        return text(`No Shoppers Stop matches for “${query}”. Try watch, bag, nike, beauty.`);
      }
      let listing = `Shoppers Stop fashion (not Truffles) — ${matches.length} match(es) for “${query}”:\n`;
      const images = [];
      for (const p of matches) {
        listing += `• ${p.sku} — ${p.name} — ${inr(p.price)} — ${p.status || p.stock}\n`;
        const img = await fetchInlineImage(p.image_url);
        if (img) images.push(img);
      }
      listing += "\nPick a SKU, then create_fashion_order. Payment is a link; photos stay in chat.";
      return { content: [{ type: "text", text: listing }, ...images] };
    }
  );

  server.registerTool(
    "create_fashion_order",
    {
      title: "Order Shoppers Stop item",
      description:
        "Create a fashion order in the Shoppers Stop database only. Never writes to Truffles. After this, send_fashion_payment_link.",
      inputSchema: {
        customer_name: z.string(),
        customer_phone: z.string(),
        customer_email: z.string().optional(),
        sku: z.string(),
        qty: z.number().optional()
      }
    },
    async (args) => {
      const sku = String(args.sku || "").trim().toUpperCase();
      const qty = Math.max(1, Number(args.qty) || 1);
      const phone = digits(args.customer_phone);
      if (phone.length !== 10) return text("Need a 10-digit Indian mobile number.");
      const { data: found, error } = await shoppersDb().from("products").select("*").eq("sku", sku).maybeSingle();
      if (error) return text(error.message);
      if (!found) return text(`SKU ${sku} not in Shoppers Stop catalog. Call search_fashion first.`);
      const unit = Number(found.price) || 0;
      const total = unit * qty;
      const orderId = `SS-ORD-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
      const payload = {
        order_id: orderId,
        customer_name: args.customer_name,
        customer_phone: phone,
        customer_email: args.customer_email || "",
        items_json: [{ sku, name: found.name, qty, price: unit, img: found.image_url }],
        total_amount: total,
        payment_method: "UPI",
        status: "Awaiting Payment",
        store_location: "Online Store (eCom Direct)",
        channel: "MCP",
        shipping_address: "MCP fashion order"
      };
      const { error: oErr } = await shoppersDb().from("orders").upsert(payload, { onConflict: "order_id" });
      if (oErr) return text(`Shoppers Stop order failed: ${oErr.message}`);
      await shoppersDb()
        .from("customers")
        .upsert(
          {
            name: args.customer_name,
            phone,
            email: args.customer_email || "",
            channel: "ONLINE",
            store_location: "Online Store (eCom Direct)",
            last_visit_at: new Date().toISOString()
          },
          { onConflict: "phone" }
        );
      const img = await fetchInlineImage(found.image_url);
      const link = payUrl(orderId);
      return {
        content: [
          {
            type: "text",
            text:
              `Shoppers Stop order ${orderId} (not Truffles).\n${found.name} × ${qty} = ${inr(total)}\n` +
              `Payment link: ${link}\nAfter paying, call confirm_fashion_payment or say paidonline.`
          },
          ...(img ? [img] : [])
        ]
      };
    }
  );

  server.registerTool(
    "send_fashion_payment_link",
    {
      title: "Send Shoppers Stop payment link",
      description: "Razorpay-style payment URL for a Shoppers Stop order id (SS-ORD-...). Truffles food payments still use the existing /r/ticket link.",
      inputSchema: { order_id: z.string() }
    },
    async ({ order_id }) => {
      const id = String(order_id || "").trim();
      if (!id) return text("Need order_id.");
      return text(`Shoppers Stop payment link for ${id}:\n${payUrl(id)}`);
    }
  );

  server.registerTool(
    "confirm_fashion_payment",
    {
      title: "Confirm Shoppers Stop payment",
      description: "Mark a Shoppers Stop fashion order paid. Does not touch Truffles orders. Use confirm_payment for Truffles food.",
      inputSchema: { order_id: z.string() }
    },
    async ({ order_id }) => {
      const id = String(order_id || "").trim();
      const { data, error } = await shoppersDb().from("orders").select("*").eq("order_id", id).maybeSingle();
      if (error) return text(error.message);
      if (!data) return text(`No Shoppers Stop order ${id}.`);
      const { error: uErr } = await shoppersDb().from("orders").update({ status: "Processing" }).eq("order_id", id);
      if (uErr) return text(uErr.message);
      return text(
        `Payment confirmed for Shoppers Stop ${id}. Dashboard: https://shopperstop-dashboard-app.vercel.app/`
      );
    }
  );
}

export { shoppersDb };
