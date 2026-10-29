#!/usr/bin/env python3
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0
# International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

"""Bridge a host-network listener into a child user-namespace-owned netns.
Usage: port_fwd.py <listen_port> <target_port> <inner_netns_pid>
Binds listen_port on the host netns, then setns() into the inner netns and
relays every accepted connection to 127.0.0.1:target_port inside it."""

import ctypes
import os
import socket
import sys
import threading

LISTEN_PORT = int(sys.argv[1])
TARGET_PORT = int(sys.argv[2])
INNER_PID = sys.argv[3]
CLONE_NEWNET = 0x40000000

libc = ctypes.CDLL("libc.so.6", use_errno=True)

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", LISTEN_PORT))
srv.listen(64)

fd = os.open(f"/proc/{INNER_PID}/ns/net", os.O_RDONLY)
if libc.setns(fd, CLONE_NEWNET) != 0:
    raise OSError(ctypes.get_errno(), "setns failed")
os.close(fd)


def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(conn):
    try:
        up = socket.create_connection(("127.0.0.1", TARGET_PORT), timeout=10)
        up.settimeout(None)  # connect timeout must not persist into relay
    except OSError:
        conn.close()
        return
    threading.Thread(target=pump, args=(up, conn), daemon=True).start()
    pump(conn, up)


while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
