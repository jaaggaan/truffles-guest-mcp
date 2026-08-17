/** Official Truffles Bengaluru outlets. This MCP does not serve other brands or cities. */
export const OUTLETS = [
  { id: "st-marks", name: "Truffles St. Marks Road", address: "#22, St. Marks Road, Ashok Nagar, Bengaluru 560001" },
  { id: "st-marks-vasavi", name: "Truffles St. Marks Road (Vasavi)", address: "#117/2, Vasavi Complex, St. Marks Road, Bengaluru 560001" },
  { id: "koramangala", name: "Truffles Koramangala", address: "Apex Building, 93/A, 4th B Cross, 5th Block, Koramangala, Bengaluru 560095" },
  { id: "jp-nagar", name: "Truffles JP Nagar", address: "Eterna, 788, 15th Cross, 1st Phase, JP Nagar, Bengaluru 560078" },
  { id: "indiranagar", name: "Truffles Indiranagar", address: "KP Square, 307, 100 Feet Road, Indiranagar, Bengaluru 560008" },
  { id: "kalyan-nagar", name: "Truffles Kalyan Nagar", address: "408, 5th A Main, HRBR 2nd Block, Kalyan Nagar, Bengaluru 560043" },
  { id: "sanjaynagar", name: "Truffles Sanjaynagar", address: "84, 80 Feet Road, Jaladarsini Layout, Bengaluru 560094" },
  { id: "jakkur", name: "Truffles Jakkur", address: "1 & 39, New Airport Road, Yelahanka, Bengaluru 560065" },
  { id: "whitefield", name: "Truffles Whitefield", address: "Nallurahalli Village, KR Puram Hobli, Bengaluru 560066" },
  { id: "electronic-city", name: "Truffles Electronic City", address: "47/11, Velankani Drive, Electronic City Phase I, Bengaluru 560100" },
  { id: "bellandur", name: "Truffles Bellandur", address: "164 Cherry Lane, Green Glen Layout, Bellandur, Bengaluru 560103" },
  { id: "mahadevapura", name: "Truffles Mahadevapura", address: "Trifecta Starlight B Wing, ITPL Main Road, Mahadevapura, Bengaluru 560048" }
];

const OTHER_BRAND = /\b(mcdonald|mcd|kfc|burger king|domino|pizza hut|toit|social|starbucks|cafe coffee|ccd|subway|wow momo|biryani|paradise|meghana|empire|corner house)\b/i;

export function isOtherBrand(text) {
  return OTHER_BRAND.test(String(text || ""));
}

export function findOutlet(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return OUTLETS;
  return OUTLETS.filter(
    (o) =>
      o.id.includes(q.replace(/\s+/g, "-")) ||
      o.name.toLowerCase().includes(q) ||
      o.address.toLowerCase().includes(q)
  );
}
