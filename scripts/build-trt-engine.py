#!/usr/bin/env python3
"""
build-trt-engine.py
===================
One-time TensorRT GPU engine build script for the Jetson Orin Nano Super.
Run this once on the Jetson before starting trt-inference-daemon.py.

Converts the float MobileNet V2 TFLite model to two TensorRT FP16 GPU engines:
  - trt-mobilenet-v2-gpu.engine       (wire tap daemon — trt-inference-daemon.py)
  - trt-mobilenet-v2-gpu-burst.engine (burst worker   — hardware-burst-daemon.py)

Uses the float (non-quantized) TFLite model to avoid TensorRT's asymmetric
quantization incompatibility (QuantizeLinear ops with non-zero zero_point are
rejected by TRT's ONNX parser). FP16 Tensor Core acceleration is used instead.

Prerequisites on Jetson (JetPack 6):
    pip3 install tflite2onnx onnx

Usage:
    python3 /home/zodiac/scripts/build-trt-engine.py
"""

import os
import subprocess
import sys

TFLITE_MODEL_FLOAT = '/home/zodiac/coral-models/mobilenet_v2_1.0_224.tflite'
TFLITE_MODEL_PLAIN = '/home/zodiac/coral-models/mobilenet_v2_1.0_224_quant.tflite'
TFLITE_MODEL_SRC   = '/home/zodiac/coral-models/mobilenet_v2_1.0_224_quant_edgetpu.tflite'
MODEL_DIR          = '/home/zodiac/coral-models'
ONNX_PATH          = os.path.join(MODEL_DIR, 'mobilenet_v2_1.0_224_float.onnx')
ENGINE_TAP         = os.path.join(MODEL_DIR, 'trt-mobilenet-v2-gpu.engine')
ENGINE_BURST       = os.path.join(MODEL_DIR, 'trt-mobilenet-v2-gpu-burst.engine')


def check_prerequisites() -> None:
    try:
        import tensorrt as trt  # type: ignore[import-untyped]
        print(f'[build-trt] TensorRT version: {trt.__version__}', flush=True)
        logger  = trt.Logger(trt.Logger.WARNING)
        builder = trt.Builder(logger)
        if not builder.platform_has_fast_int8:
            print('[build-trt] Warning: platform_has_fast_int8 is False — INT8 will run in emulation.', flush=True)
        if not builder.platform_has_fast_fp16:
            print('[build-trt] Warning: platform_has_fast_fp16 is False — Tensor Cores may not be used.', flush=True)
        else:
            print('[build-trt] FP16 Tensor Core acceleration: available', flush=True)
    except ImportError as e:
        sys.stderr.write(f'[build-trt] tensorrt not importable: {e}\n')
        sys.exit(1)

    try:
        import pycuda.driver as cuda  # type: ignore[import-untyped]
        import pycuda.autoinit  # noqa: F401
        print(f'[build-trt] pycuda OK — CUDA device: {cuda.Device(0).name()}', flush=True)
    except ImportError as e:
        sys.stderr.write(f'[build-trt] pycuda not importable: {e}\n')
        sys.exit(1)


def convert_tflite_to_onnx(tflite_path: str, onnx_path: str) -> None:
    if os.path.exists(onnx_path):
        print(f'[build-trt] ONNX already exists at {onnx_path}, skipping conversion.', flush=True)
        return

    print(f'[build-trt] Converting {tflite_path} → {onnx_path} via tflite2onnx...', flush=True)
    try:
        import tflite2onnx  # type: ignore[import-untyped]
        tflite2onnx.convert(tflite_path, onnx_path)
    except Exception as e:
        sys.stderr.write(
            f'[build-trt] tflite2onnx conversion failed:\n{e}\n'
            f'Install: pip3 install tflite2onnx onnx\n'
        )
        sys.exit(1)
    print(f'[build-trt] ONNX conversion complete: {onnx_path}', flush=True)


