"""V2-owned push-to-talk. Importing this module opens no device or OS hook."""
import math
import struct
import sys
import threading
import time

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280


def rms(pcm):
    values = struct.unpack(f'<{len(pcm) // 2}h', pcm)
    return math.sqrt(sum(value * value for value in values) / max(1, len(values)))


class CaptureController:
    def __init__(self, transcribe, emit, stream_factory=None, clock=time.monotonic,
                 silence_seconds=1.6, max_seconds=20.0, no_speech_seconds=5.0):
        self.transcribe, self.emit, self.clock = transcribe, emit, clock
        self.silence_seconds, self.max_seconds = silence_seconds, max_seconds
        self.no_speech_seconds = no_speech_seconds
        self.available, self.error = True, None
        self._lock, self._stop = threading.Lock(), threading.Event()
        self._thread = None
        self.stream_factory = stream_factory
        if stream_factory is None:
            try:
                import sounddevice as sd
                self.stream_factory = lambda: sd.RawInputStream(
                    samplerate=SAMPLE_RATE, channels=1, dtype='int16', blocksize=FRAME_SAMPLES)
            except Exception as exc:
                self.available, self.error = False, f'Microphone dependency unavailable: {type(exc).__name__}'

    @property
    def busy(self):
        return self._lock.locked()

    def trigger(self, source='hotkey'):
        if not self.available or self._stop.is_set() or not self._lock.acquire(blocking=False):
            return False
        self._thread = threading.Thread(target=self._run, args=(source,), daemon=True, name='v2-voice-capture')
        self._thread.start()
        return True

    def _run(self, source):
        # Announce before opening the microphone so the owning surface can
        # interrupt playback, and errors have a corresponding capture owner.
        self.emit({'type': 'wake', 'source': source, 'score': 1.0})
        try:
            with self.stream_factory() as stream:
                noise = 80.0
                for _ in range(3):
                    frame, _ = stream.read(FRAME_SAMPLES)
                    noise = .7 * noise + .3 * min(rms(bytes(frame)), 600.0)
                threshold, frames = max(noise * 3, 250.0), []
                started, heard, last_speech = self.clock(), False, None
                while not self._stop.is_set() and self.clock() - started < self.max_seconds:
                    frame, _ = stream.read(FRAME_SAMPLES)
                    pcm = bytes(frame)
                    frames.append(pcm)
                    now = self.clock()
                    if rms(pcm) >= threshold:
                        heard, last_speech = True, now
                    elif heard and now - last_speech >= self.silence_seconds:
                        break
                    elif not heard and now - started >= self.no_speech_seconds:
                        break
                if self._stop.is_set():
                    return
                if not heard:
                    self.emit({'type': 'wake_timeout'})
                    return
                text = self.transcribe(b''.join(frames)).strip()
                if not self._stop.is_set():
                    self.emit({'type': 'transcript', 'text': text} if text else {'type': 'wake_timeout'})
        except Exception as exc:
            self.error = f'Capture failed: {type(exc).__name__}'
            if not self._stop.is_set():
                self.emit({'type': 'wake_error', 'error': self.error})
        finally:
            self._lock.release()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


def parse_hotkey(combo):
    modifiers = {'ctrl': 2, 'control': 2, 'alt': 1, 'shift': 4, 'win': 8}
    mask, key = 0x4000, None  # MOD_NOREPEAT
    for part in combo.lower().split('+'):
        part = part.strip()
        if part in modifiers:
            mask |= modifiers[part]
        elif key is None and len(part) == 1 and part.isascii() and part.isalnum():
            key = ord(part.upper())
        else:
            raise ValueError('Use modifiers plus one letter or digit, such as ctrl+alt+j.')
    if key is None:
        raise ValueError('A hotkey needs a letter or digit.')
    return mask, key


class WindowsHotkeyBackend:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes, self.wintypes = ctypes, wintypes
        self.user32 = ctypes.WinDLL('user32', use_last_error=True)
        self.user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        self.user32.RegisterHotKey.restype = wintypes.BOOL
        self.user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user32.UnregisterHotKey.restype = wintypes.BOOL
        self.user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        self.user32.PeekMessageW.restype = wintypes.BOOL

    def register(self, mask, key):
        if not self.user32.RegisterHotKey(None, 0xA0B2, mask, key):
            raise RuntimeError(f'Hotkey unavailable (Windows error {self.ctypes.get_last_error()}); another app may own it.')

    def fired(self):
        message = self.wintypes.MSG()
        return bool(self.user32.PeekMessageW(self.ctypes.byref(message), None, 0x0312, 0x0312, 1)
                    and message.wParam == 0xA0B2)

    def unregister(self):
        self.user32.UnregisterHotKey(None, 0xA0B2)


class HotkeyListener:
    def __init__(self, trigger, combo='ctrl+alt+j', backend_factory=None):
        self.trigger, self.combo = trigger, combo
        self.ok, self.error = False, None
        self.enabled = combo.lower() not in ('off', '0', 'false')
        self._backend_factory = backend_factory
        self._stop, self._ready = threading.Event(), threading.Event()
        self._thread = None

    def start(self):
        if not self.enabled or self._thread is not None:
            return
        if self._backend_factory is None and sys.platform != 'win32':
            self.error = 'Standalone global hotkey is supported on Windows; click-to-talk remains available.'
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name='v2-voice-hotkey')
        self._thread.start()
        if not self._ready.wait(2):
            self.error = 'Hotkey registration timed out.'
            self._stop.set()

    def _run(self):
        backend, registered = None, False
        try:
            mask, key = parse_hotkey(self.combo)
            backend = (self._backend_factory or WindowsHotkeyBackend)()
            backend.register(mask, key)
            registered, self.ok = True, True
            self._ready.set()
            while not self._stop.wait(.05):
                if backend.fired():
                    self.trigger('hotkey')
        except Exception as exc:
            self.error = str(exc)
        finally:
            self._ready.set()
            if registered:
                backend.unregister()
            self.ok = False

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
