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
  const seenCustomers = new Set();  // customer IDs seen in any prior month
  const custProducts  = {};         // customerID → Set<product> ever bought
  const typeMap = {};
  for (const month of sortedMonths) {
    const rows  = byMonth[month] || [];
    const toAdd = [];
    for (const row of rows) {
      const custID = (row["Customer ID"] || "").trim();
      const prod   = (row["Product"]     || "").trim();
      if (!custID) { typeMap[row._id] = "new"; continue; }
      if (!seenCustomers.has(custID)) {
        typeMap[row._id] = "new";
      } else if (prod && custProducts[custID]?.has(prod)) {
        typeMap[row._id] = "upsell";
      } else {
        typeMap[row._id] = "crosssell";
      }
      toAdd.push([custID, prod]);
    }
    for (const [k, p] of toAdd) {
      seenCustomers.add(k);
      if (!custProducts[k]) custProducts[k] = new Set();
      if (p) custProducts[k].add(p);
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
  { key: "upsell",    label: "Upsell",     iconEl: KPI_ICONS.upsell,    border: "#10b981", iconBg: "#f0fdf4", pill: { bg: "#f0fdf4", text: "#166534", border: "#bbf7d0" } },
  { key: "crosssell", label: "Cross-sell", iconEl: KPI_ICONS.crosssell, border: "#3b82f6", iconBg: "#eff6ff", pill: { bg: "#eff6ff", text: "#1e40af", border: "#bfdbfe" } },
  { key: "new",       label: "New",        iconEl: KPI_ICONS.new,       border: "#7c3aed", iconBg: "#f5f3ff", pill: { bg: "#f5f3ff", text: "#4c1d95", border: "#ddd6fe" } },
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
            {prior != null && <span className="text-[10px] text-gray-400">vs prior year</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

const FYMonthFilter = ({ values, onChange, allMonths }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutsideClose(ref, open, setOpen);

  const fyTree = useMemo(() => {
    const groups = {};
    for (const ym of allMonths) {
      const fy = getFY(ym);
      if (!groups[fy]) groups[fy] = [];
      groups[fy].push(ym);
    }
    for (const fy in groups) groups[fy].sort((a, b) => b.localeCompare(a));
    return Object.entries(groups).sort(([a],[b]) => b - a).map(([fy, months]) => ({ fy: Number(fy), months }));
  }, [allMonths]);

  const selSet = useMemo(() => new Set(values), [values]);
  const allOf  = (ms) => ms.length > 0 && ms.every(m => selSet.has(m));
  const someOf = (ms) => ms.some(m => selSet.has(m));
  const toggleFY    = (months) => { const next = new Set(selSet); if (allOf(months)) months.forEach(m => next.delete(m)); else months.forEach(m => next.add(m)); onChange([...next]); };
  const toggleMonth = (ym)     => { const next = new Set(selSet); next.has(ym) ? next.delete(ym) : next.add(ym); onChange([...next]); };

  const displayLabel = values.length === 0 ? "Latest month"
    : values.length === 1 ? fmtMonthKey(values[0])
    : `${values.length} months`;

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <div onClick={() => setOpen(!open)} className={"w-full px-2.5 py-1.5 text-sm border rounded-lg bg-white h-[36px] flex items-center gap-1 cursor-pointer " + (values.length > 0 ? "border-blue-400 hover:border-blue-500" : "border-gray-200 hover:border-blue-300")}>
        <span className={"flex-1 min-w-0 truncate " + (values.length > 0 ? "text-blue-600" : "text-gray-400")}>{displayLabel}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={values.length > 0 ? "#60a5fa" : "#9ca3af"} strokeWidth="2" className={"flex-shrink-0 transition-transform " + (open ? "rotate-180" : "")}><path d="M6 9l6 6 6-6"/></svg>
      </div>
      {open && (
        <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto" style={{ minWidth: "100%" }}>
          {fyTree.map(({ fy, months }) => {
            const fyChk = allOf(months), fySome = someOf(months), fyExp = fySome || fyChk;
            return (
              <div key={fy} className="border-b border-gray-100 last:border-b-0">
                <div className="flex items-center gap-2 hover:bg-gray-50" style={{ padding: "10px 12px" }}>
                  <Chk checked={fyChk} partial={fySome} onClick={() => toggleFY(months)} />
                  <span className="text-xs font-bold text-gray-800 cursor-pointer select-none" onClick={() => toggleFY(months)}>{getFYLabel(fy)}</span>
                </div>
                {fyExp && months.map(ym => {
                  const chk = selSet.has(ym);
                  return (
                    <div key={ym} className="flex items-center gap-2 hover:bg-gray-50 border-t border-dashed border-gray-200" style={{ padding: "10px 12px 10px 28px" }} onClick={() => toggleMonth(ym)}>
                      <Chk checked={chk} partial={false} onClick={(e) => { e.stopPropagation(); toggleMonth(ym); }} />
                      <span className="text-xs font-semibold text-gray-700 select-none">{fmtMonthKey(ym)}</span>
                    </div>
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
const GRID      = "minmax(180px, 2fr) 1fr 1fr 1fr 1fr 1fr 1fr 90px";
const GAP       = { gap: "16px" };

const SortTh = ({ col, label, right = false, sortCol, onSort }) => (
  <span className={"cursor-pointer select-none hover:text-gray-700 transition text-xs uppercase tracking-wider font-medium whitespace-nowrap " + (right ? "block text-right" : "")}
    onClick={() => onSort(col)} style={{ color: sortCol === col ? "#1d4ed8" : "#9ca3af" }}>{label}</span>
);

const IDBadge  = ({ id })    => <span className="inline-block px-1.5 py-px text-[10px] font-medium rounded border border-gray-200 bg-gray-50 text-gray-400 flex-shrink-0">{id}</span>;
const CntBadge = ({ label }) => <span className="inline-block px-1.5 py-px text-[10px] rounded border border-slate-200 bg-slate-100 text-slate-500 flex-shrink-0">{label}</span>;
const Dash     = ()          => <span className="text-gray-200 text-xs">—</span>;

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
          className="hidden"
          onChange={e => { handleUpload(e.target.files); if (fileRef.current) fileRef.current.value = ""; }}
        />

        <button
          onClick={() => { if (!st || st === "error") fileRef.current?.click(); }}
          disabled={st === "uploading" || st === "success"}
          className={"w-full h-10 rounded-lg text-sm font-medium mt-7 transition-opacity " + (st === "uploading" || st === "success" ? "bg-blue-600 text-white opacity-35 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700 cursor-pointer")}
        >
          Upload data
        </button>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   TRACKER VIEW
   ═══════════════════════════════════════════════════════════════════ */
const TrackerView = ({ allRows, sortedMonths, typeMap }) => {
  const latestMonth = sortedMonths.length ? sortedMonths[sortedMonths.length - 1] : null;
  const [selMonths, setSelMonths]       = useState(() => latestMonth ? [latestMonth] : []);
  const [selPartner, setSelPartner]     = useState([]);
  const [selCustomer, setSelCustomer]   = useState([]);
  const [selProducts, setSelProducts]   = useState([]);
  const [selCountry, setSelCountry]     = useState([]);
  const [expanded, setExpanded]         = useState(new Set());
  const [expandedCust, setExpandedCust] = useState(new Set());
  const [sortCol, setSortCol]           = useState(null);
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

  const priorYearMonths = useMemo(() =>
    effectiveMonths
      .map(ym => { const [y, m] = ym.split("-").map(Number); return `${y - 1}-${String(m).padStart(2, "0")}`; })
      .filter(ym => sortedMonths.includes(ym)),
    [effectiveMonths, sortedMonths]
  );

  const parseValue = useCallback((v) => parseFloat((v || "").toString().replace(/[^0-9.-]/g, "")) || 0, []);

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

  /* ── Filter options ── */
  const partnerOptions = useMemo(() => {
    const all = {};
    for (const r of monthRows) {
      const id = (r["Partner ID"] || "").trim(), name = (r["Partner Name"] || "").trim();
      if (id) all[id] = name || id;
    }
    return Object.entries(all).sort(([,a],[,b]) => a.localeCompare(b))
      .map(([id, name]) => ({ value: id, label: name, disabled: !validForPartner.has(id) }));
  }, [monthRows, validForPartner]);

  const customerOptions = useMemo(() => {
    const all = {};
    for (const r of monthRows) {
      const id = (r["Customer ID"] || "").trim(), name = (r["Customer Name"] || "").trim();
      if (id) all[id] = name || id;
    }
    return Object.entries(all).sort(([,a],[,b]) => a.localeCompare(b))
      .map(([id, name]) => ({ value: id, label: name, disabled: !validForCustomer.has(id) }));
  }, [monthRows, validForCustomer]);

  const productOptions = useMemo(() => {
    const all = [...new Set(monthRows.map(r => (r["Product"] || "").trim()).filter(Boolean))].sort();
    return all.map(p => ({ value: p, label: p, disabled: !validForProduct.has(p) }));
  }, [monthRows, validForProduct]);

  const countryOptions = useMemo(() => {
    const all = [...new Set(monthRows.map(r => (r["Country"] || "").trim()).filter(Boolean))].sort();
    return all.map(c => ({ value: c, label: c, disabled: !validForCountry.has(c) }));
  }, [monthRows, validForCountry]);

  /* ── Aggregate ── */
  const aggregate = useCallback((months, partnerFilter, customerFilter, prodFilter, countryFilter, totalsOnly = false) => {
    const empty = { byPartner: {}, totals: { upsell: 0, crosssell: 0, new: 0, total: 0 } };
    if (!months || !months.length) return empty;
    const rows = allRows.filter(r => {
      if (!months.includes(r._reportingMonth)) return false;
      if (partnerFilter.length  && !partnerFilter.includes((r["Partner ID"]   || "").trim())) return false;
      if (customerFilter.length && !customerFilter.includes((r["Customer ID"] || "").trim())) return false;
      if (prodFilter.length     && !prodFilter.includes((r["Product"]         || "").trim())) return false;
      if (countryFilter.length  && !countryFilter.includes((r["Country"]      || "").trim())) return false;
      return true;
    });
    const byPartner = {}, totals = { upsell: 0, crosssell: 0, new: 0, total: 0 };
    for (const row of rows) {
      const type = typeMap[row._id] || "new";
      const val  = parseValue(row["Value"]);
      totals[type] += val; totals.total += val;
      if (totalsOnly) continue;
      const pID  = (row["Partner ID"]    || "").trim() || "unknown";
      const pNm  = (row["Partner Name"]  || "").trim() || "Unknown Partner";
      const cID  = (row["Customer ID"]   || "").trim() || "unknown";
      const cNm  = (row["Customer Name"] || "").trim() || "Unknown Customer";
      const prod = (row["Product"] || "").trim();
      if (!byPartner[pID]) byPartner[pID] = { name: pNm, upsell: 0, crosssell: 0, new: 0, total: 0, customers: {} };
      byPartner[pID][type] += val; byPartner[pID].total += val;
      if (!byPartner[pID].customers[cID])
        byPartner[pID].customers[cID] = { name: cNm, upsell: 0, crosssell: 0, new: 0, total: 0, productBreakdown: {} };
      byPartner[pID].customers[cID][type] += val; byPartner[pID].customers[cID].total += val;
      if (prod) {
        const pb = byPartner[pID].customers[cID].productBreakdown;
        if (!pb[prod]) pb[prod] = { upsell: 0, crosssell: 0, new: 0, total: 0, type };
        pb[prod][type] += val; pb[prod].total += val;
      }
    }
    return { byPartner, totals };
  }, [allRows, typeMap, parseValue]);

  const { byPartner: currentPartners, totals: currentTotals } = useMemo(
    () => aggregate(effectiveMonths, selPartner, selCustomer, selProducts, selCountry),
    [aggregate, effectiveMonths, selPartner, selCustomer, selProducts, selCountry]
  );
  const { totals: priorTotals } = useMemo(
    () => priorYearMonths.length ? aggregate(priorYearMonths, selPartner, selCustomer, selProducts, selCountry, true) : { totals: null },
    [aggregate, priorYearMonths, selPartner, selCustomer, selProducts, selCountry]
  );

  /* ── All-time lifecycle data ── */
  const customerLifecycleData = useMemo(() => {
    const m = {};
    for (const row of allRows) {
      const cID  = (row["Customer ID"]  || "").trim();
      const pNm  = (row["Partner Name"] || "").trim();
      const prod = (row["Product"]      || "").trim();
      if (!cID) continue;
      if (!m[cID]) m[cID] = { partners: new Set(), products: new Set() };
      if (pNm)  m[cID].partners.add(pNm);
      if (prod) m[cID].products.add(prod);
    }
    return m;
  }, [allRows]);

  const toggleSort = useCallback((col) => {
    if (sortCol === col) { if (sortDir === "desc") setSortDir("asc"); else { setSortCol(null); setSortDir("desc"); } }
    else { setSortCol(col); setSortDir("desc"); }
    setExpanded(new Set()); setExpandedCust(new Set()); setPartnerPage(0);
  }, [sortCol, sortDir]);

  const toggleExpand     = useCallback((pID) => setExpanded(prev => { const n = new Set(prev); n.has(pID) ? n.delete(pID) : n.add(pID); return n; }), []);
  const toggleExpandCust = useCallback((pID, cID) => { const k = pID+"|||"+cID; setExpandedCust(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; }); }, []);

  const partnerNames = useMemo(() => {
    const ids = Object.keys(currentPartners);
    return sortCol
      ? [...ids].sort((a, b) => {
          const pa = currentPartners[a], pb = currentPartners[b];
          if (sortCol === "partner")   { const d = pa.name.toLowerCase().localeCompare(pb.name.toLowerCase()); return sortDir === "desc" ? d : -d; }
          let av, bv;
          if      (sortCol === "upsell")    { av = pa.upsell;     bv = pb.upsell;     }
          else if (sortCol === "crosssell") { av = pa.crosssell;  bv = pb.crosssell;  }
          else if (sortCol === "new")       { av = pa.new;        bv = pb.new;        }
          else if (sortCol === "total")     { av = pa.total;      bv = pb.total;      }
          else if (sortCol === "recap")     { av = recapRate(pa); bv = recapRate(pb); }
          return sortDir === "desc" ? (bv - av) : (av - bv);
        })
      : [...ids].sort((a, b) => currentPartners[a].name.localeCompare(currentPartners[b].name));
  }, [currentPartners, sortCol, sortDir]);

  useEffect(() => { setPartnerPage(0); setExpanded(new Set()); setExpandedCust(new Set()); }, [selPartner, selCustomer, selProducts, selCountry, selMonths]);

  const totalPartnerPages = Math.max(1, Math.ceil(partnerNames.length / PAGE_SIZE));
  const safePartnerPage   = Math.min(partnerPage, totalPartnerPages - 1);
  const pagedPartnerNames = partnerNames.slice(safePartnerPage * PAGE_SIZE, (safePartnerPage + 1) * PAGE_SIZE);
  const uniqueCustomerCount = useMemo(() => Object.values(currentPartners).reduce((s, pd) => s + Object.keys(pd.customers).length, 0), [currentPartners]);

  const hasFilters = (selMonths.length !== 1 || selMonths[0] !== latestMonth) || selPartner.length > 0 || selCustomer.length > 0 || selProducts.length > 0 || selCountry.length > 0 || sortCol !== null;

  const resetAll = useCallback(() => {
    setSelMonths(latestMonth ? [latestMonth] : []); setSelPartner([]); setSelCustomer([]); setSelProducts([]); setSelCountry([]);
    setSortCol(null); setSortDir("desc");
    setExpanded(new Set()); setExpandedCust(new Set()); setPartnerPage(0);
  }, [latestMonth]);

  return (
    <div>
      <KPICards totals={currentTotals} priorTotals={priorTotals}/>

      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-2">
          <FYMonthFilter values={selMonths} onChange={v => { setSelMonths(v); setExpanded(new Set()); setExpandedCust(new Set()); setPartnerPage(0); }} allMonths={sortedMonths} />
          <div className="flex-1 min-w-0"><MultiSel values={selPartner}  onChange={v => { setSelPartner(v);  setSelCustomer([]); setPartnerPage(0); }} options={partnerOptions}  placeholder="Partner"  searchable/></div>
          <div className="flex-1 min-w-0"><MultiSel values={selCustomer} onChange={v => { setSelCustomer(v); setPartnerPage(0); }}                   options={customerOptions} placeholder="Customer" searchable/></div>
          <div className="flex-1 min-w-0"><MultiSel values={selProducts} onChange={setSelProducts} options={productOptions} placeholder="Product"/></div>
          <div className="flex-1 min-w-0"><MultiSel values={selCountry}  onChange={setSelCountry}  options={countryOptions} placeholder="Country"/></div>
          <button onClick={resetAll} disabled={!hasFilters}
            className={"h-[36px] px-4 text-xs font-medium rounded-lg border transition flex-shrink-0 whitespace-nowrap " + (hasFilters ? "text-red-500 border-red-200 hover:bg-red-50" : "text-gray-300 border-gray-200 cursor-not-allowed")}>
            Reset All Filters
          </button>
        </div>
      </div>

      {/* Table */}
      {partnerNames.length === 0
        ? <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-sm text-gray-500">No data for selected filters</p>
          </div>
        : <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">

            {/* Meta row */}
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>{allRows.length.toLocaleString()} rows imported</span>
                <span className="text-gray-300 text-sm select-none">|</span>
                <span>{partnerNames.length.toLocaleString()} unique partner{partnerNames.length !== 1 ? "s" : ""}</span>
                <span className="text-gray-300 text-sm select-none">|</span>
                <span>{uniqueCustomerCount.toLocaleString()} unique customer{uniqueCustomerCount !== 1 ? "s" : ""}</span>
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
                        ? <button key={i} onClick={() => { item[1](); setExpanded(new Set()); setExpandedCust(new Set()); }} disabled={item[2]}
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
              <SortTh col="upsell"    label="Upsell"     sortCol={sortCol} onSort={toggleSort}/>
              <SortTh col="crosssell" label="Cross-sell" sortCol={sortCol} onSort={toggleSort}/>
              <SortTh col="new"       label="New"        sortCol={sortCol} onSort={toggleSort}/>
              <SortTh col="total"     label="Total"      sortCol={sortCol} onSort={toggleSort}/>
              <SortTh col="recap"     label="Recapture"  sortCol={sortCol} onSort={toggleSort} right/>
            </div>

            {/* Partner rows */}
            {pagedPartnerNames.map((pID, pi) => {
              const pd      = currentPartners[pID];
              const isExp   = expanded.has(pID);
              const rate    = recapRate(pd);
              const custIDs = Object.keys(pd.customers).sort();
              return (
                <div key={pID} className={pi > 0 ? "border-t border-gray-200" : ""}>

                  {/* Partner row */}
                  <div onClick={() => toggleExpand(pID)} className="grid items-center px-4 py-3 cursor-pointer hover:bg-gray-50 transition select-none" style={{gridTemplateColumns: GRID, ...GAP}}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className={"transition-transform flex-shrink-0 " + (isExp ? "rotate-90" : "")}><path d="M9 18l6-6-6-6"/></svg>
                      <div className="w-[18px] h-[18px] rounded bg-blue-50 flex items-center justify-center flex-shrink-0">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2"><path d="M3 21h18M3 7l9-4 9 4M4 7v14M20 7v14M9 21V11h6v10"/></svg>
                      </div>
                      <span className="text-xs font-medium text-gray-800 truncate" title={pd.name}>{pd.name}</span>
                    </div>
                    <div className="flex items-center"><CntBadge label={`${custIDs.length} customer${custIDs.length !== 1 ? "s" : ""}`}/></div>
                    <div className="flex items-center"><IDBadge id={pID}/></div>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.upsell)}</span>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.crosssell)}</span>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.new)}</span>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.total)}</span>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtPct(rate)}</span>
                  </div>

                  {/* Customer rows */}
                  {isExp && custIDs.map((cID) => {
                    const cd      = pd.customers[cID];
                    const custKey = pID + "|||" + cID;
                    const isExpC  = expandedCust.has(custKey);
                    const prodKeys= Object.keys(cd.productBreakdown).sort();
                    const custRate= recapRate(cd);
                    const lcData  = customerLifecycleData[cID] || { partners: new Set(), products: new Set() };

                    return (
                      <React.Fragment key={cID}>
                        {/* Customer row */}
                        <div onClick={e => { e.stopPropagation(); toggleExpandCust(pID, cID); }}
                          className="grid items-center px-4 py-2.5 border-t border-dashed border-gray-200 cursor-pointer hover:bg-blue-50/20 transition select-none"
                          style={{gridTemplateColumns: GRID, ...GAP}}>
                          <div className="flex items-center gap-1.5 min-w-0" style={{marginLeft:"16px"}}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" className={"transition-transform flex-shrink-0 " + (isExpC ? "rotate-90" : "")}><path d="M9 18l6-6-6-6"/></svg>
                            <div className="w-[16px] h-[16px] rounded bg-emerald-50 flex items-center justify-center flex-shrink-0">
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/></svg>
                            </div>
                            <span className="text-xs font-medium text-gray-700 truncate" title={cd.name}>{cd.name}</span>
                          </div>
                          <div className="flex items-center"><CntBadge label={`${prodKeys.length} product${prodKeys.length !== 1 ? "s" : ""}`}/></div>
                          <div className="flex items-center"><IDBadge id={cID}/></div>
                          <span className="text-xs text-gray-700">{cd.upsell    > 0 ? fmtVal(cd.upsell)    : <Dash/>}</span>
                          <span className="text-xs text-gray-700">{cd.crosssell > 0 ? fmtVal(cd.crosssell) : <Dash/>}</span>
                          <span className="text-xs text-gray-700">{cd.new       > 0 ? fmtVal(cd.new)       : <Dash/>}</span>
                          <span className="text-xs text-gray-700">{fmtVal(cd.total)}</span>
                          <span className="text-xs text-gray-700 text-right">{fmtPct(custRate)}</span>
                        </div>

                        {/* Product rows */}
                        {isExpC && prodKeys.map(product => {
                          const prd = cd.productBreakdown[product];
                          return (
                            <div key={product} className="grid items-center px-4 py-2 bg-gray-50/70 border-t border-dotted border-gray-200" style={{gridTemplateColumns: GRID, ...GAP}}>
                              <div className="flex items-center gap-1.5 min-w-0" style={{marginLeft:"48px"}}>
                                <div className="w-[16px] h-[16px] rounded bg-violet-50 flex items-center justify-center flex-shrink-0">
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
                                </div>
                                <Badge text={product} className={hashProductColor(product)}/>
                              </div>
                              <span/>
                              <span/>
                              {["upsell","crosssell","new"].map(t => (
                                <span key={t} className="text-xs text-gray-600">{prd.type === t ? fmtVal(prd[t]) : <Dash/>}</span>
                              ))}
                              <span className="text-xs font-medium text-gray-700">{fmtVal(prd.total)}</span>
                              <span className="text-right"><Dash/></span>
                            </div>
                          );
                        })}

                        {/* Lifecycle rows — indent 1, always shown when customer is expanded */}
                        {isExpC && (
                          <>
                            <div className="px-4 py-2.5 border-t border-dotted border-gray-200 bg-indigo-50/20">
                              <div className="flex items-start gap-3" style={{marginLeft:"16px"}}>
                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider whitespace-nowrap pt-0.5 flex-shrink-0" style={{minWidth:"160px"}}>All products purchased</span>
                                <div className="flex flex-wrap gap-1">
                                  {[...lcData.products].sort().map(p => <Badge key={p} text={p} className={hashProductColor(p)}/>)}
                                </div>
                              </div>
                            </div>
                            <div className="px-4 py-2.5 border-t border-dotted border-gray-200 bg-indigo-50/20">
                              <div className="flex items-start gap-3" style={{marginLeft:"16px"}}>
                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider whitespace-nowrap pt-0.5 flex-shrink-0" style={{minWidth:"160px"}}>All recorded partners</span>
                                <div className="flex flex-wrap gap-1">
                                  {[...lcData.partners].sort().map(p => <span key={p} className="inline-block px-2 py-0.5 text-[10px] rounded-full bg-white border border-gray-200 text-gray-500 whitespace-nowrap">{p}</span>)}
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })}
          </div>
      }
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
    const file = files[0];
    console.log("[CloudRe] Upload started:", file.name, `(${(file.size / 1024).toFixed(1)} KB)`);
    setUploadState({ status: "uploading" });
    try {
      await new Promise(r => setTimeout(r, 40));
      const raw = await parseCsv(file);
      console.log("[CloudRe] Parsed rows:", raw.length, "· Detected headers:", Object.keys(raw[0] || {}).join(", "));

      const { valid, message } = validateCsv(raw);
      if (!valid) {
        console.warn("[CloudRe] validation failed:", message, "· Expected columns:", REQUIRED_COLS.join(", "));
        setUploadState({ status: "error", message: message || "Upload failed" });
        return;
      }

      const isBlank = v => !v.trim() || ["na","n/a","#n/a","#na"].includes(v.trim().toLowerCase());
      const STRICT_COLS = REQUIRED_COLS.filter(c => c !== "amount");
      const clean   = raw.filter(r => STRICT_COLS.every(c => !isBlank(r[c] || "")));
      const skipped = raw.length - clean.length;
      if (skipped > 0) {
        const skippedRows = raw.filter(r => !STRICT_COLS.every(c => !isBlank(r[c] || "")));
        console.warn("[CloudRe] Skipped", skipped, "row(s) — blank or invalid required fields:");
        skippedRows.slice(0, 10).forEach((r, i) => {
          const blankFields = REQUIRED_COLS.filter(c => isBlank(r[c] || ""));
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
        "Product":       (r["SubscriptionName"] || "").trim(),
        "Value":         ((r["amount"]           || "").trim() || "0"),
        "Country":       extractCountry(r["storeid"]),
      }));
      console.log("[CloudRe] Normalized sample row:", normalized[0]);

      let idCounter = Date.now();
      const newRows = normalized.map(r => ({
        ...r,
        _reportingMonth: getMonthKey(r["Date"]),
        _id: String(idCounter++),
      })).filter(r => r._reportingMonth);

      const unparsedDates = normalized.length - newRows.length;
      if (unparsedDates > 0) console.warn("[CloudRe] Rows dropped — could not parse date value:", unparsedDates, "· Sample date values:", [...new Set(normalized.map(r => r["Date"]))].slice(0, 5));

      if (!newRows.length) {
        console.warn("[CloudRe] No valid rows remaining after filtering. Check that the date column contains parseable date values");
        setUploadState({ status: "error", message: "No valid rows found" });
        return;
      }

      const newMonths = [...new Set(newRows.map(r => r._reportingMonth))];
      console.log("[CloudRe] Months detected:", newMonths.map(fmtMonthKey).join(", "));

      await new Promise(r => setTimeout(r, 80));

      setAllRows(prev => [...prev.filter(r => !newMonths.includes(r._reportingMonth)), ...newRows]);

      console.log("[CloudRe] Upload complete —", newRows.length, "rows ·", newMonths.length, "month(s)");
      setUploadState({ status: "success", imported: newRows.length, skipped });

    } catch (err) {
      console.error("[CloudRe] Upload error:", err);
      setUploadState({ status: "error", message: "Upload failed" });
    }
  }, []);

  /* ── Clear all ── */
  const clearAll = useCallback(async () => {
    setAllRows([]); setUploadState(null);
    const idx = await psGet("rows_idx") || [];
    for (const k of idx) await psDel("rows:" + k);
    await psDel("rows_idx");
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
              className="px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap h-[32px] border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100">
              Upload data
            </button>
            <button onClick={clearAll} disabled={!hasData}
              className={"px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap h-[32px] " + (!hasData ? "text-gray-300 bg-gray-100 cursor-not-allowed" : "text-red-600 bg-red-50 hover:bg-red-100")}>
              Clear all data
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