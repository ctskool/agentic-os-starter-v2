"""V2-owned push-to-talk. Importing this module opens no device or OS hook."""
import math
import json
import pathlib
import queue
import subprocess
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


class MacHotkeyBackend:
    """Carbon runs in a child main thread; speech keeps its asyncio event loop."""
    def __init__(self, command=None, startup_timeout=2, stop_timeout=.3):
        self.command = command or [sys.executable, '-u', str(pathlib.Path(__file__).with_name('macos_hotkey.py'))]
        self.startup_timeout, self.stop_timeout = startup_timeout, stop_timeout
        self.process, self.reader = None, None
        self.messages = queue.Queue()

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(4097)
                if not line:
                    break
                if len(line) > 4096:
                    raise ValueError('oversized message')
                message = json.loads(line)
                if not isinstance(message, dict) or message.get('type') not in ('ready', 'pressed', 'error'):
                    raise ValueError('unknown message')
                self.messages.put(message)
        except (ValueError, OSError):
            self.messages.put({'type': 'error', 'error': 'Mac hotkey helper sent an invalid response.'})
        finally:
            self.messages.put({'type': 'error', 'error': 'Mac hotkey helper stopped; restart voice to register it again.'})

    @staticmethod
    def _check(message, expected):
        if message.get('type') == 'error':
            raise RuntimeError(str(message.get('error') or 'Mac hotkey helper failed.')[:500])
        if message.get('type') != expected:
            raise RuntimeError('Mac hotkey helper sent an unexpected response.')

    def register(self, mask, key):
        try:
            self.process = subprocess.Popen([*self.command, str(mask), str(key)], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True, bufsize=0)
            self.reader = threading.Thread(target=self._read, daemon=True, name='v2-mac-hotkey-protocol')
            self.reader.start()
            try:
                message = self.messages.get(timeout=self.startup_timeout)
            except queue.Empty:
                raise RuntimeError('Mac hotkey registration timed out; use the microphone button.') from None
            self._check(message, 'ready')
            if self.process.poll() is not None:
                raise RuntimeError('Mac hotkey helper exited during registration.')
        except Exception:
            self.unregister()
            raise

    def fired(self):
        if self.process.poll() is not None:
            raise RuntimeError('Mac hotkey helper stopped; restart voice to register it again.')
        try:
            message = self.messages.get_nowait()
        except queue.Empty:
            if self.process.poll() is not None:
                raise RuntimeError('Mac hotkey helper stopped; restart voice to register it again.')
            return False
        self._check(message, 'pressed')
        return True

    def unregister(self):
        if self.process is None:
            return
        process = self.process
        if process.stdin:
            process.stdin.close()  # EOF releases the helper's registration, even after parent death.
        for action in (None, process.terminate, process.kill):
            if process.poll() is not None:
                break
            if action:
                try:
                    action()
                except ProcessLookupError:
                    break
            try:
                process.wait(timeout=self.stop_timeout)
            except subprocess.TimeoutExpired:
                continue
        if self.reader:
            self.reader.join(timeout=self.stop_timeout)
        if process.stdout:
            process.stdout.close()


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
        if self._backend_factory is None and sys.platform not in ('win32', 'darwin'):
            self.error = 'Standalone global hotkey is supported on Windows and macOS; click-to-talk remains available.'
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name='v2-voice-hotkey')
        self._thread.start()
        if not self._ready.wait(4):
            self.error = 'Hotkey registration timed out.'
            self._stop.set()

    def _run(self):
        backend, registered = None, False
        try:
            mask, key = parse_hotkey(self.combo)
            factory = MacHotkeyBackend if sys.platform == 'darwin' else WindowsHotkeyBackend
            backend = (self._backend_factory or factory)()
            backend.register(mask, key)
            registered = True
            if self._stop.is_set():
                return
            self.ok = True
            self._ready.set()
            while not self._stop.wait(.05):
                if backend.fired():
                    self.trigger('hotkey')
        except Exception as exc:
            self.error = str(exc)
        finally:
            self._ready.set()
            try:
                if registered:
                    backend.unregister()
            finally:
                self.ok = False

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=4)
