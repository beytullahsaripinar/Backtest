import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, Cell, ReferenceLine, Legend,
} from "recharts";
import { dbLoadAll, dbSaveDataset, dbDeleteDataset } from "./supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const TP_MULT = 1.0485;
const SL_MULT = 0.9475;

const TF_ORDER = ["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M","main"];
const tfSort   = (a, b) => {
  const ia = TF_ORDER.indexOf(a), ib = TF_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
};

const SL_BUCKETS = [
  { label: "0-0.5",  min: 0,   max: 0.5 },
  { label: "0.5-1",  min: 0.5, max: 1.0 },
  { label: "1-1.5",  min: 1.0, max: 1.5 },
  { label: "1.5-2",  min: 1.5, max: 2.0 },
  { label: "2-2.5",  min: 2.0, max: 2.5 },
  { label: "2.5-3",  min: 2.5, max: 3.0 },
  { label: "+3",     min: 3.0, max: Infinity },
];

const TABS = [
  { id: "overview",     label: "Genel Bakis"  },
  { id: "winrate",      label: "Win Rate"     },
  { id: "distribution", label: "SL% Dagilim" },
  { id: "equity",       label: "Equity Curve" },
  { id: "streaks",      label: "Seriler"      },
  { id: "conflict",     label: "Conflict"     },
  { id: "monthly",      label: "Aylik"        },
];

const C = {
  green:"#00e5a0", red:"#ff4757", orange:"#ff8c42", blue:"#4da6ff",
  muted:"#4a5a6a", bg:"#070c11", surface:"#0c1520", surface2:"#111d2b",
  border:"rgba(255,255,255,0.07)", text:"#b0c4d8", textBright:"#e4eef8",
};

// ─────────────────────────────────────────────────────────────────────────────
//  FILENAME PARSER
// ─────────────────────────────────────────────────────────────────────────────
const TICKER_MAP = {
  btc:"BTCUSDT", eth:"ETHUSDT", bnb:"BNBUSDT", sol:"SOLUSDT",
  xrp:"XRPUSDT", ada:"ADAUSDT", doge:"DOGEUSDT", dot:"DOTUSDT",
  avax:"AVAXUSDT", matic:"MATICUSDT", link:"LINKUSDT", uni:"UNIUSDT",
  atom:"ATOMUSDT", ltc:"LTCUSDT", etc:"ETCUSDT", xlm:"XLMUSDT",
  algo:"ALGOUSDT", vet:"VETUSDT", icp:"ICPUSDT", fil:"FILUSDT",
  aave:"AAVEUSDT", mkr:"MKRUSDT", comp:"COMPUSDT", snx:"SNXUSDT",
  crv:"CRVUSDT", sushi:"SUSHIUSDT", yfi:"YFIUSDT", uma:"UMAUSDT",
  trx:"TRXUSDT", near:"NEARUSDT", ftm:"FTMUSDT", one:"ONEUSDT",
  hbar:"HBARUSDT", egld:"EGLDUSDT", theta:"THETAUSDT", axs:"AXSUSDT",
  sand:"SANDUSDT", mana:"MANAUSDT", enj:"ENJUSDT", chz:"CHZUSDT",
  gala:"GALAUSDT", flow:"FLOWUSDT", ape:"APEUSDT", ldo:"LDOUSDT",
  op:"OPUSDT", arb:"ARBUSDT", sui:"SUIUSDT", apt:"APTUSDT",
  sei:"SEIUSDT", tia:"TIAUSDT", inj:"INJUSDT", blur:"BLURUSDT",
  pepe:"PEPEUSDT", wif:"WIFUSDT", bonk:"BONKUSDT",
};

function normalizePair(raw) {
  const lower = raw.toLowerCase();
  if (TICKER_MAP[lower]) return { pair: TICKER_MAP[lower], contractType: "P" };
  const upper = raw.toUpperCase();
  if (upper.endsWith("USDT")) return { pair: upper, contractType: "P" };
  return { pair: upper + "USDT", contractType: "P" };
}

const TF_RX = /^(\d+)(m|h|d|w|M)$/;

