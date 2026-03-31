const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_FILE = path.join(__dirname, "db.json");

// ── Tiny JSON database ──────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_FILE)) return { sellers: {}, products: [], sessions: {} };
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function uid() { return crypto.randomBytes(12).toString("hex"); }
function hash(p) { return crypto.createHash("sha256").update(p + "millo_salt_2026").digest("hex"); }
function parseBody(req) {
  return new Promise((res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { res(JSON.parse(body)); } catch { res({}); }
    });
  });
}
function parseQuery(url) {
  const q = {};
  const parts = url.split("?")[1] || "";
  parts.split("&").forEach((p) => {
    const [k, v] = p.split("=");
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || "");
  });
  return q;
}
function getCookie(req, name) {
  const c = req.headers.cookie || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
function getSession(req) {
  const db = readDB();
  const sid = getCookie(req, "millo_sid");
  return sid && db.sessions[sid] ? { sid, ...db.sessions[sid] } : null;
}
function json(res, data, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function html(res, content, code = 200) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

// ── Static page ──────────────────────────────────────────────────────────────
function servePage(res) {
  // Serve index.html from root directory (or public/ as fallback)
  const rootFile = path.join(__dirname, "index.html");
  const publicFile = path.join(__dirname, "public", "index.html");
  const file = fs.existsSync(rootFile) ? rootFile : publicFile;
  html(res, fs.readFileSync(file, "utf8"));
}

// ── Route handler ─────────────────────────────────────────────────────────────
async function router(req, res) {
  const url = req.url.split("?")[0];
  const method = req.method;

  // Serve static page
  if (method === "GET" && (url === "/" || url === "/index.html")) return servePage(res);

  // ── AUTH ──────────────────────────────────────────────────────────────────
  if (method === "POST" && url === "/api/signup") {
    const { name, email, password, storeName } = await parseBody(req);
    if (!name || !email || !password || !storeName)
      return json(res, { error: "All fields required" }, 400);
    const db = readDB();
    if (Object.values(db.sellers).find((s) => s.email === email))
      return json(res, { error: "Email already registered" }, 409);
    const id = uid();
    db.sellers[id] = { id, name, email, password: hash(password), storeName, joinedAt: Date.now() };
    const sid = uid();
    db.sessions[sid] = { sellerId: id };
    writeDB(db);
    res.setHeader("Set-Cookie", `millo_sid=${sid}; HttpOnly; Path=/; Max-Age=604800`);
    return json(res, { ok: true, seller: { id, name, email, storeName } });
  }

  if (method === "POST" && url === "/api/login") {
    const { email, password } = await parseBody(req);
    const db = readDB();
    const seller = Object.values(db.sellers).find(
      (s) => s.email === email && s.password === hash(password)
    );
    if (!seller) return json(res, { error: "Invalid credentials" }, 401);
    const sid = uid();
    db.sessions[sid] = { sellerId: seller.id };
    writeDB(db);
    res.setHeader("Set-Cookie", `millo_sid=${sid}; HttpOnly; Path=/; Max-Age=604800`);
    return json(res, { ok: true, seller: { id: seller.id, name: seller.name, email: seller.email, storeName: seller.storeName } });
  }

  if (method === "POST" && url === "/api/logout") {
    const sid = getCookie(req, "millo_sid");
    if (sid) {
      const db = readDB();
      delete db.sessions[sid];
      writeDB(db);
    }
    res.setHeader("Set-Cookie", "millo_sid=; HttpOnly; Path=/; Max-Age=0");
    return json(res, { ok: true });
  }

  if (method === "GET" && url === "/api/me") {
    const sess = getSession(req);
    if (!sess) return json(res, { seller: null });
    const db = readDB();
    const seller = db.sellers[sess.sellerId];
    if (!seller) return json(res, { seller: null });
    const myProducts = db.products.filter((p) => p.sellerId === seller.id);
    return json(res, { seller: { id: seller.id, name: seller.name, email: seller.email, storeName: seller.storeName, joinedAt: seller.joinedAt }, productCount: myProducts.length, monthlyBill: myProducts.length * 25 });
  }

  // ── PRODUCTS ──────────────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/products") {
    const q = parseQuery(req.url);
    const db = readDB();
    let products = db.products.map((p) => {
      const seller = db.sellers[p.sellerId];
      return { ...p, sellerName: seller?.name, storeName: seller?.storeName };
    });
    if (q.search) {
      const s = q.search.toLowerCase();
      products = products.filter(
        (p) => p.name.toLowerCase().includes(s) || p.description.toLowerCase().includes(s) || p.category.toLowerCase().includes(s)
      );
    }
    if (q.category && q.category !== "all") products = products.filter((p) => p.category === q.category);
    return json(res, { products });
  }

  if (method === "GET" && url.startsWith("/api/products/")) {
    const id = url.split("/")[3];
    const db = readDB();
    const product = db.products.find((p) => p.id === id);
    if (!product) return json(res, { error: "Not found" }, 404);
    const seller = db.sellers[product.sellerId];
    return json(res, { product: { ...product, sellerName: seller?.name, storeName: seller?.storeName } });
  }

  if (method === "POST" && url === "/api/products") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const { name, description, price, category, imageUrl } = await parseBody(req);
    if (!name || !description || !price || !category)
      return json(res, { error: "Name, description, price, and category required" }, 400);
    const db = readDB();
    const product = { id: uid(), sellerId: sess.sellerId, name, description, price: parseFloat(price), category, imageUrl: imageUrl || "", createdAt: Date.now() };
    db.products.push(product);
    writeDB(db);
    return json(res, { ok: true, product });
  }

  if (method === "PUT" && url.startsWith("/api/products/")) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const id = url.split("/")[3];
    const db = readDB();
    const idx = db.products.findIndex((p) => p.id === id && p.sellerId === sess.sellerId);
    if (idx === -1) return json(res, { error: "Not found or not yours" }, 404);
    const updates = await parseBody(req);
    db.products[idx] = { ...db.products[idx], ...updates, id, sellerId: sess.sellerId };
    writeDB(db);
    return json(res, { ok: true, product: db.products[idx] });
  }

  if (method === "DELETE" && url.startsWith("/api/products/")) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const id = url.split("/")[3];
    const db = readDB();
    const idx = db.products.findIndex((p) => p.id === id && p.sellerId === sess.sellerId);
    if (idx === -1) return json(res, { error: "Not found or not yours" }, 404);
    db.products.splice(idx, 1);
    writeDB(db);
    return json(res, { ok: true });
  }

  if (method === "GET" && url === "/api/my-products") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const db = readDB();
    const products = db.products.filter((p) => p.sellerId === sess.sellerId);
    return json(res, { products, monthlyBill: products.length * 25 });
  }

  // 404
  json(res, { error: "Not found" }, 404);
}

