import os
import resource
import select
import signal
import sys
import time
import ctypes
import errno


def restrict_syscalls():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot set no_new_privs')
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(0x7fff0000)
    if not context:
        raise RuntimeError('Cannot initialize seccomp')
    try:
        for name in ('mount', 'umount2', 'pivot_root', 'chroot', 'unshare', 'setns',
                     'ptrace', 'process_vm_writev', 'process_vm_readv', 'bpf',
                     'perf_event_open', 'keyctl', 'add_key', 'request_key',
                     'open_by_handle_at', 'init_module', 'finit_module',
                     'delete_module', 'kexec_load', 'kexec_file_load', 'reboot',
                     'userfaultfd', 'io_uring_setup'):
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(context, 0x50000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError('Cannot add seccomp rule')
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError('Cannot load seccomp filter')
    finally:
        seccomp.seccomp_release(context)


def supervise():
    seconds = float(sys.argv[1])
    if not 0.1 <= seconds <= 15 or len(sys.argv) < 3:
        raise ValueError('Invalid supervisor arguments')
    child = os.fork()
    if child == 0:
        os.setsid()
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # NPROC is per real UID, not a namespace-wide process quota.
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        restrict_syscalls()
        null = os.open('/dev/null', os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
        os.execv(sys.argv[2], sys.argv[2:])
    def stop(*_):
        try:
            os.killpg(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda *_: sys.exit(130))
    deadline = time.monotonic() + seconds
    try:
        while True:
            finished, status = os.waitpid(child, os.WNOHANG)
            if finished:
                return os.waitstatus_to_exitcode(status)
            if time.monotonic() >= deadline:
                return 124
            # The host owns this pipe; disconnect cancels the sandbox workload.
            if select.select([0], [], [], 0.02)[0] and not os.read(0, 1):
                return 130
    finally:
        stop()


try:
    result = supervise()
    sys.exit(128 - result if result < 0 else result)
except Exception as error:
    print(f'Sandbox supervisor failed: {error}', file=sys.stderr)
    sys.exit(125)
