import base64
import os
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from ultralytics import YOLO

TOKEN = os.getenv("CAMERA_SERVICE_TOKEN", "")
if not TOKEN:
    raise RuntimeError("CAMERA_SERVICE_TOKEN must be configured")

app = FastAPI(title="Live Team Quiz Camera Detector")
model = YOLO("yolov8n.pt")


class DetectRequest(BaseModel):
    image: str


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/detect")
def detect(payload: DetectRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    if len(payload.image) > 400_000:
        raise HTTPException(status_code=413, detail="Image too large")
    try:
        raw = base64.b64decode(payload.image, validate=True)
        if len(raw) > 300_000:
            raise ValueError("Image too large")
        frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Invalid image")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JPEG image")

    # Only report the COCO 'cell phone' class. Inference is performed in memory;
    # the submitted frame is not written to disk or retained by this service.
    results = model.predict(frame, imgsz=320, conf=0.45, classes=[67], verbose=False)
    detections = []
    for result in results:
        if result.boxes is None:
            continue
        for box in result.boxes:
            detections.append({
                "label": "cell phone",
                "confidence": round(float(box.conf[0]), 4)
            })
    return {"detections": detections}
