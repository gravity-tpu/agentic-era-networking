"""
main.py
=======
FastAPI Neural Inference Microservice for Raspberry Pi 5 + Hailo-8 NPU (26 TOPS).

Council Invariants:
- INV-1 (Anti-Shortcut Law): Explicit deterministic error handling at every boundary.
- INV-2 (Determinism): Pure monotonic nanosecond timings and integer counters.
- INV-3 (Fail-Closed Isolation): Pydantic input validation, reject unrecognized input.
- INV-6 (Goodhart's Law & Epistemic Provenance): Ground truth silicon telemetry directly from NPU.
"""

import base64
import os
import sys
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File, Query, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse

from schemas import (
    InferRequest,
    InferResponse,
    ModelListResponse,
    LoadModelRequest,
    LoadModelResponse,
    FullTelemetryResponse,
    BenchmarkRequest,
    BenchmarkResponse,
)
from telemetry import TelemetryProvider
from inference_engine import InferenceEngine, DEFAULT_MODELS_DIR
from benchmark import run_hardware_benchmark
from playground_html import INTERACTIVE_PLAYGROUND_HTML

DEFAULT_MODEL = "yolov8s_h8.hef"
MAX_PAYLOAD_BYTES = 10 * 1024 * 1024       # 10 MB fail-closed upper bound
READ_CHUNK_SIZE = 64 * 1024                # 64 KB streaming chunks

# Global singleton managers
telemetry: Optional[TelemetryProvider] = None
engine: Optional[InferenceEngine] = None


def init_service():
    """Idempotent initialization of hardware controllers and model pipeline."""
    global telemetry, engine
    if telemetry is None:
        telemetry = TelemetryProvider()
    if engine is None:
        engine = InferenceEngine(models_dir=DEFAULT_MODELS_DIR)
        default_path = os.path.join(DEFAULT_MODELS_DIR, DEFAULT_MODEL)
        if os.path.exists(default_path):
            load_ns = engine.load_model(default_path)
            telemetry.set_active_model(DEFAULT_MODEL)
            sys.stdout.write(f"[HailoService] Preloaded {DEFAULT_MODEL} in {load_ns/1e6:.2f} ms\n")
        else:
            sys.stdout.write(f"[HailoService] Default model {default_path} not found; awaiting load request\n")


