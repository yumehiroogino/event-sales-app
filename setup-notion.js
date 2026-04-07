require('dotenv').config();
const { Client } = require('@notionhq/client');

const notion    = new Client({ auth: process.env.NOTION_API_KEY });
const PAGE_ID   = process.env.DATABASE_ID; // 実際はページID

const PROPERTIES = {
  '商品名':   { title: {} },
  '日付':     { date: {} },
  '数量':     { number: { format: 'number' } },
  '単価':     { number: { format: 'number' } },
  '原価単価': { number: { format: 'number' } },
  '売上金額': { number: { format: 'number' } },
  '原価合計': { number: { format: 'number' } },
};

(async () => {
  // ─── 1. ページ内の既存データベースを探す ───
  console.log(`ページ ${PAGE_ID} 内のブロックを確認中…`);
  const blocks = await notion.blocks.children.list({ block_id: PAGE_ID });
  const dbBlock = blocks.results.find(b => b.type === 'child_database');

  let databaseId;

  if (dbBlock) {
    // ─── 2a. 既存DBが見つかった → カラムを追加 ───
    databaseId = dbBlock.id;
    console.log(`既存データベース発見: ${databaseId}`);

    const db       = await notion.databases.retrieve({ database_id: databaseId });
    const existing = Object.keys(db.properties);
    console.log('既存カラム:', existing.join(', '));

    // タイトル列を「商品名」にリネーム（既存名が異なる場合）
    const titleProp = Object.entries(db.properties).find(([, v]) => v.type === 'title');
    const updates = {};
    if (titleProp && titleProp[0] !== '商品名') {
      console.log(`タイトル列「${titleProp[0]}」→「商品名」にリネーム`);
      updates[titleProp[0]] = { name: '商品名' };
    }

    // タイトル型以外の不足カラムを追加（'商品名'は除外）
    const toAdd = Object.fromEntries(
      Object.entries(PROPERTIES).filter(([name]) => name !== '商品名' && !existing.includes(name))
    );
    Object.assign(updates, toAdd);

    if (Object.keys(updates).length === 0) {
      console.log('追加・変更するカラムはありません');
    } else {
      if (Object.keys(toAdd).length) console.log('追加するカラム:', Object.keys(toAdd).join(', '));
      await notion.databases.update({ database_id: databaseId, properties: updates });
      console.log('カラム更新完了');
    }

  } else {
    // ─── 2b. DBが存在しない → 新規作成 ───
    console.log('データベースが見つかりません。新規作成します…');

    const newDb = await notion.databases.create({
      parent:      { type: 'page_id', page_id: PAGE_ID },
      title:       [{ type: 'text', text: { content: '販売ログ' } }],
      properties:  PROPERTIES,
    });

    databaseId = newDb.id;
    console.log('データベース作成完了:', databaseId);
  }

  // ─── 3. .env の DATABASE_ID を正しいIDで上書き ───
  const fs   = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  let envText = fs.readFileSync(envPath, 'utf8');
  envText = envText.replace(/^DATABASE_ID=.*/m, `DATABASE_ID=${databaseId.replace(/-/g, '')}`);
  fs.writeFileSync(envPath, envText);
  console.log(`.env の DATABASE_ID を更新: ${databaseId.replace(/-/g, '')}`);
  console.log('完了！サーバーを再起動してください: npm start');

})().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
