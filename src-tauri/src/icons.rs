//! Extracts the shell icon for a file, folder, shortcut or executable and
//! encodes it as a small PNG for the webview.
//!
//! `SHGetFileInfoW` hands us the exact icon Explorer would draw (so `.lnk`
//! targets and per-folder artwork are resolved for free). We then blit that
//! icon into a 32-bit top-down DIB at a fixed size and encode it.

use windows::core::PCWSTR;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, SHFILEINFOW, SHGFI_FLAGS, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// Target edge length in pixels: 48 matches Explorer's medium icon size and
/// keeps the encoded PNG in the 2-4 KB range.
const ICON_SIZE: i32 = 48;

/// Extract the shell icon for `path`, returned as PNG bytes.
pub fn icon_png(path: &str) -> Result<Vec<u8>, String> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut sfi = SHFILEINFOW::default();
    // USEFILEATTRIBUTES lets us fall back to a generic (type-based) icon when
    // the file does not exist, e.g. an offline network share.
    let flags = SHGFI_FLAGS(SHGFI_ICON.0 | SHGFI_LARGEICON.0 | SHGFI_USEFILEATTRIBUTES.0);
    let res = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if res == 0 || sfi.hIcon.is_invalid() {
        return Err(format!("no icon available for {path}"));
    }
    let hicon = sfi.hIcon;

    // SAFETY: every handle acquired below is released on every path, and all
    // GDI calls are made on DCs we own for the duration of the block.
    unsafe {
        let mut info = ICONINFO::default();
        if GetIconInfo(hicon, &mut info).is_err()
            || (info.hbmColor.is_invalid() && info.hbmMask.is_invalid())
        {
            let _ = DestroyIcon(hicon);
            return Err("GetIconInfo failed".into());
        }
        // Monochrome icons only supply a mask; colour icons supply both.
        let hbm = if info.hbmColor.is_invalid() { info.hbmMask } else { info.hbmColor };

        let screen = GetDC(None);
        let dest_dc = CreateCompatibleDC(Some(screen));
        let src_dc = CreateCompatibleDC(Some(screen));

        // Ask GDI how big the icon bitmap actually is. Passing a zero-sized
        // BITMAPINFOHEADER makes GetDIBits report the dimensions.
        let mut probe = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 0,
                biHeight: 0,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let got = GetDIBits(src_dc, hbm, 0, 0, None, &mut probe, DIB_RGB_COLORS);
        let (src_w, src_h) = if got != 0 && probe.bmiHeader.biWidth > 0 && probe.bmiHeader.biHeight > 0 {
            (probe.bmiHeader.biWidth, -probe.bmiHeader.biHeight)
        } else {
            (ICON_SIZE, ICON_SIZE)
        };

        // Negative height => top-down DIB, which is already PNG row order.
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: ICON_SIZE,
                biHeight: -ICON_SIZE,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let Ok(section) = CreateDIBSection(Some(dest_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
            DeleteObject(info.hbmColor.into());
            DeleteObject(info.hbmMask.into());
            ReleaseDC(None, src_dc);
            ReleaseDC(None, dest_dc);
            ReleaseDC(None, screen);
            let _ = DestroyIcon(hicon);
            return Err("CreateDIBSection failed".into());
        };

        let old_dest = SelectObject(dest_dc, section.into());
        let old_src = SelectObject(src_dc, hbm.into());

        let blitted = StretchBlt(
            dest_dc,
            0,
            0,
            ICON_SIZE,
            ICON_SIZE,
            Some(src_dc),
            0,
            0,
            src_w,
            src_h,
            SRCCOPY,
        )
        .as_bool();

        let byte_len = (ICON_SIZE * ICON_SIZE * 4) as usize;
        let mut bgra = if blitted && !bits.is_null() {
            std::slice::from_raw_parts(bits as *const u8, byte_len).to_vec()
        } else {
            Vec::new()
        };

        SelectObject(dest_dc, old_dest);
        SelectObject(src_dc, old_src);
        DeleteObject(section.into());
        DeleteObject(info.hbmColor.into());
        DeleteObject(info.hbmMask.into());
        ReleaseDC(None, src_dc);
        ReleaseDC(None, dest_dc);
        ReleaseDC(None, screen);
        let _ = DestroyIcon(hicon);
        let _ = POINT::default();

        if bgra.is_empty() {
            return Err("icon blit produced no pixels".into());
        }

        // GDI hands back BGRA; PNG wants RGBA.
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        Ok(crate::png::encode_rgba(ICON_SIZE as u32, ICON_SIZE as u32, &bgra))
    }
}
