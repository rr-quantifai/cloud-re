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
  const dmy = t.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2,"0")}-${dmy[1].padStart(2,"0")}T00:00:00Z`);
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

const fmtDate = (s) => {
  const d = parseDateFlexible(s);
  if (!d) return s || "";
  return `${d.getDate()}-${MONTH_ABBREVS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
};

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════ */
const REQUIRED_COLS = ["custid", "EndCustomer", "InvoiceDate", "amount", "SubscriptionName", "partnername", "storeid"];

const extractPartnerName = (v) => { const s = (v||"").trim(); const i = s.indexOf("~"); return i !== -1 ? s.slice(i+1).trim() : s; };
const extractPartnerID   = (v) => { const s = (v||"").trim(); const i = s.indexOf("~"); return i !== -1 ? s.slice(0,i).trim() : ""; };
const extractCountry     = (v) => { const s = (v||"").trim(); const i = s.indexOf("-"); return i !== -1 ? s.slice(0,i).trim() : s; };
const TAB = Object.freeze({ TRACKER: "tracker", UPLOAD: "upload" });
const PAGE_SIZE = 25;
const MIN_DESKTOP = 1024;
const H_PANEL = "252px";

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

const TYPE_STYLES = {
  upsell:    { badge: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500", label: "Upsell",     col: "text-emerald-700" },
  crosssell: { badge: "bg-blue-100 text-blue-700",       dot: "bg-blue-500",    label: "Cross-sell", col: "text-blue-700"    },
  new:       { badge: "bg-violet-100 text-violet-700",   dot: "bg-violet-500",  label: "New",        col: "text-violet-700"  },
};

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
    <style>{`@keyframes dotPulse{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`}</style>
  </span>
);

const Badge = ({ text, className }) => (
  <span className={"inline-block px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap max-w-[180px] truncate " + (className||"")} title={text}>{text}</span>
);

