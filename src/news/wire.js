// ============================================================
// WIRE SERVICE — news generation.
// Schema verified against a live save export: every news item
// carries id/ts/body/turn/author/status/paperId/simDate/category/
// headline. Wire transfers run on paper_economists; campaign
// trail items on paper_today; new system items are 'draft'.
// ============================================================

const WIRE_PAPER = 'paper_economists';
const DEFAULT_PAPER = 'paper_today';

// Item display names observed in live wire reports.
const KNOWN_ITEM_NAMES = {
  item_grain: 'Grain (tonne)',
  item_msuazzdcammju4: 'The Commie Bus',
  item_autos: 'Automobiles'
};

function newNewsId() {
  return `news_ms${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 8)}`;
}

function pushNews(worldState, entry) {
  if (!Array.isArray(worldState.news)) worldState.news = [];
  const item = {
    id: newNewsId(),
    ts: Date.now(),
    turn: worldState.turn || 0,
    simDate: worldState.date,
    status: 'draft',
    paperId: DEFAULT_PAPER,
    ...entry
  };
  worldState.news.push(item);
  if (worldState.news.length > 500) worldState.news.splice(0, worldState.news.length - 500);
  return item;
}

const fmtMoney = n => `₳${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

// Live template: "Financial circles report a transfer of ₳X from A to B.
// The stated purpose: P."
function wireTransfer(worldState, from, to, amount, purpose) {
  return pushNews(worldState, {
    author: 'Wire Service',
    paperId: WIRE_PAPER,
    category: 'Business',
    headline: `Large transfer moves ${fmtMoney(amount)}`,
    body: `Financial circles report a transfer of ${fmtMoney(amount)} from ${from} to ${to}. The stated purpose: ${purpose}.`
  });
}

function resolveItemName(worldState, itemId) {
  const list = worldState.items || worldState.itemCatalog || [];
  const found = Array.isArray(list) && list.find(i => i && (i.id === itemId || i.key === itemId));
  return (found && (found.name || found.label)) || KNOWN_ITEM_NAMES[itemId] || itemId;
}

// Live template: " plus Grain (tonne) ×625"
function itemCostPhrase(worldState, itemCosts) {
  return (itemCosts || [])
    .filter(c => c && c.itemId && c.qty)
    .map(c => ` plus ${resolveItemName(worldState, c.itemId)} ×${c.qty}`)
    .join('');
}

module.exports = {
  pushNews, wireTransfer, fmtMoney, resolveItemName,
  itemCostPhrase, KNOWN_ITEM_NAMES
};

