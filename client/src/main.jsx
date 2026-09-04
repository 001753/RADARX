import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = "/api";

function formatUsd(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1000000) return `$${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `$${(number / 1000).toFixed(1)}K`;
  if (number < 0.01) return `$${number.toFixed(6)}`;
  return `$${number.toFixed(2)}`;
}

function formatScore(value) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(1);
}

function timeAgo(date) {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function statusClass(value) {
  return String(value || "unknown").toLowerCase().replaceAll("_", "-");
}

function StatusPill({ value }) {
  return <span className={`pill pill-${statusClass(value)}`}>{String(value || "unknown").replaceAll("_", " ")}</span>;
}

function Metric({ label, value, tone }) {
  return <div className="metric"><span>{label}</span><strong className={tone || ""}>{value}</strong></div>;
}

function GateRow({ gate }) {
  return (
    <div className="gate-row">
      <div className={`gate-dot ${statusClass(gate.status)}`} />
      <div className="gate-copy">
        <strong>{gate.name.replaceAll("_", " ")}</strong>
        <span>{gate.reasonCode.replaceAll("_", " ")}</span>
      </div>
      <StatusPill value={gate.status} />
    </div>
  );
}

function TokenCard({ token, onSelect }) {
  const gates = token.gates || [];
  const blocked = gates.find((gate) => gate.status === "reject");
  return (
    <button className="token-card" onClick={() => onSelect(token)}>
      <div className="token-card-head">
        <div className="token-mark">{(token.symbol || "?").slice(0, 2)}</div>
        <div className="token-identity">
          <strong>{token.name || "Unnamed token"}</strong>
          <span>{token.symbol || "—"} <i>·</i> {token.tokenAddress?.slice(0, 8)}…</span>
        </div>
        <StatusPill value={token.label || "NO_CALL"} />
      </div>
      <div className="score-row">
        <div><span className="eyebrow">Priority score</span><strong className="score-value">{formatScore(token.priorityScore)}</strong></div>
        <div className="score-mini"><span>Signal</span><b>{formatScore(token.signalScore)}</b></div>
        <div className="score-mini"><span>Evidence</span><b>{token.evidenceConfidence === null || token.evidenceConfidence === undefined ? "—" : `${(Number(token.evidenceConfidence) * 100).toFixed(0)}%`}</b></div>
      </div>
      <div className="token-metrics">
        <Metric label="Liquidity" value={formatUsd(token.liquidityUsd)} />
        <Metric label="1h volume" value={formatUsd(token.volume1h)} />
        <Metric label="Flow" value={token.flowQuality === null || token.flowQuality === undefined ? "Unknown" : Number(token.flowQuality).toFixed(0)} />
      </div>
      <div className="token-card-foot">
        <span className="lifecycle">{String(token.lifecycle || "UNKNOWN").replaceAll("_", " ")}</span>
        <span className={blocked ? "danger-text" : "fresh-text"}>{blocked ? blocked.reasonCode.replaceAll("_", " ") : `${timeAgo(token.lastUpdated)} · inspect evidence`}</span>
      </div>
    </button>
  );
}

function DetailDrawer({ token, onClose }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (token?.dataMode === "DEMO_FIXTURES") {
      setDetail({ token, gates: token.gates || [], scores: [], market: [] });
      return;
    }
    if (!token?.tokenAddress) return;
    fetch(`${API}/token/${token.tokenAddress}`).then((response) => response.json()).then(setDetail).catch(() => setDetail({ token, gates: [] }));
  }, [token]);
  if (!token) return null;
  const score = detail?.scores?.[0] || token;
  const gates = detail?.gates?.slice(0, 8) || token.gates || [];
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div><span className="eyebrow">Evidence dossier</span><h2>{token.name || "Token detail"}</h2><p>{token.symbol} · {token.tokenAddress}</p></div>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="drawer-summary">
          <div className="hero-score"><span>Priority</span><strong>{formatScore(score.priorityScore)}</strong><StatusPill value={score.label || token.label} /></div>
          <Metric label="Signal" value={formatScore(score.signalScore)} />
          <Metric label="Evidence" value={score.evidenceConfidence == null ? "—" : `${(Number(score.evidenceConfidence) * 100).toFixed(0)}%`} />
          <Metric label="Lifecycle" value={String(score.lifecycle || token.lifecycle || "UNKNOWN").replaceAll("_", " ")} />
        </div>
        <section className="drawer-section">
          <div className="section-title"><span>Gate decision trail</span><small>fail-closed</small></div>
          <div className="gate-list">{gates.map((gate, index) => <GateRow gate={gate} key={`${gate.name}-${index}`} />)}</div>
        </section>
        <section className="drawer-section">
          <div className="section-title"><span>Component scores</span><small>model v1.2.0</small></div>
          <div className="bars">
            {[["Momentum", score.momentum ?? score.momentum_score], ["Holder health", score.holderHealth ?? score.holder_health_score], ["Flow quality", score.flowQuality ?? score.flow_quality_score], ["Liquidity quality", score.liquidityQuality ?? score.liquidity_quality_score]].map(([name, value]) => (
              <div className="bar-item" key={name}><div><span>{name}</span><b>{formatScore(value)}</b></div><div className="bar-track"><i style={{ width: `${Math.max(0, Math.min(100, Number(value) || 0))}%` }} /></div></div>
            ))}
          </div>
        </section>
        <section className="evidence-box">
          <span className="eyebrow">Interpretation boundary</span>
          <p>{score.label === "REJECTED" ? "Confirmed risk was detected. This token is deliberately blocked from watchlist scoring." : score.label === "QUARANTINED" ? "Evidence is incomplete. The system refuses to call this token safe or high priority." : "This is a screening signal, not a trading recommendation. Raw score is not a probability of profit."}</p>
        </section>
      </aside>
    </div>
  );
}

function App() {
  const [items, setItems] = useState([]);
  const [mode, setMode] = useState("LIVE_DATABASE");
  const [health, setHealth] = useState({ db: "checking", modelVersion: "—" });
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [lastScan, setLastScan] = useState(null);
  const [precision, setPrecision] = useState(null);
  const [coverage, setCoverage] = useState(null);

  async function loadLive() {
    setLoading(true);
    try {
      const [radar, apiHealth, report, coverageReport] = await Promise.all([fetch(`${API}/radar`).then((r) => r.json()), fetch(`${API}/health`).then((r) => r.json()), fetch(`${API}/precision-report`).then((r) => r.json()), fetch(`${API}/coverage`).then((r) => r.json())]);
      if (radar.error) throw new Error(radar.error);
      setItems(radar.items || []);
      setMode(radar.dataMode || "LIVE_DATABASE");
      setHealth(apiHealth);
      setPrecision(report);
      setCoverage(coverageReport);
      setMessage(radar.items?.length ? "" : "Belum ada snapshot live. Jalankan scan untuk mengambil kandidat terbaru.");
    } catch (error) {
      setHealth({ db: "error", modelVersion: "—" });
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadDemo() {
    setLoading(true);
    const result = await fetch(`${API}/demo`).then((r) => r.json());
    setItems(result.items || []);
    setMode(result.dataMode);
    setPrecision({ status: "FIXTURE_ONLY", targetPrecision: 0.7, minSample: 30, horizons: [] });
    setMessage("Fixture riset aktif. Data ini bukan data pasar live.");
    setLoading(false);
  }

  async function scanLive() {
    setLoading(true);
    setMessage("Mengambil discovery, market, dan security evidence…");
    try {
      const result = await fetch(`${API}/scan`, { method: "POST" }).then((r) => r.json());
      if (result.error) throw new Error(result.error);
      setLastScan(result);
      await loadLive();
      setMessage(`Scan selesai: ${result.observationsSaved} observation tersimpan, ${result.unknown} ditahan sebagai unknown.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadLive(); }, []);

  const filtered = useMemo(() => {
    const sorted = [...items].sort((a, b) => (Number(b.priorityScore) || -1) - (Number(a.priorityScore) || -1));
    return filter === "ALL" ? sorted : sorted.filter((item) => item.label === filter);
  }, [items, filter]);
  const counts = useMemo(() => items.reduce((acc, item) => { acc[item.label || "NO_CALL"] = (acc[item.label || "NO_CALL"] || 0) + 1; return acc; }, {}), [items]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-glyph"><span /></div><div><strong>Signal Harbor</strong><small>Solana research radar</small></div></div>
        <div className="topbar-right"><span className={`connection-dot ${health.db === "connected" ? "online" : "offline"}`} /> <span>{health.db === "connected" ? "PostgreSQL connected" : health.db}</span><span className="model-tag">{health.modelVersion || "radar-v1.2.0"}</span></div>
      </header>
      <main className="main">
        <section className="hero">
          <div><span className="eyebrow accent">Precision-first signal desk</span><h1>Find the signal.<br /><em>Refuse the noise.</em></h1><p>Evidence-led screening for early Solana tokens. A missing data point is never treated as a green light.</p></div>
          <div className="hero-actions"><button className="button button-primary" onClick={scanLive} disabled={loading}><span className="button-pulse" />{loading ? "Working…" : "Scan live market"}</button><button className="button button-ghost" onClick={loadDemo}>View research fixtures</button></div>
        </section>
        <section className="disclaimer"><span className="shield">◈</span><span><strong>Research tool, not financial advice.</strong> Scores are screening outputs, not profit probabilities. High Priority requires evidence confidence; all unknowns remain visible.</span></section>
        {message && <div className={`notice ${message.includes("selesai") ? "notice-success" : ""}`}><span>{mode === "DEMO_FIXTURES" ? "Fixture mode" : "System note"}</span>{message}</div>}
        <section className="precision-proof">
          <div><span className="eyebrow accent">Precision proof</span><strong>{precision?.status === "MEASURED" ? "Measured out-of-sample" : precision?.status === "FIXTURE_ONLY" ? "Fixture only" : "Awaiting outcomes"}</strong></div>
          <div className="proof-copy">{precision?.status === "MEASURED" ? "Lower confidence bounds are being monitored." : `Need ${precision?.minSample || 30} labeled outcomes per horizon before a precision claim.`}</div>
          <span className={`proof-mark ${precision?.status === "MEASURED" ? "ready" : ""}`}>{precision?.status === "MEASURED" ? "VALIDATED" : "NOT VALIDATED"}</span>
        </section>
        <section className="overview-grid">
          <div className="overview-card"><span className="eyebrow">Universe</span><strong>{items.length || "—"}</strong><small>{mode === "DEMO_FIXTURES" ? "labeled fixtures" : "stored observations"}</small></div>
          <div className="overview-card"><span className="eyebrow">Priority</span><strong>{counts.HIGH_PRIORITY || 0}</strong><small>high evidence candidates</small></div>
          <div className="overview-card"><span className="eyebrow">Held back</span><strong>{(counts.QUARANTINED || 0) + (counts.NO_CALL || 0)}</strong><small>unknown / no call</small></div>
          <div className="overview-card regime-card"><span className="eyebrow">Coverage</span><strong>{coverage?.marketSnapshots?.count || 0}</strong><small>market snapshots · {coverage?.precisionReady ? "precision ready" : "outcome window open"}</small></div>
        </section>
        <section className="section-heading"><div><span className="eyebrow">Live watchlist</span><h2>Evidence queue</h2></div><div className="filters">{["ALL", "HIGH_PRIORITY", "WATCHLIST", "PROVISIONAL", "QUARANTINED", "REJECTED"].map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{value === "ALL" ? "All" : value.replaceAll("_", " ")}</button>)}</div></section>
        <section className="queue-meta"><span><i className="live-indicator" /> {mode === "DEMO_FIXTURES" ? "Fixture dataset · clearly labeled" : "Database snapshot · refresh manually"}</span><span>{filtered.length} showing · ranked by PriorityScore</span></section>
        {filtered.length ? <div className="token-grid">{filtered.map((token) => <TokenCard key={token.tokenAddress} token={token} onSelect={setSelected} />)}</div> : <div className="empty-state"><div className="empty-orbit">◎</div><h3>No eligible signals yet</h3><p>{message || "The radar has no stored observations. Run a live scan or open the labeled fixtures to inspect the full evidence workflow."}</p><button className="button button-primary" onClick={scanLive} disabled={loading}>Run first live scan</button></div>}
        <footer><span>RADAR / PRECISION-FIRST</span><span>Data gaps are surfaced, never hidden.</span><span>© 2026 Signal Harbor</span></footer>
      </main>
      <DetailDrawer token={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);