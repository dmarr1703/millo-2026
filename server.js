const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const DB_FILE = path.join(__dirname, "db.json");
const PRODUCTS_FILE = path.join(__dirname, "products.json");

// ── GitHub auto-commit ──────────────────────────────────────────────────────
function gitCommit(message) {
  try {
    execSync("git add db.json products.json 2>/dev/null || git add db.json", {
      cwd: __dirname,
      stdio: "pipe",
    });
    execSync(`git commit -m ${JSON.stringify(message)} --allow-empty`, {
      cwd: __dirname,
      stdio: "pipe",
    });
    execSync("git push origin HEAD 2>&1 || true", {
      cwd: __dirname,
      stdio: "pipe",
    });
    console.log(`✅ GitHub commit: ${message}`);
    return true;
  } catch (e) {
    console.warn("⚠️  Git commit failed:", e.message);
    return false;
  }
}

function syncProductsFile(db) {
  // Write a human-readable products.json alongside db.json so the GitHub
  // repo always has a clean catalogue viewable in the browser.
  const catalogue = db.products.map((p) => {
    const seller = db.sellers[p.sellerId];
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      category: p.category,
      imageUrl: p.imageUrl || "",
      seller: seller ? { name: seller.name, storeName: seller.storeName, location: seller.location || "" } : {},
      listedAt: new Date(p.createdAt).toISOString(),
      updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    };
  });
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(catalogue, null, 2));
}

// ── Tiny JSON database ──────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_FILE))
    return { sellers: {}, products: [], sessions: {}, messages: [], favorites: {} };
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (!db.messages) db.messages = [];
  if (!db.favorites) db.favorites = {};
  return db;
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  syncProductsFile(db);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
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
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}
function html(res, content, code = 200) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

// ── Static page ─────────────────────────────────────────────────────────────
function servePage(res) {
  const rootFile = path.join(__dirname, "index.html");
  const publicFile = path.join(__dirname, "public", "index.html");
  const file = fs.existsSync(rootFile) ? rootFile : publicFile;
  html(res, fs.readFileSync(file, "utf8"));
}

