#!/usr/bin/env python3
"""
scripts/train-proposer-lora.py
==============================
Cloud LoRA SFT + DPO training runner and local Ollama Modelfile generator for the Zodiac
OpenFlow policy proposer (`qwen3.8:27b`).

Designed for ephemeral A100/H100 cloud instances (RunPod, Modal, Lambda Labs):
  1. Pre-flight verification (`validate_dataset_bundle`):
     - Verifies `summary.json` schema (`proposer-lora-dataset/v1`) and provenance (`synthetic_verifier_grounded`).
     - Verifies all four held-out benchmark intent SHA-256 hashes are recorded.
     - Recomputes SHA-256 digests and line counts of every `.jsonl` file in `summary.json`.
     - Scans every JSONL record to confirm zero occurrences of the held-out benchmark subnet (`10.0.2.`)
       or benchmark intent IDs (`port1-isolation/v1`, `dns-confinement/v1`, `quarantine-precedence/v1`,
       `tap-return-isolation/v1`). Refuses to start GPU training on any violation (Invariant 3 & 4).
  2. Emits `Modelfile.proposer-lora` so the trained adapter weights can be registered directly in
     Ollama on the Mac workstation (`ollama create qwen3.8:27b-zodiac-proposer -f Modelfile.proposer-lora`).
  3. Under `--mode sft|dpo|both` (default `both`), runs HuggingFace `trl` (`SFTTrainer` and/or `DPOTrainer`)
     with `peft` (`LoraConfig`) and writes `training-run-summary.json` with monotonic nanosecond timing
     (`time.monotonic_ns()`, Invariant 2).

Usage:
  # Offline pre-flight check + Modelfile generation (no GPU / torch required):
  python3 scripts/train-proposer-lora.py --dataset-dir /tmp/zodiac-proposer-lora --out-dir /tmp/zodiac-proposer-lora/out --validate-only

  # Ephemeral cloud GPU run (requires torch, transformers, peft, trl, datasets):
  python3 scripts/train-proposer-lora.py --dataset-dir /tmp/zodiac-proposer-lora --out-dir ./proposer-lora-adapter --mode both
"""

import argparse
import hashlib
import json
import os
import sys
import time

EXPECTED_PROPOSER_SCHEMA = "proposer-lora-dataset/v1"
EXPECTED_REVIEWER_SCHEMA = "reviewer-lora-dataset/v1"
EXPECTED_SOURCE = "synthetic_verifier_grounded"

# Share of --time-budget-seconds the SFT stage may use (integer percent); DPO gets the rest. Named so it is not a buried constant (Invariant 5).
SFT_BUDGET_SHARE_PERCENT = 45
MAX_TIME_BUDGET_SECONDS = 86_400
FORBIDDEN_SUBNET_PREFIX = "10.0.2."
FORBIDDEN_INTENT_IDS = frozenset({
    "port1-isolation/v1",
    "dns-confinement/v1",
    "quarantine-precedence/v1",
    "tap-return-isolation/v1",
})
PINNED_BENCHMARK_SHA256 = frozenset({
    "dbd30d4265caec03e274ad66c9336157969e72f1ba3b30e0f680c72434e780ed",
    "e632d34f157f69ff57016ff3fb06dfe3cbdf0e0c4c898dc66db0e104c1d50041",
    "0fad17b4c7254f0207f986a2e582fb408eb1d061d8e18a96e700bded879679e4",
    "04bf2c63c9b4e2d85abb04154582672594b30d03db3a0b145491342797c08183",
})
EXPECTED_REVIEWER_INVARIANTS = frozenset({
    "INV-1", "INV-2", "INV-3", "INV-4", "INV-5", "INV-6",
    "NET-001", "NET-002", "NET-003", "NET-004", "NET-005", "NET-006", "NET-010",
})

