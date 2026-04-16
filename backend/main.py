from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import time
import asyncio
import tempfile
import os

from pipeline import load_model, predict_emotion_file, EMOTIONS

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_PATH = os.path.join(BASE_DIR, "ml", "cnn_transf_parallel_model.pt")
print(f"Loading model from: {WEIGHTS_PATH}")
MODEL = load_model(weights_path=WEIGHTS_PATH)

metrics_store = {
    "silent_chunks_rejected": 0,
    "total_chunks_processed": 0,
    "error_count": 0,
    "low_confidence_count": 0, 
    "emotion_distribution": {emotion: 0 for emotion in EMOTIONS.values()}, 
    "latest_latency_ms": 0.0
}

def run_ml_inference(audio_chunk: bytes):
    """Saves bytes to a temp file, runs inference, and cleans up."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(audio_chunk)
        tmp.flush()
        tmp.close()
        pred_idx, label, confidence = predict_emotion_file(tmp.name, MODEL)
        return label, float(confidence) 
    finally:
        try:
            os.remove(tmp.name)
        except Exception:
            pass


async def predict_emotion(audio_chunk: bytes):
    return await asyncio.to_thread(run_ml_inference, audio_chunk)

@app.get("/health")
async def health_check():
    """some light endpoint for keeping this awake."""
    return {"status": "alive"}

@app.websocket("/ws/stream")
async def audio_stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
           
            audio_data = await websocket.receive_bytes()
            start_time = time.time()
            
            try:
               
                predicted_emotion, confidence = await predict_emotion(audio_data)
                
                metrics_store["latest_latency_ms"] = round((time.time() - start_time) * 1000, 2)
                metrics_store["total_chunks_processed"] += 1
                
                if confidence < 0.60:
                    metrics_store["low_confidence_count"] += 1
                
                if predicted_emotion in metrics_store["emotion_distribution"]:
                    metrics_store["emotion_distribution"][predicted_emotion] += 1
                
                await websocket.send_json({"status": "success", "emotion": predicted_emotion})
                
            except ValueError as ve:
                if str(ve) == "SILENT_CHUNK":
                    metrics_store["silent_chunks_rejected"] += 1
                    await websocket.send_json({"status": "success", "emotion": "Listening..."})
                else:
                    raise ve 
                    
            except Exception as e:
                metrics_store["error_count"] += 1
                await websocket.send_json({"status": "error", "message": str(e)})
                
    except WebSocketDisconnect:
        print("Client disconnected from audio stream.")

@app.get("/metrics")
async def get_system_metrics():
    total_received = metrics_store["total_chunks_processed"] + metrics_store["silent_chunks_rejected"] + metrics_store["error_count"]
    
    error_rate = (metrics_store["error_count"] / total_received * 100) if total_received > 0 else 0.0
    silent_percentage = (metrics_store["silent_chunks_rejected"] / total_received * 100) if total_received > 0 else 0.0
    
    
    low_conf_percentage = 0.0
    if metrics_store["total_chunks_processed"] > 0:
        low_conf_percentage = (metrics_store["low_confidence_count"] / metrics_store["total_chunks_processed"]) * 100

    return {
        "silent_rejection_percentage": round(silent_percentage, 1),
        "latency_ms": metrics_store["latest_latency_ms"],
        "error_rate_percentage": round(error_rate, 2),
        "low_confidence_rate_percentage": round(low_conf_percentage, 1),
        "emotion_distribution": metrics_store["emotion_distribution"],
        "total_requests": total_received
    }