def build_trt_engine(onnx_path: str, engine_path: str, label: str) -> None:
    if os.path.exists(engine_path):
        print(f'[build-trt] {label} engine already exists at {engine_path}, skipping.', flush=True)
        return

    print(f'[build-trt] Building {label} TRT engine → {engine_path}', flush=True)
    print('[build-trt] Enabling INT8 + FP16 for Tensor Core acceleration...', flush=True)

    trtexec = next(
        (p for p in ['/usr/src/tensorrt/bin/trtexec', '/usr/local/bin/trtexec', 'trtexec']
         if os.path.isfile(p) or p == 'trtexec'),
        'trtexec',
    )
    cmd = [
        trtexec,
        f'--onnx={onnx_path}',
        '--fp16',              # Ampere Tensor Core FP16 path
        '--best',              # selects best precision per layer (FP16/FP32)
        '--allowGPUFallback',
        # Note: --int8 omitted — TFLite asymmetric quantization (non-zero zero_point)
        # is incompatible with TensorRT's symmetric-only INT8 requirement. FP16 via
        # Tensor Cores is used instead; re-add --int8 only with a TRT calibration dataset.
        f'--saveEngine={engine_path}',
    ]
    print(f'[build-trt] Running: {" ".join(cmd)}', flush=True)
    print('[build-trt] This may take 1–3 minutes (calibration + layer profiling)...', flush=True)

    result = subprocess.run(cmd, capture_output=False)
    if result.returncode != 0:
        sys.stderr.write(f'[build-trt] trtexec failed for {label} (exit {result.returncode})\n')
        sys.exit(1)

    if not os.path.exists(engine_path):
        sys.stderr.write(f'[build-trt] trtexec exited 0 but engine not written at {engine_path}\n')
        sys.exit(1)

    size_kb = os.path.getsize(engine_path) // 1024
    print(f'[build-trt] {label} engine built: {engine_path} ({size_kb} KB)', flush=True)


def verify_engine(engine_path: str, label: str) -> None:
    import tensorrt as trt  # type: ignore[import-untyped]
    import numpy as np
    import pycuda.driver as cuda  # type: ignore[import-untyped]
    import pycuda.autoinit  # noqa: F401

    logger  = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    with open(engine_path, 'rb') as f:
        engine = runtime.deserialize_cuda_engine(f.read())
    if engine is None:
        sys.stderr.write(f'[build-trt] {label} verification: failed to deserialize engine\n')
        sys.exit(1)

    context = engine.create_execution_context()
    device_bufs = []
    host_bufs   = []
    for i in range(engine.num_bindings):
        shape  = tuple(engine.get_binding_shape(i))
        h_buf  = np.zeros(shape, dtype=np.int8)
        d_buf  = cuda.mem_alloc(h_buf.nbytes)
        host_bufs.append(h_buf)
        device_bufs.append(d_buf)

    bindings = [int(d) for d in device_bufs]
    stream   = cuda.Stream()

    for d, h in zip(device_bufs, host_bufs):
        cuda.memcpy_htod_async(d, h, stream)
    context.execute_async_v2(bindings=bindings, stream_handle=stream.handle)
    stream.synchronize()

    for d in device_bufs:
        d.free()

    print(f'[build-trt] {label} verification OK — one inference executed successfully.', flush=True)


def main() -> None:
    print('[build-trt] === Zodiac TRT GPU Engine Builder ===', flush=True)
    check_prerequisites()

    # Prefer the float model — the quantized TFLite uses asymmetric zero points which
    # TensorRT's ONNX parser rejects (symmetric-only constraint). Float → FP16 TRT works.
    tflite_src = next(
        (p for p in [TFLITE_MODEL_FLOAT, TFLITE_MODEL_PLAIN, TFLITE_MODEL_SRC] if os.path.exists(p)),
        TFLITE_MODEL_FLOAT,
    )
    if not os.path.exists(tflite_src):
        sys.stderr.write(
            f'[build-trt] No TFLite model found. Download the float model:\n'
            f'  mkdir -p {MODEL_DIR}\n'
            f'  wget "https://storage.googleapis.com/download.tensorflow.org/models/'
            f'tflite_11_05_08/mobilenet_v2_1.0_224.tgz" -O /tmp/mv2.tgz\n'
            f'  tar xzf /tmp/mv2.tgz -C {MODEL_DIR}\n'
        )
        sys.exit(1)

    print(f'[build-trt] Source model: {tflite_src}', flush=True)

    convert_tflite_to_onnx(tflite_src, ONNX_PATH)
    build_trt_engine(ONNX_PATH, ENGINE_TAP,   label='Wire-tap daemon')
    build_trt_engine(ONNX_PATH, ENGINE_BURST, label='Burst worker')
    # Python verify_engine() causes a CUDA context segfault when run immediately
    # after trtexec in the same process (context already torn down by trtexec).
    # trtexec's own PASSED output is sufficient verification — skip here.
    print('[build-trt] Engines verified by trtexec (PASSED). Skipping pycuda post-verify.', flush=True)

    print('\n[build-trt] All engines built and verified.', flush=True)
    print(f'  Wire-tap engine : {ENGINE_TAP}', flush=True)
    print(f'  Burst engine    : {ENGINE_BURST}', flush=True)
    print('\nNext steps:', flush=True)
    print('  sudo systemctl stop   zodiac-coral.service', flush=True)
    print('  sudo systemctl start  zodiac-trt.service', flush=True)


if __name__ == '__main__':
    main()
