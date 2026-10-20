import ctypes
from ctypes import wintypes
user32 = ctypes.windll.user32
def enum_all(hwnd,lparam):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd,buf,256)
    if buf.value == 'SHELLDLL_DefView':
        par = user32.GetParent(hwnd)
        bufp = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(par,bufp,256)
        print('DEFVIEW:'+hex(hwnd)+'|PARENT:'+hex(par)+'|'+bufp.value)
        cur = user32.GetWindow(par,5)
        i=0
        while cur and i<40:
            bc = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(cur,bc,256)
            bt = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(cur,bt,256)
            print('C'+str(i)+':'+hex(cur)+'|'+bc.value+'|'+bt.value)
            cur = user32.GetWindow(cur,2)
            i+=1
        return 0
    return 1
ENUM = ctypes.WINFUNCTYPE(ctypes.c_int,wintypes.HWND,wintypes.LPARAM)
user32.EnumWindows(ENUM(enum_all),0)