function parseFilename(name) {
  const base   = name.replace(/\.(csv|CSV)$/, "");
  const parts  = base.split("_");
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;

  let pair = "UNKNOWN", contractType = "P", startDate = "", endDate = "", timeframe = "main";

  const tradeIdx = parts.indexOf("trades");
  if (tradeIdx >= 0) {
    const rawPair     = parts[tradeIdx + 1] || "UNKNOWN";
    const rawContract = parts[tradeIdx + 2] || "";
    const normalized  = normalizePair(rawPair);
    pair         = normalized.pair;
    contractType = rawContract.toUpperCase() || normalized.contractType;
    const dateIdxs = parts.map((p, i) => (dateRx.test(p) ? i : -1)).filter((i) => i >= 0);
    if (dateIdxs.length >= 2) {
      startDate = parts[dateIdxs[0]];
      endDate   = parts[dateIdxs[1]];
      const after = dateIdxs[dateIdxs.length - 1] + 1;
      if (after < parts.length) timeframe = parts[after];
    }
  } else if (parts.length >= 2 && TF_RX.test(parts[parts.length - 1])) {
    timeframe = parts[parts.length - 1];
    const normalized = normalizePair(parts.slice(0, parts.length - 1).join("_"));
    pair         = normalized.pair;
    contractType = normalized.contractType;
  } else if (parts.length === 1) {
    const normalized = normalizePair(parts[0]);
    pair = normalized.pair;
    contractType = normalized.contractType;
  }

  const storageKey = [pair, timeframe, startDate, endDate].filter(Boolean).join("__");
  return { pair, contractType, startDate, endDate, timeframe, storageKey };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSV PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(text, filename) {
  const lines   = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  const trades  = lines.slice(1).map((line) => {
    const vals = line.split(",");
    const r    = {};
    headers.forEach((h, i) => { r[h] = (vals[i] ?? "").trim(); });
    return {
      entryTime:    r["entry_time"]           || "",
      direction:    (r["direction"]           || "").toUpperCase(),
      entryPrice:   parseFloat(r["entry_price"])   || 0,
      tpPrice:      parseFloat(r["tp_price"])      || 0,
      slPrice:      parseFloat(r["sl_price"])      || 0,
      slPct:        parseFloat(r["entry_sl_pct"])  || 0,
      result:       (r["result"]             || "").toUpperCase(),
      exitTime:     r["exit_time"]           || "",
      conflictType: (r["conflict_type"]      || "none").toLowerCase(),
      month:        r["month"]               || "",
      monthWR:      r["month_win_rate"]      || "",
      overallWR:    r["overall_win_rate_pct"]|| "",
    };
  });
  const meta = parseFilename(filename);
  return { meta, trades, filename, uploadedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────
const validTrades = (trades) => trades.filter((t) => t.result !== "CONFLICT");

function wrEvolution(list) {
  let tp = 0, sl = 0;
  return list.map((t, i) => {
    if (t.result === "TP") tp++; else sl++;
    return { x: i + 1, wr: +((tp / (tp + sl)) * 100).toFixed(2), tp, sl };
  });
}

function slDistribution(trades) {
  return SL_BUCKETS.map((b) => {
    const inn = trades.filter((t) => t.slPct >= b.min && t.slPct < b.max);
    const tp  = inn.filter((t) => t.result === "TP").length;
    const sl  = inn.filter((t) => t.result === "SL").length;
    const tot = tp + sl;
    return { label: b.label, tp, sl, total: tot, wr: tot ? +((tp / tot) * 100).toFixed(1) : 0 };
  });
}

function calcEquity(trades, startBal) {
  let bal = startBal, peak = startBal, maxDD = 0;
  const pts = [{ x: 0, bal: +startBal.toFixed(2), dd: 0 }];
  trades.forEach((t, i) => {
    if (t.result === "TP") bal *= TP_MULT;
    else if (t.result === "SL") bal *= SL_MULT;
    if (bal > peak) peak = bal;
    const dd = +((peak - bal) / peak * 100).toFixed(2);
    if (dd > maxDD) maxDD = dd;
    pts.push({ x: i + 1, bal: +bal.toFixed(2), dd, result: t.result, month: t.month });
  });
  return { pts, maxDD: +maxDD.toFixed(2), finalBal: +bal.toFixed(2), gain: +(((bal - startBal) / startBal) * 100).toFixed(2) };
}

function calcStreaks(trades) {
  let maxTP = 0, maxSL = 0, curTP = 0, curSL = 0;
  const history = [];
  trades.forEach((t) => {
    if (t.result === "TP") { curTP++; curSL = 0; if (curTP > maxTP) maxTP = curTP; }
    else { curSL++; curTP = 0; if (curSL > maxSL) maxSL = curSL; }
    history.push({ tpStreak: curTP, slStreak: -curSL });
  });
  return { maxTP, maxSL, history };
}

function calcMonthly(trades) {
  const map = {};
  trades.forEach((t) => {
    if (!t.month) return;
    if (!map[t.month]) map[t.month] = { month: t.month, tp: 0, sl: 0 };
    if (t.result === "TP") map[t.month].tp++; else if (t.result === "SL") map[t.month].sl++;
  });
  return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    ...m, total: m.tp + m.sl, wr: m.tp + m.sl ? +((m.tp / (m.tp + m.sl)) * 100).toFixed(1) : 0,
  }));
}

