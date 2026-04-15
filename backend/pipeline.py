import os
import tempfile
import soundfile as sf
import numpy as np
from typing import Optional, Tuple

import torch
import torch.nn as nn
import torchaudio
import torchaudio.transforms as T

try:
	from fastapi import FastAPI, File, UploadFile
	from fastapi.responses import JSONResponse
except Exception:
	FastAPI = None
	File = None
	UploadFile = None
	JSONResponse = None

EMOTIONS = {1: "neutral", 2: "calm", 3: "happy", 4: "sad", 5: "angry", 6: "fear", 7: "disgust", 0: "surprise"}
SAMPLE_RATE = 48000
DURATION = 3
TARGET_LENGTH = SAMPLE_RATE * DURATION


class ParallelModel(nn.Module):
	def __init__(self, num_emotions: int):
		super().__init__()
		self.conv2Dblock = nn.Sequential(
			nn.Conv2d(in_channels=1, out_channels=16, kernel_size=3, stride=1, padding=1),
			nn.BatchNorm2d(16),
			nn.ReLU(),
			nn.MaxPool2d(kernel_size=2, stride=2),
			nn.Dropout(p=0.3),
			nn.Conv2d(in_channels=16, out_channels=32, kernel_size=3, stride=1, padding=1),
			nn.BatchNorm2d(32),
			nn.ReLU(),
			nn.MaxPool2d(kernel_size=4, stride=4),
			nn.Dropout(p=0.3),
			nn.Conv2d(in_channels=32, out_channels=64, kernel_size=3, stride=1, padding=1),
			nn.BatchNorm2d(64),
			nn.ReLU(),
			nn.MaxPool2d(kernel_size=4, stride=4),
			nn.Dropout(p=0.3),
			nn.Conv2d(in_channels=64, out_channels=64, kernel_size=3, stride=1, padding=1),
			nn.BatchNorm2d(64),
			nn.ReLU(),
			nn.MaxPool2d(kernel_size=4, stride=4),
			nn.Dropout(p=0.3),
		)
		self.transf_maxpool = nn.MaxPool2d(kernel_size=[2, 4], stride=[2, 4])
		transf_layer = nn.TransformerEncoderLayer(d_model=64, nhead=4, dim_feedforward=512, dropout=0.4, activation="relu")
		self.transf_encoder = nn.TransformerEncoder(transf_layer, num_layers=4)
		self.out_linear = nn.Linear(320, num_emotions)
		self.dropout_linear = nn.Dropout(p=0.0)
		self.out_softmax = nn.Softmax(dim=1)

	def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
		conv_embedding = self.conv2Dblock(x)
		conv_embedding = torch.flatten(conv_embedding, start_dim=1)
		x_reduced = self.transf_maxpool(x)
		x_reduced = torch.squeeze(x_reduced, 1)
		x_reduced = x_reduced.permute(2, 0, 1)
		transf_out = self.transf_encoder(x_reduced)
		transf_embedding = torch.mean(transf_out, dim=0)
		complete_embedding = torch.cat([conv_embedding, transf_embedding], dim=1)
		output_logits = self.out_linear(complete_embedding)
		output_logits = self.dropout_linear(output_logits)
		output_softmax = self.out_softmax(output_logits)
		return output_logits, output_softmax


def load_model(weights_path: Optional[str] = None, device: Optional[str] = None, num_emotions: int = 8) -> nn.Module:
	device_str = device or ("cuda" if torch.cuda.is_available() else "cpu")
	torch_device = torch.device(device_str)
	model = ParallelModel(num_emotions=num_emotions)
	model = model.to(torch_device)
	if weights_path:
		if not os.path.exists(weights_path):
			raise FileNotFoundError(f"Model weights not found: {weights_path}")
		checkpoint = torch.load(weights_path, map_location=torch_device)
		if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
			state_dict = checkpoint["model_state_dict"]
		else:
			state_dict = checkpoint
		clean_state = {k.replace("module.", ""): v for k, v in state_dict.items()}
		model.load_state_dict(clean_state)
	model.eval()
	return model


SILENCE_THRESHOLD = 0.01 

