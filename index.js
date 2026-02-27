const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 4000; // Running on a different port if local

// --- CONFIGURATION ---
const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || "default_secret"; 

// --- DATABASE CONNECTION (Connects to the SAME DB as POS) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());

// --- AUTH MIDDLEWARE (Standard) ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- ROUTES ---

// 1. LOGIN (Staff need to login to track who counted what)
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT user_id, full_name, role FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const token = jwt.sign({ id: user.user_id, username: username }, JWT_SECRET);
      res.json({ success: true, user, token });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ error: "Login error" });
  }
});

// 2. GET LOCATIONS (For selecting where they are counting)
app.get('/locations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM locations ORDER BY name ASC');
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    res.status(500).json({ error: "Fetch error" });
  }
});

// 3. SCAN ITEM (Add to Temp Table)
app.post('/inventory/scan', authenticateToken, async (req, res) => {
  const { barcode, location, user_id } = req.body;
  try {
    // Identify Product by SKU
    const productRes = await pool.query("SELECT product_id, name, sku FROM products WHERE sku = $1", [barcode]);
    
    if (productRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const product = productRes.rows[0];

    // Check for existing draft count
    const checkRes = await pool.query(
      `SELECT id FROM inventory_counts WHERE product_id = $1 AND location = $2 AND status = 'DRAFT'`,
      [product.product_id, location]
    );

    if (checkRes.rows.length > 0) {
      await pool.query("UPDATE inventory_counts SET quantity = quantity + 1 WHERE id = $1", [checkRes.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO inventory_counts (product_id, location, quantity, user_id, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
        [product.product_id, location, user_id]
      );
    }
    res.json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scan failed" });
  }
});

// 4. REVIEW DRAFTS
app.get('/inventory/review', authenticateToken, async (req, res) => {
  const { location } = req.query;
  try {
    const query = `
      SELECT ic.id, ic.quantity, p.name, p.sku
      FROM inventory_counts ic
      JOIN products p ON ic.product_id = p.product_id
      WHERE ic.location = $1 AND ic.status = 'DRAFT'
      ORDER BY ic.scanned_at DESC`;
    const result = await pool.query(query, [location]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

// 5. UPDATE/DELETE DRAFT
app.post('/inventory/update', authenticateToken, async (req, res) => {
  const { id, quantity } = req.body;
  try {
    if (quantity <= 0) {
      await pool.query("DELETE FROM inventory_counts WHERE id = $1", [id]);
    } else {
      await pool.query("UPDATE inventory_counts SET quantity = $1 WHERE id = $2", [quantity, id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

// 6. COMMIT TO PRODUCTION
app.post('/inventory/commit', authenticateToken, async (req, res) => {
  const { location } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const drafts = await client.query(
      "SELECT product_id, quantity FROM inventory_counts WHERE location = $1 AND status = 'DRAFT'",
      [location]
    );

    for (const item of drafts.rows) {
      // UPSERT LOGIC: Update if exists, Insert if not
      const updateRes = await client.query(
        "UPDATE stock_levels SET on_hand = $1, available = $1 WHERE product_id = $2 AND location = $3",
        [item.quantity, item.product_id, location]
      );
      if (updateRes.rowCount === 0) {
        await client.query(
           "INSERT INTO stock_levels (product_id, location, on_hand, available) VALUES ($1, $2, $3, $3)",
           [item.product_id, location, item.quantity]
        );
      }
    }

    // Clear Drafts
    await client.query("DELETE FROM inventory_counts WHERE location = $1 AND status = 'DRAFT'", [location]);
    await client.query('COMMIT');
    res.json({ success: true, count: drafts.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: "Commit failed" });
  } finally {
    client.release();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📦 Inventory API running on port ${PORT}`);
});