# Signal Harbor — Solana Research Radar

Signal Harbor adalah radar riset token Solana berbasis PRD v1.2 Precision-First. Sistem ini memisahkan `SignalScore`, `EvidenceConfidence`, dan `PriorityScore`, serta menggunakan gate `pass/reject/unknown`. Data yang tidak lengkap tidak pernah dianggap aman.

## Menjalankan aplikasi

Workflow `Start application` menjalankan:

```bash
npm run build && RADAR_SCHEDULER_ENABLED=true npm run dev
```

Server menerima traffic pada port 5000. PostgreSQL Replit digunakan sebagai source of truth.

Untuk menjalankan migration schema secara manual:

```bash
npm run db:push
```

Pemeriksaan lokal:

```bash
npm run check
npm test
npm run build
```

## Mode sistem

- **Live database:** dashboard membaca snapshot yang tersimpan dari DexScreener, RugCheck, dan RPC Solana publik.
- **Scan live market:** mengambil discovery terbaru dan menyimpan raw observation, market snapshot, gate decision, serta score snapshot.
- **Scheduler:** discovery setiap 120 detik dan refresh watchlist setiap 30 detik, dengan scan lock.
- **Research fixtures:** data fixture diberi label eksplisit `DEMO_FIXTURES`; bukan data pasar live dan tidak boleh dipakai untuk klaim performa.

## Prinsip model

- Security-critical data yang hilang menghasilkan `unknown`/`quarantined`.
- Minimum sample size berlaku untuk flow-quality gate.
- High Priority hanya mungkin ketika score, evidence confidence, dan gate requirements terpenuhi.
- Raw score bukan probabilitas profit.
- Semua score menyimpan model version dan evidence summary.
- Tidak ada auto-trading, wallet signing, private key, atau seed phrase.

## Pengembangan lanjutan

Sebelum mengaktifkan calibrated probability, lakukan outcome labeling dan chronological walk-forward validation. Provider on-chain tambahan diperlukan untuk holder history, wallet attribution, LP state, dan feature precision yang lebih lengkap.