/** Dish photos: store https URLs on menu_items.image_url, embed JPEG bytes in chat. */

const COUNTS = { burger: 6, starter: 5, pizza: 3, pasta: 4, mains: 4, dessert: 4, drink: 5 };
const MAX_IMAGE_BYTES = 180_000;

export const PHOTO_SOURCES = {
  burger: [
    "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1571091718767-18b5b1457add?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1553979459-d2229ba7433b?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1572802419224-296b0aeee0d9?auto=format&fit=crop&w=800&q=70"
  ],
  starter: [
    "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1608039755401-742074f0548d?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1639024471283-03518883512d?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1603360946369-dc9bb6258143?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=70"
  ],
  pizza: [
    "https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=800&q=70"
  ],
  pasta: [
    "https://images.unsplash.com/photo-1621996346565-e3dbc646d9a7?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1612874742237-6526221588e3?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1551183053-bf2fbd519d03?auto=format&fit=crop&w=800&q=70"
  ],
  mains: [
    "https://images.unsplash.com/photo-1544025162-d76690232c11?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1558030006-450675393462?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=70"
  ],
  dessert: [
    "https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1562376552-0d160a2f238d?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1606313564200-e035deb567c3?auto=format&fit=crop&w=800&q=70"
  ],
  drink: [
    "https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1511920170033-f8396924c348?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=800&q=70",
    "https://images.unsplash.com/photo-1485808191679-5f86510681aa?auto=format&fit=crop&w=800&q=70"
  ]
};

export function photoBucket(name, category) {
  const t = `${name} ${category}`.toLowerCase();
  if (/pizza/.test(t)) return "pizza";
  if (/pasta|penne|spaghetti|fettuccine|alfredo|arrabi/.test(t)) return "pasta";
  if (/fries|wing|onion|skewer|mushroom bite|starter/.test(t)) return "starter";
  if (/sizzler|steak|chop|main/.test(t)) return "mains";
  if (/brownie|cake|waffle|pie|sundae|dessert/.test(t)) return "dessert";
  if (/shake|cooler|frappe|smoothie|macchiato|beverage|coffee/.test(t)) return "drink";
  if (/burger/.test(t)) return "burger";
  return "burger";
}

export function photoFile(name, category, seed = 0) {
  const bucket = photoBucket(name, category);
  const n = COUNTS[bucket] || 6;
  const idx = Math.abs(Number(seed) || 0) % n;
  return `${bucket}-${idx}.jpg`;
}

export function hostedPhotoUrl(base, name, category, seed = 0) {
  const root = String(base || "https://truffles-guest-mcp.onrender.com").replace(/\/$/, "");
  return `${root}/photos/${photoFile(name, category, seed)}`;
}

/** Stable Unsplash URL to persist on menu_items.image_url */
export function sourcePhotoUrl(name, category, seed = 0) {
  const bucket = photoBucket(name, category);
  const list = PHOTO_SOURCES[bucket] || PHOTO_SOURCES.burger;
  const idx = Math.abs(Number(seed) || 0) % list.length;
  const raw = list[idx];
  return raw.replace("w=800", "w=320");
}

export function catalogPhotoUrl(stored, name, category, seed = 0) {
  const url = String(stored || "").trim();
  if (/^https?:\/\//i.test(url) && !/foodish-api/i.test(url)) return url;
  return sourcePhotoUrl(name, category, seed);
}

function compactUnsplash(url) {
  if (!url.includes("images.unsplash.com")) return url;
  const base = url.split("?")[0];
  return `${base}?auto=format&fit=crop&q=70&w=320&h=320`;
}

/** MCP image block (base64). Skip junk so Claude does not show a blank thumbnail. */
export async function fetchInlineImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(compactUnsplash(url), {
      headers: { "User-Agent": "TrufflesGuestMCP/1.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const ctype = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!ctype.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 80 || buf.length > MAX_IMAGE_BYTES) return null;
    return {
      type: "image",
      data: buf.toString("base64"),
      mimeType: ctype
    };
  } catch {
    return null;
  }
}
