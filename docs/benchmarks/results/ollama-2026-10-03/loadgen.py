#!/usr/bin/env python3
"""Load generator for Ollama endpoints. usage: loadgen.py SECONDS QWEN_CONC GEMMA_CONC"""
import json, sys, threading, time, urllib.request, random, statistics

TARGETS = {
    "qwen2.5:3b": "http://100.118.64.16:11434",
    "gemma4:26b": "http://100.112.223.16:11434",
}
PROMPTS = [
    "Explain how a hash map works in about 150 words.",
    "Write a short story opening about a lighthouse keeper.",
    "Summarize the causes of the French Revolution.",
    "Give me 5 tips for debugging a memory leak.",
    "Describe the difference between TCP and UDP.",
    "Write a haiku sequence about autumn, then explain it.",
]
NUM_PREDICT = 300

def worker(model, base, deadline, out, lock):
    while time.time() < deadline:
        body = json.dumps({"model": model, "prompt": random.choice(PROMPTS), "stream": False,
                           "options": {"num_predict": NUM_PREDICT}}).encode()
        t0 = time.time()
        try:
            req = urllib.request.Request(base + "/api/generate", body, {"Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=600))
            rec = (time.time() - t0, d.get("eval_count", 0), d.get("eval_duration", 1) / 1e9, None)
        except Exception as e:
            rec = (time.time() - t0, 0, 0, str(e)[:80])
        with lock:
            out.append(rec)

def run(seconds, conc):
    results = {m: [] for m in conc if conc[m] > 0}
    lock, threads = threading.Lock(), []
    start = time.time(); deadline = start + seconds
    for m, n in conc.items():
        for _ in range(n):
            t = threading.Thread(target=worker, args=(m, TARGETS[m], deadline, results[m], lock)); t.start(); threads.append(t)
    for t in threads: t.join()
    wall = time.time() - start
    report = {}
    for m, recs in results.items():
        ok = [r for r in recs if not r[3]]
        toks = sum(r[1] for r in ok)
        lat = sorted(r[0] for r in ok)
        report[m] = {
            "conc": conc[m], "ok": len(ok), "errors": len(recs) - len(ok),
            "agg_tok_s": round(toks / wall, 1),
            "per_req_tok_s": round(statistics.mean(r[1] / r[2] for r in ok if r[2]), 1) if ok else 0,
            "lat_p50": round(lat[len(lat) // 2], 1) if lat else None,
            "lat_p95": round(lat[int(len(lat) * .95) - 1], 1) if lat else None,
            "raw": [{"latency_s": round(r[0],3), "eval_count": r[1], "eval_s": round(r[2],3), "error": r[3]} for r in recs],
            "tokens": toks, "first_error": next((r[3] for r in recs if r[3]), None),
        }
    return report

if __name__ == "__main__":
    secs, q, g = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    print(json.dumps(run(secs, {"qwen2.5:3b": q, "gemma4:26b": g}), indent=1))
