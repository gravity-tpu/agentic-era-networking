"""
scripts/runpod/merge-lora.py
Merge a PEFT LoRA adapter into the bf16 base weights (or, with --adapter none, only reload and re-save
the base: the pipeline control arm C3 of docs/research/evaluation-plan.md section 11). Runs on a GPU pod.

Invariant 6: writes merge-record.json (base id, adapter dir and the SHA-256 of adapter_model.safetensors,
or null for the control) next to the merged weights so the arm is traceable.
"""
import argparse
import hashlib
import json
import os


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_base(base_id: str):
    # Same class selection as scripts/train-proposer-lora.py::_load_base_model.
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM

    cfg = AutoConfig.from_pretrained(base_id, trust_remote_code=True)
    archs = getattr(cfg, "architectures", None) or []
    model_cls = AutoModelForCausalLM
    if archs:
        candidate = getattr(transformers, archs[0], None)
        if candidate is not None:
            model_cls = candidate
    return model_cls.from_pretrained(base_id, dtype=torch.bfloat16, device_map="auto", trust_remote_code=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen3.8-27B")
    ap.add_argument("--adapter", required=True, help="adapter directory, or 'none' for the control")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    from huggingface_hub import snapshot_download
    from transformers import AutoTokenizer

    model = load_base(args.base)
    adapter_sha = None
    if args.adapter != "none":
        from peft import PeftModel

        weights = os.path.join(args.adapter, "adapter_model.safetensors")
        adapter_sha = sha256_file(weights)
        model = PeftModel.from_pretrained(model, args.adapter).merge_and_unload()
    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out, safe_serialization=True)
    AutoTokenizer.from_pretrained(args.base, trust_remote_code=True).save_pretrained(args.out)
    # Config-like side files the GGUF converter may need (processor, chat template), never the weight index.
    snapshot_download(
        args.base,
        local_dir=args.out,
        allow_patterns=["*.json", "*.txt", "*.jinja", "*.model"],
        ignore_patterns=["model.safetensors.index.json"],
    )
    with open(os.path.join(args.out, "merge-record.json"), "w") as f:
        json.dump({"base": args.base, "adapter": None if args.adapter == "none" else args.adapter,
                   "adapterSafetensorsSha256": adapter_sha}, f, indent=2)


if __name__ == "__main__":
    main()
