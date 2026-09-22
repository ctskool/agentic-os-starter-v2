"""Standalone V2 speech and optional Windows/macOS voice shortcut; no V1 imports."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import glob
import io
import json
import os
import sys
import threading

from speech_runtime import CaptureController, HotkeyListener


def load_engines(assets):
    for directory in glob.glob(os.path.join(sys.prefix, 'Lib', 'site-packages', 'nvidia', '*', 'bin')):
        if hasattr(os, 'add_dll_directory'):
            os.add_dll_directory(directory)
        os.environ['PATH'] = directory + os.pathsep + os.environ['PATH']
    from faster_whisper import WhisperModel
    from kokoro_onnx import Kokoro
    def usable(model):
        # A GPU model loads fine without the CUDA math libraries and only fails on its first
        # sentence ("cublas64_12.dll is not found"). Run one second of silence through it now.
        import numpy as np
        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language='en')
        list(segments)
        return model
    try:
        whisper = usable(WhisperModel('small.en', device='cuda', compute_type='float16', local_files_only=True))
    except Exception:
        whisper = WhisperModel('small.en', device='cpu', compute_type='int8', local_files_only=True)
    return whisper, Kokoro(os.path.join(assets, 'kokoro-v1.0.onnx'), os.path.join(assets, 'voices-v1.0.bin'))


def create_app(assets, engines=None, capture_factory=CaptureController, hotkey_factory=HotkeyListener, platform=None):
    from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
    whisper, kokoro = engines if engines is not None else load_engines(assets)
    lock, clients = threading.Lock(), set()
    loop = None

    def emit(payload):
        if loop is None or loop.is_closed():
            return
        async def send():
            for client in list(clients):
                try:
                    await client.send_text(json.dumps(payload))
                except Exception:
                    clients.discard(client)
        asyncio.run_coroutine_threadsafe(send(), loop)

    def transcribe_pcm(pcm):
        import numpy as np
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        with lock:
            segments, _ = whisper.transcribe(audio, language='en', vad_filter=True)
            return ' '.join(segment.text.strip() for segment in segments)

    # On macOS, the selected Obsidian/HUD surface owns microphone capture
    # and consent instead of inheriting the login supervisor's permissions.
    surface_capture = (platform or sys.platform) == 'darwin'
    capture = None if surface_capture else capture_factory(transcribe_pcm, emit,
        silence_seconds=float(os.environ.get('VOICE_HOTKEY_SILENCE', '1.6')),
        max_seconds=float(os.environ.get('VOICE_HOTKEY_MAX', '20')))
    combo = os.environ.get('VOICE_HOTKEY', 'ctrl+alt+j')
    # No listener can capture into an unobserved/orphaned speech service.
    def trigger(source='hotkey'):
        if not clients:
            return False
        if surface_capture:
            emit({'type': 'capture-request', 'source': source})
            return True
        return capture.trigger(source)
    hotkey = hotkey_factory(trigger, combo=combo)

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal loop
        loop = asyncio.get_running_loop()
        if surface_capture or capture.available:
            await asyncio.to_thread(hotkey.start)
        try:
            yield
        finally:
            await asyncio.to_thread(hotkey.stop)
            if capture is not None:
                await asyncio.to_thread(capture.stop)
            loop = None

    app = FastAPI(lifespan=lifespan)

    @app.get('/health')
    def health():
        # The service cannot observe a surface's microphone permission or busy state.
        capture_health = {'method': 'surface', 'available': None, 'busy': None, 'error': None} if surface_capture else {
            'available': capture.available, 'busy': capture.busy, 'error': capture.error}
        return {'ok': True, 'engine': 'kokoro', 'stt': {'ok': True},
            'service': {'kind': 'aos-v2-speech', 'pid': os.getpid(), 'script': os.path.abspath(__file__)},
            'wake': {'enabled': False, 'ok': False, 'error': 'Wake-word detection is not enabled in standalone V2.'},
            'events': {'supported': True, 'clients': len(clients)},
            'capture': capture_health,
            'hotkey': {'enabled': hotkey.enabled, 'combo': combo,
                'ok': bool((surface_capture or capture.available) and hotkey.ok),
                'error': capture_health['error'] or hotkey.error}}

    @app.websocket('/events')
    async def events(ws: WebSocket):
        # The bridge connects server-to-server; arbitrary browser pages cannot
        # subscribe to microphone transcripts by opening a cross-origin socket.
        if ws.headers.get('origin') not in (None, 'http://127.0.0.1:3217', 'http://127.0.0.1:3218'):
            await ws.close(code=1008)
            return
        await ws.accept()
        clients.add(ws)
        try:
            await ws.send_text(json.dumps({'type': 'hello', 'wake': False, 'hotkey': hotkey.ok}))
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(ws)

    @app.post('/listen')
    def listen(req: Request):
        if req.headers.get('origin') not in (None, 'http://127.0.0.1:3217', 'http://127.0.0.1:3218'):
            return Response(status_code=403)
        if not surface_capture and not capture.available:
            return Response(status_code=503)
        if not clients:
            return Response(status_code=409)
        return {'ok': trigger('api')}

    @app.post('/stt')
    async def stt(req: Request):
        chunks, size = [], 0
        async for chunk in req.stream():
            size += len(chunk)
            if size > 8 * 1024 * 1024:
                return Response(status_code=413)
            chunks.append(chunk)
        if size < 1000:
            return Response(status_code=400)
        def transcribe():
            with lock:
                segments, _ = whisper.transcribe(io.BytesIO(b''.join(chunks)), language='en', vad_filter=True)
                return ' '.join(segment.text.strip() for segment in segments)
        return {'text': await asyncio.to_thread(transcribe)}

    @app.get('/speak')
    def speak(text: str = ''):
        import numpy as np
        import soundfile as sf
        if not text.strip() or len(text) > 900:
            return Response(status_code=400)
        with lock:
            samples, rate = kokoro.create(text, voice='bm_george', speed=1.0, lang='en-gb')
        out = io.BytesIO()
        sf.write(out, np.clip(samples, -1, 1), rate, format='WAV', subtype='PCM_16')
        return Response(out.getvalue(), media_type='audio/wav', headers={'Cache-Control': 'no-store'})

    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_app(args.assets), host='127.0.0.1', port=3220, log_level='warning')
