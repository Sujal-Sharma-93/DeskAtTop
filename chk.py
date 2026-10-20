import ctypes
from ctypes import wintypes
user32 = ctypes.windll.user32
workerw = None
def enum_w(hwnd,l):
    global workerw
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd,buf,256)
    if buf.value == 'WorkerW':
        def ec(hwnd2,l2):
            global workerw
            buf2 = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd2,buf2,256)
            if buf2.value == 'SHELLDLL_DefView':
                workerw = hwnd
            return 1
        ENUM2 = ctypes.WINFUNCTYPE(ctypes.c_int,wintypes.HWND,wintypes.LPARAM)
        user32.EnumChildWindows(hwnd,ENUM2(ec),0)
    return 1
ENUM = ctypes.WINFUNCTYPE(ctypes.c_int,wintypes.HWND,wintypes.LPARAM)
user32.EnumWindows(ENUM(enum_w),0)
print(hex(workerw) if workerw else 'none')
if workerw:
    defview=None
    def ec2(hwnd2,l2):
        global defview
        buf2=ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd2,buf2,256)
        if buf2.value=='SHELLDLL_DefView':
            defview=hwnd2
            return 0
        return 1
    ENUM2=ctypes.WINFUNCTYPE(ctypes.c_int,wintypes.HWND,wintypes.LPARAM)
    user32.EnumChildWindows(workerw,ENUM2(ec2),0)
    print(hex(defview) if defview else 'none')