// ── Seed demo data ─────────────────────────────────────────────────────────
function seed() {
  const db = readDB();
  if (Object.keys(db.sellers).length > 0) return;
  const sid1 = uid(), sid2 = uid();
  db.sellers[sid1] = { id: sid1, name: "Sophie Laurent", email: "sophie@demo.com", password: hash("demo123"), storeName: "Sophie's Artisan Goods", joinedAt: Date.now() - 864e5 * 30 };
  db.sellers[sid2] = { id: sid2, name: "Marcus Chen", email: "marcus@demo.com", password: hash("demo123"), storeName: "Chen Tech Finds", joinedAt: Date.now() - 864e5 * 15 };
  const cats = ["Handmade", "Electronics", "Clothing", "Books", "Home & Garden", "Art"];
  const demoProducts = [
    { name: "Hand-poured Soy Candle Set", description: "Set of 3 hand-poured soy wax candles with calming lavender, cedar, and citrus scents. Burns for 40+ hours each.", price: 48, category: "Handmade", imageUrl: "https://images.unsplash.com/photo-1608181831718-c9fca7c18c07?w=400&q=80", sellerId: sid1 },
    { name: "Macramé Wall Hanging", description: "Boho-chic hand-knotted macramé wall art, 60cm wide. Made with 100% natural cotton rope.", price: 75, category: "Handmade", imageUrl: "https://images.unsplash.com/photo-1601662528567-526cd06f6582?w=400&q=80", sellerId: sid1 },
    { name: "Ceramic Coffee Mug", description: "Wheel-thrown stoneware mug, holds 350ml, dishwasher safe. Each one unique with a speckled glaze.", price: 34, category: "Handmade", imageUrl: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400&q=80", sellerId: sid1 },
    { name: "Wireless Charging Pad", description: "Fast Qi wireless charger, 15W max output, compatible with all Qi-enabled phones. Includes USB-C cable.", price: 42, category: "Electronics", imageUrl: "https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=400&q=80", sellerId: sid2 },
    { name: "Mechanical Keyboard", description: "Compact 75% layout, hot-swappable switches, RGB backlight. Perfect for coders and writers alike.", price: 129, category: "Electronics", imageUrl: "https://images.unsplash.com/photo-1618384887929-16ec33fab9ef?w=400&q=80", sellerId: sid2 },
    { name: "Linen Tote Bag", description: "Heavyweight natural linen tote, reinforced handles, inner zip pocket. Holds up to 15kg.", price: 29, category: "Clothing", imageUrl: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=400&q=80", sellerId: sid1 },
  ];
  demoProducts.forEach((p) => {
    db.products.push({ id: uid(), createdAt: Date.now() - Math.random() * 864e5 * 20, ...p });
  });
  writeDB(db);
  console.log("✅ Seeded demo data. Login: sophie@demo.com / demo123");
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// public/ dir kept for optional static assets
fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });
seed();
http.createServer(router).listen(PORT, "0.0.0.0", () => {
  console.log(`🛍️  Millo 2026 is running at http://0.0.0.0:${PORT}`);
});
