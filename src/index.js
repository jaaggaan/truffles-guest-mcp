import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { OUTLETS, findOutlet, isOtherBrand } from "./outlets.js";

const PORT = Number(process.env.PORT || 8080);
const NAME = process.env.MCP_SERVER_NAME || "truffles-guest";

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const digitsOnly = (v) => String(v || "").replace(/\D/g, "");
const json = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
const text = (message) => ({ content: [{ type: "text", text: message }] });

const BUSY = ["occupied", "awaiting_payment", "reserved"];

function createMcpServer() {
  const server = new McpServer({ name: NAME, version: "1.0.0" });
  const db = supabase();

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
      description: "Show the Truffles menu for a Bengaluru outlet. Menu items come from the live menu_items table.",
      inputSchema: {
        outlet: z.string().describe("Outlet area, e.g. Indiranagar"),
        search: z.string().optional().describe("Optional item name filter")
      }
    },
    async ({ outlet, search }) => {
      if (isOtherBrand(outlet)) {
        return text(
          "We currently only serve Truffles in Bengaluru. Pick a Truffles outlet (Koramangala, Indiranagar, St. Marks, JP Nagar, …) to see the menu."
        );
      }
      const { data, error } = await db
        .from("menu_items")
        .select("id, item_name, price, category, is_available")
        .limit(80);
      if (error) return text(`Menu read failed: ${error.message}`);
      const needle = String(search || "").toLowerCase();
      const items = (data || [])
        .filter((row) => row.is_available !== false)
        .filter((row) => !needle || String(row.item_name || "").toLowerCase().includes(needle))
        .map((row) => ({
          id: row.id,
          name: row.item_name,
          price: row.price,
          category: row.category
        }));
      const branch = findOutlet(outlet)[0] || OUTLETS[0];
      return json({ outlet: branch, items });
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
      const start = new Date(`${date}T${time}:00`);
      if (Number.isNaN(start.getTime())) return text("Use date YYYY-MM-DD and time HH:MM.");
      const end = new Date(start.getTime() + 90 * 60 * 1000);

      const { data: tables, error: tErr } = await db
        .from("restaurant_tables")
        .select("id, table_number, status, capacity, seats")
        .order("table_number");
      if (tErr) return text(`Table read failed: ${tErr.message}`);

      const { data: holds } = await db
        .from("reservations")
        .select("id, table_id, start_time, end_time, status")
        .eq("status", "confirmed");

      const available = (tables || []).filter((table) => {
        const cap = Number(table.capacity || table.seats || 4);
        if (cap < Number(party_size)) return false;
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
      const start = new Date(`${args.date}T${args.time}:00`);
      if (Number.isNaN(start.getTime())) return text("Use date YYYY-MM-DD and time HH:MM.");
      const end = new Date(start.getTime() + 90 * 60 * 1000);

      const { data: table, error: tErr } = await db
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
      const { data: booked, error: bErr } = await db.from("reservations").insert([payload]).select();
      if (bErr) return text(`Reservation failed: ${bErr.message}`);

      await db
        .from("restaurant_tables")
        .update({
          status: "reserved",
          customer_name: args.customer_name,
          customer_phone: phone
        })
        .eq("id", table.id);

      return json({
        ok: true,
        message: `Reserved Truffles table ${args.table_number} for ${args.customer_name}. POS will refresh.`,
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

      const { data: menu } = await db.from("menu_items").select("id, item_name, price");
      const lines = args.items.map((item) => {
        const match = (menu || []).find(
          (m) => String(m.item_name || "").toLowerCase() === item.name.toLowerCase()
        );
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

      let { data, error } = await db.from("orders").insert([fullPayload]).select();
      if (error) {
        const { total_amount, ...rest } = fullPayload;
        const retry = await db.from("orders").insert([{ ...rest, total }]).select();
        data = retry.data;
        error = retry.error;
      }
      if (error) return text(`Pre-book failed: ${error.message}`);

      return json({
        ok: true,
        ticket,
        message: `Pre-booked for ${args.customer_name}. Returning Member with this phone should restore items. POS can assign a table from the pre-order queue.`,
        order: data?.[0]
      });
    }
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: NAME, endpoints: ["/mcp"] });
});

async function handleMcp(req, res) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", handleMcp);
app.get("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`${NAME} listening on 0.0.0.0:${PORT}/mcp`);
});
