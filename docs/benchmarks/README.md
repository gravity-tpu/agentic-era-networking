# Zodiac Network Infrastructure — Benchmark Archive

This directory houses bare-metal benchmark reports, architectural findings, and raw telemetry artifacts generated from physical hardware runs across the Zodiac autonomous SDN fabric.

---

## 1. Benchmark Catalog

| Benchmark Run | Scope & Topology | Key Physical Finding | Artifact / Report |
| :--- | :--- | :--- | :--- |
| **Zodiac FX Data-Plane Benchmark**<br>`2026-10-03T23:26:49.149Z` | Port 1 (RPi 3B+) ⟷ Port 2 (Transit) with Port 3 Tap and 0 / 32 / 126 quarantine depth | **Microcontroller Software Lookup**: SAM4E8E MCU evaluates flow tables in software, causing an inverse throughput penalty ($O(N)$) as rule depth increases from 0 (94.5 Mbit/s) to 126 (4.5 Mbit/s). Exact 0 switch forwarding deficit across all valid trials. | • [Physical Report](file:///Users/andymorven/git/agentic-era-networking/docs/benchmarks/zodiac-fx-dataplane-report.md)<br>• [JSON Artifact](file:///Users/andymorven/git/agentic-era-networking/docs/benchmarks/results/dataplane-2026-10-03T23-26-49-149Z.json)<br>• [Design Runbook](file:///Users/andymorven/git/agentic-era-networking/docs/design/zodiac-fx-dataplane-benchmark.md) |

---

## 2. Directory Structure

```text
docs/benchmarks/
├── README.md                                  # This catalog and archive index
├── zodiac-fx-dataplane-report.md             # Comprehensive CCIE architectural report (2026-10-03)
└── results/
    └── dataplane-2026-10-03T23-26-49-149Z.json # Cryptographic physical telemetry artifact (BigInt schema)
```

---

## 3. Epistemic Provenance Standard (Council Invariant 6)

Every benchmark artifact stored in this archive must satisfy **Council Invariant 6 (Goodhart's Law & Epistemic Telemetry Provenance)**:

1. **Origin Verification**: Artifacts must be stamped with `origin: "physical_bench_run"`. Synthetic digital twins are strictly forbidden from masquerading as physical hardware.
2. **Deterministic Metering**: All packet, byte, and bit rates use 64-bit BigInt serialization (`{"$bigint": "..."}`). Floating-point representations for network accounting are rejected.
3. **Monotonic Clocks**: All start, end, and duration timestamps are recorded using monotonic nanosecond precision (`process.hrtime.bigint()`).
4. **Silicon Attestation**: Each run binds switch DPID, serial path, hardware CPU UID, firmware version, and Linux kernel release.