const TabSwitch = ({ items, active, onChange }) => (
  <div className="inline-flex gap-1 bg-gray-100 rounded-lg p-1">
    {items.map(([k, l, disabled]) => (
      <button
        key={k}
        onClick={() => !disabled && onChange(k)}
        disabled={!!disabled}
        title={disabled ? "Upload data to enable this view" : undefined}
        className={"px-4 py-2 text-sm font-medium rounded-md transition whitespace-nowrap " +
          (disabled
            ? "text-gray-300 cursor-not-allowed"
            : active === k
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700")}
      >{l}</button>
    ))}
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

const SelectDropdown = ({ value, onChange, options, placeholder, className = "" }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutsideClose(ref, open, setOpen);
  const selected = options.find(o => o.value === value);
  return (
    <div ref={ref} className={"relative " + className}>
      <div onClick={() => setOpen(!open)} className={"w-full px-2.5 py-1.5 text-sm border rounded-lg bg-white h-[36px] flex items-center justify-between cursor-pointer " + (value ? "border-blue-400 hover:border-blue-500" : "border-gray-200 hover:border-blue-300")}>
        <span className={(value ? "text-blue-600" : "text-gray-400") + " truncate"}>{selected?.label || placeholder || "Select…"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={"flex-shrink-0 ml-1 transition-transform " + (open ? "rotate-180" : "")}><path d="M6 9l6 6 6-6"/></svg>
      </div>
      {open && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto mt-1">
          {options.map(o => (
            <div key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} className={"px-3 py-2 text-xs cursor-pointer hover:bg-gray-50 " + (o.value === value ? "font-semibold text-blue-600 bg-blue-50" : "text-gray-700")}>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

/* ═══════════════════════════════════════════════════════════════════
   UPLOAD BAR
   ═══════════════════════════════════════════════════════════════════ */
const UploadBar = ({ uploadState, handleUpload, fileRef }) => {
  const st = uploadState?.status;
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-0">
      <label className={"flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-lg border flex-shrink-0 cursor-pointer transition " + (st === "uploading" ? "border-blue-200 bg-blue-50 text-blue-300 cursor-not-allowed" : "border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100")}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
        {st === "uploading" ? "Uploading…" : "Upload CSV"}
        {st !== "uploading" && <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => { handleUpload(e.target.files); if (fileRef.current) fileRef.current.value = ""; }}/>}
      </label>

      <span className="text-gray-200 mx-4 select-none text-base">|</span>

      <span className={"text-xs font-medium flex-shrink-0 " + (st === "success" ? "text-emerald-600" : "text-gray-300")}>
        Successful
      </span>

      <span className="text-gray-200 mx-4 select-none text-base">|</span>

      <span className={"text-xs font-medium flex-shrink-0 " + (st === "error" ? "text-red-500" : "text-gray-300")}>
        Failed
      </span>

      <span className="text-gray-200 mx-4 select-none text-base">|</span>

      <span className={"text-xs flex-1 min-w-0 truncate " + (st === "success" ? "text-gray-500" : st === "error" ? "text-gray-500" : "text-gray-300 italic")}>
        {!st && "Upload status is displayed here"}
        {st === "uploading" && "Processing…"}
        {st === "success" && (uploadState.message || "")}
        {st === "error" && "See console for details"}
      </span>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   DATA COVERAGE
   ═══════════════════════════════════════════════════════════════════ */
const DataCoverage = ({ sortedMonths, flashMonths }) => {
  const byYear = useMemo(() => {
    const m = {};
    for (const ym of sortedMonths) {
      const [y, mo] = ym.split("-").map(Number);
      if (!m[y]) m[y] = [];
      if (!m[y].includes(mo)) m[y].push(mo);
    }
    return m;
  }, [sortedMonths]);
  const years = Object.keys(byYear).sort();
  const baselineMonth = sortedMonths[0] || null;
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col" style={{height: H_PANEL}}>
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Data Coverage</h2>
          <p className="text-xs text-gray-400">{sortedMonths.length} month{sortedMonths.length !== 1 ? "s" : ""} covered</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pt-3 pb-2">
        {years.length === 0
          ? <div className="flex items-center justify-center h-full"><p className="text-xs text-gray-400">No CSV uploaded</p></div>
          : <div className="flex flex-col gap-3">
              {years.map(y => (
                <div key={y} className="flex items-start flex-wrap gap-y-1.5 leading-none">
                  <span className="text-xs font-semibold text-gray-700 mr-3 pt-0.5">{y}</span>
                  <div className="flex flex-wrap gap-x-1 gap-y-1.5">
                    {byYear[y].map(mo => {
                      const ym = `${y}-${String(mo).padStart(2,"0")}`;
                      const isBaseline = ym === baselineMonth;
                      const isFlash = flashMonths.includes(ym);
                      return (
                        <span key={mo} className="flex items-center gap-1">
                          <span className={"text-xs transition-colors duration-500 " + (isFlash ? "text-emerald-600 font-semibold" : "text-gray-600")}>
                            {MONTH_ABBREVS[mo - 1]}
                          </span>
                          {isBaseline && <span className="text-[10px] text-blue-400 font-semibold uppercase tracking-wide">base</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   KPI CARDS
   ═══════════════════════════════════════════════════════════════════ */
const KPICards = ({ totals, priorTotals, monthLabel }) => {
  const fmtVal  = (v) => (v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtPct  = (v) => (v || 0).toFixed(1) + "%";
  const recapRate = (t) => t && t.total > 0 ? ((t.upsell + t.crosssell) / t.total) * 100 : 0;
  const currRate  = recapRate(totals);
  const priorRate = priorTotals ? recapRate(priorTotals) : null;
  const total     = Math.max(totals.total, 1);

  const YoY = ({ curr, prior, isPct }) => {
    if (prior == null) return null;
    if (!isPct && prior === 0) return null;
    const delta = isPct ? curr - prior : ((curr - prior) / prior) * 100;
    if (Math.abs(delta) < 0.05) return null;
    const pos   = delta >= 0;
    const label = isPct ? `${Math.abs(delta).toFixed(1)}pp` : `${Math.abs(delta).toFixed(1)}%`;
    return <><span className="text-gray-200 mx-1.5">|</span><span className={"text-xs font-medium " + (pos ? "text-emerald-600" : "text-red-500")}>{pos ? "↑" : "↓"} {label}</span></>;
  };

  const ROWS = [
    { label: "Upsell",     val: totals.upsell,    prior: priorTotals?.upsell,    pct: (totals.upsell    / total) * 100, color: "#10b981" },
    { label: "Cross-sell", val: totals.crosssell, prior: priorTotals?.crosssell, pct: (totals.crosssell / total) * 100, color: "#3b82f6" },
    { label: "New",        val: totals.new,        prior: priorTotals?.new,       pct: (totals.new       / total) * 100, color: "#7c3aed" },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
      {ROWS.map(({ label, val, prior, pct, color }) => (
        <div key={label} className="grid items-center px-5 py-2.5 border-b border-gray-100" style={{gridTemplateColumns:"100px 1fr 160px", gap:"16px"}}>
          <span className="text-xs font-medium text-gray-500">{label}</span>
          <div className="h-[7px] bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{width: pct + "%", background: color}}/>
          </div>
          <div className="flex items-center justify-end text-xs font-medium text-gray-900">
            {fmtVal(val)}<YoY curr={val} prior={prior}/>
          </div>
        </div>
      ))}
      <div className="grid items-center px-5 py-2.5 border-b border-gray-200 border-t border-gray-200" style={{gridTemplateColumns:"100px 1fr 160px", gap:"16px"}}>
        <span className="text-xs font-medium text-gray-500">Total</span>
        <div/>
        <div className="flex items-center justify-end text-xs font-medium text-gray-500">
          {fmtVal(totals.total)}<YoY curr={totals.total} prior={priorTotals?.total}/>
        </div>
      </div>
      <div className="grid items-center px-5 py-2.5" style={{gridTemplateColumns:"100px 1fr 160px", gap:"16px"}}>
        <span className="text-xs font-medium text-gray-500">Recapture</span>
        <div className="h-[7px] bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{width: currRate + "%", background: "#d97706"}}/>
        </div>
        <div className="flex items-center justify-end text-xs font-medium text-gray-900">
          {fmtPct(currRate)}<YoY curr={currRate} prior={priorRate} isPct/>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   TRACKER VIEW
   ═══════════════════════════════════════════════════════════════════ */
const TrackerView = ({ allRows, sortedMonths, typeMap }) => {
  const latestMonth = sortedMonths.length ? sortedMonths[sortedMonths.length - 1] : null;
  const [selMonth, setSelMonth]         = useState(null);
  const [selPartner, setSelPartner]     = useState([]);
  const [selCustomer, setSelCustomer]   = useState([]);
  const [selProducts, setSelProducts]   = useState([]);
  const [selCountry, setSelCountry]     = useState([]);
  const [expanded, setExpanded]         = useState(new Set());
  const [expandedCust, setExpandedCust] = useState(new Set());
  const [sortCol, setSortCol]           = useState(null);
  const [sortDir, setSortDir]           = useState("desc");
  const [partnerPage, setPartnerPage]   = useState(0);

  useEffect(() => {
    if (!latestMonth) return;
    if (!selMonth || !sortedMonths.includes(selMonth)) setSelMonth(latestMonth);
  }, [latestMonth, sortedMonths]);

  const effectiveMonth = selMonth || latestMonth;

  const priorYearMonth = useMemo(() => {
    if (!effectiveMonth) return null;
    const [y, m] = effectiveMonth.split("-").map(Number);
    const pym = `${y - 1}-${String(m).padStart(2, "0")}`;
    return sortedMonths.includes(pym) ? pym : null;
  }, [effectiveMonth, sortedMonths]);

  const parseValue = useCallback((v) => parseFloat((v || "").toString().replace(/[^0-9.\-]/g, "")) || 0, []);

  const monthRows = useMemo(() =>
    allRows.filter(r => r._reportingMonth === effectiveMonth),
    [allRows, effectiveMonth]
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

  const monthOptions = useMemo(() => sortedMonths.map(ym => ({ value: ym, label: fmtMonthKey(ym) })), [sortedMonths]);

  /* ── Aggregate ── */
  const aggregate = useCallback((month, partnerFilter, customerFilter, prodFilter, countryFilter) => {
    const empty = { byPartner: {}, totals: { upsell: 0, crosssell: 0, new: 0, total: 0 } };
    if (!month) return empty;
    const rows = allRows.filter(r => {
      if (r._reportingMonth !== month) return false;
      if (partnerFilter.length  && !partnerFilter.includes((r["Partner ID"]   || "").trim())) return false;
      if (customerFilter.length && !customerFilter.includes((r["Customer ID"] || "").trim())) return false;
      if (prodFilter.length     && !prodFilter.includes((r["Product"]         || "").trim())) return false;
      if (countryFilter.length  && !countryFilter.includes((r["Country"]      || "").trim())) return false;
      return true;
    });
    const byPartner = {}, totals = { upsell: 0, crosssell: 0, new: 0, total: 0 };
    for (const row of rows) {
      const pID  = (row["Partner ID"]    || "").trim() || "unknown";
      const pNm  = (row["Partner Name"]  || "").trim() || "Unknown Partner";
      const cID  = (row["Customer ID"]   || "").trim() || "unknown";
      const cNm  = (row["Customer Name"] || "").trim() || "Unknown Customer";
      const type = typeMap[row._id] || "new";
      const val  = parseValue(row["Value"]);
      const prod = (row["Product"] || "").trim();
      if (!byPartner[pID]) byPartner[pID] = { name: pNm, upsell: 0, crosssell: 0, new: 0, total: 0, customers: {} };
      byPartner[pID][type] += val; byPartner[pID].total += val;
      totals[type] += val; totals.total += val;
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
    () => aggregate(effectiveMonth, selPartner, selCustomer, selProducts, selCountry),
    [aggregate, effectiveMonth, selPartner, selCustomer, selProducts, selCountry]
  );
  const { byPartner: priorPartners, totals: priorTotals } = useMemo(
    () => priorYearMonth ? aggregate(priorYearMonth, selPartner, selCustomer, selProducts, selCountry) : { byPartner: {}, totals: null },
    [aggregate, priorYearMonth, selPartner, selCustomer, selProducts, selCountry]
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

  const fmtVal    = (v) => (v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtPct    = (v) => (v || 0).toFixed(1) + "%";
  const recapRate = (t) => t && t.total > 0 ? ((t.upsell + t.crosssell) / t.total) * 100 : 0;

  const toggleSort = (col) => {
    if (sortCol === col) { if (sortDir === "desc") setSortDir("asc"); else { setSortCol(null); setSortDir("desc"); } }
    else { setSortCol(col); setSortDir("desc"); }
    setExpanded(new Set()); setExpandedCust(new Set()); setPartnerPage(0);
  };

  const SortTh = ({ col, label, right = false }) => (
    <span className={"cursor-pointer select-none hover:text-gray-700 transition text-xs uppercase tracking-wider font-medium " + (right ? "block text-right" : "")}
      onClick={() => toggleSort(col)} style={{ color: sortCol === col ? "#1d4ed8" : "#9ca3af" }}>{label}</span>
  );

  const toggleExpand     = (pID) => setExpanded(prev => { const n = new Set(prev); n.has(pID) ? n.delete(pID) : n.add(pID); return n; });
  const toggleExpandCust = (pID, cID) => { const k = pID+"|||"+cID; setExpandedCust(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; }); };

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

  useEffect(() => { setPartnerPage(0); setExpanded(new Set()); setExpandedCust(new Set()); }, [selPartner, selCustomer, selProducts, selCountry, effectiveMonth]);

  const totalPartnerPages = Math.max(1, Math.ceil(partnerNames.length / PAGE_SIZE));
  const safePartnerPage   = Math.min(partnerPage, totalPartnerPages - 1);
  const pagedPartnerNames = partnerNames.slice(safePartnerPage * PAGE_SIZE, (safePartnerPage + 1) * PAGE_SIZE);
  const uniqueCustomerCount = useMemo(() => Object.values(currentPartners).reduce((s, pd) => s + Object.keys(pd.customers).length, 0), [currentPartners]);

  const monthLabel = effectiveMonth ? fmtMonthKey(effectiveMonth) : "—";
  const GRID = "1fr 80px 80px 80px 80px 80px";
  const GAP  = { gap: "8px" };

  const hasFilters = selPartner.length > 0 || selCustomer.length > 0 || selProducts.length > 0 || selCountry.length > 0 ||
    (selMonth && selMonth !== latestMonth) || sortCol !== null;

  const resetAll = () => {
    setSelPartner([]); setSelCustomer([]); setSelProducts([]); setSelCountry([]);
    setSelMonth(latestMonth); setSortCol(null); setSortDir("desc");
    setExpanded(new Set()); setExpandedCust(new Set()); setPartnerPage(0);
  };

  const IDBadge   = ({ id })  => <span className="inline-block px-1.5 py-px text-[10px] font-medium rounded border border-gray-200 bg-gray-50 text-gray-400 flex-shrink-0">{id}</span>;
  const CntBadge  = ({ label }) => <span className="inline-block px-1.5 py-px text-[10px] rounded border border-gray-200 bg-gray-50 text-gray-400 flex-shrink-0">{label}</span>;
  const Dash      = () => <span className="text-gray-200 text-xs">—</span>;

  return (
    <div>
      <KPICards totals={currentTotals} priorTotals={priorTotals} monthLabel={monthLabel}/>

      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-2">
          <SelectDropdown value={effectiveMonth} onChange={v => { setSelMonth(v); setExpanded(new Set()); setExpandedCust(new Set()); setPartnerPage(0); }} options={monthOptions} placeholder="Month" className="flex-1 min-w-0"/>
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
                <span>{partnerNames.length.toLocaleString()} unique partner{partnerNames.length !== 1 ? "s" : ""}</span>
                <span className="text-gray-300 text-sm select-none">|</span>
                <span>{uniqueCustomerCount.toLocaleString()} unique customer{uniqueCustomerCount !== 1 ? "s" : ""}</span>
              </div>
              {totalPartnerPages > 1 && (
                <div className="flex items-center">
                  {[
                    ["First", () => setPartnerPage(0),                                            safePartnerPage === 0],
                    ["Back",  () => setPartnerPage(p => Math.max(0, p - 1)),                      safePartnerPage === 0],
                    null,
                    [`${safePartnerPage + 1} / ${totalPartnerPages}`, null, false],
                    null,
                    ["Next",  () => setPartnerPage(p => Math.min(totalPartnerPages - 1, p + 1)), safePartnerPage >= totalPartnerPages - 1],
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
              <SortTh col="upsell"    label="Upsell"/>
              <SortTh col="crosssell" label="Cross-sell"/>
              <SortTh col="new"       label="New"/>
              <SortTh col="total"     label="Total"/>
              <SortTh col="recap"     label="Recapture" right/>
            </div>

            {/* Partner rows */}
            {pagedPartnerNames.map((pID, pi) => {
              const pd      = currentPartners[pID];
              const pp      = priorPartners[pID] || null;
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
                      <IDBadge id={pID}/>
                      <CntBadge label={`(${custIDs.length} customer${custIDs.length !== 1 ? "s" : ""})`}/>
                    </div>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.upsell)}</span>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.crosssell)}</span>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.new)}</span>
                    <span className="text-xs font-medium text-gray-900">{fmtVal(pd.total)}</span>
                    <span className="text-xs font-medium text-gray-900 text-right">{fmtPct(rate)}</span>
                  </div>

                  {/* Customer rows */}
                  {isExp && custIDs.map((cID) => {
                    const cd      = pd.customers[cID];
                    const ppCust  = pp?.customers?.[cID] || null;
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
                            <IDBadge id={cID}/>
                            <CntBadge label={`(${prodKeys.length} product${prodKeys.length !== 1 ? "s" : ""})`}/>
                          </div>
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
                              <div className="flex items-center gap-1.5 min-w-0" style={{marginLeft:"32px"}}>
                                <div className="w-[16px] h-[16px] rounded bg-violet-50 flex items-center justify-center flex-shrink-0">
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
                                </div>
                                <Badge text={product} className={hashProductColor(product)}/>
                              </div>
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
                            <div className="px-4 py-2.5 border-t border-dotted border-gray-200 bg-gray-50/40">
                              <div className="flex items-start gap-3" style={{marginLeft:"16px"}}>
                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider whitespace-nowrap pt-0.5" style={{minWidth:"130px"}}>All products purchased</span>
                                <div className="flex flex-wrap gap-1">
                                  {[...lcData.products].sort().map(p => <Badge key={p} text={p} className={hashProductColor(p)}/>)}
                                </div>
                              </div>
                            </div>
                            <div className="px-4 py-2.5 border-t border-dotted border-gray-200 bg-gray-50/40">
                              <div className="flex items-start gap-3" style={{marginLeft:"16px"}}>
                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider whitespace-nowrap pt-0.5" style={{minWidth:"130px"}}>All recorded partners</span>
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

            {totalPartnerPages > 1 && (
              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-400">{partnerNames.length} partner{partnerNames.length !== 1 ? "s" : ""} · page {safePartnerPage + 1} of {totalPartnerPages}</span>
                <div className="flex items-center">
                  {[
                    ["First", () => setPartnerPage(0),                                            safePartnerPage === 0],
                    ["Back",  () => setPartnerPage(p => Math.max(0, p - 1)),                      safePartnerPage === 0],
                    null,
                    [`${safePartnerPage + 1} / ${totalPartnerPages}`, null, false],
                    null,
                    ["Next",  () => setPartnerPage(p => Math.min(totalPartnerPages - 1, p + 1)), safePartnerPage >= totalPartnerPages - 1],
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
              </div>
            )}
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
  const [allRows, setAllRows]         = useState([]);
  const [dataLoaded, setDataLoaded]   = useState(false);
  const [tab, setTab]                 = useState(TAB.UPLOAD);
  const [uploadState, setUploadState] = useState(null);
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

  /* ── Auto-clear upload status on next click ── */
  useEffect(() => {
    if (uploadState?.status === "success" || uploadState?.status === "error") {
      const h = () => { setUploadState(null); setFlashMonths([]); };
      const t = setTimeout(() => window.addEventListener("click", h, { once: true }), 300);
      return () => { clearTimeout(t); window.removeEventListener("click", h); };
    }
  }, [uploadState]);

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
    setUploadState({ status: "uploading", progress: 10 });
    try {
      await new Promise(r => setTimeout(r, 40));
      const raw = await parseCsv(file);
      console.log("[CloudRe] Parsed rows:", raw.length, "· Detected headers:", Object.keys(raw[0] || {}).join(", "));
      setUploadState({ status: "uploading", progress: 50 });

      const { valid, message } = validateCsv(raw);
      if (!valid) {
        console.warn("[CloudRe] validation failed:", message, "· Expected columns:", REQUIRED_COLS.join(", "));
        setUploadState({ status: "error", message: message || "Upload failed" });
        return;
      }

      const isBlank = v => !v.trim() || ["na","n/a","#n/a","#na"].includes(v.trim().toLowerCase());
      const clean   = raw.filter(r => REQUIRED_COLS.every(c => !isBlank(r[c] || "")));
      const skipped = raw.length - clean.length;
      if (skipped > 0) {
        const skippedRows = raw.filter(r => !REQUIRED_COLS.every(c => !isBlank(r[c] || "")));
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
        "Value":         (r["amount"]           || "").trim(),
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

      setUploadState({ status: "uploading", progress: 90 });
      await new Promise(r => setTimeout(r, 80));

      setAllRows(prev => [...prev.filter(r => !newMonths.includes(r._reportingMonth)), ...newRows]);

      const skippedNote = skipped > 0 ? ` · ${skipped} row${skipped !== 1 ? "s" : ""} skipped · See console for a breakdown of skipped rows` : "";
      console.log("[CloudRe] Upload complete —", newRows.length, "rows ·", newMonths.length, "month(s)");
      setUploadState({ status: "success", message: `${newRows.length.toLocaleString()} rows created${skippedNote}` });

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

  const hasData = allRows.length > 0;

  useEffect(() => {
    if (!hasData && tab !== TAB.UPLOAD) setTab(TAB.UPLOAD);
  }, [hasData]);

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
                <path d="M4 4h16v16H4z" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/>
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 leading-tight tracking-tight">Cloud Re</h1>
              <p className="text-xs text-gray-400">Customer recapture tracker</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={clearAll} disabled={!hasData}
              className={"px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap h-[32px] " + (!hasData ? "text-gray-300 bg-gray-100 cursor-not-allowed" : "text-red-600 bg-red-50 hover:bg-red-100")}>
              Clear All Data
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="mb-6">
          <TabSwitch
            items={[
              [TAB.UPLOAD,  "Data Upload", false   ],
              [TAB.TRACKER, "Tracker",     !hasData],
            ]}
            active={tab}
            onChange={setTab}
          />
        </div>

        {tab === TAB.UPLOAD && (
          <UploadBar uploadState={uploadState} handleUpload={handleUpload} fileRef={fileRef}/>
        )}

        {tab === TAB.TRACKER && hasData && <TrackerView allRows={allRows} sortedMonths={sortedMonths} typeMap={typeMap}/>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════ */
export default function CloudRe() {
  return <ErrorBoundary><App/></ErrorBoundary>;
}