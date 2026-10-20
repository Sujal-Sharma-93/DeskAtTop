import ctypes
from ctypes import wintypes
user32 = ctypes.windll.user32
ov = 0x60628
workerw = 0x202ac
defview = 0x50042
res = user32.SetParent(ctypes.c_void_p(ov), ctypes.c_void_p(workerw))
print(int(res))
