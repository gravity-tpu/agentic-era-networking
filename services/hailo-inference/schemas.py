"""
Pydantic schemas for the Hailo-8 Neural Inference Microservice.

Council Invariants:
- INV-1 (Anti-Shortcut Law): Complete strongly-typed schemas, zero unvalidated loose dicts.
- INV-2 (Determinism): Timestamps in monotonic nanoseconds, integer nanosecond timings.
- INV-3 (Fail-Closed Isolation): Strict input validation, default-drop invalid payloads.
- INV-6 (Goodhart's Law & Epistemic Provenance): Explicit physical silicon telemetry attributes.
"""

from typing import List, Optional, Dict, Union
from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    """Normalized [0, 1] and pixel coordinates of detected bounding box."""
    ymin: float = Field(..., description="Normalized Y min [0.0, 1.0]")
    xmin: float = Field(..., description="Normalized X min [0.0, 1.0]")
    ymax: float = Field(..., description="Normalized Y max [0.0, 1.0]")
    xmax: float = Field(..., description="Normalized X max [0.0, 1.0]")
    ymin_px: int = Field(..., description="Absolute pixel Y min")
    xmin_px: int = Field(..., description="Absolute pixel X min")
    ymax_px: int = Field(..., description="Absolute pixel Y max")
    xmax_px: int = Field(..., description="Absolute pixel X max")


class Detection(BaseModel):
    """Single object detection candidate."""
    class_id: int = Field(..., description="COCO or model class index")
    class_name: str = Field(..., description="Human-readable label")
    confidence: float = Field(..., description="Detection confidence score [0.0, 1.0]")
    bbox: BoundingBox


class ClassificationPrediction(BaseModel):
    """Classification candidate with rank and score."""
    class_id: int
    class_name: Optional[str] = None
    confidence: float


class InferRequest(BaseModel):
    """JSON inference request with base64 encoded image."""
    image_b64: str = Field(..., description="Base64 encoded JPEG/PNG image")
    confidence_threshold: float = Field(0.3, ge=0.0, le=1.0, description="Minimum confidence threshold")
    iou_threshold: float = Field(0.45, ge=0.0, le=1.0, description="NMS IOU suppression threshold")
    render_annotated: bool = Field(False, description="Whether to return base64 annotated image with bounding boxes")


class TimingStats(BaseModel):
    """Monotonic nanosecond execution latency breakdown."""
    preprocess_ns: int = Field(..., description="Image decode, color conversion, and resize latency (ns)")
    inference_ns: int = Field(..., description="Direct Hailo-8 PCIe DMA hardware inference latency (ns)")
    postprocess_ns: int = Field(..., description="NMS coordinate extraction and bounding box formatting latency (ns)")
    total_ns: int = Field(..., description="End-to-end execution latency (ns)")


class InferResponse(BaseModel):
    """Inference response with verified physical hardware latency."""
    success: bool
    model: str
    source: str = "rpi5_hailo8_npu"
    timestamp_ns: int = Field(..., description="Monotonic nanosecond timestamp of completion")
    timing: TimingStats
    chip_temp_c: Optional[float] = Field(None, description="Hailo-8 silicon temperature (°C) at inference completion")
    detections: Optional[List[Detection]] = None
    classifications: Optional[List[ClassificationPrediction]] = None
    raw_outputs: Optional[Dict[str, Dict[str, Union[List[int], str]]]] = None
    annotated_image_b64: Optional[str] = None


class StreamInfoSchema(BaseModel):
    """Stream specification metadata for an input/output layer."""
    name: str
    shape: List[int]
    format_type: str
    format_order: str


class ModelInfo(BaseModel):
    """HEF compiled model metadata."""
    name: str
    filename: str
    path: str
    size_bytes: int
    network_groups: List[str]
    inputs: List[StreamInfoSchema]
    outputs: List[StreamInfoSchema]
    is_active: bool = False


class ModelListResponse(BaseModel):
    """Available and active models."""
    active_model: Optional[str]
    models: List[ModelInfo]


class LoadModelRequest(BaseModel):
    """Request to dynamically activate a compiled HEF model."""
    model_name: str = Field(..., description="Filename or name of the model in /usr/share/hailo-models/")


class LoadModelResponse(BaseModel):
    """Confirmation of model configuration and activation."""
    success: bool
    active_model: str
    load_duration_ns: int


class SiliconTelemetry(BaseModel):
    """Direct hardware telemetry extracted from Hailo-8 NPU controller."""
    device_id: str
    board_name: str
    architecture: str
    firmware_version: str
    neural_network_core_clock_rate_mhz: float
    boot_source: str
    soc_id: Optional[str] = None
    ult_id: Optional[str] = None
    ts0_temp_c: Optional[float] = None
    ts1_temp_c: Optional[float] = None
    temp_sample_count: Optional[int] = None


class HostTelemetry(BaseModel):
    """Physical telemetry of the Raspberry Pi 5 carrier host."""
    hostname: str
    cpu_temp_c: Optional[float]
    load_avg_1m: float
    load_avg_5m: float
    load_avg_15m: float
    ram_total_bytes: int
    ram_available_bytes: int
    pcie_current_link_speed: str
    pcie_current_link_width: str
    pcie_max_link_speed: str
    pcie_max_link_width: str


class ServiceCounters(BaseModel):
    """Accounting counters maintained by the service."""
    uptime_ns: int
    total_inferences: int
    total_inference_ns: int
    active_model: Optional[str]


class NetworkInterfaceTelemetry(BaseModel):
    """Physical network interface telemetry from Linux kernel."""
    name: str
    role: str
    mac_address: str
    ip_address: Optional[str] = None
    status: str
    speed_mbps: int = 0
    rx_bytes: int = 0
    tx_bytes: int = 0
    rx_packets: int = 0
    tx_packets: int = 0
    rx_dropped: int = 0
    tx_dropped: int = 0
    rx_errors: int = 0
    tx_errors: int = 0


class FullTelemetryResponse(BaseModel):
    """Unified telemetry schema satisfying Epistemic Provenance (INV-6)."""
    source: str = "rpi5_hailo8_npu"
    timestamp_ns: int
    silicon: SiliconTelemetry
    host: HostTelemetry
    counters: ServiceCounters
    interfaces: List[NetworkInterfaceTelemetry] = Field(default_factory=list)


class BenchmarkRequest(BaseModel):
    """Request to execute streaming hardware benchmark."""
    model_name: Optional[str] = Field("yolov8s_h8.hef", description="Model to benchmark")
    seconds: int = Field(3, ge=1, le=30, description="Benchmark duration in seconds")
    measure_latency: bool = Field(False, description="Measure single-frame HW latency (reduces aggregate FPS)")


class BenchmarkResponse(BaseModel):
    """Aggregate hardware benchmark performance metrics (pure integer accounting INV-2)."""
    source: str = "rpi5_hailo8_npu"
    model_name: str
    frames_count: int
    duration_ns: int
    fps_milli: int = Field(..., description="Throughput in integer milliframes per second (frames * 1000 / sec)")
    hw_latency_ns: Optional[int] = Field(None, description="Physical hardware inference latency in integer nanoseconds")
    temp_min_c: Optional[float] = None
    temp_avg_c: Optional[float] = None
    temp_max_c: Optional[float] = None
    raw_output: str
