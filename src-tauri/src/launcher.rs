//! Launching the things a launcher box can hold: executables, documents,
//! folders and URLs.

use std::path::{Component, Path};

use serde::Deserialize;
use windows::core::HSTRING;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum LaunchKind {
    App,
    File,
    Folder,
    Url,
}

const KNOWN_APPS: [&str; 3] = ["notepad.exe", "calc.exe", "explorer.exe"];
const BLOCKED_FILE_EXT: [&str; 14] = [
    "bat", "cmd", "ps1", "js", "jse", "vbs", "vbe", "wsf", "wsh", "scr", "hta", "pif", "jar",
    "msi",
];

fn blocked_path_chars(target: &str) -> bool {
    target.chars().any(|c| {
        c.is_control()
            || matches!(c, ';' | '&' | '|' | '<' | '>' | '^' | '`' | '$' | '%' | '"' | '\'')
    })
}

fn absolute_path(target: &str) -> bool {
    let bytes = target.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc = target.starts_with("\\\\")
        && target[2..]
            .split(['\\', '/'])
            .filter(|part| !part.is_empty())
            .count()
            >= 2;
    drive || unc
}

fn path_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.len() > 4096
        || target.trim() != target
        || blocked_path_chars(target)
        || !absolute_path(target)
        || Path::new(target)
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("invalid path".into());
    }
    Ok(())
}

fn http_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.len() > 2048
        || target.trim() != target
        || target
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err("invalid URL".into());
    }
    let lower = target.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &target[8..]
    } else if lower.starts_with("http://") {
        &target[7..]
    } else {
        return Err("unsupported URL scheme".into());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err("invalid URL".into());
    }
    Ok(())
}

fn extension(target: &str) -> String {
    Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn validate(target: &str, kind: LaunchKind) -> Result<(), String> {
    match kind {
        LaunchKind::Url => http_target(target),
        LaunchKind::App => {
            if KNOWN_APPS
                .iter()
                .any(|name| target.eq_ignore_ascii_case(name))
            {
                return Ok(());
            }
            path_target(target)?;
            if extension(target) != "exe" {
                return Err("invalid application".into());
            }
            if !std::fs::metadata(target)
                .map(|m| m.is_file())
                .unwrap_or(false)
            {
                return Err("application not found".into());
            }
            Ok(())
        }
        LaunchKind::File => {
            path_target(target)?;
            if BLOCKED_FILE_EXT.contains(&extension(target).as_str()) {
                return Err("unsupported file type".into());
            }
            if !std::fs::metadata(target)
                .map(|m| m.is_file())
                .unwrap_or(false)
            {
                return Err("file not found".into());
            }
            Ok(())
        }
        LaunchKind::Folder => {
            path_target(target)?;
            if !std::fs::metadata(target)
                .map(|m| m.is_dir())
                .unwrap_or(false)
            {
                return Err("folder not found".into());
            }
            Ok(())
        }
    }
}

pub fn open(target: &str, kind: LaunchKind) -> Result<(), String> {
    validate(target, kind)?;
    let verb = HSTRING::from("open");
    let file = HSTRING::from(target);
    let result = unsafe {
        ShellExecuteW(
            None,
            &verb,
            &file,
            None,
            None,
            SW_SHOWNOACTIVATE,
        )
    };
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("the shell refused to open the target".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_urls() {
        assert!(http_target("javascript:alert(1)").is_err());
        assert!(http_target("file:///C:/secret.txt").is_err());
        assert!(http_target("https://example.com/a b").is_err());
        assert!(http_target("https://example.com/?a=1&b=2").is_ok());
    }

    #[test]
    fn rejects_path_tricks() {
        assert!(path_target("cmd.exe /c calc").is_err());
        assert!(path_target(r"C:\Windows\..\secret.exe").is_err());
        assert!(path_target("notepad.exe").is_err());
        assert!(validate("notepad.exe", LaunchKind::App).is_ok());
    }
}
