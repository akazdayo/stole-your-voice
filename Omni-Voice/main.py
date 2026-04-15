from omnivoice import OmniVoice
import soundfile as sf
import torch
import io
import tempfile
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse

# Load the model
model = OmniVoice.from_pretrained(
    "k2-fsa/OmniVoice",
    device_map="cuda:0",
    dtype=torch.float16
)

app = FastAPI()


@app.post("/generate")
async def generate(
    ref_audio: UploadFile = File(...),
    text: str = Form(...),
):
    # Save uploaded audio to a temp file (model expects a file path)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(await ref_audio.read())
        tmp_path = tmp.name

    audio = model.generate(
        text=text,
        ref_audio=tmp_path,
        language_id=262
    )

    # Write result to buffer and return
    buf = io.BytesIO()
    sf.write(buf, audio[0], 24000, format="WAV")
    buf.seek(0)

    return StreamingResponse(buf, media_type="audio/wav")
