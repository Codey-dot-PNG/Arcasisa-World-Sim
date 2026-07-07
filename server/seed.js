'use strict';
// Default world: the Republic of Arcasia, circa 1962.
// Everything created here is plain data — the engine has no knowledge of any
// of these names. The GM can edit or delete all of it through the UI.
const crypto = require('crypto');
const mapdata = require('./mapdata');

function hashPassword(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return { salt, hash };
}

// ---- demographics -------------------------------------------------------
const GROUPS = ['Working Class', 'Middle Class', 'Upper Class', 'Students', 'Retired', 'Rural', 'Urban'];
const DEMO_METRICS = [
  { key: 'population', label: 'Population', format: 'number' },
  { key: 'income', label: 'Avg. Income', format: 'money' },
  { key: 'education', label: 'Education', format: 'number' },
  { key: 'politicalLeaning', label: 'Political Leaning', format: 'number' },
  { key: 'governmentSupport', label: 'Govt. Support', format: 'percent' },
  { key: 'happiness', label: 'Happiness', format: 'percent' },
  { key: 'economicConfidence', label: 'Econ. Confidence', format: 'percent' },
  { key: 'employment', label: 'Employment', format: 'percent' }
];

function makeDemo(totalPop, o) {
  const shares = { 'Working Class': 0.30, 'Middle Class': 0.22, 'Upper Class': 0.05, 'Students': 0.08, 'Retired': 0.12 };
  shares['Rural'] = 0.23 * (1 - o.urban);
  shares['Urban'] = 0.23 * o.urban;
  const lean = { 'Working Class': -40, 'Middle Class': 12, 'Upper Class': 55, 'Students': -35, 'Retired': 28, 'Rural': 22, 'Urban': -12 };
  const inc = { 'Working Class': 520, 'Middle Class': 1150, 'Upper Class': 4600, 'Students': 210, 'Retired': 430, 'Rural': 410, 'Urban': 780 };
  const edu = { 'Working Class': 34, 'Middle Class': 58, 'Upper Class': 78, 'Students': 70, 'Retired': 38, 'Rural': 28, 'Urban': 60 };
  const out = {};
  for (const g of GROUPS) {
    out[g] = {
      population: Math.round(totalPop * shares[g]),
      income: Math.round(inc[g] * (0.7 + o.wealth * 0.6)),
      education: Math.round(Math.max(5, Math.min(95, edu[g] + o.edu))),
      politicalLeaning: Math.round(Math.max(-95, Math.min(95, lean[g] + o.lean))),
      governmentSupport: Math.round(o.gs + (Math.random() * 8 - 4)),
      happiness: Math.round(o.hap + (Math.random() * 8 - 4)),
      economicConfidence: Math.round(o.conf + (Math.random() * 8 - 4)),
      employment: Math.round(o.emp + (Math.random() * 4 - 2))
    };
  }
  return out;
}

const PROV_VAR_DEFS = [
  ['population', 'Population', 'number'], ['gdp', 'GDP (ARK M)', 'number'], ['employment', 'Employment', 'percent'],
  ['industry', 'Industry', 'number'], ['agriculture', 'Agriculture', 'number'], ['oilProduction', 'Oil Production (kbbl/d)', 'number'],
  ['trade', 'Trade', 'number'], ['crime', 'Crime', 'number'], ['education', 'Education', 'number'],
  ['healthcare', 'Healthcare', 'number'], ['approval', 'Govt. Approval', 'percent'], ['infrastructure', 'Infrastructure', 'number'],
  ['happiness', 'Happiness', 'percent'], ['politicalLeaning', 'Political Leaning', 'number']
];
const COMPANY_VAR_DEFS = [
  ['revenue', 'Annual Revenue', 'money'], ['profit', 'Annual Profit', 'money'], ['valuation', 'Valuation', 'money']
];

function pvars(o) {
  const v = {};
  for (const [k] of PROV_VAR_DEFS) v[k] = o[k] !== undefined ? o[k] : 0;
  return v;
}