def preprocess_audio(file_path: str, sample_rate: int = 48000):
   
    data, sr = sf.read(file_path, dtype="float32")

    rms_volume = np.sqrt(np.mean(data**2))
    
    if rms_volume < SILENCE_THRESHOLD:
        raise ValueError("SILENT_CHUNK")
        
    waveform = torch.tensor(data)
    
    if waveform.ndim == 1:
        waveform = waveform.unsqueeze(0) 
    else:
        waveform = waveform.transpose(0, 1)
        
    if sr != sample_rate:
        resampler = T.Resample(sr, sample_rate)
        waveform = resampler(waveform)
        
    if waveform.shape[0] > 1:
        waveform = torch.mean(waveform, dim=0, keepdim=True)
        
    if waveform.shape[1] > TARGET_LENGTH:
        waveform = waveform[:, :TARGET_LENGTH]
    elif waveform.shape[1] < TARGET_LENGTH:
        padding = TARGET_LENGTH - waveform.shape[1]
        waveform = torch.nn.functional.pad(waveform, (0, padding))
        
    mel_transform = T.MelSpectrogram(sample_rate=sample_rate, n_fft=1024, win_length=512, hop_length=256, n_mels=128, f_max=sample_rate / 2.0)
    db_transform = T.AmplitudeToDB()
    mel_spec = db_transform(mel_transform(waveform))
    
    mean = mel_spec.mean()
    std = mel_spec.std()
    if std > 1e-6:
        mel_spec = (mel_spec - mean) / std
    else:
        mel_spec = mel_spec - mean
        
    mel_spec = mel_spec.unsqueeze(0)
    return mel_spec


def preprocess_audio_bytes(file_bytes: bytes, suffix: str = ".wav") -> torch.Tensor:
	tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
	try:
		tmp.write(file_bytes)
		tmp.flush()
		tmp.close()
		return preprocess_audio(tmp.name)
	finally:
		try:
			os.remove(tmp.name)
		except Exception:
			pass


def predict_emotion_file(file_path: str, model: nn.Module, device: Optional[str] = None) -> Tuple[int, str, float]:
	device_str = device or ("cuda" if torch.cuda.is_available() else "cpu")
	torch_device = torch.device(device_str)
	model = model.to(torch_device)
	input_tensor = preprocess_audio(file_path)
	input_tensor = input_tensor.to(torch_device)
	with torch.no_grad():
		_, output_softmax = model(input_tensor)
		preds = torch.argmax(output_softmax, dim=1)
		pred_idx = int(preds[0].item())
		label = EMOTIONS.get(pred_idx, str(pred_idx))
		confidence = float(output_softmax[0, pred_idx].item()) * 100.0
	return pred_idx, label, confidence


def create_app(weights_path: Optional[str] = None, device: Optional[str] = None) -> "FastAPI":
	if FastAPI is None:
		raise ImportError("FastAPI is not available in the environment")
	model = load_model(weights_path=weights_path, device=device)
	app = FastAPI(title="Audio Emotion Inference")

	@app.post("/predict")
	async def predict(file: UploadFile = File(...)):
		ext = os.path.splitext(file.filename)[1] or ".wav"
		file_bytes = await file.read()
		tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
		try:
			tmp.write(file_bytes)
			tmp.flush()
			tmp.close()
			pred_idx, label, confidence = predict_emotion_file(tmp.name, model, device=device)
			return JSONResponse({"predicted_idx": pred_idx, "predicted_label": label, "confidence": confidence})
		finally:
			try:
				os.remove(tmp.name)
			except Exception:
				pass

	return app


if __name__ == "__main__":
	import argparse

	parser = argparse.ArgumentParser(description="Audio emotion inference")
	parser.add_argument("--file", "-f", required=True, help="Path to input audio file")
	parser.add_argument("--model", "-m", default=os.path.join(os.getcwd(), "models", "cnn_transf_parallel_model.pt"), help="Path to model weights (state_dict)")
	parser.add_argument("--device", "-d", choices=["cpu", "cuda"], default=None, help="Device to run inference on")
	args = parser.parse_args()
	model = load_model(weights_path=args.model, device=args.device)
	pred_idx, label, confidence = predict_emotion_file(args.file, model, device=args.device)
	print(f"Predicted: {label} ({pred_idx})  confidence: {confidence:.2f}%")
