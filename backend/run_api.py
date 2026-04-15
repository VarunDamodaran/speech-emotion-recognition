"""Small FastAPI runner that exposes our WebSockets app."""
import uvicorn

if __name__ == "__main__":
    print("Starting the Audio Emotion Backend...")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)