// ---- seed ---------------------------------------------------------------
function seed() {
  const A = '/assets';

  const provinces = [
    {
      id: 'prov_grazi', name: 'Grazi', color: '#9c4a3c',
      description: 'North-western coastal province. Fjords, shipyards and the great port of Kradon. Heartland of the Grazihall construction dynasty.',
      path: [[368,142],[400,120],[452,100],[506,84],[520,78],[536,118],[528,158],[544,198],[538,242],[552,282],[524,278],[492,286],[448,270],[400,282],[356,268],[316,262],[296,240],[312,220],[294,200],[308,184],[330,196],[322,164],[302,150],[282,120],[296,96],[318,108],[330,86],[352,98],[348,128]],
      labelPos: [428,192], capital: 'city_kradon',
      vars: pvars({ population: 2400000, gdp: 720, employment: 89, industry: 58, agriculture: 40, oilProduction: 0, trade: 62, crime: 44, education: 52, healthcare: 50, approval: 51, infrastructure: 54, happiness: 55, politicalLeaning: 2 }),
      demographics: makeDemo(2400000, { lean: 2, wealth: 0.5, urban: 0.55, edu: 2, gs: 51, hap: 55, conf: 52, emp: 89 })
    },
    {
      id: 'prov_lachevan', name: 'Lachevan', color: '#c99a2e',
      description: 'The federal heartland. Seat of government, the national airport and the LEIKA works. The most populous and prosperous province of the Republic.',
      path: [[520,78],[566,64],[614,56],[662,58],[706,66],[736,84],[760,72],[788,92],[800,118],[786,140],[774,156],[792,176],[806,208],[794,232],[800,258],[774,290],[742,290],[716,300],[684,288],[646,300],[608,290],[570,300],[552,282],[538,242],[544,198],[528,158],[536,118]],
      labelPos: [614,152], capital: 'city_lachevan',
      vars: pvars({ population: 4600000, gdp: 1850, employment: 91.5, industry: 72, agriculture: 55, oilProduction: 8, trade: 80, crime: 38, education: 62, healthcare: 58, approval: 56, infrastructure: 66, happiness: 61, politicalLeaning: 8 }),
      demographics: makeDemo(4600000, { lean: 8, wealth: 0.75, urban: 0.7, edu: 8, gs: 56, hap: 61, conf: 60, emp: 91 })
    },
    {
      id: 'prov_mezdov', name: 'Mezdov', color: '#5a4632',
      description: 'Rugged western highlands. Iron mines, quarries and a long tradition of hard labour and harder politics.',
      path: [[316,262],[356,268],[400,282],[448,270],[492,286],[524,278],[552,282],[570,300],[576,330],[566,356],[530,368],[494,360],[458,374],[430,386],[402,380],[378,398],[356,420],[340,446],[320,470],[298,460],[276,448],[300,422],[280,394],[302,368],[286,338],[310,314],[292,286]],
      labelPos: [398,330], capital: 'city_mezdov',
      vars: pvars({ population: 1900000, gdp: 540, employment: 87.5, industry: 64, agriculture: 28, oilProduction: 4, trade: 40, crime: 52, education: 44, healthcare: 42, approval: 44, infrastructure: 40, happiness: 48, politicalLeaning: -18 }),
      demographics: makeDemo(1900000, { lean: -18, wealth: 0.35, urban: 0.4, edu: -6, gs: 44, hap: 48, conf: 44, emp: 87 })
    },
    {
      id: 'prov_korota', name: 'Korota', color: '#6b655c',
      description: 'Industrial east. Oil fields, the SATROM defence works at Razno and the Republic’s largest refinery. Faces Valksland across the strait.',
      path: [[570,300],[608,290],[646,300],[684,288],[716,300],[742,290],[774,290],[788,318],[806,352],[796,388],[810,420],[818,458],[824,470],[770,452],[730,470],[688,498],[700,444],[686,418],[664,394],[636,376],[600,366],[566,356],[576,330]],
      labelPos: [700,368], capital: 'city_razno',
      vars: pvars({ population: 2800000, gdp: 1120, employment: 90, industry: 76, agriculture: 34, oilProduction: 46, trade: 58, crime: 46, education: 50, healthcare: 48, approval: 49, infrastructure: 52, happiness: 52, politicalLeaning: -6 }),
      demographics: makeDemo(2800000, { lean: -6, wealth: 0.55, urban: 0.6, edu: 0, gs: 49, hap: 52, conf: 50, emp: 90 })
    },
    {
      id: 'prov_kordi', name: 'Kordi', color: '#cbb98c',
      description: 'Semi-autonomous southern region. Dry plains over deep mineral and oil wealth, worked by ALKO. The Kordish question dominates its politics.',
      path: [[566,356],[600,366],[636,376],[664,394],[686,418],[700,444],[688,498],[640,520],[600,538],[560,528],[520,540],[470,522],[430,500],[402,470],[360,486],[320,470],[340,446],[356,420],[378,398],[402,380],[430,386],[458,374],[494,360],[530,368]],
      labelPos: [528,456], capital: 'city_surat',
      vars: pvars({ population: 2300000, gdp: 610, employment: 85, industry: 50, agriculture: 48, oilProduction: 38, trade: 44, crime: 58, education: 38, healthcare: 36, approval: 38, infrastructure: 34, happiness: 42, politicalLeaning: -24 }),
      demographics: makeDemo(2300000, { lean: -24, wealth: 0.3, urban: 0.35, edu: -10, gs: 38, hap: 42, conf: 38, emp: 85 })
    }
  ];

  const cities = [
    { id: 'city_lachevan', provinceId: 'prov_lachevan', name: 'Lachevan', pos: [730, 150], size: 3, isCapital: true, description: 'Federal capital of the Republic of Arcasia. Seat of Parliament, the Presidency and the great ministries.' },
    { id: 'city_kradon', provinceId: 'prov_grazi', name: 'Port Kradon', pos: [348, 186], size: 2, isCapital: false, description: 'Western gateway of the Republic. Shipyards, docks and the Grazihall works.' },
    { id: 'city_razno', provinceId: 'prov_korota', name: 'Razno', pos: [742, 308], size: 2, isCapital: false, description: 'Eastern industrial port. Refineries, the SATROM plant and the eastern fleet.' },
    { id: 'city_surat', provinceId: 'prov_kordi', name: 'Surat', pos: [560, 390], size: 2, isCapital: false, description: 'Administrative seat of the semi-autonomous Kordi region.' },
    { id: 'city_mezdov', provinceId: 'prov_mezdov', name: 'Mezdov', pos: [390, 360], size: 1, isCapital: false, description: 'Highland mining town and provincial seat.' },
    { id: 'city_valgos', provinceId: 'prov_lachevan', name: 'Cape Valgos', pos: [798, 205], size: 1, isCapital: false, description: 'Harbour town on the Strait of Valgos.' },
    { id: 'city_kradesh', provinceId: 'prov_grazi', name: 'Kradesh', pos: [452, 232], size: 1, isCapital: false, description: 'Inland market town on the Kradon road.' }
  ];

  // ---- entities ----------------------------------------------------------
  const entities = [
    { id: 'ent_gov', type: 'government', name: 'Government of Arcasia', color: '#4a5560', logo: A + '/flags/seal.png',
      description: 'The federal government of the Republic of Arcasia. Presidential republic; unicameral Parliament of 150 seats.',
      ceoId: 'per_valen', vars: {}, inventory: [{ itemId: 'item_gold', qty: 1200 }] },
    { id: 'ent_bank', type: 'government', name: 'Bank of Arcasia', color: '#33424d', logo: A + '/flags/seal.png',
      description: 'Central bank and issuer of the Arcasian Koren (₳, ARK).',
      ownerId: 'ent_gov', vars: {}, inventory: [{ itemId: 'item_gold', qty: 800 }] },

    { id: 'ent_arc', type: 'company', name: 'ARC', industry: 'State Corporation', color: '#33424d', logo: A + '/companies/arc.png',
      description: 'The Arcasian Republic Corporation. State holding company managing federal industrial assets.',
      ownerId: 'ent_gov', ceoId: 'per_orn', executives: ['per_orn'], sharesOutstanding: 1000000,
      publicFloat: 0, sharePrice: 900, trust: 62,
      shareholders: [{ entityId: 'ent_gov', shares: 1000000 }],
      vars: { revenue: 310000000, profit: 22000000, valuation: 900000000 }, inventory: [] },
    { id: 'ent_leika', type: 'company', name: 'LEIKA', industry: 'Consumer Electronics', color: '#2f5c5a', logo: A + '/companies/leika.png',
      description: 'Radios, televisions and household electronics from the Lachevan works. The pride of Arcasian living rooms.',
      ownerId: 'per_moss', ceoId: 'per_moss', executives: ['per_moss', 'per_keller'], sharesOutstanding: 800000,
      publicFloat: 22, sharePrice: 525, trust: 66,
      shareholders: [{ entityId: 'per_moss', shares: 440000 }, { entityId: 'ent_arc', shares: 120000 }, { entityId: 'per_keller', shares: 60000 }, { entityId: 'per_rill', shares: 500 }],
      vars: { revenue: 96000000, profit: 8400000, valuation: 420000000 },
      inventory: [{ itemId: 'item_radio', qty: 3800 }, { itemId: 'item_tv', qty: 900 }] },
    { id: 'ent_satrom', type: 'company', name: 'SATROM', industry: 'Military & High-End Electronics', color: '#5c3a4e', logo: A + '/companies/satrom.png',
      description: 'Defence electronics, radar and precision instruments. Principal supplier to the Arcasian armed forces.',
      ownerId: 'ent_gov', ceoId: 'per_hale', executives: ['per_hale'], sharesOutstanding: 600000,
      publicFloat: 10, sharePrice: 1017, trust: 58,
      shareholders: [{ entityId: 'ent_gov', shares: 360000 }, { entityId: 'ent_arc', shares: 140000 }, { entityId: 'per_hale', shares: 100000 }],
      vars: { revenue: 74000000, profit: 9100000, valuation: 610000000 },
      inventory: [{ itemId: 'item_radar', qty: 12 }] },
    { id: 'ent_amco', type: 'company', name: 'AMCO', industry: 'Oil & Fuel', color: '#6e4a1f', logo: A + '/companies/amco.png',
      description: 'The Arcasian Mining & Carbon Oil company. Operates the Korota fields and the Razno refinery.',
      ownerId: 'per_keller', ceoId: 'per_keller', executives: ['per_keller'], sharesOutstanding: 900000,
      publicFloat: 25, sharePrice: 867, trust: 54,
      shareholders: [{ entityId: 'per_keller', shares: 470000 }, { entityId: 'ent_arc', shares: 180000 }, { entityId: 'per_moss', shares: 50000 }, { entityId: 'per_rill', shares: 500 }],
      vars: { revenue: 128000000, profit: 15600000, valuation: 780000000 },
      inventory: [{ itemId: 'item_crude', qty: 45000 }, { itemId: 'item_fuel', qty: 12000 }] },
    { id: 'ent_alko', type: 'company', name: 'ALKO', industry: 'Mining & Oil', color: '#8a4a24', logo: A + '/companies/alko.png',
      description: 'Kordi-based mining and oil concern. Iron, copper and the K-7 field. The largest employer in the southern region.',
      ownerId: 'per_odek', ceoId: 'per_odek', executives: ['per_odek'], sharesOutstanding: 700000,
      publicFloat: 25, sharePrice: 500, trust: 48,
      shareholders: [{ entityId: 'per_odek', shares: 380000 }, { entityId: 'ent_arc', shares: 160000 }, { entityId: 'per_grazi', shares: 60000 }],
      vars: { revenue: 61000000, profit: 5200000, valuation: 350000000 },
      inventory: [{ itemId: 'item_ore', qty: 12000 }, { itemId: 'item_copper', qty: 340 }, { itemId: 'item_crude', qty: 9000 }] },
    { id: 'ent_grazihall', type: 'company', name: 'GRAZIHALL', industry: 'Construction', color: '#7a2318', logo: A + '/companies/grazihall.png',
      description: 'Construction and civil engineering house of the Grazi family. Built half of Port Kradon and most of its politics.',
      ownerId: 'per_grazi', ceoId: 'per_grazi', executives: ['per_grazi'], sharesOutstanding: 500000,
      publicFloat: 15, sharePrice: 580, trust: 57,
      shareholders: [{ entityId: 'per_grazi', shares: 410000 }, { entityId: 'per_moss', shares: 40000 }, { entityId: 'ent_arc', shares: 50000 }],
      vars: { revenue: 47000000, profit: 3900000, valuation: 290000000 },
      inventory: [{ itemId: 'item_cement', qty: 22000 }, { itemId: 'item_timber', qty: 8000 }] },

    // political parties
    { id: 'party_ua', type: 'party', name: 'United Arcasia', abbrev: 'UA', color: '#1f3a5f', logo: A + '/parties/united-arcasia.png',
      description: 'Governing big-tent unionist party. Stability, industry and the federal idea.',
      leaderId: 'per_valen', ideology: { econ: 20, soc: 15 }, inGovernment: true, mpCount: 58, support: {}, vars: {}, inventory: [] },
    { id: 'party_pfj', type: 'party', name: 'People’s Freedom and Justice', abbrev: 'PFJ', color: '#2f5c5a', logo: A + '/parties/pfj.png',
      description: 'Social-democratic opposition. Welfare, civil liberties and an open Republic.',
      leaderId: 'per_verenne', ideology: { econ: -30, soc: -35 }, inGovernment: false, mpCount: 34, support: {}, vars: {}, inventory: [] },
    { id: 'party_nf', type: 'party', name: 'National Front', abbrev: 'NF', color: '#4a4441', logo: A + '/parties/national-front.png',
      description: 'Nationalist right. Order, the army and a hard line on Kordi and the strait.',
      leaderId: 'per_stahl', ideology: { econ: 30, soc: 65 }, inGovernment: false, mpCount: 27, support: {}, vars: {}, inventory: [] },
    { id: 'party_acp', type: 'party', name: 'Arcasian Communist Party', abbrev: 'ACP', color: '#8a2f24', logo: A + '/parties/acp.png',
      description: 'Marxist-Leninist party of the industrial belts. Watched closely by the ministry and by Qinal.',
      leaderId: 'per_kandel', ideology: { econ: -80, soc: 10 }, inGovernment: false, mpCount: 17, support: {}, vars: {}, inventory: [] },
    { id: 'party_kff', type: 'party', name: 'Kordish Freedom Front', abbrev: 'KFF', color: '#8a6a24', logo: A + '/parties/kff.png',
      description: 'Regionalist movement of the Kordish south. Autonomy now, and perhaps more later.',
      leaderId: 'per_suri', ideology: { econ: -15, soc: 20 }, inGovernment: false, mpCount: 14,
      support: { prov_kordi: { all: 26 }, prov_lachevan: { all: -30 }, prov_grazi: { all: -30 }, prov_korota: { all: -26 }, prov_mezdov: { all: -22 } }, vars: {}, inventory: [] },

    // people
    { id: 'per_valen', type: 'person', name: 'Miron Valen', title: 'Former President', color: '#1f3a5f', description: 'Former leader of United Arcasia. A builder of compromises, so far.', vars: {}, inventory: [{ itemId: 'item_medal', qty: 1 }] },
    { id: 'per_verenne', type: 'person', name: 'Ilya Verenne', title: 'Leader of the Opposition (PFJ)', color: '#2f5c5a', description: 'Lawyer, orator, and the sharpest tongue in Parliament.', vars: {}, inventory: [] },
    { id: 'per_stahl', type: 'person', name: 'Gregor Stahl', title: 'Chairman, National Front', color: '#4a4441', description: 'Former colonel. Speaks softly about very loud things.', vars: {}, inventory: [] },
    { id: 'per_kandel', type: 'person', name: 'Rosa Kandel', title: 'First Secretary, ACP', color: '#8a2f24', description: 'Veteran of the dock strikes of ’48.', vars: {}, inventory: [] },
    { id: 'per_suri', type: 'person', name: 'Aran Suri', title: 'Chairman, Kordish Freedom Front', color: '#8a6a24', description: 'Voice of Surat. Negotiates autonomy by day; the rest is rumour.', vars: {}, inventory: [] },
    { id: 'per_moss', type: 'person', name: 'Kira Moss', title: 'Chief Executive, LEIKA', color: '#2f5c5a', description: 'Turned a radio repair shop into the Republic’s living-room monopoly.', vars: {}, inventory: [{ itemId: 'item_tv', qty: 2 }] },
    { id: 'per_hale', type: 'person', name: 'Viktor Hale', title: 'Chief Executive, SATROM', color: '#5c3a4e', description: 'Engineer-director of the Razno works. Clearance level: considerable.', vars: {}, inventory: [] },
    { id: 'per_keller', type: 'person', name: 'Dana Keller', title: 'Chief Executive, AMCO', color: '#6e4a1f', description: 'Oil heiress and operator. Knows the price of everything by the barrel.', vars: {}, inventory: [] },
    { id: 'per_odek', type: 'person', name: 'Baran Odek', title: 'Chief Executive, ALKO', color: '#8a4a24', description: 'Kordish industrialist. Employs half of Surat and funds the other half.', vars: {}, inventory: [] },
    { id: 'per_grazi', type: 'person', name: 'Marta Grazi', title: 'Chairwoman, GRAZIHALL', color: '#7a2318', description: 'Fourth generation of the Grazi construction dynasty.', vars: {}, inventory: [] },
    { id: 'per_orn', type: 'person', name: 'Pavel Orn', title: 'Director-General, ARC', color: '#33424d', description: 'Career administrator of the state corporation.', vars: {}, inventory: [] },
    { id: 'per_halden', type: 'person', name: 'Jana Halden', title: 'Editor, The Arcasian Herald', color: '#5b5e2c', description: 'Runs the Republic’s paper of record from a smoke-filled office in Lachevan.', vars: {}, inventory: [] },
    { id: 'per_krenn', type: 'person', name: 'Halvard Krenn', title: 'Chief Justice', color: '#45525c', description: 'Presides over the Supreme Court of the Republic.', vars: {}, inventory: [] },
    { id: 'per_voss', type: 'person', name: 'Gen. Petra Voss', title: 'Chief of the General Staff', color: '#3f4a3a', description: 'Commands the armed forces of the Republic.', vars: {}, inventory: [] },
    { id: 'per_falk', type: 'person', name: 'Erik Falk', title: 'Police Commissioner', color: '#45525c', description: 'Federal police command, Lachevan.', vars: {}, inventory: [] },
    { id: 'per_rill', type: 'person', name: 'Toma Rill', title: 'Citizen', color: '#5b5e2c', description: 'A citizen of Lachevan. Owns a radio, a television and 500 shares of AMCO.', vars: {}, inventory: [{ itemId: 'item_share_amco', qty: 500 }, { itemId: 'item_radio', qty: 1 }] },

    // foreign powers
    { id: 'for_valksland', type: 'foreign', name: 'Valksland', color: '#726a58', logo: A + '/flags/valksland.png', stance: 'Tense', description: 'The great power across the Strait of Valgos. Watches Arcasia; Arcasia watches back.', vars: {}, inventory: [] },
    { id: 'for_delcasia', type: 'foreign', name: 'Del’ Casia', color: '#726a58', logo: A + '/flags/del-casia.png', stance: 'Tense', description: 'Southern neighbour on the island. The land border is quiet this year.', vars: {}, inventory: [] },
    { id: 'for_solme', type: 'foreign', name: 'Solme', color: '#726a58', logo: A + '/flags/solme.png', stance: 'Neutral', description: 'Small south-western neighbour. Trades with everyone, angers no one.', vars: {}, inventory: [] },
    { id: 'for_madrosia', type: 'foreign', name: 'Madrosia', color: '#726a58', logo: A + '/flags/madrosia.png', stance: 'Friendly', description: 'Northern maritime republic. Old trading partner.', vars: {}, inventory: [] },
    { id: 'for_mazon', type: 'foreign', name: 'Mazon', color: '#726a58', logo: A + '/flags/mazon.png', stance: 'Neutral', description: 'Island state off the north-west fjords.', vars: {}, inventory: [] },
    { id: 'for_aldonesia', type: 'foreign', name: 'Aldonesia', color: '#726a58', logo: A + '/flags/aldonesia.png', stance: 'Friendly', description: 'South-western archipelago power.', vars: {}, inventory: [] },
    { id: 'for_sarom', type: 'foreign', name: 'Federation of Sarom', color: '#726a58', logo: A + '/flags/sarom.png', stance: 'Allied', description: 'Continental federation and treaty ally.', vars: {}, inventory: [] },
    { id: 'for_qinal', type: 'foreign', name: 'People’s Republic of Qinal', color: '#726a58', logo: A + '/flags/qinal.png', stance: 'Hostile', description: 'Revolutionary power. Prints pamphlets that keep turning up in Mezdov.', vars: {}, inventory: [] },
    { id: 'for_markasia', type: 'foreign', name: 'Kingdom of Markasia', color: '#726a58', logo: A + '/flags/markasia.png', stance: 'Friendly', description: 'Old kingdom, older money. Buys Arcasian oil.', vars: {}, inventory: [] },
    { id: 'for_estal', type: 'foreign', name: 'Estal Federation', color: '#726a58', logo: A + '/flags/estal.png', stance: 'Neutral', description: 'Distant federation; occasional trade delegations.', vars: {}, inventory: [] },
    { id: 'org_grace', type: 'org', name: 'GRACE', color: '#5b5e2c', logo: A + '/flags/grace.png', stance: 'Member', description: 'Guild of Royal Allies for Commercial Exchange. Trade bloc; Arcasia holds observer status.', vars: {}, inventory: [] },
    { id: 'org_assembly', type: 'org', name: 'Assembly of Nations', color: '#5b5e2c', logo: A + '/flags/assembly.png', stance: 'Member', description: 'The world assembly. Arcasia is a founding member.', vars: {}, inventory: [] }
  ];

  // ---- properties --------------------------------------------------------
  const properties = [
    // Lachevan / capital
    { id: 'prop_parliament', name: 'Parliament of Arcasia', type: 'government', kind: 'government', provinceId: 'prov_lachevan', pos: [726, 144], ownerId: 'ent_gov', value: 40000000, employees: 900, income: 0, expenses: 120000, description: 'Unicameral chamber of 150 seats, Lachevan.', inventory: [], vars: {} },
    { id: 'prop_palace', name: 'Presidential Palace', type: 'government', kind: 'government', provinceId: 'prov_lachevan', pos: [736, 140], ownerId: 'ent_gov', value: 32000000, employees: 300, income: 0, expenses: 80000, description: 'Office and residence of the President of the Republic.', inventory: [], vars: {} },
    { id: 'prop_bank', name: 'Bank of Arcasia', type: 'commercial', kind: 'bank', provinceId: 'prov_lachevan', pos: [722, 152], ownerId: 'ent_bank', value: 60000000, employees: 450, income: 0, expenses: 60000, description: 'Central bank headquarters and the national gold vault.', inventory: [], vars: {} },
    { id: 'prop_arc_hq', name: 'ARC Headquarters', type: 'commercial', kind: 'office', provinceId: 'prov_lachevan', pos: [740, 154], ownerId: 'ent_arc', value: 18000000, employees: 700, income: 180000, expenses: 90000, description: 'Seat of the state corporation.', inventory: [], vars: {} },
    { id: 'prop_leika_hq', name: 'LEIKA Headquarters', type: 'commercial', kind: 'office', provinceId: 'prov_lachevan', pos: [732, 158], ownerId: 'ent_leika', value: 14000000, employees: 500, income: 220000, expenses: 110000, description: 'Executive offices and design bureau.', inventory: [], vars: {} },
    { id: 'prop_leika_w1', name: 'LEIKA Works No.1', type: 'industrial', kind: 'factory', provinceId: 'prov_lachevan', pos: [694, 198], ownerId: 'ent_leika', value: 26000000, employees: 4200, income: 420000, expenses: 260000, description: 'Radio and television assembly lines.', inventory: [{ itemId: 'item_radio', qty: 1200 }], vars: {} },
    { id: 'prop_amco_hq', name: 'AMCO Headquarters', type: 'commercial', kind: 'office', provinceId: 'prov_lachevan', pos: [720, 160], ownerId: 'ent_amco', value: 16000000, employees: 380, income: 200000, expenses: 95000, description: 'Corporate seat of the oil concern.', inventory: [], vars: {} },
    { id: 'prop_airport', name: 'Lachevan International Airport', type: 'infrastructure', kind: 'airport', provinceId: 'prov_lachevan', pos: [700, 172], ownerId: 'ent_gov', value: 45000000, employees: 1200, income: 160000, expenses: 140000, description: 'The Republic’s principal airfield.', inventory: [], vars: {} },
    { id: 'prop_university', name: 'University of Lachevan', type: 'government', kind: 'university', provinceId: 'prov_lachevan', pos: [744, 148], ownerId: 'ent_gov', value: 22000000, employees: 1500, income: 0, expenses: 110000, description: 'Founded 1811. Faculties of law, engineering and letters.', inventory: [], vars: {} },
    { id: 'prop_herald', name: 'Herald House', type: 'commercial', kind: 'office', provinceId: 'prov_lachevan', pos: [716, 148], ownerId: 'per_halden', value: 2400000, employees: 120, income: 40000, expenses: 28000, description: 'Offices and presses of The Arcasian Herald.', inventory: [], vars: {} },
    { id: 'prop_valgos_port', name: 'Port of Cape Valgos', type: 'infrastructure', kind: 'port', provinceId: 'prov_lachevan', pos: [796, 208], ownerId: 'ent_gov', value: 30000000, employees: 800, income: 130000, expenses: 90000, description: 'Eastern harbour on the strait.', inventory: [], vars: {} },
    { id: 'prop_rill_house', name: 'Rill Residence', type: 'residential', kind: 'house', provinceId: 'prov_lachevan', pos: [738, 164], ownerId: 'per_rill', value: 18000, employees: 0, income: 0, expenses: 40, description: 'A modest house with a very good television.', inventory: [], vars: {} },
    // Grazi
    { id: 'prop_grazihall_hq', name: 'GRAZIHALL Headquarters', type: 'commercial', kind: 'office', provinceId: 'prov_grazi', pos: [354, 194], ownerId: 'ent_grazihall', value: 9000000, employees: 300, income: 120000, expenses: 70000, description: 'The family seat above the Kradon docks.', inventory: [], vars: {} },
    { id: 'prop_kradon_port', name: 'Port of Kradon', type: 'infrastructure', kind: 'port', provinceId: 'prov_grazi', pos: [338, 182], ownerId: 'ent_gov', value: 28000000, employees: 1100, income: 150000, expenses: 100000, description: 'Western deep-water port.', inventory: [], vars: {} },
    { id: 'prop_shipyards', name: 'Kradon Shipyards', type: 'industrial', kind: 'factory', provinceId: 'prov_grazi', pos: [332, 200], ownerId: 'ent_grazihall', value: 21000000, employees: 2600, income: 260000, expenses: 190000, description: 'Hulls, cranes and welding sparks.', inventory: [], vars: {} },
    { id: 'prop_cement', name: 'GRAZIHALL Cement Works', type: 'industrial', kind: 'factory', provinceId: 'prov_grazi', pos: [412, 244], ownerId: 'ent_grazihall', value: 8000000, employees: 900, income: 110000, expenses: 70000, description: 'Feeds the Republic’s building sites.', inventory: [{ itemId: 'item_cement', qty: 6000 }], vars: {} },
    { id: 'prop_northfield', name: 'Northfield Collective Farm', type: 'agricultural', kind: 'farm', provinceId: 'prov_grazi', pos: [470, 130], ownerId: 'ent_gov', value: 3200000, employees: 700, income: 60000, expenses: 40000, description: 'Grain and dairy on the northern coast.', inventory: [{ itemId: 'item_grain', qty: 4000 }], vars: {} },
    // Mezdov
    { id: 'prop_mez_mine', name: 'Mezdov Iron Mine M-2', type: 'industrial', kind: 'mine', provinceId: 'prov_mezdov', pos: [362, 322], ownerId: 'ent_alko', value: 12000000, employees: 1800, income: 170000, expenses: 120000, description: 'Iron ore from the western highlands.', inventory: [{ itemId: 'item_ore', qty: 3000 }], vars: {} },
    { id: 'prop_quarry', name: 'Western Quarry', type: 'industrial', kind: 'mine', provinceId: 'prov_mezdov', pos: [330, 292], ownerId: 'ent_grazihall', value: 4000000, employees: 500, income: 55000, expenses: 35000, description: 'Granite and gravel for Grazihall sites.', inventory: [], vars: {} },
    { id: 'prop_fort_mezdov', name: 'Fort Mezdov', type: 'military', kind: 'military_base', provinceId: 'prov_mezdov', pos: [420, 338], ownerId: 'ent_gov', value: 15000000, employees: 2000, income: 0, expenses: 160000, description: 'Mountain garrison of the 3rd Division.', inventory: [], vars: {} },
    { id: 'prop_mez_power', name: 'Mezdov Power Station', type: 'infrastructure', kind: 'infrastructure', provinceId: 'prov_mezdov', pos: [400, 372], ownerId: 'ent_arc', value: 17000000, employees: 400, income: 90000, expenses: 60000, description: 'Coal-fired plant supplying the western grid.', inventory: [], vars: {} },
    // Korota
    { id: 'prop_satrom_hq', name: 'SATROM Headquarters', type: 'commercial', kind: 'office', provinceId: 'prov_korota', pos: [748, 312], ownerId: 'ent_satrom', value: 11000000, employees: 350, income: 150000, expenses: 80000, description: 'Razno offices of the defence concern.', inventory: [], vars: {} },
    { id: 'prop_satrom_works', name: 'SATROM Radar Works', type: 'industrial', kind: 'factory', provinceId: 'prov_korota', pos: [722, 324], ownerId: 'ent_satrom', value: 34000000, employees: 3100, income: 380000, expenses: 250000, description: 'Radar arrays and precision instruments. Restricted site.', inventory: [{ itemId: 'item_radar', qty: 4 }], vars: {} },
    { id: 'prop_oilfield', name: 'AMCO Field Korota-1', type: 'industrial', kind: 'mine', provinceId: 'prov_korota', pos: [688, 344], ownerId: 'ent_amco', value: 52000000, employees: 2400, income: 520000, expenses: 300000, description: 'The Republic’s largest producing oil field.', inventory: [{ itemId: 'item_crude', qty: 8000 }], vars: {} },
    { id: 'prop_refinery', name: 'AMCO Razno Refinery', type: 'industrial', kind: 'factory', provinceId: 'prov_korota', pos: [764, 318], ownerId: 'ent_amco', value: 38000000, employees: 1900, income: 340000, expenses: 220000, description: 'Crude in, fuel out, smoke always.', inventory: [{ itemId: 'item_fuel', qty: 5000 }], vars: {} },
    { id: 'prop_razno_port', name: 'Port of Razno', type: 'infrastructure', kind: 'port', provinceId: 'prov_korota', pos: [736, 296], ownerId: 'ent_gov', value: 26000000, employees: 900, income: 120000, expenses: 80000, description: 'Eastern port and oil terminal.', inventory: [], vars: {} },
    { id: 'prop_naval_base', name: 'Razno Naval Base', type: 'military', kind: 'military_base', provinceId: 'prov_korota', pos: [772, 288], ownerId: 'ent_gov', value: 42000000, employees: 3500, income: 0, expenses: 300000, description: 'Home of the Eastern Fleet, facing the strait.', inventory: [], vars: {} },
    // Kordi
    { id: 'prop_alko_hq', name: 'ALKO Headquarters', type: 'commercial', kind: 'office', provinceId: 'prov_kordi', pos: [556, 396], ownerId: 'ent_alko', value: 7000000, employees: 260, income: 90000, expenses: 55000, description: 'Surat seat of the mining concern.', inventory: [], vars: {} },
    { id: 'prop_mine_k1', name: 'ALKO Mine K-1', type: 'industrial', kind: 'mine', provinceId: 'prov_kordi', pos: [514, 428], ownerId: 'ent_alko', value: 16000000, employees: 2600, income: 210000, expenses: 150000, description: 'Copper and iron under the dry plain.', inventory: [{ itemId: 'item_copper', qty: 120 }], vars: {} },
    { id: 'prop_field_k7', name: 'ALKO Field K-7', type: 'industrial', kind: 'mine', provinceId: 'prov_kordi', pos: [604, 442], ownerId: 'ent_alko', value: 30000000, employees: 1500, income: 300000, expenses: 190000, description: 'The southern oil field. Politically combustible.', inventory: [{ itemId: 'item_crude', qty: 4000 }], vars: {} },
    { id: 'prop_bazaar', name: 'Surat Grand Bazaar', type: 'commercial', kind: 'office', provinceId: 'prov_kordi', pos: [566, 384], ownerId: 'ent_gov', value: 2600000, employees: 400, income: 70000, expenses: 30000, description: 'The commercial heart of the Kordish south.', inventory: [], vars: {} },
    { id: 'prop_fort_surat', name: 'Fort Surat', type: 'military', kind: 'military_base', provinceId: 'prov_kordi', pos: [582, 412], ownerId: 'ent_gov', value: 13000000, employees: 1600, income: 0, expenses: 140000, description: 'Southern garrison. Its presence is itself a policy.', inventory: [], vars: {} },
    { id: 'prop_aqueduct', name: 'Kordi Aqueduct', type: 'infrastructure', kind: 'infrastructure', provinceId: 'prov_kordi', pos: [534, 380], ownerId: 'ent_gov', value: 9000000, employees: 200, income: 0, expenses: 50000, description: 'Waters the dry plain; built 1931, patched since.', inventory: [], vars: {} }
  ];

  // ---- items -------------------------------------------------------------
  const items = [
    { id: 'item_crude', name: 'Crude Oil (barrel)', description: 'Unrefined crude from the Korota and Kordi fields.', icon: 'O', category: 'Commodities', marketValue: 2.9, tradable: true, meta: {} },
    { id: 'item_fuel', name: 'Refined Fuel (barrel)', description: 'Motor and heating fuel from the Razno refinery.', icon: 'F', category: 'Commodities', marketValue: 5.4, tradable: true, meta: {} },
    { id: 'item_ore', name: 'Iron Ore (tonne)', description: 'Ore from Mezdov and Kordi mines.', icon: 'I', category: 'Commodities', marketValue: 11, tradable: true, meta: {} },
    { id: 'item_copper', name: 'Copper (tonne)', description: 'Refined copper cathode.', icon: 'C', category: 'Commodities', marketValue: 480, tradable: true, meta: {} },
    { id: 'item_grain', name: 'Grain (tonne)', description: 'Wheat and rye from the northern coast.', icon: 'G', category: 'Commodities', marketValue: 52, tradable: true, meta: {} },
    { id: 'item_timber', name: 'Timber (m³)', description: 'Softwood from the Korota forests.', icon: 'T', category: 'Commodities', marketValue: 9, tradable: true, meta: {} },
    { id: 'item_cement', name: 'Cement (tonne)', description: 'Portland cement, Grazihall works.', icon: 'C', category: 'Commodities', marketValue: 14, tradable: true, meta: {} },
    { id: 'item_radio', name: 'LEIKA Model-9 Radio', description: 'The people’s receiver. Walnut veneer, three bands.', icon: 'R', category: 'Goods', marketValue: 34, tradable: true, meta: { maker: 'ent_leika' } },
    { id: 'item_tv', name: 'LEIKA T-1 Television', description: 'First mass-market television set in the Republic.', icon: 'T', category: 'Goods', marketValue: 148, tradable: true, meta: { maker: 'ent_leika' } },
    { id: 'item_radar', name: 'SATROM R-4 Radar Array', description: 'Long-range early warning array. Export restricted.', icon: 'R', category: 'Military', marketValue: 86000, tradable: false, meta: { maker: 'ent_satrom' } },
    { id: 'item_gold', name: 'Gold Bar (400 oz)', description: 'Reserve bullion of the Bank of Arcasia.', icon: 'A', category: 'Reserves', marketValue: 15800, tradable: true, meta: {} },
    { id: 'item_share_leika', name: 'LEIKA Shares', description: 'Ownership in LEIKA Consumer Electronics.', icon: 'S', category: 'Securities', marketValue: 525, tradable: true, meta: { companyId: 'ent_leika' } },
    { id: 'item_share_satrom', name: 'SATROM Shares', description: 'Ownership in SATROM Military Electronics.', icon: 'S', category: 'Securities', marketValue: 1017, tradable: true, meta: { companyId: 'ent_satrom' } },
    { id: 'item_share_amco', name: 'AMCO Shares', description: 'Ownership in the Arcasian Mining & Carbon Oil company.', icon: 'S', category: 'Securities', marketValue: 867, tradable: true, meta: { companyId: 'ent_amco' } },
    { id: 'item_share_alko', name: 'ALKO Shares', description: 'Ownership in the ALKO mining concern.', icon: 'S', category: 'Securities', marketValue: 500, tradable: true, meta: { companyId: 'ent_alko' } },
    { id: 'item_share_grazihall', name: 'GRAZIHALL Shares', description: 'Ownership in the Grazihall construction house.', icon: 'S', category: 'Securities', marketValue: 580, tradable: true, meta: { companyId: 'ent_grazihall' } },
    { id: 'item_medal', name: 'Medal of the Republic', description: 'Highest civilian honour of Arcasia.', icon: 'M', category: 'Honours', marketValue: 0, tradable: false, meta: {} }
  ];

  // ---- accounts ----------------------------------------------------------
  const accounts = [
    { id: 'acct_treasury', ownerId: 'ent_gov', name: 'Federal Treasury', balance: 1200000000 },
    { id: 'acct_reserve', ownerId: 'ent_bank', name: 'Reserve Account', balance: 400000000 },
    { id: 'acct_arc', ownerId: 'ent_arc', name: 'ARC Operating', balance: 120000000 },
    { id: 'acct_leika', ownerId: 'ent_leika', name: 'LEIKA Operating', balance: 38000000 },
    { id: 'acct_satrom', ownerId: 'ent_satrom', name: 'SATROM Operating', balance: 45000000 },
    { id: 'acct_amco', ownerId: 'ent_amco', name: 'AMCO Operating', balance: 62000000 },
    { id: 'acct_alko', ownerId: 'ent_alko', name: 'ALKO Operating', balance: 21000000 },
    { id: 'acct_grazihall', ownerId: 'ent_grazihall', name: 'GRAZIHALL Operating', balance: 17000000 },
    { id: 'acct_ua', ownerId: 'party_ua', name: 'Party Treasury', balance: 2400000 },
    { id: 'acct_pfj', ownerId: 'party_pfj', name: 'Party Treasury', balance: 1600000 },
    { id: 'acct_nf', ownerId: 'party_nf', name: 'Party Treasury', balance: 900000 },
    { id: 'acct_acp', ownerId: 'party_acp', name: 'Party Treasury', balance: 600000 },
    { id: 'acct_kff', ownerId: 'party_kff', name: 'Party Treasury', balance: 500000 },
    { id: 'acct_valen', ownerId: 'per_valen', name: 'Personal Account', balance: 84000 },
    { id: 'acct_moss', ownerId: 'per_moss', name: 'Personal Account', balance: 1200000 },
    { id: 'acct_keller', ownerId: 'per_keller', name: 'Personal Account', balance: 950000 },
    { id: 'acct_hale', ownerId: 'per_hale', name: 'Personal Account', balance: 310000 },
    { id: 'acct_odek', ownerId: 'per_odek', name: 'Personal Account', balance: 280000 },
    { id: 'acct_grazi', ownerId: 'per_grazi', name: 'Personal Account', balance: 720000 },
    { id: 'acct_halden', ownerId: 'per_halden', name: 'Personal Account', balance: 22000 },
    { id: 'acct_rill', ownerId: 'per_rill', name: 'Personal Account', balance: 8400 },
    { id: 'acct_markasia', ownerId: 'for_markasia', name: 'Trade Mission Account', balance: 5000000 }
  ];

  // ---- roles -------------------------------------------------------------
  const PAGES_ALL = ['map', 'parliament', 'companies', 'economy', 'population', 'news', 'timeline'];
  function role(id, name, perms) { return { id, name, builtin: true, perms }; }
  const roles = [
    role('gamemaster', 'Gamemaster', { pages: PAGES_ALL.concat(['gm']), inventories: 'all', accounts: 'all', companyFinancials: true, government: true, statistics: true, mapLayers: ['political', 'data', 'ownership', 'military'], manageNews: true, gm: true }),
    role('citizen', 'Citizen', { pages: ['map', 'companies', 'economy', 'news', 'timeline'], inventories: 'own', accounts: 'own', companyFinancials: false, government: false, statistics: false, mapLayers: ['political'], manageNews: false, gm: false }),
    role('mp', 'MP', { pages: PAGES_ALL, inventories: 'own', accounts: 'own', companyFinancials: false, government: true, statistics: true, mapLayers: ['political', 'data'], manageNews: false, gm: false }),
    role('judge', 'Judge', { pages: PAGES_ALL, inventories: 'own', accounts: 'own', companyFinancials: true, government: true, statistics: true, mapLayers: ['political', 'data'], manageNews: false, gm: false }),
    role('executive', 'Executive (Company)', { pages: ['map', 'companies', 'economy', 'news', 'timeline', 'population'], inventories: 'own', accounts: 'own', companyFinancials: true, government: false, statistics: true, mapLayers: ['political', 'ownership'], manageNews: false, gm: false }),
    role('president', 'President', { pages: PAGES_ALL, inventories: 'own', accounts: 'all', companyFinancials: true, government: true, statistics: true, mapLayers: ['political', 'data', 'ownership', 'military'], manageNews: false, gm: false }),
    role('minister', 'Cabinet Minister', { pages: PAGES_ALL, inventories: 'own', accounts: 'all', companyFinancials: true, government: true, statistics: true, mapLayers: ['political', 'data', 'military'], manageNews: false, gm: false }),
    role('journalist', 'Journalist', { pages: PAGES_ALL, inventories: 'own', accounts: 'own', companyFinancials: false, government: false, statistics: true, mapLayers: ['political', 'data'], manageNews: true, gm: false }),
    role('police', 'Police', { pages: ['map', 'companies', 'economy', 'population', 'news', 'timeline'], inventories: 'own', accounts: 'own', companyFinancials: false, government: false, statistics: true, mapLayers: ['political', 'data'], manageNews: false, gm: false }),
    role('military', 'Military', { pages: ['map', 'economy', 'news', 'timeline'], inventories: 'own', accounts: 'own', companyFinancials: false, government: false, statistics: false, mapLayers: ['political', 'military'], manageNews: false, gm: false })
  ];

  // ---- users -------------------------------------------------------------
  // `extra` carries optional per-user fields introduced by later phases (e.g.
  // Phase 5's `newspaperId`) without needing a positional parameter for each.
  function user(id, username, displayName, roleId, entityId, extra) {
    const { salt, hash } = hashPassword('arcasia');
    return { id, username, displayName, salt, passHash: hash, roleId, entityId, created: Date.now(), lastLogin: null, ...(extra || {}) };
  }
  const users = [
    user('user_gm', 'gm', 'The Gamemaster', 'gamemaster', null),
    user('user_president', 'president', 'Miron Valen', 'president', 'per_valen'),
    user('user_journalist', 'journalist', 'Jana Halden', 'journalist', 'per_halden', { newspaperId: 'paper_today' }),
    user('user_executive', 'executive', 'Kira Moss', 'executive', 'per_moss'),
    user('user_citizen', 'citizen', 'Toma Rill', 'citizen', 'per_rill')
  ];

  // ---- simulation events --------------------------------------------------
  const events = [
    {
      id: 'ev_employment', name: 'Jobs → Employment', enabled: true,
      description: 'STEP 1 of the causal chain. Provincial employment is recomputed from labour demand (Σ employees of every property in the province) against the working-age labour force. Blend keeps it gradual; k calibrates demand to the listed workforce sample. Tune k / workingShare / blend here.',
      trigger: { type: 'every_turn' }, conditions: [],
      effects: [
        { type: 'recompute_employment', k: 200, workingShare: 0.6, blend: 0.15 }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_econ_drift', name: 'Employment → GDP & Happiness', enabled: true,
      description: 'STEP 2. Provincial GDP follows employment; happiness drifts toward an employment-anchored target (35 + employment·0.35), nudged by approval. Unemployment is the strongest depressor of mood — it outweighs approval roughly 2:1.',
      trigger: { type: 'every_turn' }, conditions: [],
      effects: [
        { type: 'adjust_var', scope: 'province', target: 'all', key: 'gdp', op: 'add', value: '$gdp * 0.00035 * ($employment - 88)' },
        { type: 'adjust_var', scope: 'province', target: 'all', key: 'happiness', op: 'add', value: 'clamp(((35 + $employment * 0.35 + ($approval - 50) * 0.06) - $happiness) * 0.05, -0.5, 0.5)' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_confidence', name: 'Household Confidence', enabled: true,
      description: 'Each population group’s economic confidence drifts toward provincial employment conditions.',
      trigger: { type: 'every_turn' }, conditions: [],
      effects: [
        { type: 'adjust_demo', province: 'all', group: 'all', metric: 'economicConfidence', op: 'add', value: 'clamp((($p_employment - 35) - $economicConfidence) * 0.04, -1.5, 1.5)' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_oil_amco', name: 'AMCO Crude Sales', enabled: true,
      description: 'Daily receipts from the Korota fields, priced at the live market value of crude.',
      trigger: { type: 'every_turn' }, conditions: [],
      effects: [
        { type: 'money', kind: 'deposit', to: 'ent_amco', amount: 'prov(korota, oilProduction) * 1000 * item(crude) * 0.45', memo: 'Korota crude sales' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_oil_alko', name: 'ALKO Mining & Oil Receipts', enabled: true,
      description: 'Daily receipts from the Kordi field K-7 and the ore mines.',
      trigger: { type: 'every_turn' }, conditions: [],
      effects: [
        { type: 'money', kind: 'deposit', to: 'ent_alko', amount: 'prov(kordi, oilProduction) * 1000 * item(crude) * 0.4 + 9000', memo: 'K-7 crude and ore sales' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_polling', name: 'Economy → Opinion', enabled: true,
      description: 'STEP 3. Government support in every demographic group moves with local happiness, household economic confidence, and national GDP growth (g(gdpGrowth)), plus a little noise. Approval of the government is the slower-moving cousin of happiness.',
      trigger: { type: 'weekly' }, conditions: [],
      effects: [
        { type: 'adjust_demo', province: 'all', group: 'all', metric: 'governmentSupport', op: 'add', value: 'clamp(($happiness - 50) * 0.05 + ($economicConfidence - 50) * 0.03 + g(gdpGrowth) * 60, -1.8, 1.8) + rand(-1.4, 1.4)' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_trust', name: 'Trust → Companies', enabled: true,
      description: 'STEP 4. Each company’s citizen trust drifts toward the average happiness of the provinces where it holds property. Trust feeds share prices (the weekly market session) and can be used as a small revenue multiplier.',
      trigger: { type: 'every_turn' }, conditions: [],
      effects: [
        { type: 'adjust_trust', company: 'all', value: '$avghappiness', rate: 0.06 }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_market', name: 'Weekly Market Session', enabled: true,
      description: 'Listed shares reprice on the Lachevan exchange. Price moves with earnings yield (profit/valuation), national growth, citizen trust, and a little noise. All coefficients live in this effect — tune them here.',
      trigger: { type: 'weekly' }, conditions: [],
      effects: [
        { type: 'reprice_shares', company: 'all', a: 0.6, b: 0.8, c: 0.15, e: 0.03 }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_property_pl', name: 'Monthly Property Accounts', enabled: true,
      description: 'Every property pays its income less expenses to its owner’s account.',
      trigger: { type: 'monthly' }, conditions: [],
      effects: [{ type: 'property_pl' }], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_census', name: 'Monthly Census & Migration', enabled: true,
      description: 'Populations grow slowly; the census bureau updates provincial totals.',
      trigger: { type: 'monthly' }, conditions: [],
      effects: [
        { type: 'adjust_demo', province: 'all', group: 'all', metric: 'population', op: 'mul', value: '1 + rand(0.0002, 0.0014)' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_corporate', name: 'Monthly Corporate Earnings', enabled: true,
      description: 'Retail and contract earnings land in company accounts; the Treasury collects its share.',
      trigger: { type: 'monthly' }, conditions: [],
      effects: [
        { type: 'money', kind: 'deposit', to: 'ent_leika', amount: 'rand(1600000, 2600000)', memo: 'Retail sales' },
        { type: 'money', kind: 'deposit', to: 'ent_satrom', amount: 'rand(900000, 2100000)', memo: 'Defence contracts' },
        { type: 'money', kind: 'deposit', to: 'ent_grazihall', amount: 'rand(700000, 1500000)', memo: 'Construction contracts' },
        { type: 'money', kind: 'transfer', from: 'ent_amco', to: 'ent_gov', amount: 'rand(500000, 900000)', memo: 'Petroleum levy' },
        { type: 'money', kind: 'transfer', from: 'ent_leika', to: 'ent_gov', amount: 'rand(220000, 420000)', memo: 'Corporate tax' },
        { type: 'money', kind: 'transfer', from: 'ent_alko', to: 'ent_gov', amount: 'rand(150000, 320000)', memo: 'Corporate tax' }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_kordi_watch', name: 'Kordi Unrest Watch', enabled: true,
      description: 'If approval in Kordi collapses below 30, crime rises and support bleeds. A threshold event — dormant until conditions are met.',
      trigger: { type: 'every_turn' },
      conditions: [{ a: 'prov(kordi, approval)', op: '<', b: '30' }],
      effects: [
        { type: 'adjust_var', scope: 'province', target: 'prov_kordi', key: 'crime', op: 'add', value: '0.4' },
        { type: 'adjust_demo', province: 'prov_kordi', group: 'all', metric: 'governmentSupport', op: 'add', value: '-0.3' },
        { type: 'news', headline: 'Unrest simmers in Kordi', body: 'Reports from Surat describe growing frustration in the southern region as approval of the federal government falls. Kordish Freedom Front organisers were seen outside the Grand Bazaar.', category: 'Regional', publish: false }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_election', name: 'General Election', enabled: true,
      description: 'Dissolve Parliament and go to the country. Results are computed from the simulated population of every province.',
      trigger: { type: 'manual' }, conditions: [],
      effects: [{ type: 'election' }], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_infrastructure', name: 'State Infrastructure Programme', enabled: true,
      description: 'A K25M national works programme. Fire manually when the government announces it.',
      trigger: { type: 'manual' }, conditions: [],
      effects: [
        { type: 'money', kind: 'withdraw', from: 'ent_gov', amount: '25000000', memo: 'National works programme' },
        { type: 'adjust_var', scope: 'province', target: 'all', key: 'infrastructure', op: 'add', value: '2' },
        { type: 'adjust_var', scope: 'province', target: 'all', key: 'approval', op: 'add', value: '1.5' },
        { type: 'news', headline: 'Government launches nationwide works programme', body: 'The Ministry of Development will spend K25 million on roads, water and power across all five provinces. Grazihall shares rose on the announcement.', category: 'Politics', publish: true }
      ], lastTurn: 0, runs: 0
    },
    {
      id: 'ev_valgos_incident', name: 'Strait of Valgos Incident', enabled: true,
      description: 'A naval standoff in the strait. Trade suffers; the government answers hard questions. Fire manually for drama.',
      trigger: { type: 'manual' }, conditions: [],
      effects: [
        { type: 'adjust_var', scope: 'province', target: 'prov_lachevan', key: 'trade', op: 'add', value: '-6' },
        { type: 'adjust_var', scope: 'province', target: 'prov_korota', key: 'trade', op: 'add', value: '-4' },
        { type: 'adjust_demo', province: 'prov_lachevan', group: 'all', metric: 'governmentSupport', op: 'add', value: '-2' },
        { type: 'news', headline: 'Naval standoff in the Strait of Valgos', body: 'Valkslandic patrol vessels shadowed an Arcasian convoy off Cape Valgos for six hours before withdrawing. The Admiralty called the incident “regrettable”. Shipping insurers called it expensive.', category: 'Foreign', publish: true }
      ], lastTurn: 0, runs: 0
    }
  ];

  // ---- news --------------------------------------------------------------
  // Phase 5: four fixed newspapers. `paperId` on every article routes it to
  // one masthead in the UI; `newspaperRouting` (below, in settings) maps a
  // news category to a default paper for auto-drafted articles.
  const now = Date.now();
  const news = [
    { id: 'news_seed1', headline: 'Parliament opens the 1962 session', category: 'Politics', status: 'published', author: 'Jana Halden', ts: now - 200000, simDate: '1962-03-01', turn: 0, paperId: 'paper_today', body: 'President Valen opened the spring session of Parliament with a call for “steadiness in a loud decade”. The opposition benches, newly confident after autumn polling, promised to be anything but steady. The budget, the Kordi question and the strait dominate the order paper.' },
    { id: 'news_seed2', headline: 'LEIKA unveils the T-1 television set', category: 'Business', status: 'published', author: 'Jana Halden', ts: now - 150000, simDate: '1962-03-01', turn: 0, paperId: 'paper_economists', body: 'At a crowded showroom on Assembly Street, LEIKA chief Kira Moss switched on the Republic’s first mass-market television. “Every Arcasian living room,” she promised, “within the decade.” The set retails at K148. The Herald’s reviewer notes the picture is excellent and the cabinet walnut.' },
    { id: 'news_seed3', headline: 'Kordi assembly demands budget review', category: 'Regional', status: 'published', author: 'Jana Halden', ts: now - 100000, simDate: '1962-03-01', turn: 0, paperId: 'paper_herald', body: 'The semi-autonomous assembly in Surat voted 31–14 to demand a review of the federal transfer formula. KFF chairman Aran Suri called the current settlement “a pipeline that flows one way”. The Ministry of Finance said the formula is “under continuous review”, which observers note is another way of saying no.' }
  ];

  // ---- assembled world ----------------------------------------------------
  const db = {
    schema: 2,
    settings: {
      worldName: 'Republic of Arcasia',
      currency: '₳',
      currencyName: 'Arcasian Koren',
      // Phase 11 — national profile card shown atop the Population view and
      // in the Government entity dossier. `leader: null` reflects the vacancy
      // left when President Valen was cleared as national leader (per_valen
      // remains on file as 'Former President').
      country: {
        leader: null,
        government: 'Semi-Presidential Republic (no Prime Minister)',
        economy: 'Mixed State Capitalism & Planned Economy',
        gdpRank: '20th / 103',
        urbanisation: 60,
        lifeExpectancy: 55,
        schooling: 4,
        hdi: 0.534,
        populationGrowth: 'high'
      },
      time: { turn: 0, unit: 'day', perTurn: 1, date: '1962-03-01', auto: { enabled: false, seconds: 3600 } },
      parliamentSeats: 150,
      registration: { open: true, defaultRole: 'citizen', stipend: 5000 },
      newsThresholds: { transaction: 5000000 },
      demographics: { groups: GROUPS.slice(), metrics: DEMO_METRICS },
      // Phase 5 — exactly four newspapers. Fixed list: the GM may rename
      // fields here but the UI offers no "add paper" control.
      newspapers: [
        { id: 'paper_today', name: 'Arcasia Today', tagline: '-HEART OF ARCASIA-', city: 'Lachevan', style: 'today', owner: 'This newspaper is owned by the State corporation ARC' },
        { id: 'paper_herald', name: 'The National Herald', tagline: 'VOICE OF THE NATION', city: 'Lachevan', style: 'herald', owner: 'This newspaper is funded by the NFP' },
        { id: 'paper_economists', name: 'Economists', tagline: 'MARKETS · TRADE · INDUSTRY', city: 'Lachevan', style: 'economists', owner: 'This newspaper is owned by the Satrom group' },
        { id: 'paper_radical', name: 'Radical', tagline: '-THE VOICE OF ARCASIA-', city: 'Kordi', style: 'radical', owner: 'This is an independent newspaper' }
      ],
      // category → default paper for auto-drafted articles (sim.draftNews).
      // Unlisted categories fall back to paper_today.
      newspaperRouting: {
        Politics: 'paper_today',
        Regional: 'paper_herald',
        Foreign: 'paper_herald',
        Economy: 'paper_economists',
        Business: 'paper_economists'
      },
      // Phase 10 — Audio & Presentation. The intended default soundtrack is
      // the playlist at https://www.youtube.com/watch?v=vZDT1vaCUqE, but a
      // bare <audio> element cannot play YouTube page URLs — only direct
      // audio file URLs (.mp3/.ogg/.m4a/etc). Seed a handful of placeholder
      // library entries (titles preserved / inspired by that playlist,
      // ordered) with empty/placeholder URLs so the shape and default
      // playlist ordering are correct out of the box. THE GM SHOULD PASTE
      // DIRECT AUDIO FILE URLS into these (or new) library entries from GM
      // Studio → Presentation for real playback.
      music: {
        enabled: false,
        shuffle: true,
        volume: 0.7,
        library: [
          { id: 'trk_seed1', title: 'Suzerain: Rizia OST — Stress', url: '' },
          { id: 'trk_seed2', title: 'Suzerain: Rizia OST — Assembly', url: '' },
          { id: 'trk_seed3', title: 'Suzerain: Rizia OST — The Republic', url: '' },
          { id: 'trk_seed4', title: 'Suzerain: Rizia OST — Election Night', url: '' },
          { id: 'trk_seed5', title: 'Suzerain: Rizia OST — Reflection', url: '' }
        ],
        playlists: [
          { id: 'plist_default', name: 'Default Soundtrack', tracks: ['trk_seed1', 'trk_seed2', 'trk_seed3', 'trk_seed4', 'trk_seed5'] }
        ],
        activePlaylist: 'plist_default',
        forcedTrack: null
      }
      // settings.map (countries, labels, roads, rails) is attached by
      // mapdata.applyMap(db) below, which also upgrades all coordinates
      // to the 3840×2160 SVG map grid.
    },
    globalVars: {},
    variables: [
      ...PROV_VAR_DEFS.map(([key, label, format]) => ({ id: 'var_prov_' + key, scope: 'province', key, label, format, default: 0 })),
      ...COMPANY_VAR_DEFS.map(([key, label, format]) => ({ id: 'var_co_' + key, scope: 'company', key, label, format, default: 0 }))
    ],
    roles, users, entities, provinces, cities, properties, items, accounts,
    markers: [],
    history: [],
    trades: [],
    transactions: [], events, news,
    timeline: [{
      id: 'tl_genesis', ts: now, turn: 0, simDate: '1962-03-01', type: 'system',
      title: 'World initialised', detail: 'The Republic of Arcasia enters simulation. Five provinces, six great companies, one hundred and fifty seats, and a long decade ahead.', actor: 'SYSTEM', refs: []
    }],
    elections: [{
      id: 'elec_1958', ts: now - 1000, turn: -1, simDate: '1958-10-12', name: 'General Election of 1958', seats: 150, turnout: 71.2,
      national: [
        { partyId: 'party_ua', pct: 38.1, seats: 58, votes: 3890000 },
        { partyId: 'party_pfj', pct: 22.8, seats: 34, votes: 2330000 },
        { partyId: 'party_nf', pct: 17.9, seats: 27, votes: 1830000 },
        { partyId: 'party_acp', pct: 11.6, seats: 17, votes: 1180000 },
        { partyId: 'party_kff', pct: 9.6, seats: 14, votes: 980000 }
      ], byProvince: {}
    }],
    sessions: {}
  };

  // ---- Phase 11.4 rescale --------------------------------------------------
  // The 1962 draft world was authored at ~14.0M population / 4,840M GDP. Bump
  // both to the current target scale (~39M population / K13,000M GDP) while
  // keeping every province's relative share intact. This runs exactly once,
  // here at seed time (fresh worlds are born at schema 2, see below) — the
  // matching migration in store.js is gated on `schema < 2` so a live world
  // is never rescaled twice.
  const POP_SCALE = 2.79;
  const GDP_SCALE = 2.686;
  for (const p of db.provinces) {
    for (const gname in p.demographics) {
      p.demographics[gname].population = Math.round(p.demographics[gname].population * POP_SCALE);
    }
    p.vars.gdp = Math.round(p.vars.gdp * GDP_SCALE);
    // sync province population var with (now rescaled) demographics
    p.vars.population = Object.values(p.demographics).reduce((s, g) => s + g.population, 0);
  }
  // lift the hand-drawn 1200×675 world onto the SVG map grid
  mapdata.applyMap(db);
  return db;
}

module.exports = { seed, hashPassword };
