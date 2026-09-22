"""One registered shortcut, on Carbon's main thread. No microphone or key monitor."""
import ctypes
from collections import deque
import json
import os
import select
import sys
import threading


# Carbon virtual key codes describe ANSI physical keys, not typed characters.
KEY_CODES = {
    'A': 0, 'S': 1, 'D': 2, 'F': 3, 'H': 4, 'G': 5, 'Z': 6, 'X': 7,
    'C': 8, 'V': 9, 'B': 11, 'Q': 12, 'W': 13, 'E': 14, 'R': 15,
    'Y': 16, 'T': 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22,
    '5': 23, '9': 25, '7': 26, '8': 28, '0': 29, 'O': 31, 'U': 32,
    'I': 34, 'P': 35, 'L': 37, 'J': 38, 'K': 40, 'N': 45, 'M': 46,
}
HOTKEY_ID = (int.from_bytes(b'AOS2', 'big'), 1)
KEYBOARD = int.from_bytes(b'keyb', 'big')
PRESSED, RELEASED = 5, 6


def carbon_key(mask, key):
    """Translate the existing Windows-style config without monitoring typing."""
    if mask & ~0x400f or not mask & (2 | 8):
        raise ValueError('Mac hotkeys require Control or Command (win), plus a letter or digit.')
    character = chr(key)
    if not character.isascii() or not character.isalnum() or character not in KEY_CODES:
        raise ValueError('Mac hotkeys support ANSI physical letter and digit keys.')
    modifiers = sum(carbon for windows, carbon in ((1, 2048), (2, 4096), (4, 512), (8, 256)) if mask & windows)
    return modifiers, KEY_CODES[character]


class EventType(ctypes.Structure):
    _fields_ = [('eventClass', ctypes.c_uint32), ('eventKind', ctypes.c_uint32)]


class HotkeyID(ctypes.Structure):
    _fields_ = [('signature', ctypes.c_uint32), ('id', ctypes.c_uint32)]


EventHandler = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)


class CarbonHotkey:
    def __init__(self):
        if sys.platform != 'darwin' or threading.current_thread() is not threading.main_thread():
            raise RuntimeError('Mac hotkeys must run on the macOS helper main thread.')
        self.api = ctypes.CDLL('/System/Library/Frameworks/Carbon.framework/Carbon')
        pointer, uint, status = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32
        signatures = {
            'GetApplicationEventTarget': ([], pointer),
            'GetEventDispatcherTarget': ([], pointer),
            'InstallEventHandler': ([pointer, EventHandler, ctypes.c_ulong, ctypes.POINTER(EventType),
                pointer, ctypes.POINTER(pointer)], status),
            'RemoveEventHandler': ([pointer], status),
            'RegisterEventHotKey': ([uint, uint, HotkeyID, pointer, uint, ctypes.POINTER(pointer)], status),
            'UnregisterEventHotKey': ([pointer], status),
            'ReceiveNextEvent': ([ctypes.c_ulong, ctypes.POINTER(EventType), ctypes.c_double,
                ctypes.c_ubyte, ctypes.POINTER(pointer)], status),
            'GetEventKind': ([pointer], uint),
            'GetEventParameter': ([pointer, uint, uint, ctypes.POINTER(uint), ctypes.c_ulong,
                ctypes.POINTER(ctypes.c_ulong), pointer], status),
            'SendEventToEventTarget': ([pointer, pointer], status),
            'ReleaseEvent': ([pointer], None),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = arguments, result
        self.reference, self.handler = pointer(), pointer()
        self.pending, self.error = deque(), None
        self.callback = EventHandler(self._handle_event)  # Retain for the entire native registration.
        self.events = (EventType * 2)(EventType(KEYBOARD, PRESSED), EventType(KEYBOARD, RELEASED))

    def register(self, mask, key):
        modifiers, code = carbon_key(mask, key)
        target = self.api.GetApplicationEventTarget()
        status = self.api.InstallEventHandler(target, self.callback, 2, self.events, None, ctypes.byref(self.handler))
        if status:
            raise RuntimeError(f'Mac hotkey event handler failed (macOS error {status}).')
        status = self.api.RegisterEventHotKey(code, modifiers, HotkeyID(*HOTKEY_ID),
            target, 1, ctypes.byref(self.reference))
        if status:
            raise RuntimeError(f'Mac hotkey unavailable (macOS error {status}); another app may own it. '
                'Choose another shortcut or use the microphone button.')

    def _handle_event(self, _call, event, _data):
        # Carbon can dispatch directly while pumping its run loop. Never let a
        # Python exception cross this C callback boundary.
        try:
            identifier = HotkeyID()
            status = self.api.GetEventParameter(event, int.from_bytes(b'----', 'big'),
                int.from_bytes(b'hkid', 'big'), None, ctypes.sizeof(identifier), None,
                ctypes.byref(identifier))
            if status:
                raise RuntimeError(f'Mac hotkey event was invalid (macOS error {status}).')
            identity = (identifier.signature, identifier.id)
            if identity != HOTKEY_ID:
                return -9874  # eventNotHandledErr
            self.pending.append((self.api.GetEventKind(event), identity))
            return 0
        except Exception as exc:
            self.error = str(exc)
            return -9874

    def next_event(self):
        if not self.pending:
            event = ctypes.c_void_p()
            # Pump and dispatch the helper's own application queue; only the
            # registered hotkey handler above observes input. No event monitor.
            status = self.api.ReceiveNextEvent(0, None, .1, True, ctypes.byref(event))
            if status == 0:
                try:
                    self.api.SendEventToEventTarget(event, self.api.GetEventDispatcherTarget())
                finally:
                    self.api.ReleaseEvent(event)
            elif status != -9875:  # eventLoopTimedOutErr also lets us notice parent exit.
                raise RuntimeError(f'Mac hotkey event loop failed (macOS error {status}).')
        if self.error:
            raise RuntimeError(self.error)
        return self.pending.popleft() if self.pending else None

    def unregister(self):
        if self.reference.value:
            self.api.UnregisterEventHotKey(self.reference)
            self.reference = ctypes.c_void_p()
        if self.handler.value:
            self.api.RemoveEventHandler(self.handler)
            self.handler = ctypes.c_void_p()


def run(mask, key, backend, parent_alive, emit):
    """The helper owns registration even if ready notification or its loop fails."""
    try:
        backend.register(mask, key)
        emit({'type': 'ready'})
        down = False
        while parent_alive():
            event = backend.next_event()
            if not event or event[1] != HOTKEY_ID:
                continue
            if event[0] == RELEASED:
                down = False
            elif event[0] == PRESSED and not down:
                down = True
                emit({'type': 'pressed'})
    finally:
        backend.unregister()


def parent_alive(parent, source):
    if parent == 1 or os.getppid() != parent:
        return False
    # stdin is a private lifetime pipe; EOF also covers normal shutdown.
    readable, _, _ = select.select([source], [], [], 0)
    return not readable or bool(os.read(source.fileno(), 1))


def main():
    def emit(message):
        print(json.dumps(message), flush=True)
    try:
        mask, key = map(int, sys.argv[1:])
        parent = os.getppid()
        run(mask, key, CarbonHotkey(), lambda: parent_alive(parent, sys.stdin), emit)
        return 0
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    except Exception as exc:
        try:
            emit({'type': 'error', 'error': str(exc)})
        except BrokenPipeError:
            pass
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
