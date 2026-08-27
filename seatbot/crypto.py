from __future__ import annotations

import base64
import hashlib

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

_AES_KEY = b"u2oh6Vu^HWe4_AES"
_AES_IV = b"u2oh6Vu^HWe4_AES"


def encrypt_login_field(value: str) -> str:
    """Encrypt a Chaoxing login field using the web client's AES-CBC convention."""
    padder = padding.PKCS7(128).padder()
    padded = padder.update(value.encode("utf-8")) + padder.finalize()
    cipher = Cipher(algorithms.AES(_AES_KEY), modes.CBC(_AES_IV), backend=default_backend())
    encryptor = cipher.encryptor()
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(encrypted).decode("ascii")


def verify_param(params: dict[str, object], algorithm_value: str) -> str:
    """Build the request verification hash used by the seat submit page."""
    parts = [f"[{key}={params[key]}]" for key in sorted(params)]
    parts.append(f"[{algorithm_value}]")
    return hashlib.md5("".join(parts).encode("utf-8")).hexdigest()