// ── Route handler ────────────────────────────────────────────────────────────
async function router(req, res) {
  const url = req.url.split("?")[0];
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // Serve static page
  if (method === "GET" && (url === "/" || url === "/index.html")) return servePage(res);

  // ── AUTH ─────────────────────────────────────────────────────────────────
  if (method === "POST" && url === "/api/signup") {
    const { name, email, password, storeName } = await parseBody(req);
    if (!name || !email || !password || !storeName)
      return json(res, { error: "All fields required" }, 400);
    if (password.length < 6)
      return json(res, { error: "Password must be at least 6 characters" }, 400);
    const db = readDB();
    if (Object.values(db.sellers).find((s) => s.email.toLowerCase() === email.toLowerCase()))
      return json(res, { error: "Email already registered" }, 409);
    const id = uid();
    db.sellers[id] = {
      id, name: name.trim(), email: email.toLowerCase().trim(),
      password: hash(password), storeName: storeName.trim(),
      bio: "", location: "", website: "",
      joinedAt: Date.now(),
    };
    const sid = uid();
    db.sessions[sid] = { sellerId: id };
    writeDB(db);
    // Auto-commit new seller signup
    gitCommit(`feat(sellers): new seller signed up — "${storeName.trim()}" (${email.toLowerCase().trim()})`);
    res.setHeader("Set-Cookie", `millo_sid=${sid}; HttpOnly; Path=/; Max-Age=604800`);
    return json(res, { ok: true, seller: { id, name: name.trim(), email, storeName: storeName.trim() } });
  }

  if (method === "POST" && url === "/api/login") {
    const { email, password } = await parseBody(req);
    if (!email || !password) return json(res, { error: "Email and password required" }, 400);
    const db = readDB();
    const seller = Object.values(db.sellers).find(
      (s) => s.email.toLowerCase() === email.toLowerCase() && s.password === hash(password)
    );
    if (!seller) return json(res, { error: "Invalid email or password" }, 401);
    const sid = uid();
    db.sessions[sid] = { sellerId: seller.id };
    writeDB(db);
    res.setHeader("Set-Cookie", `millo_sid=${sid}; HttpOnly; Path=/; Max-Age=604800`);
    return json(res, {
      ok: true,
      seller: {
        id: seller.id, name: seller.name, email: seller.email,
        storeName: seller.storeName, bio: seller.bio || "",
        location: seller.location || "", website: seller.website || "",
      },
    });
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
    const unreadCount = db.messages.filter((m) => m.sellerId === seller.id && !m.read).length;
    return json(res, {
      seller: {
        id: seller.id, name: seller.name, email: seller.email,
        storeName: seller.storeName, bio: seller.bio || "",
        location: seller.location || "", website: seller.website || "",
        joinedAt: seller.joinedAt,
      },
      productCount: myProducts.length,
      monthlyBill: myProducts.length * 25,
      unreadMessages: unreadCount,
    });
  }

  // ── ACCOUNT SETTINGS ─────────────────────────────────────────────────────
  if (method === "PUT" && url === "/api/account") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const { name, storeName, bio, location, website, currentPassword, newPassword } = await parseBody(req);
    const db = readDB();
    const seller = db.sellers[sess.sellerId];
    if (!seller) return json(res, { error: "Seller not found" }, 404);

    if (newPassword) {
      if (!currentPassword) return json(res, { error: "Current password required to set a new one" }, 400);
      if (seller.password !== hash(currentPassword)) return json(res, { error: "Current password is incorrect" }, 401);
      if (newPassword.length < 6) return json(res, { error: "New password must be at least 6 characters" }, 400);
      db.sellers[sess.sellerId].password = hash(newPassword);
    }

    if (name) db.sellers[sess.sellerId].name = name.trim();
    if (storeName) db.sellers[sess.sellerId].storeName = storeName.trim();
    db.sellers[sess.sellerId].bio = (bio || "").trim();
    db.sellers[sess.sellerId].location = (location || "").trim();
    db.sellers[sess.sellerId].website = (website || "").trim();
    writeDB(db);
    // Auto-commit profile update
    gitCommit(`chore(account): seller "${seller.name}" updated their profile`);

    const updated = db.sellers[sess.sellerId];
    return json(res, {
      ok: true,
      seller: {
        id: updated.id, name: updated.name, email: updated.email,
        storeName: updated.storeName, bio: updated.bio,
        location: updated.location, website: updated.website,
      },
    });
  }

  // ── PRODUCTS ─────────────────────────────────────────────────────────────
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
        (p) =>
          p.name.toLowerCase().includes(s) ||
          p.description.toLowerCase().includes(s) ||
          p.category.toLowerCase().includes(s) ||
          (p.storeName || "").toLowerCase().includes(s)
      );
    }
    if (q.category && q.category !== "all")
      products = products.filter((p) => p.category === q.category);
    if (q.sellerId)
      products = products.filter((p) => p.sellerId === q.sellerId);
    products.sort((a, b) => b.createdAt - a.createdAt);
    return json(res, { products });
  }

  if (method === "GET" && url.match(/^\/api\/products\/[^/]+$/)) {
    const id = url.split("/")[3];
    const db = readDB();
    const product = db.products.find((p) => p.id === id);
    if (!product) return json(res, { error: "Not found" }, 404);
    const seller = db.sellers[product.sellerId];
    return json(res, {
      product: {
        ...product,
        sellerName: seller?.name,
        storeName: seller?.storeName,
        sellerBio: seller?.bio || "",
        sellerLocation: seller?.location || "",
        sellerWebsite: seller?.website || "",
      },
    });
  }

  if (method === "POST" && url === "/api/products") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const { name, description, price, category, imageUrl } = await parseBody(req);
    if (!name || !description || !price || !category)
      return json(res, { error: "Name, description, price, and category required" }, 400);
    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0)
      return json(res, { error: "Price must be a valid positive number" }, 400);
    const db = readDB();
    const seller = db.sellers[sess.sellerId];
    const product = {
      id: uid(), sellerId: sess.sellerId, name: name.trim(),
      description: description.trim(), price: parsedPrice,
      category, imageUrl: imageUrl || "", createdAt: Date.now(),
    };
    db.products.push(product);
    writeDB(db);
    // Auto-commit new product listing
    gitCommit(`feat(products): "${name.trim()}" listed by ${seller?.storeName || seller?.name || "a seller"} — $${parsedPrice} CAD · ${category}`);
    return json(res, { ok: true, product });
  }

  if (method === "PUT" && url.match(/^\/api\/products\/[^/]+$/)) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const id = url.split("/")[3];
    const db = readDB();
    const idx = db.products.findIndex((p) => p.id === id && p.sellerId === sess.sellerId);
    if (idx === -1) return json(res, { error: "Not found or not yours" }, 404);
    const { name, description, price, category, imageUrl } = await parseBody(req);
    const prevName = db.products[idx].name;
    if (name) db.products[idx].name = name.trim();
    if (description) db.products[idx].description = description.trim();
    if (price !== undefined) {
      const parsedPrice = parseFloat(price);
      if (!isNaN(parsedPrice) && parsedPrice >= 0) db.products[idx].price = parsedPrice;
    }
    if (category) db.products[idx].category = category;
    if (imageUrl !== undefined) db.products[idx].imageUrl = imageUrl;
    db.products[idx].updatedAt = Date.now();
    writeDB(db);
    const seller = db.sellers[sess.sellerId];
    // Auto-commit product update
    gitCommit(`fix(products): "${db.products[idx].name}" updated by ${seller?.storeName || seller?.name || "a seller"}`);
    return json(res, { ok: true, product: db.products[idx] });
  }

  if (method === "DELETE" && url.match(/^\/api\/products\/[^/]+$/)) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const id = url.split("/")[3];
    const db = readDB();
    const idx = db.products.findIndex((p) => p.id === id && p.sellerId === sess.sellerId);
    if (idx === -1) return json(res, { error: "Not found or not yours" }, 404);
    const deletedName = db.products[idx].name;
    const seller = db.sellers[sess.sellerId];
    db.products.splice(idx, 1);
    writeDB(db);
    // Auto-commit product deletion
    gitCommit(`chore(products): "${deletedName}" removed by ${seller?.storeName || seller?.name || "a seller"}`);
    return json(res, { ok: true });
  }

  if (method === "GET" && url === "/api/my-products") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const db = readDB();
    const products = db.products
      .filter((p) => p.sellerId === sess.sellerId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return json(res, { products, monthlyBill: products.length * 25 });
  }

  // ── SELLERS / STORES ─────────────────────────────────────────────────────
  if (method === "GET" && url.match(/^\/api\/sellers\/[^/]+$/)) {
    const sellerId = url.split("/")[3];
    const db = readDB();
    const seller = db.sellers[sellerId];
    if (!seller) return json(res, { error: "Seller not found" }, 404);
    const products = db.products
      .filter((p) => p.sellerId === sellerId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return json(res, {
      seller: {
        id: seller.id, name: seller.name, storeName: seller.storeName,
        bio: seller.bio || "", location: seller.location || "",
        website: seller.website || "", joinedAt: seller.joinedAt,
      },
      products,
    });
  }

  if (method === "GET" && url === "/api/sellers") {
    const db = readDB();
    const sellers = Object.values(db.sellers).map((s) => {
      const productCount = db.products.filter((p) => p.sellerId === s.id).length;
      return {
        id: s.id, name: s.name, storeName: s.storeName,
        bio: s.bio || "", location: s.location || "",
        joinedAt: s.joinedAt, productCount,
      };
    }).filter((s) => s.productCount > 0);
    return json(res, { sellers });
  }

  // ── GITHUB ACTIVITY ──────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/github-activity") {
    try {
      const log = execSync(
        'git log --oneline --no-merges -20 --pretty=format:"%H|%s|%ai|%an"',
        { cwd: __dirname, stdio: "pipe" }
      ).toString();
      const commits = log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split("|");
          const [msg, date, author] = rest;
          return { sha: sha.slice(0, 7), message: msg, date, author };
        });
      return json(res, { commits });
    } catch {
      return json(res, { commits: [] });
    }
  }

  // ── MESSAGES ─────────────────────────────────────────────────────────────
  if (method === "POST" && url === "/api/messages") {
    const { senderName, senderEmail, message, productId, sellerId } = await parseBody(req);
    if (!senderName || !senderEmail || !message || !sellerId)
      return json(res, { error: "Name, email, message, and seller are required" }, 400);
    if (!message.trim()) return json(res, { error: "Message cannot be empty" }, 400);
    const db = readDB();
    const seller = db.sellers[sellerId];
    if (!seller) return json(res, { error: "Seller not found" }, 404);

    let productName = null;
    if (productId) {
      const product = db.products.find((p) => p.id === productId);
      if (product) productName = product.name;
    }

    const msg = {
      id: uid(), sellerId, senderName: senderName.trim(),
      senderEmail: senderEmail.trim(), message: message.trim(),
      productId: productId || null, productName,
      read: false, createdAt: Date.now(),
    };
    db.messages.push(msg);
    writeDB(db);
    return json(res, { ok: true, message: "Message sent successfully!" });
  }

  if (method === "GET" && url === "/api/messages") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const db = readDB();
    const messages = db.messages
      .filter((m) => m.sellerId === sess.sellerId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return json(res, { messages });
  }

  if (method === "PUT" && url.match(/^\/api\/messages\/[^/]+\/read$/)) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const msgId = url.split("/")[3];
    const db = readDB();
    const idx = db.messages.findIndex((m) => m.id === msgId && m.sellerId === sess.sellerId);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    db.messages[idx].read = true;
    writeDB(db);
    return json(res, { ok: true });
  }

  if (method === "DELETE" && url.match(/^\/api\/messages\/[^/]+$/)) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const msgId = url.split("/")[3];
    const db = readDB();
    const idx = db.messages.findIndex((m) => m.id === msgId && m.sellerId === sess.sellerId);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    db.messages.splice(idx, 1);
    writeDB(db);
    return json(res, { ok: true });
  }

  // ── FAVORITES ────────────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/favorites") {
    const sess = getSession(req);
    if (!sess) return json(res, { favorites: [] });
    const db = readDB();
    const favIds = db.favorites[sess.sellerId] || [];
    const products = db.products
      .filter((p) => favIds.includes(p.id))
      .map((p) => {
        const seller = db.sellers[p.sellerId];
        return { ...p, sellerName: seller?.name, storeName: seller?.storeName };
      });
    return json(res, { favorites: favIds, products });
  }

  if (method === "POST" && url === "/api/favorites") {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Sign in to save favourites" }, 401);
    const { productId } = await parseBody(req);
    if (!productId) return json(res, { error: "productId required" }, 400);
    const db = readDB();
    if (!db.favorites[sess.sellerId]) db.favorites[sess.sellerId] = [];
    if (!db.favorites[sess.sellerId].includes(productId)) {
      db.favorites[sess.sellerId].push(productId);
      writeDB(db);
    }
    return json(res, { ok: true });
  }

  if (method === "DELETE" && url.match(/^\/api\/favorites\/[^/]+$/)) {
    const sess = getSession(req);
    if (!sess) return json(res, { error: "Unauthorized" }, 401);
    const productId = url.split("/")[3];
    const db = readDB();
    if (db.favorites[sess.sellerId]) {
      db.favorites[sess.sellerId] = db.favorites[sess.sellerId].filter((id) => id !== productId);
      writeDB(db);
    }
    return json(res, { ok: true });
  }

  // 404
  json(res, { error: "Not found" }, 404);
}

