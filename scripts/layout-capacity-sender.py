# Paced UDP sender. argv: dst_ip dst_port pps seconds src_ip iface payload_bytes. Prints "sent <n> elapsed_ns <ns>".
import socket, sys, time
dst, port, pps, secs, src, iface, size = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), sys.argv[5], sys.argv[6], int(sys.argv[7])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
if iface != '-':
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())
if src != '-':
    s.bind((src, 0))
payload = b'x' * size
addr = (dst, port)
start = time.perf_counter_ns()
end = start + int(secs * 1e9)
interval = 1e9 / pps
sent = 0
send = s.sendto
while True:
    now = time.perf_counter_ns()
    if now >= end: break
    due = int((now - start) / interval) + 1  # packets that should have been sent by now
    n = due - sent
    for _ in range(n if n < 200 else 200):
        send(payload, addr); sent += 1
print('sent', sent, 'elapsed_ns', time.perf_counter_ns() - start)
