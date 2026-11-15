use std::collections::HashMap;
use std::path::PathBuf;

use tauri::Emitter;

use crate::models::ThemePayload;

// colors.toml keys that drive the UI palette; every other key passes through
// as --c-<key>. Mirrors server/theme.js from the Node app.
const SEMANTIC: &[(&str, &str)] = &[
    ("background", "--bg"),
    ("darker_background", "--bg-deep"),
    ("lighter_background", "--bg-raised"),
    ("foreground", "--fg"),
    ("bright_foreground", "--fg-bright"),
    ("muted", "--muted"),
    ("dark_foreground", "--muted"),
    ("selection", "--selection"),
    ("accent", "--accent"),
];

fn parse_colors(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().to_string();
        let value = value
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        if !key.is_empty() && !value.is_empty() {
            out.insert(key, value);
        }
    }
    out
}

fn xdg_dir(var: &str, fallback: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(var) {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(fallback))
}

/// Omarchy records the active theme in this state file; `omarchy theme set`
/// rewrites it, which is the change signal we poll.
fn theme_slug() -> Option<String> {
    let path = xdg_dir("XDG_STATE_HOME", ".local/state")?
        .join("omarchy")
        .join("current")
        .join("theme.name");
    let text = std::fs::read_to_string(path).ok()?;
    let slug = text.trim().to_string();
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

/// "tokyo-night" -> "Tokyo Night", matching `omarchy theme current` output.
fn display_name(slug: &str) -> String {
    slug.split('-')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn load_vars(slug: &str) -> Option<HashMap<String, String>> {
    for dir in [
        xdg_dir("XDG_CONFIG_HOME", ".config")?.join("omarchy").join("themes"),
        PathBuf::from("/usr/share/omarchy/themes"),
    ] {
        let candidate = dir.join(slug).join("colors.toml");
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            let mut vars = HashMap::new();
            for (key, value) in parse_colors(&text) {
                let css_key = SEMANTIC
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, css)| css.to_string())
                    .unwrap_or_else(|| format!("--c-{key}"));
                vars.insert(css_key, value);
            }
            return Some(vars);
        }
    }
    None
}

/// Theme palette + display name for the current Omarchy theme. Every platform
/// without omarchy state gets name: None and empty vars, so the UI keeps its
/// built-in Dracula fallbacks.
pub fn get_theme() -> ThemePayload {
    let Some(slug) = theme_slug() else {
        return ThemePayload { name: None, vars: HashMap::new() };
    };
    match load_vars(&slug) {
        Some(vars) => ThemePayload { name: Some(display_name(&slug)), vars },
        None => ThemePayload { name: None, vars: HashMap::new() },
    }
}

/// Polls the Omarchy theme state file and emits `theme-changed` when the user
/// applies a different theme, so the UI re-skins without a restart. Two-second
/// stat+read poll: theme switches are rare and the check costs nothing.
pub fn watch_loop(handle: tauri::AppHandle) {
    let mut last = theme_slug();
    loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let current = theme_slug();
        if current.is_some() && current != last {
            last = current;
            let payload = get_theme();
            println!("[theme] switched to {:?}", payload.name);
            let _ = handle.emit("theme-changed", &payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_colors_toml_lines() {
        let colors = parse_colors("background = \"#282a36\"\naccent = \"#bd93f9\"\n\n# comment\nmuted='#6272a4'\nbroken\n");
        assert_eq!(colors.get("background").unwrap(), "#282a36");
        assert_eq!(colors.get("accent").unwrap(), "#bd93f9");
        assert_eq!(colors.get("muted").unwrap(), "#6272a4");
        assert_eq!(colors.len(), 3);
    }

    #[test]
    fn slugs_become_display_names() {
        assert_eq!(display_name("dracula"), "Dracula");
        assert_eq!(display_name("tokyo-night"), "Tokyo Night");
        assert_eq!(display_name("catppuccin-mocha"), "Catppuccin Mocha");
    }
}
