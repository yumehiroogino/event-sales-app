require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Notion クライアント（APIキーが設定されている場合のみ有効化）
let notion = null;
if (process.env.NOTION_API_KEY && process.env.NOTION_API_KEY !== 'your_notion_api_key_here') {
  const { Client } = require('@notionhq/client');
  notion = new Client({ auth: process.env.NOTION_API_KEY });
}
const DATABASE_ID = process.env.DATABASE_ID;

// ─── 商品マスタ ───────────────────────────────────────────────────────────────
const PRODUCTS = [
  { id: 1, name: 'トライアルビーンズ',      price: 2570, cost:  484, stock: 224 },
  { id: 2, name: 'ウォルカ・サカロ',        price: 1930, cost:  537, stock:  15 },
  { id: 3, name: 'ウリ',                    price: 2300, cost:  535, stock:   9 },
  { id: 4, name: 'ラス ブルガス',           price: 2520, cost:  542, stock:   5 },
  { id: 5, name: 'カフェオレベース＋DBセット', price: 4200, cost: 1635, stock:  35 },
  { id: 6, name: 'ドリップバッグBOX',       price: 1500, cost:  360, stock:  75 },
  { id: 7, name: 'ドリップバッグ4個入り',   price: 1200, cost:  360, stock: 100 },
  { id: 8, name: 'カフェオレベース',        price: 2200, cost:  915, stock:  35 },
  { id: 9, name: 'HARIOフィルター',         price:  440, cost:  264, stock:  20 },
];

// ─── 固定経費 ─────────────────────────────────────────────────────────────────
const FIXED_EXPENSES = {
  accommodation:  50680,  // 宿泊費
  transportation: 11220,  // 交通費
  partTime:       40750,  // アルバイト代
  // 出店料: 売上 × 25%（動的計算）
};

// ─── データ永続化 ─────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSales() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveSales(sales) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sales, null, 2), 'utf8');
}

// ─── 日時ユーティリティ（JST 固定）────────────────────────────────────────────
function toJST(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}
function getDateStr(date) {
  const jst = toJST(date);
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${m}/${d}`;
}
function getISODate(date) {
  return toJST(date).toISOString().split('T')[0];
}

// ─── Notion 送信（非同期・エラーは無視）──────────────────────────────────────
async function sendToNotion(entry, isoDate) {
  if (!notion || !DATABASE_ID) return;
  try {
    await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        '商品名':   { title:  [{ text: { content: entry.productName } }] },
        '日付':     { date:   { start: isoDate } },
        '数量':     { number: entry.quantity },
        '単価':     { number: entry.unitPrice },
        '原価単価': { number: entry.unitCost },
        '売上金額': { number: entry.quantity * entry.unitPrice },
        '原価合計': { number: entry.quantity * entry.unitCost },
      },
    });
  } catch (err) {
    console.error(`[Notion] ${entry.productName}: ${err.message}`);
  }
}

// ─── API: 商品一覧（残在庫付き）──────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const sales = loadSales();
  const soldMap = {};
  for (const s of sales) soldMap[s.productId] = (soldMap[s.productId] || 0) + s.quantity;

  res.json(PRODUCTS.map(p => ({
    id:             p.id,
    name:           p.name,
    price:          p.price,
    stock:          p.stock,
    remainingStock: p.stock - (soldMap[p.id] || 0),
  })));
});

// ─── API: 一括売上登録 ────────────────────────────────────────────────────────
app.post('/api/sales/batch', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: '商品データが不正です' });

  const sales  = loadSales();
  const now    = new Date();
  const dateStr  = getDateStr(now);
  const isoDate  = getISODate(now);

  // 現在の販売済み数量
  const soldMap = {};
  for (const s of sales) soldMap[s.productId] = (soldMap[s.productId] || 0) + s.quantity;

  // バリデーション
  const newEntries = [];
  for (const item of items) {
    const product = PRODUCTS.find(p => p.id === item.productId);
    if (!product)
      return res.status(400).json({ error: `商品ID ${item.productId} が見つかりません` });

    if (item.quantity > 0) {
      const remaining = product.stock - (soldMap[product.id] || 0);
      if (item.quantity > remaining)
        return res.status(400).json({
          error: `${product.name} の在庫が不足しています（残: ${remaining}個）`,
        });
    }

    newEntries.push({
      id:          `${Date.now()}-${product.id}`,
      productId:   product.id,
      productName: product.name,
      quantity:    item.quantity,
      unitPrice:   product.price,
      unitCost:    product.cost,
      date:        now.toISOString(),
      dateStr,
    });

    soldMap[product.id] = (soldMap[product.id] || 0) + item.quantity;
  }

  saveSales([...sales, ...newEntries]);

  // Notion 非同期送信
  for (const entry of newEntries) sendToNotion(entry, isoDate);

  res.json({ success: true, count: newEntries.length });
});

// ─── API: 集計 ────────────────────────────────────────────────────────────────
app.get('/api/summary', (req, res) => {
  const sales   = loadSales();
  const byDate  = {};
  const overall = {};

  for (const s of sales) {
    const rev  = s.quantity * s.unitPrice;
    const cost = s.quantity * s.unitCost;

    // 日別
    if (!byDate[s.dateStr]) byDate[s.dateStr] = {};
    const d = byDate[s.dateStr];
    if (!d[s.productId]) d[s.productId] = { productName: s.productName, quantity: 0, revenue: 0, cost: 0 };
    d[s.productId].quantity += s.quantity;
    d[s.productId].revenue  += rev;
    d[s.productId].cost     += cost;

    // 累計
    if (!overall[s.productId]) overall[s.productId] = { productName: s.productName, quantity: 0, revenue: 0, cost: 0 };
    overall[s.productId].quantity += s.quantity;
    overall[s.productId].revenue  += rev;
    overall[s.productId].cost     += cost;
  }

  res.json({ byDate, overall });
});

// ─── API: 損益計算 ────────────────────────────────────────────────────────────
app.get('/api/pnl', (req, res) => {
  const sales = loadSales();

  const totalRevenue = sales.reduce((s, e) => s + e.quantity * e.unitPrice, 0);
  const totalCOGS    = sales.reduce((s, e) => s + e.quantity * e.unitCost,  0);
  const grossProfit  = totalRevenue - totalCOGS;

  const boothFee          = Math.round(totalRevenue * 0.25);
  const fixedTotal        = FIXED_EXPENSES.accommodation + FIXED_EXPENSES.transportation + FIXED_EXPENSES.partTime;
  const totalExpenses     = totalCOGS + boothFee + fixedTotal;
  const operatingProfit   = totalRevenue - totalExpenses;

  const pct = (v) => totalRevenue > 0 ? Math.round(v / totalRevenue * 1000) / 10 : 0;

  res.json({
    totalRevenue,
    totalCOGS,
    grossProfit,
    grossProfitRate:      pct(grossProfit),
    expenses: {
      cogs:          totalCOGS,
      boothFee,
      accommodation: FIXED_EXPENSES.accommodation,
      transportation:FIXED_EXPENSES.transportation,
      partTime:      FIXED_EXPENSES.partTime,
    },
    totalExpenses,
    operatingProfit,
    operatingProfitRate:  pct(operatingProfit),
  });
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(notion
    ? `Notion: 接続済み (DB: ${DATABASE_ID})`
    : 'Notion: 未設定（.env の NOTION_API_KEY を設定してください）'
  );
});
