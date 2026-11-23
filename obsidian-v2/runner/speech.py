"""Standalone V2 speech and optional Windows/macOS voice shortcut; no V1 imports."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import glob
import io
import json
import os
import re
import secrets
import struct
import sys
import tempfile
import threading
import uuid

from speech_runtime import CaptureController, HotkeyListener, accepts_mode


ENGLISH = {'language': 'en', 'model': 'small.en', 'voice': 'bm_george', 'kokoro_lang': 'en-gb'}
SENTENCE_END = re.compile('(?<=[.!?…]) +')
# Voice names begin with the accent or language they were recorded in. A voice is only offered, and only
# accepted, for the language the service is running: an English voice reading Portuguese is not a choice.
VOICE_FAMILIES = {'en': 'ab', 'es': 'e', 'fr': 'f', 'it': 'i', 'pt': 'p'}
VOICE_LANGUAGE = {'a': 'en-us', 'b': 'en-gb'}


def speech_chunks(text):
    """The first sentence alone, so playback can start as soon as it has been spoken; the rest in
    pieces of at least 60 characters, so short fragments do not chop the rhythm of the voice."""
    parts = [part for part in SENTENCE_END.split(' '.join(text.split())) if part]
    if not parts:
        return [text]
    chunks, current = [parts[0]], ''
    for part in parts[1:]:
        current = (current + ' ' + part).strip()
        if len(current) >= 60:
            chunks.append(current)
            current = ''
    if current:
        chunks.append(current)
    return chunks


def vocabulary_reader(file):
    """The words this member uses (written by the bridge from the names of their notes, voice-words.mjs),
    as the short hint speech-to-text accepts. Read again only when the file changes; a missing or broken
    file means no hint, never an error."""
    state = {'mtime': None, 'prompt': None}
    def read():
        try:
            mtime = os.path.getmtime(file)
            if mtime != state['mtime']:
                with open(file, encoding='utf-8') as handle:
                    prompt = json.load(handle).get('prompt')
                state['mtime'], state['prompt'] = mtime, prompt if isinstance(prompt, str) and 0 < len(prompt) <= 800 else None
        except Exception:
            state['mtime'], state['prompt'] = None, None
        return state['prompt']
    return read


def streaming_wav_header(rate):
    """A WAV header for audio whose length is not known yet: players read to the end of the stream."""
    size = 0x7FFFFFFF - 36
    return struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + size, b'WAVE', b'fmt ', 16, 1, 1, rate, rate * 2, 2, 16, b'data', size)


def load_engines(assets, model='small.en', language='en'):
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
        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language=language)
        list(segments)
        return model
    name = model
    try:
        whisper = usable(WhisperModel(name, device='cuda', compute_type='float16', local_files_only=True))
    except Exception:
        whisper = WhisperModel(name, device='cpu', compute_type='int8', local_files_only=True)
    return whisper, Kokoro(os.path.join(assets, 'kokoro-v1.0.onnx'), os.path.join(assets, 'voices-v1.0.bin'))


def write_mode_auth(path, value):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.speech-auth-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def create_app(assets, engines=None, capture_factory=CaptureController, hotkey_factory=HotkeyListener, platform=None, speech=None, words_file=None, mode_auth_file=None):
    from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
    from fastapi.responses import StreamingResponse
    # One language for hearing and speaking, chosen by the member (system/v2/profile.json, "speechLanguage").
    # An English-only model does not refuse other languages: it writes down English-looking words, which
    # then get answered as if they had been said. So the language is always explicit, and reported in /health.
    speech = {**ENGLISH, **(speech or {})}
    wanted, language_problem = speech['language'], None
    if engines is None:
        try:
            engines = load_engines(assets, speech['model'], speech['language'])
        except Exception as error:
            if speech['language'] == 'en':
                raise
            # Usually the model for that language was never downloaded. Voice keeps working in English
            # and says so, instead of leaving the member with no voice at all; the doctor reports it
            # with the fix, and the real reason is kept for whoever has to look.
            language_problem = ('Voice could not start in this language, most often because its speech model is not installed. '
                'Run `node aos.mjs setup --voice yes`. (' + type(error).__name__ + ': ' + str(error)[:160] + ')')
            speech = dict(ENGLISH)
            engines = load_engines(assets)
    whisper, kokoro = engines
    # Next to this installation's voice files: .runtime/voice-words.json.
    vocabulary = vocabulary_reader(words_file or os.path.join(os.path.dirname(os.path.abspath(assets)), 'voice-words.json'))
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
            segments, _ = whisper.transcribe(audio, language=speech['language'], vad_filter=True, initial_prompt=vocabulary())
            return ' '.join(segment.text.strip() for segment in segments)

    # On macOS, the selected Obsidian/HUD surface owns microphone capture
    # and consent instead of inheriting the login supervisor's permissions.
    surface_capture = (platform or sys.platform) == 'darwin'
    capture = None if surface_capture else capture_factory(transcribe_pcm, emit,
        silence_seconds=float(os.environ.get('VOICE_HOTKEY_SILENCE', '1.6')),
        max_seconds=float(os.environ.get('VOICE_HOTKEY_MAX', '20')))
    boot_id = str(uuid.uuid4())
    mode_secret = None
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
        nonlocal loop, mode_secret
        loop = asyncio.get_running_loop()
        if (platform or sys.platform) == 'win32' and hasattr(capture, 'set_mode'):
            mode_secret = secrets.token_hex(32)
            auth_file = mode_auth_file or os.path.join(os.path.dirname(os.path.abspath(assets)), 'speech-auth.json')
            write_mode_auth(auth_file, {'modeSecret': mode_secret, 'bootId': boot_id})
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
            'language': {'code': speech['language'], 'wanted': wanted, 'error': language_problem},
            'vocabulary': {'words': len([word for word in (vocabulary() or '').split(',') if word.strip()])},
            'service': {'kind': 'aos-v2-speech', 'pid': os.getpid(), 'script': os.path.abspath(__file__)},
            'wake': {'enabled': False, 'ok': False, 'error': 'Wake-word detection is not enabled in standalone V2.'},
            'events': {'supported': True, 'clients': len(clients)},
            'bootId': boot_id,
            'mode': mode_secret is not None,
            'capture': capture_health,
            'hotkey': {'enabled': hotkey.enabled, 'combo': combo,
                'ok': bool((surface_capture or capture.available) and hotkey.ok),
                'error': capture_health['error'] or hotkey.error}}

    @app.post('/mode')
    async def mode(req: Request):
        if mode_secret is None or not accepts_mode(req.client.host if req.client else '', req.headers.get('x-v2-mode-secret'), mode_secret):
            return Response(status_code=403)
        try:
            data = await req.json()
            capture_mode, lease, ttl = data.get('capture'), data.get('lease'), data.get('ttl')
            renew = data.get('renew', False)
            if capture_mode not in ('off', 'on') or str(uuid.UUID(lease, version=4)) != lease or type(ttl) is not int or not 1 <= ttl <= 60 or type(renew) is not bool:
                return Response(status_code=400)
        except (AttributeError, TypeError, ValueError):
            return Response(status_code=400)
        state = capture.set_mode(capture_mode, lease, ttl, renew)
        if state == 'unknown':
            return Response(status_code=409)
        return {'state': state, 'bootId': boot_id}

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
            await ws.send_text(json.dumps({'type': 'hello', 'wake': False, 'hotkey': hotkey.ok,
                **({'bootId': boot_id} if mode_secret is not None else {})}))
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
                segments, _ = whisper.transcribe(io.BytesIO(b''.join(chunks)), language=speech['language'], vad_filter=True, initial_prompt=vocabulary())
                return ' '.join(segment.text.strip() for segment in segments)
        return {'text': await asyncio.to_thread(transcribe)}

    def voices_for_language():
        try:
            names = sorted(str(name) for name in kokoro.get_voices())
        except Exception:
            return []
        return [name for name in names if name[:1] in VOICE_FAMILIES.get(speech['language'], '') and name[2:3] == '_']

    @app.get('/voices')
    def voices():
        return {'language': speech['language'], 'default': speech['voice'], 'voices': voices_for_language()}

    @app.get('/speak')
    async def speak(req: Request, text: str = '', stream: int = 0, voice: str = '', speed: float = 1.0):
        import numpy as np
        import soundfile as sf
        if not text.strip() or len(text) > 900:
            return Response(status_code=400)
        # The member's choice of voice and speed. Anything this service cannot speak in its language falls
        # back to the default instead of failing: a reply in the usual voice beats no reply.
        chosen = voice if voice and voice in voices_for_language() else speech['voice']
        accent = VOICE_LANGUAGE.get(chosen[:1], speech['kokoro_lang']) if speech['language'] == 'en' else speech['kokoro_lang']
        pace = speed if 0.8 <= speed <= 1.4 else 1.0
        # Set as soon as the listener has gone (stopped, interrupted, or switched to the whole-file request).
        left = threading.Event()
        async def watch():
            try:
                while not left.is_set():
                    if await req.is_disconnected():
                        left.set()
                        return
                    await asyncio.sleep(0.05)
            except BaseException:
                # The request itself was torn down: nobody is listening.
                left.set()
                raise
        def synthesize(piece):
            # One sentence at a time holds the lock, so a spoken request can be heard between sentences.
            # Checked before waiting for the engine and again once it is ours: a sentence nobody will hear
            # must not keep hearing waiting.
            if left.is_set():
                return None, 0
            with lock:
                if left.is_set():
                    return None, 0
                return kokoro.create(piece, voice=chosen, speed=pace, lang=accent)
        watcher = asyncio.create_task(watch())
        if not stream:
            # The whole reply as one complete WAV file, exactly as before. The doctor and the
            # buffered playback fallback use this.
            try:
                samples, sample_rate = await asyncio.to_thread(synthesize, text)
            finally:
                left.set()
                watcher.cancel()
            if samples is None:
                return Response(status_code=499)
            out = io.BytesIO()
            sf.write(out, np.clip(samples, -1, 1), sample_rate, format='WAV', subtype='PCM_16')
            return Response(out.getvalue(), media_type='audio/wav', headers={'Cache-Control': 'no-store'})
        # stream=1: the reply is sent sentence by sentence as it is spoken. On a computer without a
        # graphics card a sentence takes about a second to build, so a four-sentence reply used to
        # start after four seconds; now it starts after the first.
        pieces = speech_chunks(text)
        pcm = lambda samples: (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
        try:
            first, sample_rate = await asyncio.to_thread(synthesize, pieces[0])
            if first is None:
                left.set()
                watcher.cancel()
                return Response(status_code=499)
            # Built in full before the reply starts: a failure up to here is still an ordinary error response.
            opening = streaming_wav_header(sample_rate) + pcm(first)
        except BaseException:
            left.set()
            watcher.cancel()
            raise
        async def generate():
            try:
                yield opening
                for piece in pieces[1:]:
                    samples, _ = await asyncio.to_thread(synthesize, piece)
                    if samples is None:
                        return
                    yield bytes(int(sample_rate * 0.12) * 2)  # a short breath between sentences
                    yield pcm(samples)
            finally:
                left.set()
                watcher.cancel()
        return StreamingResponse(generate(), media_type='audio/wav', headers={'Cache-Control': 'no-store'})

    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True)
    # All four travel together from shared/speech-language.mjs; with none given the service is English.
    parser.add_argument('--language', default=ENGLISH['language'])
    parser.add_argument('--whisper-model', default=ENGLISH['model'])
    parser.add_argument('--voice', default=ENGLISH['voice'])
    parser.add_argument('--kokoro-lang', default=ENGLISH['kokoro_lang'])
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(create_app(args.assets, speech={'language': args.language, 'model': args.whisper_model, 'voice': args.voice, 'kokoro_lang': args.kokoro_lang}),
        host='127.0.0.1', port=3220, log_level='warning')