# Configurable, bounded defaults (Invariant 5)
DEFAULT_BASE_MODEL = "Qwen/Qwen3.8-27B"
DEFAULT_OLLAMA_BASE = "qwen3.8:27b"
DEFAULT_LORA_R = 16
DEFAULT_LORA_ALPHA = 32
DEFAULT_SFT_EPOCHS = 1
DEFAULT_DPO_EPOCHS = 1
DEFAULT_BATCH_SIZE = 1
DEFAULT_GRAD_ACCUM = 8
DEFAULT_MAX_SEQ_LEN = 3072
LORA_TARGET_MODULES = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


def validate_dataset_bundle(dataset_dir: str, task: str = "proposer") -> dict:
    summary_path = os.path.join(dataset_dir, "summary.json")
    if not os.path.isfile(summary_path):
        raise ValueError(f"missing summary.json in {dataset_dir}")

    with open(summary_path, "r", encoding="utf-8") as fh:
        summary = json.load(fh)

    expected_schema = EXPECTED_PROPOSER_SCHEMA if task == "proposer" else EXPECTED_REVIEWER_SCHEMA
    if summary.get("schema") != expected_schema:
        raise ValueError(f"unexpected schema {summary.get('schema')!r}; expected {expected_schema!r}")
    if summary.get("source") != EXPECTED_SOURCE:
        raise ValueError(f"unexpected provenance source {summary.get('source')!r}; expected {EXPECTED_SOURCE!r}")

    if task == "proposer":
        recorded_hashes = frozenset(summary.get("heldOutBenchmarkHashes") or [])
        if recorded_hashes != PINNED_BENCHMARK_SHA256:
            raise ValueError("heldOutBenchmarkHashes in summary.json does not match the four pinned benchmark intent hashes")
    else:
        inv_counts = summary.get("invariantCounts")
        covered = frozenset(inv_counts.keys()) if isinstance(inv_counts, dict) else frozenset()
        if not EXPECTED_REVIEWER_INVARIANTS.issubset(covered):
            raise ValueError("invariantCounts in reviewer summary.json is missing required invariants")

    files_meta = summary.get("files")
    if not isinstance(files_meta, dict) or not files_meta:
        raise ValueError("summary.json is missing file checksum metadata")

    for filename, meta in files_meta.items():
        fpath = os.path.join(dataset_dir, filename)
        if not os.path.isfile(fpath):
            raise ValueError(f"missing dataset file {filename}")
        with open(fpath, "rb") as bfh:
            raw_bytes = bfh.read()
        actual_sha = hashlib.sha256(raw_bytes).hexdigest()
        expected_sha = meta.get("sha256")
        if actual_sha != expected_sha:
            raise ValueError(f"sha256 mismatch on {filename}: expected {expected_sha}, got {actual_sha}")

        text = raw_bytes.decode("utf-8")
        lines = [ln for ln in text.splitlines() if ln.strip()]
        expected_rows = meta.get("rows")
        if len(lines) != expected_rows:
            raise ValueError(f"row count mismatch on {filename}: expected {expected_rows}, got {len(lines)}")

        if task == "proposer":
            for idx, ln in enumerate(lines, start=1):
                if FORBIDDEN_SUBNET_PREFIX in ln:
                    raise ValueError(
                        f"train/test contamination in {filename}:{idx}: contains held-out subnet prefix {FORBIDDEN_SUBNET_PREFIX}"
                    )
                obj = json.loads(ln)
                scen_id = obj.get("scenarioId", "")
                row_id = obj.get("id", "")
                if scen_id in FORBIDDEN_INTENT_IDS or row_id in FORBIDDEN_INTENT_IDS:
                    raise ValueError(
                        f"train/test contamination in {filename}:{idx}: id/scenarioId is a benchmark intent"
                    )

    return summary


