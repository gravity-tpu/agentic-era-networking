"""
inference_engine.py
===================
High-performance inference engine for Hailo-8 NPU on Raspberry Pi 5.

Council Invariants:
- INV-1 (Anti-Shortcut Law): Explicit deterministic error handling, zero swallowed exceptions.
- INV-2 (Determinism): Pure integer monotonic nanoseconds (time.perf_counter_ns()) for latency.
- INV-3 (Fail-Closed Isolation): Validates input shapes and bounds; rejects corrupt payloads.
- INV-5 (Adaptive Control & Concurrency): Thread lock protects PCIe DMA channels across requests.
- INV-6 (Epistemic Provenance): Pure hardware execution on 26 TOPS Hailo-8 silicon.
"""

import base64
import glob
import io
import os
import sys
import threading
import time
from typing import List, Optional, Dict, Any, Tuple

import cv2
import numpy as np
from PIL import Image

from hailo_platform import (
    HEF,
    VDevice,
    ConfigureParams,
    InferVStreams,
    InputVStreamParams,
    OutputVStreamParams,
    FormatType,
    HailoStreamInterface,
)

from coco_classes import get_class_name
from schemas import (
    Detection,
    BoundingBox,
    ClassificationPrediction,
    StreamInfoSchema,
    ModelInfo,
    TimingStats,
    InferResponse,
)

DEFAULT_MODELS_DIR = "/usr/share/hailo-models"
DEFAULT_LOCK_TIMEOUT_SEC = float(os.environ.get("HAILO_LOCK_TIMEOUT_SEC", "5.0"))


