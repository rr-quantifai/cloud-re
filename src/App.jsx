import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import Papa from "papaparse";

/* ═══════════════════════════════════════════════════════════════════
   PERSISTENT STORAGE — IndexedDB
   ═══════════════════════════════════════════════════════════════════ */
let idb = null;
const getIDB = () => {
  if (idb) return idb;
  idb = new Promise((res, rej) => {
    const req = indexedDB.open("cloud-re", 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore("kv"); };
    req.onsuccess = () => res(req.result);
    req.onerror = () => { idb = null; rej(req.error); };
  });
  return idb;
};
const psGet = async (k) => {
  try {
    const db = await getIDB();
    return new Promise(r => { const req = db.transaction("kv","readonly").objectStore("kv").get(k); req.onsuccess = () => r(req.result ?? null); req.onerror = () => r(null); });
  } catch { return null; }
};
const psSet = async (k, v) => {
  try {
    const db = await getIDB();
    return new Promise(r => { const tx = db.transaction("kv","readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => r(); tx.onerror = () => r(); });
  } catch {}
};
const psDel = async (k) => {
  try {
    const db = await getIDB();
    return new Promise(r => { const tx = db.transaction("kv","readwrite"); tx.objectStore("kv").delete(k); tx.oncomplete = () => r(); tx.onerror = () => r(); });
  } catch {}
};

/* ═══════════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════════ */
const parseCsv = (file) => new Promise((res, rej) => {
  Papa.parse(file, {
    header: true, skipEmptyLines: true, dynamicTyping: false,
    delimitersToGuess: [",", ";", "\t", "|"],
    transformHeader: (h) => h.trim().replace(/^\uFEFF/, ""),
    complete: (r) => res(r.data.map(row => { const o = {}; for (const k in row) o[k.trim()] = (row[k] || "").toString().trim(); return o; })),
    error: () => rej(new Error("Parse failed")),
  });
});

const parseDateFlexible = (s) => {
  if (!s) return null;
  const t = s.trim();
  const dmy = t.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const rawYear = parseInt(dmy[3], 10);
    const year    = dmy[3].length === 2 ? 2000 + rawYear : rawYear;
    const d = new Date(`${year}-${dmy[2].padStart(2,"0")}-${dmy[1].padStart(2,"0")}T00:00:00Z`);
    if (!isNaN(d)) return d;
  }
  const d = new Date(t);
  if (!isNaN(d)) return d;
  return null;
};

const getMonthKey = (dateStr) => {
  const d = parseDateFlexible(dateStr);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const MONTH_ABBREVS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const fmtMonthKey = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return MONTH_ABBREVS[m - 1] + "-" + String(y).slice(2);
};

const getFY      = (ym) => { const [y, m] = ym.split("-").map(Number); return m >= 4 ? y + 1 : y; };
const getFYLabel = (fy) => `FY${String(fy).slice(2)}`;

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════ */
const REQUIRED_COLS = ["custid", "EndCustomer", "InvoiceDate", "amount", "SubscriptionName", "partnername", "storeid"];

const extractPartnerName = (v) => { const s = (v||"").trim(); const i = s.indexOf("~"); return i !== -1 ? s.slice(i+1).trim() : s; };
const extractPartnerID   = (v) => { const s = (v||"").trim(); const i = s.indexOf("~"); return i !== -1 ? s.slice(0,i).trim() : ""; };
const extractCountry     = (v) => { const s = (v||"").trim(); const i = s.indexOf("-"); return i !== -1 ? s.slice(0,i).trim() : s; };
const PAGE_SIZE = 25;
const MIN_DESKTOP = 1024;

const PRODUCT_PALETTE = [
  "bg-purple-100 text-purple-700",
  "bg-emerald-100 text-emerald-700",
  "bg-blue-100 text-blue-700",
  "bg-amber-100 text-amber-700",
  "bg-pink-100 text-pink-700",
  "bg-orange-100 text-orange-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

/* deterministic color per product name */
const hashProductColor = (product) => {
  if (product === "Blank") return "bg-gray-100 text-gray-500";
  let h = 5381;
  for (let i = 0; i < product.length; i++) { h = ((h << 5) + h) + product.charCodeAt(i); h = h & h; }
  return PRODUCT_PALETTE[Math.abs(h) % PRODUCT_PALETTE.length];
};

/* ═══════════════════════════════════════════════════════════════════
   VALIDATION
   ═══════════════════════════════════════════════════════════════════ */
const validateCsv = (rows) => {
  if (!rows.length) return { valid: false, message: "Empty file" };
  const headers = new Set(Object.keys(rows[0]));
  const missing = REQUIRED_COLS.filter(c => !headers.has(c));
  if (missing.length) return { valid: false, message: `Missing: ${missing.join(", ")}` };
  for (const row of rows.slice(0, 5)) {
    if (!getMonthKey(row["InvoiceDate"])) return { valid: false, message: "Cannot parse date column" };
  }
  return { valid: true };
};

/* ═══════════════════════════════════════════════════════════════════
   RECAPTURE ENGINE
   ═══════════════════════════════════════════════════════════════════ */
const buildTypeMap = (allRows, sortedMonths) => {
  // typeMap: rowId → "upsell" | "crosssell" | "new"
  if (!sortedMonths.length) return {};
  const byMonth = {};
  for (const row of allRows) {
    const m = row._reportingMonth;
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(row);
  }
  const seenRelationships = new Set();  // custID|||country|||partnerID seen in any prior month
  const relProducts       = {};         // relationship key → Set<product> ever bought
  const typeMap = {};
  for (const month of sortedMonths) {
    const rows  = byMonth[month] || [];
    const toAdd = [];
    for (const row of rows) {
      const custID  = (row["Customer ID"] || "").trim();
      const country = (row["Country"]     || "").trim();
      const pID     = (row["Partner ID"]  || "").trim();
      const prod    = (row["Product"]     || "").trim();
      if (!custID) { typeMap[row._id] = "new"; continue; }
      const relKey = custID + "|||" + country + "|||" + pID;
      if (!seenRelationships.has(relKey)) {
        typeMap[row._id] = "new";
      } else if (prod && relProducts[relKey]?.has(prod)) {
        typeMap[row._id] = "upsell";
      } else {
        typeMap[row._id] = "crosssell";
      }
      toAdd.push([relKey, prod]);
    }
    for (const [k, p] of toAdd) {
      seenRelationships.add(k);
      if (!relProducts[k]) relProducts[k] = new Set();
      if (p) relProducts[k].add(p);
    }
  }
  return typeMap;
};

/* ═══════════════════════════════════════════════════════════════════
   ATOM COMPONENTS
   ═══════════════════════════════════════════════════════════════════ */
const Dots = () => (
  <span className="inline-flex items-center gap-1">
    {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full bg-gray-300" style={{animation:"dotPulse 1.2s infinite",animationDelay:i*0.2+"s"}}/>)}
  </span>
);

const Badge = ({ text, className }) => (
  <span className={"inline-block px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap max-w-[180px] truncate " + (className||"")} title={text}>{text}</span>
);

const Chk = ({ checked, partial, onClick }) => (
  <div onClick={onClick} className={"w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer transition " + (checked ? "border-blue-600" : partial ? "border-blue-400" : "border-gray-300 hover:border-gray-400")}>
    {checked && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="4"><path d="M20 6L9 17l-5-5"/></svg>}
    {partial && !checked && <div className="w-2 h-0.5 bg-blue-400 rounded-sm"/>}
  </div>
);

/* ═══════════════════════════════════════════════════════════════════
   DROPDOWN COMPONENTS
   ═══════════════════════════════════════════════════════════════════ */
const useOutsideClose = (ref, open, setOpen) => {
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
};

const MultiSel = ({ values, onChange, options, placeholder, searchable = false }) => {
  const [open, setOpen]               = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const ref       = useRef(null);
  const searchRef = useRef(null);
  useOutsideClose(ref, open, setOpen);
  useEffect(() => {
    if (!open) { setSearchQuery(""); return; }
    if (searchable && searchRef.current) setTimeout(() => searchRef.current?.focus(), 0);
  }, [open, searchable]);
  const toggle   = (v) => { const o = options.find(x => (typeof x === "object" ? x.value : ""+x) === v); if (o?.disabled && !values.includes(v)) return; onChange(values.includes(v) ? values.filter(x => x !== v) : [...values, v]); };
  const getLabel = (v) => { const o = options.find(x => (typeof x === "object" ? x.value : ""+x) === v); return typeof o === "object" ? o.label : o != null ? ""+o : v; };
  const dis      = options.length === 0;
  const visible  = searchable && searchQuery.trim()
    ? options.filter(o => {
        const l = typeof o === "object" ? o.label : ""+o;
        const v = typeof o === "object" ? o.value : ""+o;
        const q = searchQuery.trim().toLowerCase();
        return l.toLowerCase().includes(q) || v.toLowerCase().includes(q);
      })
    : options;
  const displayLabel = values.length === 0 ? (placeholder||"All") : values.length === 1 ? getLabel(values[0]) : "Multiple selections";
  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => !dis && setOpen(!open)}
        className={"w-full px-2.5 py-1.5 text-sm border rounded-lg bg-white h-[36px] flex items-center gap-1 " + (dis ? "opacity-50 cursor-not-allowed border-gray-200" : values.length > 0 ? "cursor-pointer border-blue-400 hover:border-blue-500" : "cursor-pointer border-gray-200 hover:border-blue-300")}
      >
        <span className={"flex-1 min-w-0 truncate " + (values.length > 0 ? "text-blue-600" : "text-gray-400")} title={values.length === 1 ? getLabel(values[0]) : undefined}>{displayLabel}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={"flex-shrink-0 transition-transform " + (open ? "rotate-180" : "") + " " + (values.length > 0 ? "text-blue-400" : "text-gray-400")}><path d="M6 9l6 6 6-6"/></svg>
      </div>
      {open && !dis && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 overflow-hidden">
          {searchable && (
            <div className="p-2 border-b border-gray-100">
              <div className={"flex items-center gap-1.5 h-7 px-2 rounded-md border bg-gray-50 " + (searchQuery ? "border-blue-300" : "border-gray-200")}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={searchQuery ? "#2563eb" : "#9ca3af"} strokeWidth="2.5" className="flex-shrink-0"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                <input ref={searchRef} type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search…" className={"flex-1 min-w-0 text-xs bg-transparent focus:outline-none placeholder-gray-400 " + (searchQuery ? "text-blue-600" : "text-gray-700")} onClick={e => e.stopPropagation()}/>
                {searchQuery && <button onClick={e => { e.stopPropagation(); setSearchQuery(""); }} className="flex-shrink-0 text-gray-400 hover:text-gray-600"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>}
              </div>
            </div>
          )}
          <div className="max-h-52 overflow-y-auto divide-y divide-gray-100">
            {visible.length === 0
              ? <div className="px-3 py-3 text-xs text-gray-400">No matches</div>
              : visible.map(o => {
                  const v = typeof o === "object" ? o.value : ""+o;
                  const l = typeof o === "object" ? o.label : ""+o;
                  const chk = values.includes(v);
                  const isOff = typeof o === "object" && o.disabled && !chk;
                  return (
                    <div key={v} onClick={() => !isOff && toggle(v)} className={"px-3 py-2.5 text-xs flex items-center gap-2 " + (isOff ? "opacity-35 cursor-not-allowed" : "cursor-pointer hover:bg-gray-50")}>
                      <div className={"w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 " + (chk ? "border-blue-600" : "border-gray-300")}>
                        {chk && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="4"><path d="M20 6L9 17l-5-5"/></svg>}
                      </div>
                      <span className="truncate" title={l}>{l}</span>
                    </div>
                  );
                })
            }
          </div>
        </div>
      )}
    </div>
  );
};

const KPI_ICONS = {
  upsell:    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>,
  crosssell: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2"><path d="M17 4l4 4-4 4M7 20l-4-4 4-4M3 8h18M3 16h18"/></svg>,
  new:       <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M12 3l1.8 5.4L19 9l-5.2 4 2 5.8L12 15.6 8.2 18.8l2-5.8L5 9l5.2-.6L12 3z"/></svg>,
  recapture: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><path d="M20 11A8.1 8.1 0 004.5 9M4 5v4h4M4 13a8.1 8.1 0 0015.5 2M20 17v-4h-4"/></svg>,
  total:     <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M18 16v2a1 1 0 01-1 1H7l6-7-6-7h10a1 1 0 011 1v2"/></svg>,
};

const KPI_CONFIG = [
  { key: "new",       label: "New",        iconEl: KPI_ICONS.new,       border: "#7c3aed", iconBg: "#f5f3ff", pill: { bg: "#f5f3ff", text: "#4c1d95", border: "#ddd6fe" } },
  { key: "upsell",    label: "Upsell",     iconEl: KPI_ICONS.upsell,    border: "#10b981", iconBg: "#f0fdf4", pill: { bg: "#f0fdf4", text: "#166534", border: "#bbf7d0" } },
  { key: "crosssell", label: "Cross-sell", iconEl: KPI_ICONS.crosssell, border: "#3b82f6", iconBg: "#eff6ff", pill: { bg: "#eff6ff", text: "#1e40af", border: "#bfdbfe" } },
  { key: "recapture", label: "Recapture",  iconEl: KPI_ICONS.recapture, border: "#d97706", iconBg: "#fffbeb", pill: null },
  { key: "total",     label: "Total",      iconEl: KPI_ICONS.total,     border: "#6b7280", iconBg: "#f9fafb", pill: null },
];

/* ═══════════════════════════════════════════════════════════════════
   KPI CARDS
   ═══════════════════════════════════════════════════════════════════ */
const ChangeChip = ({ curr, prior, isPct = false }) => {
  const neutral = "inline-flex text-[10px] font-medium px-1.5 py-px rounded-full flex-shrink-0 border bg-slate-100 text-slate-400 border-slate-200";
  if (prior == null || (!isPct && prior === 0)) return <span className={neutral}>—</span>;
  const delta = isPct ? curr - prior : ((curr - prior) / prior) * 100;
  if (Math.abs(delta) < 0.05) return <span className={neutral}>—</span>;
  const pos   = delta >= 0;
  const label = isPct ? `${Math.abs(delta).toFixed(1)}pp` : `${Math.abs(delta).toFixed(1)}%`;
  return (
    <span className={"inline-flex text-[10px] font-medium px-1.5 py-px rounded-full flex-shrink-0 border " + (pos ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-red-50 text-red-800 border-red-200")}>
      {pos ? "↑" : "↓"} {label}
    </span>
  );
};

const KPICards = ({ totals, priorTotals }) => {
  const total = Math.max(totals.total, 1);
  const currRate  = recapRate(totals);
  const priorRate = priorTotals ? recapRate(priorTotals) : null;

  const dynamic = {
    upsell:    { pct: Math.round((totals.upsell    / total) * 100), val: fmtVal(totals.upsell),    curr: totals.upsell,    prior: priorTotals?.upsell    ?? null, isPct: false },
    crosssell: { pct: Math.round((totals.crosssell / total) * 100), val: fmtVal(totals.crosssell), curr: totals.crosssell, prior: priorTotals?.crosssell ?? null, isPct: false },
    new:       { pct: Math.round((totals.new       / total) * 100), val: fmtVal(totals.new),       curr: totals.new,       prior: priorTotals?.new       ?? null, isPct: false },
    recapture: { pct: null,                     val: fmtPct(currRate),         curr: currRate,         prior: priorRate,                      isPct: true  },
    total:     { pct: null,                     val: fmtVal(totals.total),     curr: totals.total,     prior: priorTotals?.total     ?? null, isPct: false },
  };
  const CARDS = KPI_CONFIG.map(cfg => ({ ...cfg, ...dynamic[cfg.key] }));

  return (
    <div className="grid mb-6" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "8px" }}>
      {CARDS.map(({ key, label, iconEl, border, iconBg, pill, pct, val, curr, prior, isPct }) => (
        <div key={key} className="bg-white rounded-xl border border-gray-200" style={{ borderLeft: `3px solid ${border}`, padding: "13px 13px 12px" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="w-[22px] h-[22px] rounded-md flex items-center justify-center flex-shrink-0" style={{ background: iconBg }}>
                {iconEl}
              </div>
              <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">{label}</span>
            </div>
            {pill && pct != null && (
              <span className="text-[10px] font-medium px-1.5 py-px rounded-full border flex-shrink-0 ml-1" style={{ background: pill.bg, color: pill.text, borderColor: pill.border }}>{pct}%</span>
            )}
          </div>
          <div className="text-lg font-medium text-gray-900 tracking-tight mb-2.5">{val}</div>
          <div className="flex items-center gap-1.5">
            <ChangeChip curr={curr} prior={prior} isPct={isPct}/>
            {prior != null && <span className="text-[10px] text-gray-400">vs. prior year</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

const getFQ = (ym) => { const m = Number(ym.split("-")[1]); return m >= 4 ? Math.ceil((m - 3) / 3) : 4; };

const FYMonthFilter = ({ values, onChange, allMonths, validMonths }) => {
  const [open, setOpen]           = useState(false);
  const [expFY, setExpFY]         = useState(() => new Set());
  const [expQ, setExpQ]           = useState(() => new Set());
  const ref = useRef(null);
  useOutsideClose(ref, open, setOpen);

  const fyTree = useMemo(() => {
    const groups = {};
    for (const ym of allMonths) {
      const fy = getFY(ym), q = getFQ(ym);
      if (!groups[fy]) groups[fy] = {};
      if (!groups[fy][q]) groups[fy][q] = [];
      groups[fy][q].push(ym);
    }
    return Object.entries(groups).sort(([a],[b]) => b - a).map(([fy, qs]) => ({
      fy: Number(fy),
      quarters: Object.entries(qs).sort(([a],[b]) => b - a).map(([q, months]) => ({
        q: Number(q),
        months: months.sort((a, b) => b.localeCompare(a)),
      })),
    }));
  }, [allMonths]);

  const selSet = useMemo(() => new Set(values), [values]);
  const allOf  = (ms) => ms.length > 0 && ms.every(m => selSet.has(m));
  const someOf = (ms) => ms.some(m => selSet.has(m));

  const canPick  = (ym) => !validMonths || validMonths.has(ym) || selSet.has(ym);
  const pickable = (ms) => ms.filter(canPick);

  const toggleGroup = (months) => {
    const ms = pickable(months);
    if (!ms.length) return;
    const next = new Set(selSet);
    if (allOf(ms)) ms.forEach(m => next.delete(m));
    else ms.forEach(m => next.add(m));
    onChange([...next]);
  };

  const toggleMonth = (ym) => {
    if (!canPick(ym)) return;                          // no data for current filters
    if (selSet.has(ym) && selSet.size === 1) return;   // last selected month is locked
    const next = new Set(selSet);
    next.has(ym) ? next.delete(ym) : next.add(ym);
    onChange([...next]);
  };

  /* on open, expand only the FYs/quarters containing current selections */
  useEffect(() => {
    if (!open) return;
    setExpFY(new Set(values.map(getFY)));
    setExpQ(new Set(values.map(ym => getFY(ym) + "-Q" + getFQ(ym))));
  }, [open]);

  const toggleExp = (setter, key) => setter(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const displayLabel = values.length === 0 ? "Month"
    : values.length === 1 ? fmtMonthKey(values[0])
    : `${values.length} months`;

  const Chevron = ({ exp }) => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className={"transition-transform flex-shrink-0 " + (exp ? "rotate-90" : "")}><path d="M9 18l6-6-6-6"/></svg>
  );

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <div onClick={() => setOpen(!open)} className={"w-full px-2.5 py-1.5 text-sm border rounded-lg bg-white h-[36px] flex items-center gap-1 cursor-pointer " + (values.length > 0 ? "border-blue-400 hover:border-blue-500" : "border-gray-200 hover:border-blue-300")}>
        <span className={"flex-1 min-w-0 truncate " + (values.length > 0 ? "text-blue-600" : "text-gray-400")}>{displayLabel}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={values.length > 0 ? "#60a5fa" : "#9ca3af"} strokeWidth="2" className={"flex-shrink-0 transition-transform " + (open ? "rotate-180" : "")}><path d="M6 9l6 6 6-6"/></svg>
      </div>
      {open && (
        <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto" style={{ minWidth: "100%" }}>
          {fyTree.map(({ fy, quarters }) => {
            const fyMonths = quarters.flatMap(q => q.months);
            const fyPick   = pickable(fyMonths);
            const fyExp    = expFY.has(fy);
            return (
              <div key={fy} className="border-b border-gray-100 last:border-b-0">
                <div className="flex items-center gap-2 hover:bg-gray-50 select-none" style={{ padding: "10px 12px" }}>
                  <span onClick={() => toggleExp(setExpFY, fy)} className="cursor-pointer flex items-center"><Chevron exp={fyExp}/></span>
                  <Chk checked={allOf(fyPick)} partial={someOf(fyMonths)} onClick={() => toggleGroup(fyMonths)} />
                  <span className="text-xs font-bold text-gray-800 cursor-pointer" onClick={() => toggleExp(setExpFY, fy)}>{getFYLabel(fy)}</span>
                </div>
                {fyExp && quarters.map(({ q, months }) => {
                  const qKey  = fy + "-Q" + q;
                  const qPick = pickable(months);
                  const qExp  = expQ.has(qKey);
                  return (
                    <React.Fragment key={qKey}>
                      <div className="flex items-center gap-2 hover:bg-gray-50 border-t border-dashed border-gray-200 select-none" style={{ padding: "10px 12px 10px 28px" }}>
                        <span onClick={() => toggleExp(setExpQ, qKey)} className="cursor-pointer flex items-center"><Chevron exp={qExp}/></span>
                        <Chk checked={allOf(qPick)} partial={someOf(months)} onClick={() => toggleGroup(months)} />
                        <span className="text-xs font-semibold text-gray-700 cursor-pointer" onClick={() => toggleExp(setExpQ, qKey)}>{`Q${q} ${getFYLabel(fy)}`}</span>
                      </div>
                      {qExp && months.map(ym => {
                        const chk    = selSet.has(ym);
                        const locked = chk && selSet.size === 1;
                        const off    = !canPick(ym);
                        return (
                          <div key={ym} onClick={() => toggleMonth(ym)}
                            className={"flex items-center gap-2 border-t border-dotted border-gray-200 select-none " + (off ? "opacity-35 cursor-not-allowed" : locked ? "cursor-default" : "hover:bg-gray-50 cursor-pointer")}
                            title={off ? "No data for current filters" : locked ? "At least one month must stay selected" : undefined}
                            style={{ padding: "10px 12px 10px 44px" }}>
                            <span className="w-[11px] flex-shrink-0"/>
                            <Chk checked={chk} partial={false} onClick={(e) => { e.stopPropagation(); toggleMonth(ym); }} />
                            <span className="text-xs font-medium text-gray-700">{fmtMonthKey(ym)}</span>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const fmtVal    = (v) => (v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPct    = (v) => (v || 0).toFixed(1) + "%";
const recapRate = (t) => t && t.total > 0 ? ((t.upsell + t.crosssell) / t.total) * 100 : 0;
const GRID      = "250px 85px 85px 85px 85px 85px 85px 85px";
const GAP       = { gap: "16px", justifyContent: "space-between" };

const SortTh = ({ col, label, right = false, sortCol, onSort }) => (
  <span className={"cursor-pointer select-none hover:text-gray-700 transition text-xs uppercase tracking-wider font-medium whitespace-nowrap " + (right ? "block text-right" : "")}
    onClick={() => onSort(col)} style={{ color: sortCol === col ? "#1d4ed8" : "#9ca3af" }}>{label}</span>
);

const IDBadge  = ({ id })    => <span className="inline-block px-1.5 py-px text-[10px] font-medium rounded border border-gray-200 bg-gray-50 text-gray-400 flex-shrink-0">{id}</span>;
const CntBadge = ({ label }) => <span className="inline-block px-1.5 py-px text-[10px] rounded border border-slate-200 bg-slate-100 text-slate-500 flex-shrink-0">{label}</span>;
const Dash     = ()          => <span className="text-gray-200 text-xs">—</span>;

/* ═══════════════════════════════════════════════════════════════════
   HISTORY MODAL
   ═══════════════════════════════════════════════════════════════════ */
const MODAL_W   = "560px";
const MODAL_H   = "80vh";
const TYPE_DOTS = { new: "#7c3aed", upsell: "#16a34a", crosssell: "#2563eb" };
const TYPE_LABELS = [["new","New"],["upsell","Upsell"],["crosssell","Cross-sell"]];

const HistoryCell = ({ cell }) => {
  if (!cell) return <span className="text-gray-200 text-xs">—</span>;
  return (
    <div className="flex items-center justify-end gap-1.5">
      <div className="w-[6px] h-[6px] rounded-full flex-shrink-0" style={{ background: TYPE_DOTS[cell.type] }}/>
      <span className="text-[11px] font-medium text-gray-700 whitespace-nowrap">{fmtVal(cell.value)}</span>
    </div>
  );
};

const HistoryModal = ({ open, customerName, country, data, onClose, onAskAI }) => {
  if (!open || !data) return null;
  const { months, partners } = data;
  const partnerIDs = Object.keys(partners).sort((a, b) => partners[a].name.localeCompare(partners[b].name));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "#0f0f0f" }}>
      <div className="bg-white rounded-2xl overflow-hidden flex flex-col" style={{ width: MODAL_W, maxHeight: MODAL_H }}>

        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-gray-200 flex-shrink-0">
          <span className="text-[15px] font-semibold text-gray-900 truncate" title={customerName}>{customerName}</span>
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-[11px] font-medium text-gray-500 flex-shrink-0">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
            {country}
          </span>
          <button onClick={onAskAI}
            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-[11px] font-medium text-indigo-600 hover:bg-indigo-100 hover:border-indigo-300 transition flex-shrink-0">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
            </svg>
            Ask AI
          </button>
          <button onClick={onClose} aria-label="Close"
            className="ml-auto w-7 h-7 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition flex-shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="border-collapse text-xs" style={{ minWidth: "max-content", width: "100%" }}>
            <thead>
              <tr className="bg-gray-50" style={{ position: "sticky", top: 0, zIndex: 4 }}>
                <th className="text-left border-b border-r border-gray-200 bg-gray-50" style={{ position: "sticky", left: 0, zIndex: 5, width: "170px", minWidth: "170px", padding: "8px 12px 8px 16px" }}/>
                {months.map(m => (
                  <th key={m} className="text-right border-b border-gray-200 text-[10px] font-medium text-gray-400 uppercase tracking-wider whitespace-nowrap" style={{ padding: "8px 12px", minWidth: "88px" }}>{fmtMonthKey(m)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {partnerIDs.map(pID => {
                const p = partners[pID];
                const prodKeys = Object.keys(p.products).sort();
                return (
                  <React.Fragment key={pID}>
                    <tr className="border-b border-gray-200">
                      <td className="border-r border-gray-200 bg-white align-middle" style={{ position: "sticky", left: 0, zIndex: 3, padding: "10px 12px 10px 16px" }}>
                        <div className="flex items-center gap-1.5">
                          <div className="w-[14px] h-[14px] rounded bg-blue-50 flex items-center justify-center flex-shrink-0">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2"><path d="M3 21h18M3 7l9-4 9 4M4 7v14M20 7v14M9 21V11h6v10"/></svg>
                          </div>
                          <span className="text-[11px] font-medium text-gray-700 truncate" title={p.name} style={{ maxWidth: "125px" }}>{p.name}</span>
                        </div>
                      </td>
                      <td className="bg-white" colSpan={months.length}/>
                    </tr>
                    {prodKeys.map(prod => (
                      <tr key={prod} className="border-b border-dotted border-gray-100">
                        <td className="border-r border-gray-200 bg-white" style={{ position: "sticky", left: 0, zIndex: 3, padding: "10px 12px 10px 16px", verticalAlign: "middle" }}>
                          <div className="flex items-center gap-1.5 min-w-0" style={{ marginLeft: "16px" }}>
                            <div className="w-[16px] h-[16px] rounded bg-violet-50 flex items-center justify-center flex-shrink-0">
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
                            </div>
                            <Badge text={prod} className={hashProductColor(prod) + " max-w-[100px]"}/>
                          </div>
                        </td>
                        {months.map(m => (
                          <td key={m} className="text-right align-middle" style={{ padding: "10px 12px" }}><HistoryCell cell={p.products[prod][m]}/></td>
                        ))}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Legend footer */}
        <div className="flex items-center gap-5 px-5 py-2.5 bg-gray-50 border-t border-gray-200 flex-shrink-0">
          {TYPE_LABELS.map(([k, label]) => (
            <div key={k} className="flex items-center gap-1.5">
              <div className="w-[6px] h-[6px] rounded-full flex-shrink-0" style={{ background: TYPE_DOTS[k] }}/>
              <span className="text-[10px] text-gray-500">{label}</span>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   AI INSIGHTS MODAL
   ═══════════════════════════════════════════════════════════════════ */
const AIInsightsModal = ({ open, customerName, onClose, onAnalyzeAgain, loading, content, failed }) => {
  if (!open) return null;
  
  const parseContent = (text) => {
    const lines = text.split("\n");
    const sections = [];
    let currentSection = null;
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      if (line.startsWith("**") && line.endsWith("**")) {
        if (currentSection) sections.push(currentSection);
        currentSection = { title: line.replace(/\*\*/g, ""), bullets: [] };
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        if (currentSection) {
          currentSection.bullets.push(line.replace(/^[-*]\s*/, "").replace(/\.$/, ""));
        }
      } else if (currentSection && !line.startsWith("#")) {
        if (currentSection.bullets.length === 0) {
          currentSection.bullets.push(line.replace(/\.$/, ""));
        }
      }
    }
    if (currentSection) sections.push(currentSection);
    return sections;
  };

  const sections = content ? parseContent(content) : [];
  const [displayName, displayCountry] = customerName.includes(" — ")
    ? customerName.split(" — ")
    : [customerName, null];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "#0f0f0f" }}>
      <div className="bg-white rounded-2xl overflow-hidden" style={{ width: "560px", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>

        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "0.5px solid #e5e7eb", flexShrink: 0 }}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
            </svg>
            <span style={{ fontSize: "10px", fontWeight: 500, color: "#4f46e5", textTransform: "uppercase", letterSpacing: "0.08em" }}>Recapture Recommendations</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 style={{ fontSize: "17px", fontWeight: 600, color: "#111827", margin: 0 }}>{displayName}</h3>
            {displayCountry && (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-gray-100 border border-gray-200 text-[11px] font-medium text-gray-500 flex-shrink-0">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                {displayCountry}
              </span>
            )}
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading && <div className="flex items-center justify-center h-32"><Dots /></div>}
          {!loading && !failed && (
            <div>
              {sections.map((section, i) => (
                <div key={i} style={{ padding: "14px 24px", borderBottom: i < sections.length - 1 ? "0.5px solid #e5e7eb" : "none" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <div style={{ width: "22px", height: "22px", borderRadius: "6px", background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                      </svg>
                    </div>
                    <span style={{ fontSize: "13px", fontWeight: 600, color: "#111827" }}>{section.title}</span>
                  </div>
                  <div style={{ paddingLeft: "30px", display: "flex", flexDirection: "column", gap: "4px" }}>
                    {section.bullets.map((bullet, bi) => (
                      <div key={bi} className="flex items-start gap-2">
                        <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: "#a78bfa", flexShrink: 0, marginTop: "6px" }}/>
                        <span style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.6 }}>{bullet}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {failed && <div className="flex items-center justify-center h-32"><p className="text-sm text-gray-400">Unable to load</p></div>}
        </div>

        {/* Footer */}
        <div style={{ padding: "14px", borderTop: "1px solid #e5e7eb", background: "#f9fafb", display: "flex", gap: "8px", flexShrink: 0 }}>
          <button onClick={onClose} className="flex-1 h-9 rounded-lg text-xs font-medium bg-white text-gray-600 hover:bg-gray-50 transition inline-flex items-center justify-center gap-1.5 border border-gray-200">
            Back
          </button>
          <button onClick={onAnalyzeAgain} disabled={loading || failed} className={"flex-1 h-9 rounded-lg text-xs font-medium transition inline-flex items-center justify-center gap-1.5 " + (loading || failed ? "bg-gray-100 text-gray-400 cursor-not-allowed border border-gray-200" : "bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200")}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
            </svg>
            Analyze Again
          </button>
        </div>

      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   UPLOAD MODAL
   ═══════════════════════════════════════════════════════════════════ */
const UploadModal = ({ uploadState, handleUpload, hasData, onClose, fileRef }) => {
  const st = uploadState?.status;
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (st === "success") {
      const t = setTimeout(onClose, 2000);
      return () => clearTimeout(t);
    }
  }, [st, onClose]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDrag(false);
    if (st === "uploading") return;
    const files = e.dataTransfer.files;
    if (files?.length) handleUpload(files);
  }, [handleUpload, st]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    if (st !== "uploading") setDrag(true);
  }, [st]);

  const onDragLeave = useCallback((e) => {
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setDrag(false);
  }, []);

  const imported = uploadState?.imported ?? 0;
  const skipped  = uploadState?.skipped  ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "#0f0f0f" }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="bg-white rounded-2xl relative" style={{ width: "340px", padding: "40px 32px 32px" }}>

        {hasData && st !== "uploading" && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3.5 right-3.5 w-7 h-7 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}

        <div className="flex flex-col items-center text-center gap-4">

          {!st && (
            <div className={"w-14 h-14 rounded-2xl flex items-center justify-center transition-colors " + (drag ? "bg-blue-100" : "bg-blue-50")}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={drag ? "#1d4ed8" : "#2563eb"} strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
            </div>
          )}
          {st === "uploading" && (
            <div className="w-14 h-14 rounded-full border-[3px] border-gray-200 border-t-blue-600" style={{ animation: "_spin .9s linear infinite" }}/>
          )}
          {st === "success" && (
            <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center" style={{ animation: "_pop .3s cubic-bezier(.34,1.56,.64,1) forwards" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
          )}
          {st === "error" && (
            <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center" style={{ animation: "_pop .3s cubic-bezier(.34,1.56,.64,1) forwards" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </div>
          )}

          <div>
            <p className="text-sm font-semibold text-gray-900 mb-1.5">
              {!st ? "Upload CSV" : st === "uploading" ? "Uploading CSV" : st === "success" ? "Upload complete" : "Upload failed"}
            </p>
            <p className="text-xs text-gray-400">
              {!st ? "Drop or click to browse" : st === "uploading" ? "Do not close the modal" : st === "success" ? `${imported.toLocaleString()} rows imported` : "See console for details"}
            </p>
            {st === "success" && skipped > 0 && (
              <p className="text-xs text-amber-500 mt-1">{skipped.toLocaleString()} rows skipped</p>
            )}
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          multiple
          className="hidden"
          onChange={e => { handleUpload(e.target.files); if (fileRef.current) fileRef.current.value = ""; }}
        />

        <button
          onClick={() => { if (!st || st === "error") fileRef.current?.click(); }}
          disabled={st === "uploading" || st === "success"}
          className={"w-full h-10 rounded-lg text-sm font-medium mt-7 transition-opacity " + (st === "uploading" || st === "success" ? "bg-blue-600 text-white opacity-35 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700 cursor-pointer")}
        >
          Upload Data
        </button>
      </div>
    </div>
  );
};

/* ─ Claude API call for Microsoft recommendations ─ */
const callClaudeAPI = async (products) => {
  const response = await fetch("/.netlify/functions/get-microsoft-recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ products: [...products] }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `API call failed (${response.status})`);
  }

  const data = await response.json();
  return data.content;
};

/* ═══════════════════════════════════════════════════════════════════
   TRACKER VIEW
   ═══════════════════════════════════════════════════════════════════ */
const TrackerView = ({ allRows, sortedMonths, typeMap }) => {
  const latestMonth = sortedMonths.length ? sortedMonths[sortedMonths.length - 1] : null;
  const [selMonths, setSelMonths]             = useState(() => latestMonth ? [latestMonth] : []);
  const [selPartner, setSelPartner]           = useState([]);
  const [selCustomer, setSelCustomer]         = useState([]);
  const [selProducts, setSelProducts]         = useState([]);
  const [selCountry, setSelCountry]           = useState([]);
  const [expandedCust, setExpandedCust]       = useState(new Set());
  const [expandedCountry, setExpandedCountry] = useState(new Set());
  const [expandedPartner, setExpandedPartner] = useState(new Set());
  const [aiModalOpen, setAIModalOpen]         = useState(false);
  const [aiCustomerName, setAICustomerName]   = useState("");
  const [aiProducts, setAIProducts]           = useState(new Set());
  const [aiLoading, setAILoading]             = useState(false);
  const [aiContent, setAIContent]             = useState("");
  const [aiFailed, setAIFailed]               = useState(false);
  const [sortCol, setSortCol]                 = useState(null);
  const [historyTarget, setHistoryTarget]     = useState(null);  // { cID, cNm, country }

  const parseValue = useCallback((v) => {
  const s = (v || "").toString().trim();
  const isAcctNeg = s.startsWith("(") && s.endsWith(")");
  const n = parseFloat(s.replace(/[^0-9.-]/g, "")) || 0;
  return isAcctNeg ? -n : n;
}, []);

  const historyData = useMemo(() => {
    if (!historyTarget) return null;
    const rows = allRows.filter(r =>
      (r["Customer ID"] || "").trim() === historyTarget.cID &&
      (((r["Country"] || "").trim()) || "Unknown") === historyTarget.country
    );
    const months = sortedMonths;
    const partners = {};
    for (const row of rows) {
      const pID  = (row["Partner ID"]   || "").trim() || "unknown";
      const pNm  = (row["Partner Name"] || "").trim() || "Unknown Partner";
      const prod = (row["Product"]      || "").trim() || "Blank";
      const m    = row._reportingMonth;
      if (!partners[pID]) partners[pID] = { name: pNm, products: {} };
      if (!partners[pID].products[prod]) partners[pID].products[prod] = {};
      if (!partners[pID].products[prod][m]) partners[pID].products[prod][m] = { type: typeMap[row._id] || "new", value: 0 };
      partners[pID].products[prod][m].value += parseValue(row["Value"]);
    }
    return { months, partners };
  }, [historyTarget, allRows, typeMap, parseValue, sortedMonths]);

  const getCacheKey = (cNm, products) => "ai:" + cNm + "||" + [...products].sort().join(",");

  const openAIModal = useCallback(async (cNm, products) => {
    setAICustomerName(cNm);
    setAIProducts(products);
    setAIFailed(false);
    setAIModalOpen(true);
    setAILoading(true);
    setAIContent("");
    const cacheKey = getCacheKey(cNm, products);
    const cached = await psGet(cacheKey);
    if (cached) {
      setAIContent(cached);
      setAILoading(false);
      return;
    }
    callClaudeAPI(products)
      .then((content) => { setAIContent(content); psSet(cacheKey, content); })
      .catch((err) => { console.error("[CloudRe] AI:", err); setAIFailed(true); })
      .finally(() => setAILoading(false));
  }, []);

  const onAnalyzeAgain = useCallback(() => {
    const cacheKey = getCacheKey(aiCustomerName, aiProducts);
    setAILoading(true);
    setAIContent("");
    setAIFailed(false);
    callClaudeAPI(aiProducts)
      .then((content) => { setAIContent(content); psSet(cacheKey, content); })
      .catch((err) => { console.error("[CloudRe] AI:", err); setAIFailed(true); })
      .finally(() => setAILoading(false));
  }, [aiCustomerName, aiProducts]);

  const [sortDir, setSortDir]           = useState("desc");
  const [partnerPage, setPartnerPage]   = useState(0);

  const prevLatestRef = useRef(latestMonth);
  useEffect(() => {
    if (latestMonth && latestMonth !== prevLatestRef.current) {
      prevLatestRef.current = latestMonth;
      setSelMonths([latestMonth]);
    }
  }, [latestMonth]);

  const effectiveMonths = useMemo(
    () => selMonths.length ? selMonths : (latestMonth ? [latestMonth] : []),
    [selMonths, latestMonth]
  );

  const priorYearMonths = useMemo(() => {
    const mapped = effectiveMonths.map(ym => { const [y, m] = ym.split("-").map(Number); return `${y - 1}-${String(m).padStart(2, "0")}`; });
    return mapped.every(ym => sortedMonths.includes(ym)) ? mapped : [];
  }, [effectiveMonths, sortedMonths]);

  const monthRows = useMemo(() =>
    allRows.filter(r => effectiveMonths.includes(r._reportingMonth)),
    [allRows, effectiveMonths]
  );

  /* ── Cascading valid sets ── */
  const validForPartner = useMemo(() => {
    const f = monthRows.filter(r =>
      (!selCustomer.length || selCustomer.includes((r["Customer ID"] || "").trim())) &&
      (!selProducts.length || selProducts.includes((r["Product"]     || "").trim())) &&
      (!selCountry.length  || selCountry.includes((r["Country"]      || "").trim()))
    );
    return new Set(f.map(r => (r["Partner ID"] || "").trim()).filter(Boolean));
  }, [monthRows, selCustomer, selProducts, selCountry]);

  const validForCustomer = useMemo(() => {
    const f = monthRows.filter(r =>
      (!selPartner.length  || selPartner.includes((r["Partner ID"]   || "").trim())) &&
      (!selProducts.length || selProducts.includes((r["Product"]     || "").trim())) &&
      (!selCountry.length  || selCountry.includes((r["Country"]      || "").trim()))
    );
    return new Set(f.map(r => (r["Customer ID"] || "").trim()).filter(Boolean));
  }, [monthRows, selPartner, selProducts, selCountry]);

  const validForProduct = useMemo(() => {
    const f = monthRows.filter(r =>
      (!selPartner.length  || selPartner.includes((r["Partner ID"]   || "").trim())) &&
      (!selCustomer.length || selCustomer.includes((r["Customer ID"] || "").trim())) &&
      (!selCountry.length  || selCountry.includes((r["Country"]      || "").trim()))
    );
    return new Set(f.map(r => (r["Product"] || "").trim()).filter(Boolean));
  }, [monthRows, selPartner, selCustomer, selCountry]);

  const validForCountry = useMemo(() => {
    const f = monthRows.filter(r =>
      (!selPartner.length  || selPartner.includes((r["Partner ID"]   || "").trim())) &&
      (!selCustomer.length || selCustomer.includes((r["Customer ID"] || "").trim())) &&
      (!selProducts.length || selProducts.includes((r["Product"]     || "").trim()))
    );
    return new Set(f.map(r => (r["Country"] || "").trim()).filter(Boolean));
  }, [monthRows, selPartner, selCustomer, selProducts]);

  /* months valid for current non-month filters — computed over ALL rows */
  const validForMonth = useMemo(() => {
    const f = allRows.filter(r =>
      (!selPartner.length  || selPartner.includes((r["Partner ID"]   || "").trim())) &&
      (!selCustomer.length || selCustomer.includes((r["Customer ID"] || "").trim())) &&
      (!selProducts.length || selProducts.includes((r["Product"]     || "").trim())) &&
      (!selCountry.length  || selCountry.includes((r["Country"]      || "").trim()))
    );
    return new Set(f.map(r => r._reportingMonth).filter(Boolean));
  }, [allRows, selPartner, selCustomer, selProducts, selCountry]);

  /* never allow an empty month selection — revert to most recent VALID month */
  const handleMonthsChange = useCallback((next) => {
    if (next.length) { setSelMonths(next); return; }
    const validList = sortedMonths.filter(m => validForMonth.has(m));
    const fallback  = validForMonth.has(latestMonth) ? latestMonth : (validList[validList.length - 1] || latestMonth);
    setSelMonths(fallback ? [fallback] : []);
  }, [sortedMonths, validForMonth, latestMonth]);

  /* ── Filter options ── */
  const partnerOptions = useMemo(() => {
    const all = {};
    for (const r of allRows) {
      const id = (r["Partner ID"] || "").trim(), name = (r["Partner Name"] || "").trim();
      if (id) all[id] = name || id;
    }
    return Object.entries(all).sort(([,a],[,b]) => a.localeCompare(b))
      .map(([id, name]) => ({ value: id, label: name, disabled: !validForPartner.has(id) }));
  }, [monthRows, validForPartner]);

  const customerOptions = useMemo(() => {
    const all = {};
    for (const r of allRows) {
      const id = (r["Customer ID"] || "").trim(), name = (r["Customer Name"] || "").trim();
      if (id) all[id] = name || id;
    }
    return Object.entries(all).sort(([,a],[,b]) => a.localeCompare(b))
      .map(([id, name]) => ({ value: id, label: name, disabled: !validForCustomer.has(id) }));
  }, [monthRows, validForCustomer]);

  const productOptions = useMemo(() => {
    const all = [...new Set(allRows.map(r => (r["Product"] || "").trim()).filter(Boolean))].sort();
    return all.map(p => ({ value: p, label: p, disabled: !validForProduct.has(p) }));
  }, [monthRows, validForProduct]);

  const countryOptions = useMemo(() => {
    const all = [...new Set(allRows.map(r => (r["Country"] || "").trim()).filter(Boolean))].sort();
    return all.map(c => ({ value: c, label: c, disabled: !validForCountry.has(c) }));
  }, [monthRows, validForCountry]);

  /* ── Aggregate ── */
  const aggregate = useCallback((months, partnerFilter, customerFilter, prodFilter, countryFilter, totalsOnly = false) => {
    const empty = { byCustomer: {}, totals: { upsell: 0, crosssell: 0, new: 0, total: 0 } };
    if (!months || !months.length) return empty;
    const rows = allRows.filter(r => {
      if (!months.includes(r._reportingMonth)) return false;
      if (partnerFilter.length  && !partnerFilter.includes((r["Partner ID"]   || "").trim())) return false;
      if (customerFilter.length && !customerFilter.includes((r["Customer ID"] || "").trim())) return false;
      if (prodFilter.length     && !prodFilter.includes((r["Product"]         || "").trim())) return false;
      if (countryFilter.length  && !countryFilter.includes((r["Country"]      || "").trim())) return false;
      return true;
    });
    const byCustomer = {}, totals = { upsell: 0, crosssell: 0, new: 0, total: 0 };
    for (const row of rows) {
      const type    = typeMap[row._id] || "new";
      const val     = parseValue(row["Value"]);
      totals[type] += val; totals.total += val;
      if (totalsOnly) continue;
      const cID     = (row["Customer ID"]   || "").trim() || "unknown";
      const cNm     = (row["Customer Name"] || "").trim() || "Unknown Customer";
      const country = (row["Country"]       || "").trim() || "Unknown";
      const pID     = (row["Partner ID"]    || "").trim() || "unknown";
      const pNm     = (row["Partner Name"]  || "").trim() || "Unknown Partner";
      const prod    = (row["Product"]       || "").trim();
      if (!byCustomer[cID]) byCustomer[cID] = { name: cNm, upsell: 0, crosssell: 0, new: 0, total: 0, countries: {} };
      byCustomer[cID][type] += val; byCustomer[cID].total += val;
      if (!byCustomer[cID].countries[country]) byCustomer[cID].countries[country] = { upsell: 0, crosssell: 0, new: 0, total: 0, partners: {} };
      byCustomer[cID].countries[country][type] += val; byCustomer[cID].countries[country].total += val;
      if (!byCustomer[cID].countries[country].partners[pID]) byCustomer[cID].countries[country].partners[pID] = { name: pNm, upsell: 0, crosssell: 0, new: 0, total: 0, productBreakdown: {} };
      byCustomer[cID].countries[country].partners[pID][type] += val; byCustomer[cID].countries[country].partners[pID].total += val;
      if (prod) {
        const pb = byCustomer[cID].countries[country].partners[pID].productBreakdown;
        if (!pb[prod]) pb[prod] = { upsell: 0, crosssell: 0, new: 0, total: 0 };
        pb[prod][type] += val; pb[prod].total += val;
      }
    }
    return { byCustomer, totals };
  }, [allRows, typeMap, parseValue]);

  const { byCustomer: currentCustomers, totals: currentTotals } = useMemo(
    () => aggregate(effectiveMonths, selPartner, selCustomer, selProducts, selCountry),
    [aggregate, effectiveMonths, selPartner, selCustomer, selProducts, selCountry]
  );
  const { totals: priorTotals } = useMemo(
    () => priorYearMonths.length ? aggregate(priorYearMonths, selPartner, selCustomer, selProducts, selCountry, true) : { totals: null },
    [aggregate, priorYearMonths, selPartner, selCustomer, selProducts, selCountry]
  );

  /* ── All-time lifecycle data (per customer per country) ── */
  const customerLifecycleData = useMemo(() => {
    const m = {};
    for (const row of allRows) {
      const cID     = (row["Customer ID"]  || "").trim();
      const country = (row["Country"]      || "").trim() || "Unknown";
      const pNm     = (row["Partner Name"] || "").trim();
      const prod    = (row["Product"]      || "").trim();
      if (!cID) continue;
      if (!m[cID]) m[cID] = {};
      if (!m[cID][country]) m[cID][country] = { partners: new Set(), products: new Set() };
      if (pNm)  m[cID][country].partners.add(pNm);
      if (prod) m[cID][country].products.add(prod);
    }
    return m;
  }, [allRows]);

  const toggleSort = useCallback((col) => {
    if (sortCol === col) { if (sortDir === "desc") setSortDir("asc"); else { setSortCol(null); setSortDir("desc"); } }
    else { setSortCol(col); setSortDir("desc"); }
    setExpandedCust(new Set()); setExpandedCountry(new Set()); setExpandedPartner(new Set()); setPartnerPage(0);
  }, [sortCol, sortDir]);

  const toggleExpand        = useCallback((cID) => setExpandedCust(prev => { const n = new Set(prev); n.has(cID) ? n.delete(cID) : n.add(cID); return n; }), []);
  const toggleExpandCountry = useCallback((cID, country) => { const k = cID+"|||"+country; setExpandedCountry(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; }); }, []);
  const toggleExpandPartner = useCallback((cID, country, pID) => { const k = cID+"|||"+country+"|||"+pID; setExpandedPartner(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; }); }, []);

  const customerNames = useMemo(() => {
    const ids = Object.keys(currentCustomers);
    return sortCol
      ? [...ids].sort((a, b) => {
          const ca = currentCustomers[a], cb = currentCustomers[b];
          if (sortCol === "customer")  { const d = ca.name.toLowerCase().localeCompare(cb.name.toLowerCase()); return sortDir === "desc" ? d : -d; }
          let av, bv;
          if      (sortCol === "upsell")    { av = ca.upsell;     bv = cb.upsell;     }
          else if (sortCol === "crosssell") { av = ca.crosssell;  bv = cb.crosssell;  }
          else if (sortCol === "new")       { av = ca.new;        bv = cb.new;        }
          else if (sortCol === "total")     { av = ca.total;      bv = cb.total;      }
          else if (sortCol === "recap")     { av = recapRate(ca); bv = recapRate(cb); }
          return sortDir === "desc" ? (bv - av) : (av - bv);
        })
      : [...ids].sort((a, b) => currentCustomers[a].name.localeCompare(currentCustomers[b].name));
  }, [currentCustomers, sortCol, sortDir]);

  useEffect(() => { setPartnerPage(0); setExpandedCust(new Set()); setExpandedCountry(new Set()); setExpandedPartner(new Set()); }, [selPartner, selCustomer, selProducts, selCountry, selMonths]);

  const totalPartnerPages  = Math.max(1, Math.ceil(customerNames.length / PAGE_SIZE));
  const safePartnerPage    = Math.min(partnerPage, totalPartnerPages - 1);
  const pagedCustomerNames = customerNames.slice(safePartnerPage * PAGE_SIZE, (safePartnerPage + 1) * PAGE_SIZE);
  const uniquePartnerCount = useMemo(() => { const s = new Set(); Object.values(currentCustomers).forEach(cd => Object.values(cd.countries).forEach(ctd => Object.keys(ctd.partners).forEach(pID => s.add(pID)))); return s.size; }, [currentCustomers]);

  const hasFilters = (selMonths.length !== 1 || selMonths[0] !== latestMonth) || selPartner.length > 0 || selCustomer.length > 0 || selProducts.length > 0 || selCountry.length > 0 || sortCol !== null;

  const resetAll = useCallback(() => {
    setSelMonths(latestMonth ? [latestMonth] : []); setSelPartner([]); setSelCustomer([]); setSelProducts([]); setSelCountry([]);
    setSortCol(null); setSortDir("desc");
    setExpandedCust(new Set()); setExpandedCountry(new Set()); setExpandedPartner(new Set()); setPartnerPage(0);
  }, [latestMonth]);

  return (
    <div>
      <KPICards totals={currentTotals} priorTotals={priorTotals}/>

      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-2">
          <FYMonthFilter values={selMonths} onChange={handleMonthsChange} allMonths={sortedMonths} validMonths={validForMonth} />
          <div className="flex-1 min-w-0"><MultiSel values={selCustomer} onChange={v => { setSelCustomer(v); setPartnerPage(0); }}              options={customerOptions} placeholder="Customer" searchable/></div>
          <div className="flex-1 min-w-0"><MultiSel values={selCountry}  onChange={setSelCountry}                                               options={countryOptions}  placeholder="Country"/></div>
          <div className="flex-1 min-w-0"><MultiSel values={selPartner}  onChange={v => { setSelPartner(v);  setPartnerPage(0); }}              options={partnerOptions}  placeholder="Partner"  searchable/></div>
          <div className="flex-1 min-w-0"><MultiSel values={selProducts} onChange={setSelProducts}                                              options={productOptions}  placeholder="Product"/></div>
          <button onClick={resetAll} disabled={!hasFilters}
            className={"h-[36px] px-4 text-xs font-medium rounded-lg border transition flex-shrink-0 whitespace-nowrap " + (hasFilters ? "text-red-500 border-red-200 hover:bg-red-50" : "text-gray-300 border-gray-200 cursor-not-allowed")}>
            Reset All Filters
          </button>
        </div>
      </div>

      {/* Table */}
      {customerNames.length === 0
        ? <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-sm text-gray-500">No data for selected filters</p>
          </div>
        : <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">

            {/* Meta row */}
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>{allRows.length.toLocaleString()} rows imported</span>
                <span className="text-gray-300 text-sm select-none">|</span>
                <span>{customerNames.length.toLocaleString()} unique customer{customerNames.length !== 1 ? "s" : ""}</span>
                <span className="text-gray-300 text-sm select-none">|</span>
                <span>{uniquePartnerCount.toLocaleString()} unique partner{uniquePartnerCount !== 1 ? "s" : ""}</span>
              </div>
              {totalPartnerPages > 1 && (
                <div className="flex items-center">
                  {[
                    ["First", () => setPartnerPage(0),                                            safePartnerPage === 0],
                    null,
                    ["Back",  () => setPartnerPage(p => Math.max(0, p - 1)),                      safePartnerPage === 0],
                    null,
                    [`${safePartnerPage + 1} / ${totalPartnerPages}`, null, false],
                    null,
                    ["Next",  () => setPartnerPage(p => Math.min(totalPartnerPages - 1, p + 1)), safePartnerPage >= totalPartnerPages - 1],
                    null,
                    ["Last",  () => setPartnerPage(totalPartnerPages - 1),                        safePartnerPage >= totalPartnerPages - 1],
                  ].map((item, i) =>
                    item === null
                      ? <span key={i} className="text-gray-300 mx-1">·</span>
                      : item[1]
                        ? <button key={i} onClick={() => { item[1](); setExpandedCust(new Set()); setExpandedCountry(new Set()); setExpandedPartner(new Set()); }} disabled={item[2]}
                            className={"px-2 py-1 text-xs font-medium transition " + (item[2] ? "text-gray-300 cursor-not-allowed" : "text-gray-500 hover:text-gray-700")}>
                            {item[0]}
                          </button>
                        : <span key={i} className="px-2 py-1 text-xs font-medium text-gray-500">{item[0]}</span>
                  )}
                </div>
              )}
            </div>

            {/* Column headers */}
            <div className="grid items-center px-4 py-2.5 bg-gray-50 border-b border-gray-200" style={{gridTemplateColumns: GRID, ...GAP}}>
              <span></span>
              <span/>
              <span/>
              <SortTh col="new"       label="New"        sortCol={sortCol} onSort={toggleSort} right/>
              <SortTh col="upsell"    label="Upsell"     sortCol={sortCol} onSort={toggleSort} right/>
              <SortTh col="crosssell" label="Cross-sell" sortCol={sortCol} onSort={toggleSort} right/>
              <SortTh col="total"     label="Total"      sortCol={sortCol} onSort={toggleSort} right/>
              <SortTh col="recap"     label="Recapture"  sortCol={sortCol} onSort={toggleSort} right/>
            </div>

            {/* Customer rows */}
            {pagedCustomerNames.map((cID, ci) => {
              const cd          = currentCustomers[cID];
              const isExp       = expandedCust.has(cID);
              const rate        = recapRate(cd);
              const countryKeys = Object.keys(cd.countries).sort();
              return (
                <div key={cID} className={ci > 0 ? "border-t border-gray-200" : ""}>

                  {/* Customer row */}
                  <div onClick={() => toggleExpand(cID)} className="grid items-center px-4 py-3 cursor-pointer hover:bg-gray-50 transition select-none" style={{gridTemplateColumns: GRID, ...GAP}}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className={"transition-transform flex-shrink-0 " + (isExp ? "rotate-90" : "")}><path d="M9 18l6-6-6-6"/></svg>
                      <div className="w-[18px] h-[18px] rounded bg-emerald-50 flex items-center justify-center flex-shrink-0">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/></svg>
                      </div>
                      <span className="text-xs font-medium text-gray-800 truncate" title={cd.name}>{cd.name}</span>
                    </div>
                    <div className="flex items-center justify-end"><CntBadge label={`${countryKeys.length} countr${countryKeys.length !== 1 ? "ies" : "y"}`}/></div>
                    <div className="flex items-center justify-end"><IDBadge id={cID}/></div>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtVal(cd.new)}</span>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtVal(cd.upsell)}</span>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtVal(cd.crosssell)}</span>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtVal(cd.total)}</span>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtPct(rate)}</span>
                  </div>

                  {/* Country rows */}
                  {isExp && countryKeys.map((country) => {
                    const ctd         = cd.countries[country];
                    const ctKey       = cID + "|||" + country;
                    const isExpC      = expandedCountry.has(ctKey);
                    const partnerKeys = Object.keys(ctd.partners).sort();
                    const ctRate      = recapRate(ctd);
                    return (
                      <React.Fragment key={ctKey}>

                        {/* Country row */}
                        <div onClick={e => { e.stopPropagation(); toggleExpandCountry(cID, country); }}
                          className="grid items-center px-4 py-2.5 border-t border-dashed border-gray-200 cursor-pointer hover:bg-orange-50/20 transition select-none"
                          style={{gridTemplateColumns: GRID, ...GAP}}>
                          <div className="flex items-center gap-1.5 min-w-0" style={{marginLeft:"16px"}}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className={"transition-transform flex-shrink-0 " + (isExpC ? "rotate-90" : "")}><path d="M9 18l6-6-6-6"/></svg>
                            <div className="w-[16px] h-[16px] rounded bg-orange-50 flex items-center justify-center flex-shrink-0">
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                            </div>
                            <span className="text-xs font-medium text-gray-700 truncate" title={country}>{country}</span>
                          </div>
                          <div className="flex items-center justify-end"><CntBadge label={`${partnerKeys.length} partner${partnerKeys.length !== 1 ? "s" : ""}`}/></div>
                          <div className="flex items-center justify-end">
                            <button onClick={e => { e.stopPropagation(); setHistoryTarget({ cID, cNm: cd.name, country }); }}
                              className="inline-flex items-center px-2 h-[20px] rounded border border-indigo-200 bg-indigo-50 text-[10px] font-medium text-indigo-600 hover:bg-indigo-100 hover:border-indigo-300 transition whitespace-nowrap">
                              View History
                            </button>
                          </div>
                          <span className="text-xs text-gray-700 text-right">{ctd.new       !== 0 ? fmtVal(ctd.new)       : <Dash/>}</span>
                          <span className="text-xs text-gray-700 text-right">{ctd.upsell    !== 0 ? fmtVal(ctd.upsell)    : <Dash/>}</span>
                          <span className="text-xs text-gray-700 text-right">{ctd.crosssell !== 0 ? fmtVal(ctd.crosssell) : <Dash/>}</span>
                          <span className="text-xs text-gray-700 text-right">{fmtVal(ctd.total)}</span>
                          <span className="text-xs text-gray-700 text-right">{fmtPct(ctRate)}</span>
                        </div>

                        {/* Partner rows */}
                        {isExpC && partnerKeys.map((pID) => {
                          const pd       = ctd.partners[pID];
                          const pKey     = ctKey + "|||" + pID;
                          const isExpP   = expandedPartner.has(pKey);
                          const prodKeys = Object.keys(pd.productBreakdown).sort();
                          const pRate    = recapRate(pd);
                          return (
                            <React.Fragment key={pKey}>

                              {/* Partner row */}
                              <div onClick={e => { e.stopPropagation(); toggleExpandPartner(cID, country, pID); }}
                                className="grid items-center px-4 py-2.5 border-t border-dashed border-gray-200 cursor-pointer hover:bg-blue-50/20 transition select-none"
                                style={{gridTemplateColumns: GRID, ...GAP}}>
                                <div className="flex items-center gap-1.5 min-w-0" style={{marginLeft:"32px"}}>
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className={"transition-transform flex-shrink-0 " + (isExpP ? "rotate-90" : "")}><path d="M9 18l6-6-6-6"/></svg>
                                  <div className="w-[16px] h-[16px] rounded bg-blue-50 flex items-center justify-center flex-shrink-0">
                                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2"><path d="M3 21h18M3 7l9-4 9 4M4 7v14M20 7v14M9 21V11h6v10"/></svg>
                                  </div>
                                  <span className="text-xs font-medium text-gray-700 truncate" title={pd.name}>{pd.name}</span>
                                </div>
                                <div className="flex items-center justify-end"><CntBadge label={`${prodKeys.length} product${prodKeys.length !== 1 ? "s" : ""}`}/></div>
                                <div className="flex items-center justify-end"><IDBadge id={pID}/></div>
                                <span className="text-xs text-gray-700 text-right">{pd.new       !== 0 ? fmtVal(pd.new)       : <Dash/>}</span>
                                <span className="text-xs text-gray-700 text-right">{pd.upsell    !== 0 ? fmtVal(pd.upsell)    : <Dash/>}</span>
                                <span className="text-xs text-gray-700 text-right">{pd.crosssell !== 0 ? fmtVal(pd.crosssell) : <Dash/>}</span>
                                <span className="text-xs text-gray-700 text-right">{fmtVal(pd.total)}</span>
                                <span className="text-xs text-gray-700 text-right">{fmtPct(pRate)}</span>
                              </div>

                              {/* Product rows */}
                              {isExpP && prodKeys.map(product => {
                                const prd = pd.productBreakdown[product];
                                return (
                                  <div key={product} className="grid items-center px-4 py-2 bg-gray-50/70 border-t border-dotted border-gray-200" style={{gridTemplateColumns: GRID, ...GAP}}>
                                    <div className="flex items-center gap-1.5 min-w-0" style={{marginLeft:"48px"}}>
                                      <span className="w-[11px] flex-shrink-0"/>
                                      <div className="w-[16px] h-[16px] rounded bg-violet-50 flex items-center justify-center flex-shrink-0">
                                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
                                      </div>
                                      <Badge text={product} className={hashProductColor(product)}/>
                                    </div>
                                    <span/><span/>
                                    {["new","upsell","crosssell"].map(t => (
                                      <span key={t} className="text-xs text-gray-600 text-right">{prd[t] !== 0 ? fmtVal(prd[t]) : <Dash/>}</span>
                                    ))}
                                    <span className="text-xs font-medium text-gray-700 text-right">{fmtVal(prd.total)}</span>
                                    <span className="text-right"><Dash/></span>
                                  </div>
                                );
                              })}
                            </React.Fragment>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })}
          </div>
      }
      <HistoryModal
        open={!!historyTarget}
        customerName={historyTarget?.cNm || ""}
        country={historyTarget?.country || ""}
        data={historyData}
        onClose={() => setHistoryTarget(null)}
        onAskAI={() => {
          const products = customerLifecycleData[historyTarget.cID]?.[historyTarget.country]?.products || new Set();
          openAIModal(historyTarget.cNm + " — " + historyTarget.country, products);
        }}
      />
      <AIInsightsModal
        open={aiModalOpen}
        customerName={aiCustomerName}
        onClose={() => setAIModalOpen(false)}
        onAnalyzeAgain={onAnalyzeAgain}
        loading={aiLoading}
        content={aiContent}
        failed={aiFailed}
      />
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   ERROR BOUNDARY
   ═══════════════════════════════════════════════════════════════════ */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  handleReset = async () => {
    try { const db = await getIDB(); const tx = db.transaction("kv","readwrite"); tx.objectStore("kv").clear(); await new Promise(r => { tx.oncomplete = r; tx.onerror = r; }); } catch {}
    this.setState({ hasError: false });
    window.location.reload();
  };
  render() {
    if (this.state.hasError) return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center" style={{fontFamily:"'Inter',ui-sans-serif,sans-serif"}}>
        <div className="text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Something went wrong</h2>
          <p className="text-sm text-gray-500 mb-4">Reset the data to recover</p>
          <button onClick={this.handleReset} className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition">Reset & Reload</button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════════ */
function App() {
  const [allRows, setAllRows]                 = useState([]);
  const [dataLoaded, setDataLoaded]           = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadState, setUploadState]         = useState(null);
  const fileRef = useRef(null);

  const [isDesktop, setIsDesktop] = useState(() => typeof window !== "undefined" ? window.innerWidth >= MIN_DESKTOP : true);
  useEffect(() => {
    const h = () => setIsDesktop(window.innerWidth >= MIN_DESKTOP);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  /* ── Load persisted rows ── */
  useEffect(() => {
    setDataLoaded(false);
    (async () => {
      try {
        const idx    = await psGet("rows_idx") || [];
        const chunks = await Promise.all(idx.map(k => psGet("rows:" + k)));
        setAllRows(chunks.flat().filter(Boolean));
      } catch { setAllRows([]); }
      setDataLoaded(true);
    })();
  }, []);

  /* ── Persist rows (chunked by month) ── */
  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(async () => {
      const byM = {};
      for (const row of allRows) {
        const k = row._reportingMonth || "unknown";
        if (!byM[k]) byM[k] = [];
        byM[k].push(row);
      }
      const ks    = Object.keys(byM);
      const oldIdx = await psGet("rows_idx") || [];
      for (const k of oldIdx) { if (!ks.includes(k)) await psDel("rows:" + k); }
      for (const k of ks) await psSet("rows:" + k, byM[k]);
      await psSet("rows_idx", ks);
    }, 300);
    return () => clearTimeout(t);
  }, [allRows, dataLoaded]);

  /* ── Derived ── */
  const sortedMonths = useMemo(() =>
    [...new Set(allRows.map(r => r._reportingMonth).filter(Boolean))].sort(),
    [allRows]
  );

  const typeMap = useMemo(() => buildTypeMap(allRows, sortedMonths), [allRows, sortedMonths]);

  /* ── Upload handler ── */
  const handleUpload = useCallback(async (files) => {
    if (!files || !files.length) return;
    const fileList = [...files];
    setUploadState({ status: "uploading" });
    try {
      await new Promise(r => setTimeout(r, 40));

      /* ── Phase 1: parse + validate ALL files (all-or-nothing) ── */
      const parsed = [];
      for (const file of fileList) {
        console.log("[CloudRe] Upload started:", file.name, `(${(file.size / 1024).toFixed(1)} KB)`);
        const raw = await parseCsv(file);
        console.log("[CloudRe]", file.name, "— parsed rows:", raw.length, "· Detected headers:", Object.keys(raw[0] || {}).join(", "));
        const { valid, message } = validateCsv(raw);
        if (!valid) {
          console.warn("[CloudRe]", file.name, "— validation failed:", message, "· Expected columns:", REQUIRED_COLS.join(", "));
          console.warn("[CloudRe] All-or-nothing: nothing was imported");
          setUploadState({ status: "error" });
          return;
        }
        parsed.push({ name: file.name, raw });
      }

      /* ── Phase 2: normalize + import ── */
      const isBlank = v => !v.trim() || ["na","n/a","#n/a","#na"].includes(v.trim().toLowerCase());
      const STRICT_COLS = REQUIRED_COLS.filter(c => c !== "amount" && c !== "SubscriptionName");
      let batchRows = [];
      let totalSkipped = 0;

      for (const { name, raw } of parsed) {
        const clean   = raw.filter(r => STRICT_COLS.every(c => !isBlank(r[c] || "")));
        const skipped = raw.length - clean.length;
        totalSkipped += skipped;
        if (skipped > 0) {
          const skippedRows = raw.filter(r => !STRICT_COLS.every(c => !isBlank(r[c] || "")));
          console.warn("[CloudRe]", name, "— skipped", skipped, "row(s) — blank or invalid required fields:");
          skippedRows.slice(0, 10).forEach((r, i) => {
            const blankFields = STRICT_COLS.filter(c => isBlank(r[c] || ""));
            console.warn(`  [Row ${i + 1}] Blank fields: ${blankFields.join(", ")} →`, JSON.stringify(r));
          });
          if (skipped > 10) console.warn(`  … and ${skipped - 10} more. First 10 shown above.`);
        }

        const normalized = clean.map(r => ({
          "Date":          (r["InvoiceDate"]     || "").trim(),
          "Customer Name": (r["EndCustomer"]      || "").trim(),
          "Customer ID":   (r["custid"]           || "").trim(),
          "Partner Name":  extractPartnerName(r["partnername"]),
          "Partner ID":    extractPartnerID(r["partnername"]),
          "Product":       isBlank(r["SubscriptionName"] || "") ? "Blank" : (r["SubscriptionName"] || "").trim(),
          "Value":         ((r["amount"]           || "").trim() || "0"),
          "Country":       extractCountry(r["storeid"]),
        }));
        console.log("[CloudRe]", name, "— normalized sample row:", normalized[0]);

        const uploadStamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        const newRows = normalized.map((r, i) => ({
          ...r,
          _reportingMonth: getMonthKey(r["Date"]),
          _id: uploadStamp + "-" + i,
        })).filter(r => r._reportingMonth);

        const unparsedDates = normalized.length - newRows.length;
        if (unparsedDates > 0) console.warn("[CloudRe]", name, "— rows dropped, could not parse date value:", unparsedDates, "· Sample date values:", [...new Set(normalized.map(r => r["Date"]))].slice(0, 5));

        if (!newRows.length) {
          console.warn("[CloudRe]", name, "— no valid rows remaining after filtering. All-or-nothing: nothing was imported");
          setUploadState({ status: "error" });
          return;
        }

        const newMonths = [...new Set(newRows.map(r => r._reportingMonth))];
        console.log("[CloudRe]", name, "— months detected:", newMonths.map(fmtMonthKey).join(", "));

        /* within the batch, a later file replaces overlapping months from earlier files */
        batchRows = [...batchRows.filter(r => !newMonths.includes(r._reportingMonth)), ...newRows];
      }

      await new Promise(r => setTimeout(r, 80));

      const batchMonths = [...new Set(batchRows.map(r => r._reportingMonth))];
      setAllRows(prev => [...prev.filter(r => !batchMonths.includes(r._reportingMonth)), ...batchRows]);

      console.log("[CloudRe] Upload complete —", batchRows.length, "rows ·", batchMonths.length, "month(s) ·", fileList.length, "file(s)");
      setUploadState({ status: "success", imported: batchRows.length, skipped: totalSkipped });

    } catch (err) {
      console.error("[CloudRe] Upload error:", err);
      setUploadState({ status: "error" });
    }
  }, []);

  /* ── Clear all ── */
  const clearAll = useCallback(async () => {
    setAllRows([]); setUploadState(null);
    try {
      const db = await getIDB();
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").clear();
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch {}
  }, []);

  const closeModal = useCallback(() => {
    setUploadModalOpen(false);
    setUploadState(null);
  }, []);

  const hasData = allRows.length > 0;

  useEffect(() => {
    if (dataLoaded && !hasData) setUploadModalOpen(true);
  }, [dataLoaded, hasData]);

  /* ── Guard: desktop only ── */
  if (!isDesktop) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center" style={{fontFamily:"'Inter',ui-sans-serif,sans-serif"}}>
      <p className="text-sm text-gray-500">Cloud Re is available on desktop only</p>
    </div>
  );

  /* ── Guard: loading ── */
  if (!dataLoaded) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center" style={{fontFamily:"'Inter',ui-sans-serif,sans-serif"}}>
      <Dots />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50" style={{fontFamily:"'Inter',ui-sans-serif,sans-serif"}}>
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-600 to-violet-700 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/>
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 leading-tight tracking-tight">Cloud Re</h1>
              <p className="text-xs text-gray-400">Customer recapture tracker</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setUploadModalOpen(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap h-[32px] bg-blue-50 text-blue-600 hover:bg-blue-100">
              Upload Data
            </button>
            <button onClick={clearAll} disabled={!hasData}
              className={"px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap h-[32px] " + (!hasData ? "text-gray-300 bg-gray-100 cursor-not-allowed" : "text-red-600 bg-red-50 hover:bg-red-100")}>
              Clear All Data
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {hasData && <TrackerView allRows={allRows} sortedMonths={sortedMonths} typeMap={typeMap}/>}
      </div>

      {uploadModalOpen && (
        <UploadModal
          uploadState={uploadState}
          handleUpload={handleUpload}
          hasData={hasData}
          onClose={closeModal}
          fileRef={fileRef}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════ */
export default function CloudRe() {
  return <ErrorBoundary><App/></ErrorBoundary>;
}