def write_ollama_modelfile(out_dir: str, ollama_base: str, adapter_subpath: str, task: str = "proposer") -> str:
    os.makedirs(out_dir, exist_ok=True)
    if task == "proposer":
        modelfile_name = "Modelfile.proposer-lora"
        model_tag = "qwen3.8:27b-zodiac-proposer"
        temp = "0.2"
        num_predict = "32768"
    else:
        modelfile_name = "Modelfile.reviewer-lora"
        model_tag = "qwen3.8:27b-zodiac-reviewer"
        temp = "0.0"
        num_predict = "2048"
    modelfile_path = os.path.join(out_dir, modelfile_name)
    content = (
        f"# Generated by scripts/train-proposer-lora.py (--task {task})\n"
        f"# Register on the Mac workstation with:\n"
        f"#   ollama create {model_tag} -f {modelfile_path}\n"
        f"FROM {ollama_base}\n"
        f"ADAPTER {adapter_subpath}\n"
        f"PARAMETER temperature {temp}\n"
        f"PARAMETER top_p 0.95\n"
        f"PARAMETER num_predict {num_predict}\n"
    )
    with open(modelfile_path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return modelfile_path


def _load_base_model(base_model_id: str):
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM

    cfg = AutoConfig.from_pretrained(base_model_id, trust_remote_code=True)
    archs = getattr(cfg, "architectures", None) or []
    model_cls = AutoModelForCausalLM
    if archs:
        candidate = getattr(transformers, archs[0], None)
        if candidate is not None:
            model_cls = candidate
    return model_cls.from_pretrained(
        base_model_id,
        dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )


def _filter_cfg_kwargs(cfg_cls, kwargs: dict) -> dict:
    import inspect

    sig = inspect.signature(cfg_cls.__init__)
    valid = set(sig.parameters.keys())
    out = {}
    for k, v in kwargs.items():
        if k in valid:
            out[k] = v
        elif k == "max_seq_length" and "max_length" in valid:
            out["max_length"] = v
        elif k == "max_length" and "max_seq_length" in valid:
            out["max_seq_length"] = v
    return out


def make_deadline_callback(base_cls, deadline_ns: int, clock=time.monotonic_ns):
    """A Trainer callback that asks training to stop once the monotonic clock reaches `deadline_ns` (Invariant 2: integer monotonic time).

    Stopping is graceful: `train()` returns, the caller saves the adapter, and the steps actually done are recorded, so a pod time limit
    cannot destroy a long run. `base_cls` is `transformers.TrainerCallback` (passed in so this stays importable without GPU packages).
    """

    class DeadlineStop(base_cls):
        def __init__(self) -> None:
            super().__init__()
            self.stopped = False

        def on_step_end(self, args, state, control, **kwargs):
            if clock() >= deadline_ns:
                control.should_training_stop = True
                self.stopped = True
            return control

    return DeadlineStop()


def run_cloud_training(args: argparse.Namespace, dataset_summary: dict, start_ns: int) -> dict:
    # Imported lazily so --validate-only runs in CI without GPU packages installed.
    import gc
    import torch
    from datasets import load_dataset
    from peft import LoraConfig, PeftModel
    from transformers import AutoTokenizer, TrainerCallback
    from trl import DPOConfig, DPOTrainer, SFTConfig, SFTTrainer

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=list(LORA_TARGET_MODULES),
    )

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    budget_ns = args.time_budget_seconds * 1_000_000_000
    sft_deadline_ns = start_ns + budget_ns * SFT_BUDGET_SHARE_PERCENT // 100
    dpo_deadline_ns = start_ns + budget_ns
    sft_steps = dpo_steps = sft_examples = dpo_pairs = None
    sft_stopped = dpo_stopped = False

    sft_out = os.path.join(args.out_dir, "sft-adapter")
    dpo_out = os.path.join(args.out_dir, "dpo-adapter")
    final_adapter = sft_out
    sft_filename = "sft-combined.jsonl" if args.task == "proposer" else "sft-reviewer.jsonl"
    dpo_filename = "dpo-pairs.jsonl" if args.task == "proposer" else "dpo-reviewer.jsonl"

    if args.mode in ("sft", "both"):
        sft_file = os.path.join(args.dataset_dir, sft_filename)
        sft_ds = load_dataset("json", data_files=sft_file, split="train")
        model = _load_base_model(args.base_model)
        sft_kwargs = _filter_cfg_kwargs(
            SFTConfig,
            {
                "output_dir": sft_out,
                "num_train_epochs": args.sft_epochs,
                "max_steps": args.max_steps,
                "per_device_train_batch_size": args.batch_size,
                "gradient_accumulation_steps": args.grad_accum,
                "gradient_checkpointing": True,
                "learning_rate": 2e-4,
                "bf16": True,
                "logging_steps": 10,
                "save_strategy": "no",
                "max_seq_length": args.max_seq_len,
                "seed": args.seed,
                "report_to": "none",
            },
        )
        sft_cfg = SFTConfig(**sft_kwargs)
        sft_cb = make_deadline_callback(TrainerCallback, sft_deadline_ns) if budget_ns > 0 else None
        trainer = SFTTrainer(
            model=model,
            args=sft_cfg,
            train_dataset=sft_ds,
            processing_class=tokenizer,
            peft_config=peft_config,
            callbacks=[sft_cb] if sft_cb else None,
        )
        trainer.train()
        sft_steps = int(trainer.state.global_step)
        sft_examples = len(sft_ds)
        sft_stopped = bool(sft_cb and sft_cb.stopped)
        trainer.save_model(sft_out)
        tokenizer.save_pretrained(sft_out)
        final_adapter = sft_out
        del trainer, model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    if args.mode in ("dpo", "both"):
        dpo_file = os.path.join(args.dataset_dir, dpo_filename)
        dpo_ds = load_dataset("json", data_files=dpo_file, split="train")
        base_model = _load_base_model(args.base_model)
        if args.mode == "both":
            model = PeftModel.from_pretrained(base_model, sft_out, is_trainable=True)
            dpo_peft = None
        else:
            model = base_model
            dpo_peft = peft_config

        dpo_kwargs = _filter_cfg_kwargs(
            DPOConfig,
            {
                "output_dir": dpo_out,
                "num_train_epochs": args.dpo_epochs,
                "max_steps": args.max_steps,
                "per_device_train_batch_size": args.batch_size,
                "gradient_accumulation_steps": args.grad_accum,
                "gradient_checkpointing": True,
                "learning_rate": 5e-5,
                "beta": 0.1,
                "bf16": True,
                "logging_steps": 10,
                "save_strategy": "no",
                "max_length": args.max_seq_len,
                "seed": args.seed,
                "report_to": "none",
            },
        )
        dpo_cfg = DPOConfig(**dpo_kwargs)
        dpo_cb = make_deadline_callback(TrainerCallback, dpo_deadline_ns) if budget_ns > 0 else None
        dpo_trainer = DPOTrainer(
            model=model,
            ref_model=None,
            args=dpo_cfg,
            train_dataset=dpo_ds,
            processing_class=tokenizer,
            peft_config=dpo_peft,
            callbacks=[dpo_cb] if dpo_cb else None,
        )
        dpo_trainer.train()
        dpo_steps = int(dpo_trainer.state.global_step)
        dpo_pairs = len(dpo_ds)
        dpo_stopped = bool(dpo_cb and dpo_cb.stopped)
        dpo_trainer.save_model(dpo_out)
        tokenizer.save_pretrained(dpo_out)
        final_adapter = dpo_out
        del dpo_trainer, model, base_model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    wall_ns = time.monotonic_ns() - start_ns
    modelfile_path = write_ollama_modelfile(
        args.out_dir, args.ollama_base, os.path.relpath(final_adapter, args.out_dir), args.task
    )
    run_report = {
        "schema": f"{args.task}-lora-training-run/v1",
        "task": args.task,
        "source": EXPECTED_SOURCE,
        "baseModel": args.base_model,
        "ollamaBase": args.ollama_base,
        "mode": args.mode,
        "loraR": args.lora_r,
        "loraAlpha": args.lora_alpha,
        "seed": args.seed,
        "datasetGitCommit": dataset_summary.get("gitCommit"),
        "heldOutBenchmarkHashes": dataset_summary.get("heldOutBenchmarkHashes"),
        "batchSize": args.batch_size,
        "gradAccum": args.grad_accum,
        "maxStepsArg": args.max_steps,
        "timeBudgetSeconds": args.time_budget_seconds,
        "sftExamples": sft_examples,
        "sftStepsDone": sft_steps,
        "sftExamplesSeen": None if sft_steps is None else sft_steps * args.batch_size * args.grad_accum,
        "sftStoppedByDeadline": sft_stopped,
        "dpoPairs": dpo_pairs,
        "dpoStepsDone": dpo_steps,
        "dpoPairsSeen": None if dpo_steps is None else dpo_steps * args.batch_size * args.grad_accum,
        "dpoStoppedByDeadline": dpo_stopped,
        "finalAdapterDir": final_adapter,
        "modelfile": modelfile_path,
        "wallNs": str(wall_ns),
    }
    with open(os.path.join(args.out_dir, "training-run-summary.json"), "w", encoding="utf-8") as fh:
        json.dump(run_report, fh, indent=2)
        fh.write("\n")
    return run_report


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Validate dataset and run LoRA SFT/DPO training for Zodiac proposer or reviewer.")
    ap.add_argument("--task", choices=("proposer", "reviewer"), default="proposer", help="Target LoRA adapter task")
    ap.add_argument("--dataset-dir", required=True, help="Directory containing summary.json and JSONL files")
    ap.add_argument("--out-dir", required=True, help="Output directory for adapter weights and Modelfile")
    ap.add_argument("--mode", choices=("sft", "dpo", "both"), default="both")
    ap.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    ap.add_argument("--ollama-base", default=DEFAULT_OLLAMA_BASE)
    ap.add_argument("--lora-r", type=int, default=DEFAULT_LORA_R)
    ap.add_argument("--lora-alpha", type=int, default=DEFAULT_LORA_ALPHA)
    ap.add_argument("--sft-epochs", type=int, default=DEFAULT_SFT_EPOCHS)
    ap.add_argument("--dpo-epochs", type=int, default=DEFAULT_DPO_EPOCHS)
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    ap.add_argument("--grad-accum", type=int, default=DEFAULT_GRAD_ACCUM)
    ap.add_argument("--max-seq-len", type=int, default=DEFAULT_MAX_SEQ_LEN)
    ap.add_argument("--max-steps", type=int, default=-1, help="Optional cap on training steps (-1 for full epochs)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--time-budget-seconds", type=int, default=0, help="Wall-clock budget for both stages from process start; training stops gracefully and the adapter is saved when it is reached (0 = no budget)")
    ap.add_argument("--validate-only", action="store_true", help="Run fail-closed dataset checks and write Modelfile without GPU training")
    args = ap.parse_args(argv)
    if not 0 <= args.time_budget_seconds <= MAX_TIME_BUDGET_SECONDS:
        ap.error(f"--time-budget-seconds must be 0 to {MAX_TIME_BUDGET_SECONDS}")
    return args


def main() -> None:
    start_ns = time.monotonic_ns()
    args = parse_args(sys.argv[1:])
    summary = validate_dataset_bundle(args.dataset_dir, args.task)

    if args.validate_only:
        adapter_rel = "./dpo-adapter" if args.mode in ("dpo", "both") else "./sft-adapter"
        modelfile_path = write_ollama_modelfile(args.out_dir, args.ollama_base, adapter_rel, args.task)
        wall_ns = time.monotonic_ns() - start_ns
        out = {
            "ok": True,
            "task": args.task,
            "validatedFiles": list(summary["files"].keys()),
            "dpoPairCount": summary["dpoPairCount"],
            "modelfile": modelfile_path,
            "wallNs": str(wall_ns),
        }
        sys.stdout.write(json.dumps(out, indent=2) + "\n")
        return

    report = run_cloud_training(args, summary, start_ns)
    sys.stdout.write(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stderr.write(f"FATAL: {exc}\n")
        sys.exit(1)