class InferenceEngine:
    """Manages VDevice hardware context, dynamic HEF compilation, and PCIe streaming."""

    def __init__(self, models_dir: str = DEFAULT_MODELS_DIR):
        self.models_dir = models_dir
        self.lock = threading.Lock()

        # VDevice singleton and active model state
        self.vdevice: Optional[VDevice] = None
        self.active_model_name: Optional[str] = None
        self.active_hef_path: Optional[str] = None

        # Active pipeline contexts
        self.hef: Optional[HEF] = None
        self.network_group = None
        self.network_group_params = None
        self.vstream_context = None
        self.pipeline = None
        self.activation_context = None

        # Cached input stream parameters
        self.input_name: Optional[str] = None
        self.input_shape: Tuple[int, int, int] = (640, 640, 3)
        self.output_names: List[str] = []
        self.is_nms_detector: bool = False
        self.teardown_errors_count: int = 0

        self._init_device()

    def _init_device(self) -> None:
        """Allocate physical VDevice context."""
        with self.lock:
            if self.vdevice is None:
                self.vdevice = VDevice()

    def release_device(self) -> None:
        """Temporarily release VDevice (e.g., for standalone hailortcli execution)."""
        with self.lock:
            self._unload_active_model_unlocked()
            if self.vdevice is not None:
                self.vdevice.release()
                self.vdevice = None

    def reacquire_device(self) -> None:
        """Re-acquire VDevice and restore previous active model if any."""
        with self.lock:
            if self.vdevice is None:
                self.vdevice = VDevice()
            if self.active_model_name and self.active_hef_path:
                self._load_model_unlocked(self.active_hef_path)

    def list_available_models(self) -> List[ModelInfo]:
        """Scan models directory and inspect input/output layer contracts."""
        models: List[ModelInfo] = []
        if not os.path.exists(self.models_dir):
            return models

        for path in sorted(glob.glob(os.path.join(self.models_dir, "*.hef"))):
            fname = os.path.basename(path)
            size = os.path.getsize(path)
            try:
                temp_hef = HEF(path)
                ng_names = temp_hef.get_network_group_names()
                inputs: List[StreamInfoSchema] = []
                outputs: List[StreamInfoSchema] = []

                for info in temp_hef.get_input_vstream_infos():
                    inputs.append(
                        StreamInfoSchema(
                            name=info.name,
                            shape=list(info.shape),
                            format_type=str(info.format.type),
                            format_order=str(info.format.order),
                        )
                    )

                for info in temp_hef.get_output_vstream_infos():
                    outputs.append(
                        StreamInfoSchema(
                            name=info.name,
                            shape=list(info.shape),
                            format_type=str(info.format.type),
                            format_order=str(info.format.order),
                        )
                    )

                m_info = ModelInfo(
                    name=fname.replace(".hef", ""),
                    filename=fname,
                    path=path,
                    size_bytes=size,
                    network_groups=ng_names,
                    inputs=inputs,
                    outputs=outputs,
                    is_active=(fname == self.active_model_name),
                )
                models.append(m_info)
            except Exception as e:
                # Log inspection failure explicitly (INV-1 Anti-Shortcut)
                sys.stderr.write(f"[InferenceEngine] Warning inspecting HEF {path}: {e}\n")
                models.append(
                    ModelInfo(
                        name=fname.replace(".hef", ""),
                        filename=fname,
                        path=path,
                        size_bytes=size,
                        network_groups=[],
                        inputs=[],
                        outputs=[],
                        is_active=False,
                    )
                )
        return models

    def _unload_active_model_unlocked(self) -> None:
        """Deactivate active hardware stream pipeline."""
        if self.activation_context is not None:
            try:
                self.activation_context.__exit__(None, None, None)
            except Exception as e:
                self.teardown_errors_count += 1
                sys.stderr.write(f"[InferenceEngine] Error during activation context exit: {e}\n")
            self.activation_context = None

        if self.vstream_context is not None:
            try:
                self.vstream_context.__exit__(None, None, None)
            except Exception as e:
                self.teardown_errors_count += 1
                sys.stderr.write(f"[InferenceEngine] Error during vstream context exit: {e}\n")
            self.vstream_context = None
            self.pipeline = None

        self.hef = None
        self.network_group = None
        self.network_group_params = None
        self.input_name = None
        self.output_names = []
        self.is_nms_detector = False

    def load_model(self, model_identifier: str) -> int:
        """
        Load and activate a compiled HEF model. Returns load duration in ns.
        Strictly sanitizes model_identifier to prevent directory traversal (INV-3 Fail-Closed).
        """
        with self.lock:
            safe_name = os.path.basename(model_identifier.strip())
            if not safe_name.endswith(".hef"):
                safe_name += ".hef"

            models_dir_abs = os.path.abspath(self.models_dir)
            target_path = os.path.abspath(os.path.join(models_dir_abs, safe_name))

            common = os.path.commonpath([models_dir_abs, target_path])
            if common != models_dir_abs or not target_path.startswith(models_dir_abs + os.sep):
                raise ValueError(f"Path traversal detected in model identifier: '{model_identifier}'")

            if not os.path.isfile(target_path):
                raise FileNotFoundError(f"Model file not found in models catalog: {safe_name}")

            return self._load_model_unlocked(target_path)

    def _load_model_unlocked(self, hef_path: str) -> int:
        """Internal unlocked model loader."""
        t_start = time.perf_counter_ns()
        self._unload_active_model_unlocked()

        if self.vdevice is None:
            self.vdevice = VDevice()

        self.hef = HEF(hef_path)
        configure_params = ConfigureParams.create_from_hef(self.hef, interface=HailoStreamInterface.PCIe)
        network_groups = self.vdevice.configure(self.hef, configure_params)
        if not network_groups:
            raise RuntimeError(f"No network groups configured from {hef_path}")

        self.network_group = network_groups[0]
        self.network_group_params = self.network_group.create_params()

        # Input and output stream params
        in_params = InputVStreamParams.make(
            self.network_group, quantized=False, format_type=FormatType.UINT8
        )
        out_params = OutputVStreamParams.make(
            self.network_group, quantized=False, format_type=FormatType.FLOAT32
        )

        in_infos = self.hef.get_input_vstream_infos()
        if not in_infos:
            raise RuntimeError(f"HEF {hef_path} has no input streams")
        self.input_name = in_infos[0].name
        self.input_shape = tuple(in_infos[0].shape)  # e.g. (640, 640, 3)

        out_infos = self.hef.get_output_vstream_infos()
        self.output_names = [o.name for o in out_infos]
        # Check if output is NMS postprocessed detection
        self.is_nms_detector = any("nms" in o.name.lower() for o in out_infos)

        # Enter streaming contexts
        self.vstream_context = InferVStreams(self.network_group, in_params, out_params)
        self.pipeline = self.vstream_context.__enter__()
        self.activation_context = self.network_group.activate(self.network_group_params)
        self.activation_context.__enter__()

        self.active_model_name = os.path.basename(hef_path)
        self.active_hef_path = hef_path

        t_end = time.perf_counter_ns()
        return t_end - t_start

    def infer_image(
        self,
        image_bytes: bytes,
        conf_thresh: float = 0.3,
        iou_thresh: float = 0.45,
        render_annotated: bool = False,
    ) -> InferResponse:
        """
        Execute hardware inference on raw image bytes.
        Returns InferResponse with precise monotonic nanosecond breakdown.
        """
        t_total_start = time.perf_counter_ns()

        # Preprocessing: decode, extract dimensions, resize to model input shape
        t_pre_start = time.perf_counter_ns()

        # Decompression bomb defense: check dimensions via safe header parser before OpenCV decode
        Image.MAX_IMAGE_PIXELS = 16_777_216  # 16 MP upper bound
        try:
            with Image.open(io.BytesIO(image_bytes)) as pil_img:
                img_w, img_h = pil_img.size
                if img_w > 4096 or img_h > 4096 or (img_w * img_h) > 16_777_216:
                    raise ValueError(f"Image dimensions ({img_w}x{img_h}) exceed 4096x4096 (16MP) safety bound")
        except (Image.DecompressionBombError, ValueError) as e:
            raise ValueError(f"Decompression bomb or oversized image rejected: {e}")
        except Exception as e:
            raise ValueError(f"Invalid image header or corrupt image bytes: {e}")

        nparr = np.frombuffer(image_bytes, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise ValueError("Failed to decode image from provided bytes (corrupt or unsupported format)")

        orig_h, orig_w = img_bgr.shape[:2]
        target_h, target_w = self.input_shape[0], self.input_shape[1]

        resized = cv2.resize(img_bgr, (target_w, target_h))
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        input_tensor = np.expand_dims(rgb, axis=0)
        t_pre_end = time.perf_counter_ns()
        preprocess_ns = t_pre_end - t_pre_start

        # Hardware Inference under thread lock with explicit timeout (INV-5)
        lock_acquired = self.lock.acquire(timeout=DEFAULT_LOCK_TIMEOUT_SEC)
        if not lock_acquired:
            raise TimeoutError(f"Timed out waiting for Hailo-8 PCIe DMA lock after {DEFAULT_LOCK_TIMEOUT_SEC}s")
        try:
            if self.pipeline is None or self.input_name is None:
                raise RuntimeError("No active model loaded on Hailo-8 NPU")

            t_infer_start = time.perf_counter_ns()
            raw_res: Dict[str, np.ndarray] = self.pipeline.infer({self.input_name: input_tensor})
            t_infer_end = time.perf_counter_ns()
            inference_ns = t_infer_end - t_infer_start
        finally:
            self.lock.release()

        # Postprocessing
        t_post_start = time.perf_counter_ns()
        detections: Optional[List[Detection]] = None
        classifications: Optional[List[ClassificationPrediction]] = None
        raw_outputs: Optional[Dict[str, Any]] = None
        annotated_b64: Optional[str] = None

        if self.is_nms_detector:
            detections = []
            nms_key = next((k for k in raw_res.keys() if "nms" in k.lower()), None)
            if not nms_key:
                raise ValueError(
                    f"Model configured as NMS detector but output stream missing NMS tensor. Available outputs: {list(raw_res.keys())}"
                )
            if len(raw_res[nms_key]) == 0:
                raise ValueError(
                    f"NMS output tensor '{nms_key}' is empty. Available outputs: {list(raw_res.keys())}"
                )
            batch_detections = raw_res[nms_key][0]  # list of arrays per class
            for class_id, class_boxes in enumerate(batch_detections):
                if len(class_boxes) == 0:
                    continue
                class_name = get_class_name(class_id)
                for box in class_boxes:
                    score = float(box[4])
                    if score < conf_thresh:
                        continue
                    ymin = float(max(0.0, min(1.0, box[0])))
                    xmin = float(max(0.0, min(1.0, box[1])))
                    ymax = float(max(0.0, min(1.0, box[2])))
                    xmax = float(max(0.0, min(1.0, box[3])))

                    ymin_px = int(ymin * orig_h)
                    xmin_px = int(xmin * orig_w)
                    ymax_px = int(ymax * orig_h)
                    xmax_px = int(xmax * orig_w)

                    detections.append(
                        Detection(
                            class_id=class_id,
                            class_name=class_name,
                            confidence=round(score, 4),
                            bbox=BoundingBox(
                                ymin=round(ymin, 4),
                                xmin=round(xmin, 4),
                                ymax=round(ymax, 4),
                                xmax=round(xmax, 4),
                                ymin_px=ymin_px,
                                xmin_px=xmin_px,
                                ymax_px=ymax_px,
                                xmax_px=xmax_px,
                            ),
                        )
                    )
            # Sort detections by confidence descending
            detections.sort(key=lambda d: d.confidence, reverse=True)

            if render_annotated and detections:
                annotated_img = img_bgr.copy()
                for det in detections:
                    b = det.bbox
                    cv2.rectangle(annotated_img, (b.xmin_px, b.ymin_px), (b.xmax_px, b.ymax_px), (0, 255, 0), 2)
                    label = f"{det.class_name} {det.confidence:.2f}"
                    cv2.putText(
                        annotated_img,
                        label,
                        (b.xmin_px, max(15, b.ymin_px - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.5,
                        (0, 255, 0),
                        2,
                    )
                _, enc_buf = cv2.imencode(".jpg", annotated_img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                annotated_b64 = base64.b64encode(enc_buf).decode("ascii")

        elif any("softmax" in k.lower() or "prob" in k.lower() for k in raw_res.keys()):
            # Classification model (e.g. ResNet)
            classifications = []
            out_key = list(raw_res.keys())[0]
            logits = raw_res[out_key][0]  # shape (num_classes,)
            top_indices = np.argsort(logits)[::-1][:5]
            for idx in top_indices:
                classifications.append(
                    ClassificationPrediction(
                        class_id=int(idx),
                        class_name=None,
                        confidence=float(logits[idx]),
                    )
                )
        else:
            # Fallback raw output
            raw_outputs = {}
            for k, v in raw_res.items():
                if hasattr(v, "shape"):
                    raw_outputs[k] = {"shape": [int(d) for d in v.shape], "dtype": str(v.dtype)}
                else:
                    raw_outputs[k] = {"type": str(type(v))}

        t_post_end = time.perf_counter_ns()
        postprocess_ns = t_post_end - t_post_start
        total_ns = t_post_end - t_total_start

        timing = TimingStats(
            preprocess_ns=preprocess_ns,
            inference_ns=inference_ns,
            postprocess_ns=postprocess_ns,
            total_ns=total_ns,
        )

        return InferResponse(
            success=True,
            model=self.active_model_name or "unknown",
            source="rpi5_hailo8_npu",
            timestamp_ns=time.monotonic_ns(),
            timing=timing,
            chip_temp_c=None,  # filled by endpoint
            detections=detections,
            classifications=classifications,
            raw_outputs=raw_outputs,
            annotated_image_b64=annotated_b64,
        )

    def close(self) -> None:
        """Clean shutdown of Hailo-8 pipeline and device allocation."""
        with self.lock:
            self._unload_active_model_unlocked()
            if self.vdevice is not None:
                try:
                    self.vdevice.release()
                except Exception as e:
                    sys.stderr.write(f"[InferenceEngine] Warning releasing vdevice: {e}\n")
                self.vdevice = None
