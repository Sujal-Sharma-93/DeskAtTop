use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static IMPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

pub fn wallpaper_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA is unavailable".to_string())?;
    let dir = Path::new(&appdata)
        .join("com.deskattop.desk")
        .join("wallpapers");
    std::fs::create_dir_all(&dir).map_err(|e| format!("wallpaper directory: {e}"))?;
    Ok(dir)
}

fn is_safe_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 120 || name.contains("..") || name.ends_with('.') {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn supported_extension(path: &Path) -> Option<&str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "bmp" => Some("bmp"),
        "webp" => Some("webp"),
        "tif" | "tiff" => Some("tif"),
        _ => None,
    }
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(&[0x49, 0x49, 0x2a, 0x00]) || bytes.starts_with(&[0x4d, 0x4d, 0x00, 0x2a]) {
        Some("image/tiff")
    } else {
        None
    }
}

fn confirm_within_dir(dir: &Path, file: &Path) -> Result<PathBuf, String> {
    let canonical_dir = std::fs::canonicalize(dir).map_err(|e| format!("wallpaper directory: {e}"))?;
    let canonical_file = std::fs::canonicalize(file).map_err(|e| format!("wallpaper file: {e}"))?;
    if canonical_file.parent() != Some(canonical_dir.as_path()) {
        return Err("Wallpaper must be inside the application wallpaper directory.".into());
    }
    Ok(canonical_file)
}

pub fn resolve_reference(reference: &str) -> Result<PathBuf, String> {
    if !is_safe_name(reference) {
        return Err("Choose an image from the wallpaper picker.".into());
    }
    let dir = wallpaper_dir()?;
    confirm_within_dir(&dir, &dir.join(reference))
}

pub fn read_reference(reference: &str) -> Result<(Vec<u8>, &'static str), String> {
    let path = resolve_reference(reference)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("wallpaper file: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("The selected wallpaper is not a supported image.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("wallpaper file: {e}"))?;
    let mime = image_mime(&bytes).ok_or_else(|| "The selected wallpaper is not a supported image.".to_string())?;
    Ok((bytes, mime))
}

pub fn import(source_path: &str) -> Result<String, String> {
    if source_path.is_empty() || source_path.len() > 4096 || source_path.chars().any(|c| c.is_control()) {
        return Err("Invalid image path.".into());
    }
    let source = PathBuf::from(source_path);
    let ext = supported_extension(&source)
        .ok_or_else(|| "Choose a PNG, JPEG, GIF, BMP, WebP or TIFF image.".to_string())?;
    let canonical = std::fs::canonicalize(&source).map_err(|e| format!("image file: {e}"))?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| format!("image file: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("The selected image is too large or is not a file.".into());
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("image file: {e}"))?;
    image_mime(&bytes).ok_or_else(|| "The selected image content is not a supported image.".to_string())?;

    let stem_raw = canonical
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("wallpaper");
    let stem: String = stem_raw
        .chars()
        .take(40)
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let stem = if stem.is_empty() {
        "wallpaper".to_string()
    } else {
        stem
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sequence = IMPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("{stem}_{stamp:x}_{sequence:x}.{ext}");
    if !is_safe_name(&name) {
        return Err("Could not create a safe wallpaper name.".into());
    }

    let dir = wallpaper_dir()?;
    let destination = dir.join(&name);
    std::fs::write(&destination, &bytes).map_err(|e| format!("save wallpaper: {e}"))?;
    confirm_within_dir(&dir, &destination)?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_arbitrary_wallpaper_paths() {
        assert!(!is_safe_name(r"C:\Users\digital\secret.png"));
        assert!(!is_safe_name("..\\secret.png"));
        assert!(read_reference(r"C:\Users\digital\secret.png").is_err());
        assert!(read_reference("..\\secret.png").is_err());
        assert!(is_safe_name("photo_123.png"));
    }

    #[test]
    fn validates_image_magic() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n123"), Some("image/png"));
        assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"not an image"), None);
    }
}