// ── Seed demo data ──────────────────────────────────────────────────────────
function seed() {
  const db = readDB();
  if (Object.keys(db.sellers).length > 0) return;
  const sid1 = uid(), sid2 = uid(), sid3 = uid();
  db.sellers[sid1] = {
    id: sid1, name: "Sophie Laurent", email: "sophie@demo.com",
    password: hash("demo123"), storeName: "Sophie's Artisan Goods",
    bio: "Handmade goods crafted with love in Montreal. Every piece is one-of-a-kind.",
    location: "Montréal, QC", website: "",
    joinedAt: Date.now() - 864e5 * 30,
  };
  db.sellers[sid2] = {
    id: sid2, name: "Marcus Chen", email: "marcus@demo.com",
    password: hash("demo123"), storeName: "Chen Tech Finds",
    bio: "Curated electronics and tech accessories for the modern maker.",
    location: "Vancouver, BC", website: "",
    joinedAt: Date.now() - 864e5 * 15,
  };
  db.sellers[sid3] = {
    id: sid3, name: "Amara Osei", email: "amara@demo.com",
    password: hash("demo123"), storeName: "Amara's Art Studio",
    bio: "Original paintings and prints inspired by African heritage and Canadian nature.",
    location: "Toronto, ON", website: "",
    joinedAt: Date.now() - 864e5 * 7,
  };
  const demoProducts = [
    { name: "Hand-poured Soy Candle Set", description: "Set of 3 hand-poured soy wax candles with calming lavender, cedar, and citrus scents. Burns for 40+ hours each.", price: 48, category: "Handmade", imageUrl: "https://images.unsplash.com/photo-1608181831718-c9fca7c18c07?w=400&q=80", sellerId: sid1 },
    { name: "Macramé Wall Hanging", description: "Boho-chic hand-knotted macramé wall art, 60cm wide. Made with 100% natural cotton rope.", price: 75, category: "Handmade", imageUrl: "https://images.unsplash.com/photo-1601662528567-526cd06f6582?w=400&q=80", sellerId: sid1 },
    { name: "Ceramic Coffee Mug", description: "Wheel-thrown stoneware mug, holds 350ml, dishwasher safe. Each one unique with a speckled glaze.", price: 34, category: "Handmade", imageUrl: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400&q=80", sellerId: sid1 },
    { name: "Wireless Charging Pad", description: "Fast Qi wireless charger, 15W max output, compatible with all Qi-enabled phones. Includes USB-C cable.", price: 42, category: "Electronics", imageUrl: "https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=400&q=80", sellerId: sid2 },
    { name: "Mechanical Keyboard", description: "Compact 75% layout, hot-swappable switches, RGB backlight. Perfect for coders and writers alike.", price: 129, category: "Electronics", imageUrl: "https://images.unsplash.com/photo-1618384887929-16ec33fab9ef?w=400&q=80", sellerId: sid2 },
    { name: "Linen Tote Bag", description: "Heavyweight natural linen tote, reinforced handles, inner zip pocket. Holds up to 15kg.", price: 29, category: "Clothing", imageUrl: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=400&q=80", sellerId: sid1 },
    { name: "Abstract Acrylic Print — Sunrise", description: "Original abstract acrylic painting on 40×50cm canvas. Warm sunrise palette, ready to hang.", price: 195, category: "Art", imageUrl: "https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=400&q=80", sellerId: sid3 },
    { name: "Botanical Watercolour Set", description: "Set of 6 A5 botanical watercolour prints, printed on 300gsm fine art paper. Perfect for framing.", price: 65, category: "Art", imageUrl: "https://images.unsplash.com/photo-1578321272176-b7bbc0679853?w=400&q=80", sellerId: sid3 },
    { name: "Knitted Wool Scarf", description: "Hand-knitted merino wool scarf, 180cm long. Incredibly soft and warm for Canadian winters.", price: 58, category: "Clothing", imageUrl: "https://images.unsplash.com/photo-1520903920243-00d872a2d1c9?w=400&q=80", sellerId: sid1 },
    { name: "The Maker's Mindset", description: "A practical guide to building a creative business in the digital age. 240 pages, paperback.", price: 22, category: "Books", imageUrl: "https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=400&q=80", sellerId: sid2 },
    { name: "Herb Garden Starter Kit", description: "Everything you need to grow basil, mint, and thyme indoors. Includes pots, soil, and seed packets.", price: 37, category: "Home & Garden", imageUrl: "https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?w=400&q=80", sellerId: sid3 },
    { name: "Beeswax Food Wraps (3-pack)", description: "Reusable beeswax food wraps in small, medium, and large. Eco-friendly alternative to plastic wrap.", price: 26, category: "Home & Garden", imageUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&q=80", sellerId: sid1 },
  ];
  demoProducts.forEach((p) => {
    db.products.push({ id: uid(), createdAt: Date.now() - Math.random() * 864e5 * 20, ...p });
  });
  writeDB(db);
  gitCommit("chore(seed): initialise demo sellers and product catalogue");
  console.log("✅ Seeded demo data. Login: sophie@demo.com / demo123");
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });
seed();
http.createServer(router).listen(PORT, "0.0.0.0", () => {
  console.log(`🛍️  Millo 2026 is running at http://0.0.0.0:${PORT}`);
  console.log(`📦  GitHub repo: https://github.com/dmarr1703/millo-2026`);
});