# Eager initialization on module load (INV-1 Zero Suppression / INV-3 Fail-Closed):
# Never swallow exceptions; any hardware failure must crash the process immediately
# so systemd can enforce restart backoff instead of entering a degraded zombie state.
init_service()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for hardware controllers and model pipeline."""
    global engine
    init_service()
    yield
    if engine is not None:
        engine.close()
        sys.stdout.write("[HailoService] Hardware pipeline shutdown cleanly\n")


app = FastAPI(
    title="Zodiac Hailo-8 Neural Inference Service",
    description="Autonomous verifiable edge neural inference microservice on Raspberry Pi 5 + Hailo-8 M.2 (26 TOPS).",
    version="1.0.0",
    lifespan=lifespan,
)

# Whitelisted CORS origins (INV-3 Fail-Closed Isolation & Quoc Le anti-heuristics rule):
# Default strictly to local loopback; subnet/operator origins configured via HAILO_CORS_ORIGINS env.
DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]
cors_origins_env = os.environ.get("HAILO_CORS_ORIGINS")
allowed_origins = [o.strip() for o in cors_origins_env.split(",") if o.strip()] if cors_origins_env else DEFAULT_CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "User-Agent"],
)






@app.get("/", tags=["Info"])
def get_root():
    """Root metadata and microservice status."""
    global engine, telemetry
    active_m = engine.active_model_name if engine else None
    tot_inf = telemetry.total_inferences if telemetry else 0
    return {
        "service": "Zodiac Hailo-8 Neural Inference Microservice",
        "version": "1.0.0",
        "node": "agentic-node-02 (RPi 5 + Hailo-8)",
        "accelerator": "Hailo-8 M.2 (26 TOPS NPU)",
        "status": "ONLINE",
        "active_model": active_m,
        "total_inferences": tot_inf,
        "interactive_playground": "/infer",
        "swagger_docs": "/docs",
        "redoc": "/redoc",
    }


@app.get("/health", tags=["Telemetry"])
def get_health():
    """Liveness check and physical silicon connectivity verification."""
    global telemetry, engine
    if telemetry is None or engine is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service initializing")

    ts0, ts1, _ = telemetry.get_chip_temperature()
    if ts0 is None:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "status": "DEGRADED",
                "hailo_device": "DISCONNECTED",
                "message": "Unable to query Hailo-8 thermal sensor",
            },
        )

    return {
        "status": "HEALTHY",
        "hailo_device": "CONNECTED",
        "chip_ts0_c": ts0,
        "chip_ts1_c": ts1,
        "active_model": engine.active_model_name,
    }


@app.get("/telemetry", response_model=FullTelemetryResponse, tags=["Telemetry"])
def get_telemetry():
    """Return complete epistemic telemetry (INV-6 physical provenance)."""
    global telemetry
    if telemetry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Telemetry provider unready")
    return telemetry.get_full_telemetry()


@app.get("/models", response_model=ModelListResponse, tags=["Models"])
def list_models():
    """List all available HEF models on host storage and current active model."""
    global engine
    if engine is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Engine unready")
    models = engine.list_available_models()
    return ModelListResponse(active_model=engine.active_model_name, models=models)


@app.post("/models/load", response_model=LoadModelResponse, tags=["Models"])
def load_model(req: LoadModelRequest):
    """Dynamically configure and activate a specified HEF compiled model."""
    global engine, telemetry
    if engine is None or telemetry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Engine unready")

    try:
        load_duration_ns = engine.load_model(req.model_name)
        telemetry.set_active_model(engine.active_model_name)
        return LoadModelResponse(
            success=True,
            active_model=engine.active_model_name or req.model_name,
            load_duration_ns=load_duration_ns,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except Exception as e:
        sys.stderr.write(f"[HailoService] Failed loading model {req.model_name}: {e}\n")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed loading model: {e}")


@app.get("/infer", include_in_schema=False)
def infer_get(request: Request):
    """
    Handle GET requests to /infer.
    If requested from a web browser (Accept includes text/html), serve the interactive Neural Playground.
    Otherwise, return an informative HTTP 405 response explaining how to POST.
    """
    accept_header = request.headers.get("accept", "").lower()
    if "text/html" in accept_header:
        return HTMLResponse(content=INTERACTIVE_PLAYGROUND_HTML)
    return JSONResponse(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        content={
            "detail": "Method Not Allowed. /infer requires an HTTP POST request with an image payload.",
            "interactive_playground": "Open /infer in a web browser for the graphical playground or /docs for Swagger UI.",
            "endpoints": {
                "upload_file": "POST /infer/upload (multipart/form-data)",
                "json_payload": "POST /infer (application/json with image_b64)",
                "swagger_docs": "/docs",
                "telemetry": "/telemetry",
            },
            "example_curl": "curl -X POST http://<host>:8000/infer/upload -F 'file=@image.jpg'",
        },
    )


@app.get("/playground", response_class=HTMLResponse, tags=["Inference"])
def get_playground():
    """Interactive Neural Inference Playground web UI."""
    return HTMLResponse(content=INTERACTIVE_PLAYGROUND_HTML)


@app.post("/infer", response_model=InferResponse, tags=["Inference"])
def infer_json(req: InferRequest):
    """
    Execute neural inference from JSON payload with base64 image.
    Synchronous def routed to Starlette threadpool to avoid event loop starvation.
    """
    global engine, telemetry
    if engine is None or telemetry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Engine unready")
    if engine.pipeline is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model currently active. Call /models/load first.",
        )

    # Decode base64 image bytes with size bounding
    try:
        b64_data = req.image_b64
        if "," in b64_data:
            b64_data = b64_data.split(",", 1)[1]
        if len(b64_data) > (MAX_PAYLOAD_BYTES * 4 // 3 + 1024):
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Base64 payload exceeds maximum size limit ({MAX_PAYLOAD_BYTES} bytes)",
            )
        image_bytes = base64.b64decode(b64_data)
        if len(image_bytes) > MAX_PAYLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Decoded image exceeds maximum size limit ({MAX_PAYLOAD_BYTES} bytes)",
            )
    except HTTPException:
        raise
    except Exception as e:
        sys.stderr.write(f"[HailoService] Base64 decode error: {e}\n")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid base64 payload: {e}")

    try:
        res = engine.infer_image(
            image_bytes=image_bytes,
            conf_thresh=req.confidence_threshold,
            iou_thresh=req.iou_threshold,
            render_annotated=req.render_annotated,
        )
        telemetry.record_inference(res.timing.inference_ns)
        ts0, _, _ = telemetry.get_chip_temperature()
        res.chip_temp_c = ts0
        return res
    except TimeoutError as e:
        sys.stderr.write(f"[HailoService] PCIe DMA lock timeout: {e}\n")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        sys.stderr.write(f"[HailoService] Inference execution error: {e}\n")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Inference failure: {e}")


@app.post("/infer/upload", response_model=InferResponse, tags=["Inference"])
def infer_upload(
    file: UploadFile = File(..., description="Image file (JPEG, PNG, WebP)"),
    confidence_threshold: float = Query(0.3, ge=0.0, le=1.0),
    iou_threshold: float = Query(0.45, ge=0.0, le=1.0),
    render_annotated: bool = Query(False),
):
    """
    Execute neural inference on a multipart form image file upload.
    Synchronous def routed to Starlette threadpool; bounded streaming read to prevent OOM.
    """
    global engine, telemetry
    if engine is None or telemetry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Engine unready")
    if engine.pipeline is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model currently active. Call /models/load first.",
        )

    try:
        buf = bytearray()
        while True:
            chunk = file.file.read(READ_CHUNK_SIZE)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > MAX_PAYLOAD_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"Uploaded file exceeds maximum limit of {MAX_PAYLOAD_BYTES} bytes",
                )
        image_bytes = bytes(buf)

        res = engine.infer_image(
            image_bytes=image_bytes,
            conf_thresh=confidence_threshold,
            iou_thresh=iou_threshold,
            render_annotated=render_annotated,
        )
        telemetry.record_inference(res.timing.inference_ns)
        ts0, _, _ = telemetry.get_chip_temperature()
        res.chip_temp_c = ts0
        return res
    except HTTPException:
        raise
    except TimeoutError as e:
        sys.stderr.write(f"[HailoService] PCIe DMA lock timeout: {e}\n")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        sys.stderr.write(f"[HailoService] Upload inference error: {e}\n")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Inference failure: {e}")


@app.post("/benchmark", response_model=BenchmarkResponse, tags=["Hardware Performance"])
def benchmark_model(req: BenchmarkRequest):
    """
    Execute hardware streaming benchmark on Hailo-8 NPU using native hailortcli.
    Measures aggregate frame throughput (FPS), PCIe DMA bandwidth, and thermal rise.
    """
    global engine
    if engine is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Engine unready")

    # Resolve HEF path with strict path traversal defense (INV-3 Fail-Closed)
    raw_name = req.model_name or DEFAULT_MODEL
    safe_name = os.path.basename(raw_name.strip())
    if not safe_name.endswith(".hef"):
        safe_name += ".hef"

    models_dir_abs = os.path.abspath(DEFAULT_MODELS_DIR)
    hef_path = os.path.abspath(os.path.join(models_dir_abs, safe_name))
    common = os.path.commonpath([models_dir_abs, hef_path])
    if common != models_dir_abs or not hef_path.startswith(models_dir_abs + os.sep):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Path traversal in model name rejected")

    if not os.path.isfile(hef_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Model not found in catalog: {safe_name}")

    # Release VDevice lock so hailortcli has direct hardware access
    engine.release_device()
    try:
        bench_res = run_hardware_benchmark(
            hef_path=hef_path,
            seconds=req.seconds,
            measure_latency=req.measure_latency,
        )
        return bench_res
    except Exception as e:
        sys.stderr.write(f"[HailoService] Benchmark failure: {e}\n")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Benchmark error: {e}")
    finally:
        # Re-acquire VDevice and restore pipeline state
        engine.reacquire_device()