function calcConflict(trades) {
  return ["none","same-bar","later"].map((ct) => {
    const g  = trades.filter((t) => t.conflictType === ct);
    const tp = g.filter((t) => t.result === "TP").length;
    const sl = g.filter((t) => t.result === "SL").length;
    const cn = g.filter((t) => t.result === "CONFLICT").length;
    return { type: ct, total: g.length, tp, sl, conflict: cn, wr: tp + sl ? +((tp / (tp + sl)) * 100).toFixed(1) : 0 };
  });
}

const wrColor  = (wr) => wr >= 55 ? C.green : wr >= 45 ? C.orange : C.red;
const pnlColor = (v)  => v >= 0 ? C.green : C.red;
const fmtBal   = (v)  => v >= 1000 ? `$${(v / 1000).toFixed(2)}K` : `$${v.toFixed(2)}`;

// ─────────────────────────────────────────────────────────────────────────────
//  UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px 18px", flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: color || C.textBright }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function SecTitle({ children }) {
  return (
    <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 2, marginBottom: 14, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAB COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function OverviewTab({ data }) {
  const { trades, meta, uploadedAt } = data;
  const valid  = validTrades(trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const tpAll  = valid.filter((t) => t.result === "TP").length;
  const slAll  = valid.filter((t) => t.result === "SL").length;
  const wrAll  = valid.length ? +((tpAll / valid.length) * 100).toFixed(1) : 0;
  const wrL    = longs.length  ? +((longs.filter((t) => t.result === "TP").length / longs.length) * 100).toFixed(1) : 0;
  const wrS    = shorts.length ? +((shorts.filter((t) => t.result === "TP").length / shorts.length) * 100).toFixed(1) : 0;
  const { maxTP, maxSL } = calcStreaks(valid);
  const conflictCount = trades.filter((t) => t.result === "CONFLICT").length;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatCard label="Toplam Islem"    value={valid.length}   sub={`${conflictCount} conflict haric`} />
        <StatCard label="Genel Win Rate"  value={`${wrAll}%`}    color={wrColor(wrAll)}  sub={`${tpAll} TP  ${slAll} SL`} />
        <StatCard label="Long Win Rate"   value={`${wrL}%`}      color={wrColor(wrL)}    sub={`${longs.length} islem`} />
        <StatCard label="Short Win Rate"  value={`${wrS}%`}      color={wrColor(wrS)}    sub={`${shorts.length} islem`} />
        <StatCard label="Max Ust Uste TP" value={maxTP}          color={C.green} />
        <StatCard label="Max Ust Uste SL" value={maxSL}          color={C.red} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <SecTitle>TP / SL Orani</SecTitle>
        <div style={{ height: 10, borderRadius: 6, background: "rgba(255,71,87,0.2)", overflow: "hidden" }}>
          <div style={{ width: `${wrAll}%`, height: "100%", background: `linear-gradient(90deg,${C.green},#00c87a)`, transition: "width .5s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ color: C.green, fontSize: 11 }}>TP {tpAll} ({wrAll}%)</span>
          <span style={{ color: C.red,   fontSize: 11 }}>SL {slAll} ({(100 - wrAll).toFixed(1)}%)</span>
        </div>
      </div>
      <SecTitle>Dosya Bilgisi</SecTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(155px,1fr))", gap: 10 }}>
        {[
          ["Parite",    meta.pair],
          ["Kontrat",   meta.contractType === "P" ? "Perpetual" : (meta.contractType || "Spot")],
          ["Timeframe", meta.timeframe],
          ["Baslangic", meta.startDate || "—"],
          ["Bitis",     meta.endDate   || "—"],
          ["Yuklendi",  new Date(uploadedAt).toLocaleDateString("tr-TR")],
        ].map(([k, v]) => (
          <div key={k} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 14px" }}>
            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{k}</div>
            <div style={{ fontSize: 12, color: C.textBright, fontFamily: "monospace" }}>{v || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WinRateTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");

  const WRChart = ({ chartData, title, color }) => {
    const final = chartData[chartData.length - 1]?.wr ?? 0;
    return (
      <div style={{ marginBottom: 30 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: C.textBright }}>{title}</div>
          <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: wrColor(final) }}>{final.toFixed(1)}%</div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 10 }} />
            <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={42} />
            <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <Tooltip formatter={(v, n) => [`${v.toFixed(2)}%`, n]} />
            <Line type="monotone" dataKey="wr" name="Win Rate" stroke={color} dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  return (
    <div>
      <WRChart chartData={wrEvolution(valid)}  title="Genel Win Rate"   color={C.blue}   />
      <WRChart chartData={wrEvolution(longs)}  title="Long Win Rate"    color={C.green}  />
      <WRChart chartData={wrEvolution(shorts)} title="Short Win Rate"   color={C.orange} />
    </div>
  );
}

function DistributionTab({ data }) {
  const dist = slDistribution(validTrades(data.trades));
  return (
    <div>
      <SecTitle>Entry SL% Dagilimi</SecTitle>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={dist}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="label" tick={{ fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} />
          <Tooltip formatter={(v, n) => [v, n]} />
          <Bar dataKey="tp" name="TP" stackId="a" fill={C.green} />
          <Bar dataKey="sl" name="SL" stackId="a" fill={C.red} radius={[3,3,0,0]} />
          <Legend formatter={(v) => <span style={{ color: v === "tp" ? C.green : C.red, fontSize: 11 }}>{v.toUpperCase()}</span>} />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 20, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>{["SL% Araligi","Toplam","TP","SL","Win Rate"].map((h) => (
              <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: C.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.3)" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {dist.map((d, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent" }}>
                <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.textBright }}>{d.label}%</td>
                <td style={{ padding: "9px 14px", color: C.text }}>{d.total}</td>
                <td style={{ padding: "9px 14px", color: C.green, fontWeight: 600 }}>{d.tp}</td>
                <td style={{ padding: "9px 14px", color: C.red, fontWeight: 600 }}>{d.sl}</td>
                <td style={{ padding: "9px 14px", color: wrColor(d.wr), fontWeight: 700, fontFamily: "monospace" }}>{d.total ? `${d.wr}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EquityTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");

  const [startBal, setStartBal] = useState(10000);
  const [inputVal, setInputVal] = useState("10000");
  const [activeEq, setActiveEq] = useState("all"); // "all" | "long" | "short"

  const tradeSet = activeEq === "long" ? longs : activeEq === "short" ? shorts : valid;
  const { pts, maxDD, finalBal, gain } = calcEquity(tradeSet, startBal);

  const eqTabs = [
    { id: "all",   label: "Tum Islemler", color: C.blue   },
    { id: "long",  label: "Sadece LONG",  color: C.green  },
    { id: "short", label: "Sadece SHORT", color: C.orange },
  ];
  const activeColor = eqTabs.find((t) => t.id === activeEq)?.color ?? C.blue;

  const EqChart = ({ pts, gain, startBal, gradId, ddGradId }) => (
    <>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={pts}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={gain >= 0 ? activeColor : C.red} stopOpacity={0.22} />
              <stop offset="95%" stopColor={gain >= 0 ? activeColor : C.red} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 10 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={fmtBal} width={74} />
          <ReferenceLine y={startBal} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
          <Tooltip formatter={(v) => [fmtBal(v), "Bakiye"]} />
          <Area type="monotone" dataKey="bal" name="Bakiye" stroke={gain >= 0 ? activeColor : C.red} fill={`url(#${gradId})`} strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 16 }}>
        <SecTitle>Drawdown</SecTitle>
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={pts}>
            <defs>
              <linearGradient id={ddGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.red} stopOpacity={0.28} />
                <stop offset="95%" stopColor={C.red} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 9 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 9 }} tickFormatter={(v) => `${v.toFixed(0)}%`} width={38} />
            <Tooltip formatter={(v) => [`${v.toFixed(2)}%`, "Drawdown"]} />
            <Area type="monotone" dataKey="dd" name="Drawdown" stroke={C.red} fill={`url(#${ddGradId})`} strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );

  return (
    <div>
      {/* Baslangic bakiyesi input */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Baslangic Bakiyesi ($)</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={inputVal} onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = parseFloat(inputVal); if (v > 0) setStartBal(v); } }}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, color: C.textBright, padding: "7px 12px", fontSize: 14, fontFamily: "monospace", width: 130 }} />
            <button onClick={() => { const v = parseFloat(inputVal); if (v > 0) setStartBal(v); }}
              style={{ background: "rgba(0,229,160,0.1)", border: `1px solid rgba(0,229,160,0.3)`, color: C.green, padding: "7px 16px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
              Uygula
            </button>
          </div>
        </div>
      </div>

      {/* Segment tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
        {eqTabs.map((t) => (
          <button key={t.id} onClick={() => setActiveEq(t.id)}
            style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
              background: activeEq === t.id ? `rgba(${t.id === "long" ? "0,229,160" : t.id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
              border: `1px solid ${activeEq === t.id ? t.color : "rgba(255,255,255,0.08)"}`,
              color: activeEq === t.id ? t.color : C.muted }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatCard label="Islem Sayisi"   value={tradeSet.length}                   color={C.textBright} />
        <StatCard label="Final Bakiye"   value={fmtBal(finalBal)}                  color={pnlColor(gain)} />
        <StatCard label="Toplam Getiri"  value={`${gain > 0 ? "+" : ""}${gain}%`}  color={pnlColor(gain)} />
        <StatCard label="Max Drawdown"   value={`${maxDD.toFixed(1)}%`}             color={C.red} />
        <StatCard label="Net Kar/Zarar"  value={fmtBal(finalBal - startBal)}        color={pnlColor(finalBal - startBal)} />
      </div>

      <SecTitle>
        Bakiye Grafigi —{" "}
        {activeEq === "all" ? "Tum Islemler" : activeEq === "long" ? "Sadece LONG" : "Sadece SHORT"}
      </SecTitle>
      <EqChart pts={pts} gain={gain} startBal={startBal} gradId={`eqGrad_${activeEq}`} ddGradId={`ddGrad_${activeEq}`} />
    </div>
  );
}

function StreaksTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const [activeSeg, setActiveSeg] = useState("all");

  const segMap = {
    all:   { trades: valid,  label: "Tum Islemler", color: C.blue   },
    long:  { trades: longs,  label: "Sadece LONG",  color: C.green  },
    short: { trades: shorts, label: "Sadece SHORT", color: C.orange },
  };
  const seg = segMap[activeSeg];
  const { maxTP, maxSL, history } = calcStreaks(seg.trades);
  const chartData = history.map((h, i) => ({ x: i + 1, ...h }));

  const SegButton = ({ id }) => (
    <button onClick={() => setActiveSeg(id)}
      style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
        background: activeSeg === id ? `rgba(${id === "long" ? "0,229,160" : id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
        border: `1px solid ${activeSeg === id ? segMap[id].color : "rgba(255,255,255,0.08)"}`,
        color: activeSeg === id ? segMap[id].color : C.muted }}>
      {segMap[id].label}
    </button>
  );

  return (
    <div>
      {/* Segment selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        <SegButton id="all" /><SegButton id="long" /><SegButton id="short" />
      </div>

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        <StatCard label="Islem Sayisi"     value={seg.trades.length}  color={C.textBright} />
        <StatCard label="Max Ust Uste TP"  value={maxTP}              color={C.green} sub="Ardisik TP serisi" />
        <StatCard label="Max Ust Uste SL"  value={maxSL}              color={C.red}   sub="Ardisik SL serisi" />
      </div>

      {/* Streak chart */}
      <SecTitle>Seri Gecmisi — {seg.label}</SecTitle>
      {chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} barSize={4}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="x" tick={{ fill: C.muted, fontSize: 9 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 9 }} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
            <Tooltip formatter={(v, n) => [Math.abs(v), n]} />
            <Bar dataKey="tpStreak" name="TP Serisi" fill={C.green} />
            <Bar dataKey="slStreak" name="SL Serisi" fill={C.red} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12 }}>Bu segment için veri yok.</div>
      )}

      {/* Carpan hesabi */}
      <div style={{ marginTop: 24 }}>
        <SecTitle>Carpan Etki Hesabi — {seg.label} (Komisyon Dahil)</SecTitle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(195px,1fr))", gap: 10 }}>
          {[
            { label: `${maxTP}x ust uste TP`, mult: Math.pow(TP_MULT, maxTP), color: C.green },
            { label: `${maxSL}x ust uste SL`, mult: Math.pow(SL_MULT, maxSL), color: C.red   },
            { label: "10x TP ardisik",         mult: Math.pow(TP_MULT, 10),   color: C.green },
            { label: "10x SL ardisik",         mult: Math.pow(SL_MULT, 10),   color: C.red   },
          ].map((s) => (
            <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: C.muted, marginBottom: 6 }}>{s.label}</div>
              <div style={{ fontSize: 18, fontFamily: "monospace", fontWeight: 700, color: s.color }}>
                {s.mult >= 1 ? "+" : ""}{((s.mult - 1) * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>$10.000 → {fmtBal(10000 * s.mult)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConflictTab({ data }) {
  const analysis = calcConflict(data.trades);
  return (
    <div>
      <SecTitle>Conflict Tipi Bazli Performans</SecTitle>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        {analysis.map((a) => (
          <div key={a.type} style={{ flex: 1, minWidth: 150, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px 18px" }}>
            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>{a.type}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: wrColor(a.wr), fontFamily: "monospace" }}>{a.wr}%</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>Win Rate</div>
            <div style={{ marginTop: 10, display: "flex", gap: 12 }}>
              <span style={{ fontSize: 11, color: C.green }}>TP {a.tp}</span>
              <span style={{ fontSize: 11, color: C.red   }}>SL {a.sl}</span>
              {a.conflict > 0 && <span style={{ fontSize: 11, color: C.orange }}>CONF {a.conflict}</span>}
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>Toplam: {a.total}</div>
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={analysis}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="type" tick={{ fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} />
          <Tooltip formatter={(v, n) => [v, n]} />
          <Bar dataKey="tp" name="TP" stackId="a" fill={C.green} />
          <Bar dataKey="sl" name="SL" stackId="a" fill={C.red} radius={[3,3,0,0]} />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 22 }}>
        <SecTitle>Aciklama</SecTitle>
        {[
          ["none",     C.green,  "Cakisma yok. En temiz sinyal."],
          ["same-bar", C.orange, "Ayni bar cakismasi. CONFLICT result haric tutulur."],
          ["later",    C.blue,   "Sonraki bar cakismasi. Islem gecerli sayilir."],
        ].map(([type, color, desc]) => (
          <div key={type} style={{ display: "flex", gap: 12, padding: "10px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, marginBottom: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 3, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 11, color: C.textBright, marginBottom: 2, fontFamily: "monospace" }}>{type}</div>
              <div style={{ fontSize: 10, color: C.muted }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthlyTab({ data }) {
  const valid  = validTrades(data.trades);
  const longs  = valid.filter((t) => t.direction === "LONG");
  const shorts = valid.filter((t) => t.direction === "SHORT");
  const [activeSeg, setActiveSeg] = useState("all");

  const segMap = {
    all:   { trades: valid,  label: "Tum Islemler", color: C.blue   },
    long:  { trades: longs,  label: "Sadece LONG",  color: C.green  },
    short: { trades: shorts, label: "Sadece SHORT", color: C.orange },
  };
  const seg = segMap[activeSeg];
  const monthly = calcMonthly(seg.trades);

  const MonthTable = ({ data }) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{["Ay","Toplam","TP","SL","Win Rate"].map((h) => (
            <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: C.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.3)" }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {data.map((m, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent" }}>
              <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.textBright }}>{m.month}</td>
              <td style={{ padding: "9px 14px", color: C.text }}>{m.total}</td>
              <td style={{ padding: "9px 14px", color: C.green, fontWeight: 600 }}>{m.tp}</td>
              <td style={{ padding: "9px 14px", color: C.red, fontWeight: 600 }}>{m.sl}</td>
              <td style={{ padding: "9px 14px" }}>
                <span style={{ color: wrColor(m.wr), fontWeight: 700, fontFamily: "monospace" }}>{m.wr}%</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      {/* Segment selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {Object.entries(segMap).map(([id, s]) => (
          <button key={id} onClick={() => setActiveSeg(id)}
            style={{ padding: "5px 16px", borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "monospace", transition: "all .15s",
              background: activeSeg === id ? `rgba(${id === "long" ? "0,229,160" : id === "short" ? "255,140,66" : "77,166,255"},0.12)` : "transparent",
              border: `1px solid ${activeSeg === id ? s.color : "rgba(255,255,255,0.08)"}`,
              color: activeSeg === id ? s.color : C.muted }}>
            {s.label}
          </button>
        ))}
      </div>

      <SecTitle>Aylik Performans — {seg.label}</SecTitle>

      {monthly.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12 }}>Bu segment için veri yok.</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthly}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 9 }} />
              <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={40} />
              <ReferenceLine y={50} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
              <Tooltip formatter={(v) => [`${v}%`, "Win Rate"]} />
              <Bar dataKey="wr" name="Win Rate" radius={[3,3,0,0]}>
                {monthly.map((m, i) => <Cell key={i} fill={wrColor(m.wr)} fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 20 }}>
            <MonthTable data={monthly} />
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [datasets,    setDatasets]    = useState({});
  const [selectedKey, setSelectedKey] = useState(null);
  const [activeTab,   setActiveTab]   = useState("overview");
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [dragOver,    setDragOver]    = useState(false);
  const [toast,       setToast]       = useState(null);
  const [confirmDel,  setConfirmDel]  = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const fileRef = useRef();

  useEffect(() => {
    dbLoadAll()
      .then((all) => { setDatasets(all); setLoading(false); })
      .catch(() => { setLoading(false); showToast("Veritabani baglantisi kurulamadi!", "err"); });
  }, []);

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        setSaving(true);
        const dataset = parseCSV(e.target.result, file.name);
        const key = dataset.meta.storageKey;
        await dbSaveDataset(key, dataset);
        setDatasets((prev) => ({ ...prev, [key]: dataset }));
        setSelectedKey(key);
        setActiveTab("overview");
        showToast(`Kaydedildi → ${dataset.meta.pair} / ${dataset.meta.timeframe}`, "ok");
      } catch (err) {
        showToast("Hata: " + err.message, "err");
      } finally {
        setSaving(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    };
    reader.readAsText(file, "utf-8");
  }, []);

  const handleDelete = async (key) => {
    try {
      await dbDeleteDataset(key);
      setDatasets((prev) => { const n = { ...prev }; delete n[key]; return n; });
      if (selectedKey === key) {
        const rem = Object.keys(datasets).filter((k) => k !== key);
        setSelectedKey(rem[0] ?? null);
      }
      showToast("Analiz silindi.", "ok");
    } catch (err) {
      showToast("Silme hatasi: " + err.message, "err");
    } finally {
      setConfirmDel(null);
    }
  };

  // Sidebar tree
  const tree = {};
  Object.entries(datasets).forEach(([key, ds]) => {
    const p = ds.meta.pair;
    if (!tree[p]) tree[p] = [];
    tree[p].push({ key, tf: ds.meta.timeframe, startDate: ds.meta.startDate, endDate: ds.meta.endDate });
  });
  Object.values(tree).forEach((arr) => arr.sort((a, b) => tfSort(a.tf, b.tf)));
  const sortedPairs = Object.keys(tree).sort();
  const data = selectedKey ? datasets[selectedKey] : null;

  const tabContent = () => {
    if (!data) return null;
    switch (activeTab) {
      case "overview":     return <OverviewTab     data={data} />;
      case "winrate":      return <WinRateTab      data={data} />;
      case "distribution": return <DistributionTab data={data} />;
      case "equity":       return <EquityTab       data={data} />;
      case "streaks":      return <StreaksTab       data={data} />;
      case "conflict":     return <ConflictTab      data={data} />;
      case "monthly":      return <MonthlyTab       data={data} />;
      default:             return null;
    }
  };

  if (loading) return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: C.bg, gap: 14, fontFamily: "monospace" }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.green, boxShadow: `0 0 20px ${C.green}` }} />
      <div style={{ color: C.green, fontSize: 11, letterSpacing: 2.5 }}>YUKLENIYOR...</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Mono','Fira Code',monospace", overflow: "hidden" }}>

      {/* Grid bg */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, backgroundImage: "linear-gradient(rgba(0,229,160,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,160,0.02) 1px,transparent 1px)", backgroundSize: "40px 40px" }} />

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, background: C.surface2, border: `1px solid ${toast.type === "ok" ? C.green : C.red}`, borderRadius: 4, padding: "10px 20px", fontSize: 11, color: toast.type === "ok" ? C.green : C.red, boxShadow: "0 8px 40px rgba(0,0,0,0.8)", fontFamily: "monospace", maxWidth: 360 }}>
          {toast.msg}
        </div>
      )}

      {/* Confirm Modal */}
      {confirmDel && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.surface2, border: `1px solid ${C.red}`, borderRadius: 8, padding: "32px 36px", maxWidth: 380, width: "100%", textAlign: "center", fontFamily: "monospace" }}>
            <div style={{ fontSize: 32, marginBottom: 14, color: C.orange }}>!</div>
            <div style={{ color: C.textBright, fontSize: 14, marginBottom: 8 }}>Bu analizi silmek istediğine emin misin?</div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 24, lineHeight: 1.8 }}>
              {datasets[confirmDel]?.meta.pair} / {datasets[confirmDel]?.meta.timeframe}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setConfirmDel(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 24px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>Iptal</button>
              <button onClick={() => handleDelete(confirmDel)} style={{ background: "rgba(255,71,87,0.15)", border: `1px solid ${C.red}`, color: C.red, padding: "8px 24px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Sil</button>
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 54, background: "rgba(7,12,17,0.98)", borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setSidebarOpen((v) => !v)} style={{ background: "transparent", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: "0 4px", lineHeight: 1 }}>☰</button>
          <span style={{ color: C.green, fontSize: 20 }}>◈</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 3, color: C.textBright }}>BACKTEST<span style={{ color: C.green }}>LAB</span></div>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: 2, textTransform: "uppercase" }}>Kripto · Algo · 1:1 RR</div>
          </div>
          <div style={{ width: 1, height: 28, background: C.border }} />
          <div style={{ fontSize: 10, color: C.muted }}>
            <span style={{ color: C.textBright, fontWeight: 700 }}>{Object.keys(datasets).length}</span> analiz
            {sortedPairs.length > 0 && <span> · <span style={{ color: C.textBright, fontWeight: 700 }}>{sortedPairs.length}</span> parite</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saving && <span style={{ fontSize: 10, color: C.green }}>Kaydediliyor...</span>}
          <button onClick={() => fileRef.current.click()} style={{ background: "rgba(0,229,160,0.1)", border: `1px solid rgba(0,229,160,0.35)`, color: C.green, padding: "7px 18px", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>
            + CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* SIDEBAR */}
        {sidebarOpen && (
          <aside style={{ width: 210, borderRight: `1px solid ${C.border}`, background: "rgba(10,16,24,0.97)", overflowY: "auto", flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 14px", fontSize: 8, color: C.muted, textTransform: "uppercase", letterSpacing: 2.5, borderBottom: `1px solid ${C.border}`, background: "rgba(0,0,0,0.2)" }}>
              Pariteler & Timeframe
            </div>
            {sortedPairs.length === 0 ? (
              <div style={{ padding: "28px 16px", fontSize: 10, color: C.muted, lineHeight: 1.9, textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.2 }}>◫</div>
                Kayitli analiz yok.<br />CSV yukleyerek basla.
              </div>
            ) : (
              sortedPairs.map((pair) => (
                <div key={pair} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ padding: "9px 14px 5px", fontSize: 10, color: C.textBright, fontWeight: 700, letterSpacing: 2, background: "rgba(0,229,160,0.03)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green, display: "inline-block" }} />
                    {pair}
                    <span style={{ fontSize: 8, color: C.muted, marginLeft: "auto" }}>{tree[pair].length} TF</span>
                  </div>
                  {tree[pair].map(({ key, tf, startDate, endDate }) => {
                    const isActive = key === selectedKey;
                    return (
                      <div key={key} style={{ display: "flex", alignItems: "stretch", borderLeft: `2px solid ${isActive ? C.green : "transparent"}`, background: isActive ? "rgba(0,229,160,0.07)" : "transparent", transition: "all .15s" }}>
                        <div onClick={() => { setSelectedKey(key); setActiveTab("overview"); }} style={{ flex: 1, padding: "9px 14px 9px 18px", cursor: "pointer" }}>
                          <div style={{ fontSize: 13, color: isActive ? C.green : C.text, fontWeight: isActive ? 700 : 400, fontFamily: "monospace" }}>{tf}</div>
                          <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>
                            {startDate ? `${startDate.slice(0,7)} › ${endDate?.slice(0,7)}` : "—"}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setConfirmDel(key); }}
                          style={{ background: "transparent", border: "none", color: "rgba(255,71,87,0.3)", cursor: "pointer", padding: "0 12px", fontSize: 12, transition: "color .15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = C.red)}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,71,87,0.3)")}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current.click()}
              style={{ margin: 12, marginTop: "auto", border: `1px dashed ${dragOver ? C.green : "rgba(255,255,255,0.1)"}`, borderRadius: 6, padding: "14px 10px", textAlign: "center", cursor: "pointer", transition: "all .2s" }}>
              <div style={{ fontSize: 18, color: dragOver ? C.green : "rgba(255,255,255,0.15)", marginBottom: 4 }}>+</div>
              <div style={{ fontSize: 9, color: C.muted }}>CSV surukle / yukle</div>
            </div>
          </aside>
        )}

        {/* MAIN */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!data ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: 32, textAlign: "center" }}>
              <div style={{ fontSize: 52, opacity: 0.1 }}>◈</div>
              <div style={{ fontSize: 15, color: C.textBright }}>
                {Object.keys(datasets).length > 0 ? "Soldaki agactan bir analiz sec" : "Ilk CSV dosyani yukle"}
              </div>
              <div style={{ fontSize: 10, color: C.muted, maxWidth: 480, lineHeight: 1.9 }}>
                Desteklenen formatlar:<br />
                <code style={{ color: C.green }}>xlm_4h.csv</code> &nbsp;·&nbsp;
                <code style={{ color: C.green }}>btc_1d.csv</code> &nbsp;·&nbsp;
                <code style={{ color: C.green }}>new_trades_XLMUSDT_P_2025-01-01_2026-02-28_4h.csv</code>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", borderBottom: `1px solid ${C.border}`, background: "rgba(10,16,24,0.85)", flexShrink: 0, flexWrap: "wrap" }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.textBright, letterSpacing: 3 }}>{data.meta.pair}</span>
                <span style={{ color: C.muted, fontSize: 16 }}>›</span>
                <span style={{ color: C.green, border: `1px solid rgba(0,229,160,0.3)`, padding: "2px 12px", borderRadius: 2, fontSize: 12, fontFamily: "monospace" }}>{data.meta.timeframe}</span>
                {data.meta.contractType === "P" && <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>Perpetual</span>}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                  {data.meta.startDate && <span style={{ fontSize: 10, color: C.muted }}>{data.meta.startDate} — {data.meta.endDate}</span>}
                  <span style={{ fontSize: 10, color: C.muted }}>{validTrades(data.trades).length} islem</span>
                  <button onClick={() => setConfirmDel(selectedKey)} style={{ background: "rgba(255,71,87,0.08)", border: `1px solid rgba(255,71,87,0.25)`, color: "#ff6b7a", padding: "4px 12px", borderRadius: 3, cursor: "pointer", fontSize: 10 }}>Sil</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 2, padding: "8px 12px", borderBottom: `1px solid ${C.border}`, background: "rgba(7,12,17,0.75)", flexShrink: 0, overflowX: "auto" }}>
                {TABS.map((t) => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    style={{ background: activeTab === t.id ? "rgba(0,229,160,0.1)" : "transparent", border: `1px solid ${activeTab === t.id ? "rgba(0,229,160,0.3)" : "transparent"}`, color: activeTab === t.id ? C.green : C.muted, padding: "5px 14px", borderRadius: 3, cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", transition: "all .15s" }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
                {tabContent()}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
