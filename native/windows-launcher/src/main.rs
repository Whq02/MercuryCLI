#![cfg_attr(windows, windows_subsystem = "console")]

use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Command, ExitStatus, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

include!(concat!(env!("OUT_DIR"), "/policy.rs"));

const RESET: &str = "\x1b[?2026l\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1007l\x1b[?1049l\x1b[?1004l\x1b[?25h\x1b]111\x07";

#[cfg(windows)]
mod console {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
        fn SetConsoleCP(code_page: u32) -> i32;
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }

    unsafe extern "system" fn control(event: u32) -> i32 {
        i32::from(event == 0 || event == 1)
    }

    pub fn prepare() -> std::io::Result<()> {
        unsafe {
            if SetConsoleCtrlHandler(Some(control), 1) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if SetConsoleCP(65001) != 0 && SetConsoleOutputCP(65001) != 0 {
                std::env::set_var("MERCURY_WIN32_UTF8_PRESET", "1");
            }
        }
        Ok(())
    }
}

fn nonempty_env(key: &str) -> Option<OsString> {
    env::var_os(key).filter(|v| !v.is_empty())
}

fn node_binary(dir: &Path) -> io::Result<OsString> {
    if let Some(node) = nonempty_env("MERCURY_NODE") {
        if Path::new(&node).is_file() {
            return Ok(node);
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "MERCURY_NODE names no file",
        ));
    }
    let vendored = dir.join("vendor").join("node").join("node.exe");
    if vendored.is_file() {
        return Ok(vendored.into_os_string());
    }
    Ok(OsString::from(if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }))
}

fn supported_version(version: &str) -> bool {
    let parts = version.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let values = parts
        .iter()
        .map(|p| p.parse::<u32>())
        .collect::<Result<Vec<_>, _>>();
    match values {
        Ok(v) => v[0] == NODE_MINIMUM.0 && (v[0], v[1], v[2]) >= NODE_MINIMUM,
        Err(_) => false,
    }
}

fn takeover(args: &[OsString], interactive: bool) -> bool {
    interactive
        && !args.first().is_some_and(|a| {
            a.to_string_lossy().starts_with('-') || SKIP_VERBS.iter().any(|v| a == OsStr::new(v))
        })
        && !args
            .iter()
            .any(|a| SKIP_FLAGS.iter().any(|f| a == OsStr::new(f)))
}

fn cache_path(home: &Path) -> Option<PathBuf> {
    let cache = home.join("compile-cache");
    let text = cache.to_string_lossy();
    (text.encode_utf16().count() <= 200 || text.starts_with("\\\\?\\")).then_some(cache)
}

fn prepare_cache() {
    if nonempty_env("NODE_COMPILE_CACHE").is_some()
        || nonempty_env("NODE_DISABLE_COMPILE_CACHE").is_some()
    {
        return;
    }
    let home = nonempty_env("MERCURY_CONFIG_DIR")
        .or_else(|| nonempty_env("MERCURY_HOME"))
        .map(PathBuf::from)
        .or_else(|| nonempty_env("USERPROFILE").map(|p| PathBuf::from(p).join(".mercury")));
    if let Some(cache) = home.as_deref().and_then(cache_path) {
        env::set_var("NODE_COMPILE_CACHE", cache);
    }
}

fn child(node: &OsStr, script: &Path, args: &[OsString]) -> Command {
    let mut command = Command::new(node);
    command.arg(script).args(args);
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

fn exit_code(status: ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
    }
    #[cfg(not(unix))]
    status.code().unwrap_or(1)
}

fn heal() {
    let _ = io::stdout().write_all(RESET.as_bytes());
    let _ = io::stdout().flush();
}

fn node_missing() -> String {
    format!("no usable Node runtime — MERCURY_NODE must name an existing Node binary, or re-extract the archive for vendor/node/node.exe, or install Node {} ({NODE_RANGE}) on PATH", NODE_MINIMUM.0)
}

fn launch() -> Result<i32, String> {
    let exe = env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the launcher has no parent folder")?;
    #[cfg(windows)]
    console::prepare().map_err(|e| format!("could not listen for console events: {e}"))?;
    let node = node_binary(dir).map_err(|_| node_missing())?;
    let probe = Command::new(&node)
        .args(["-p", "process.versions.node"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| node_missing())?;
    let version = String::from_utf8_lossy(&probe.stdout);
    if !probe.status.success() || !supported_version(version.trim()) {
        return Err(format!("Node {} ({NODE_RANGE}) is required, found {}; point MERCURY_NODE at a supported binary or re-extract the release archive", NODE_MINIMUM.0, version.trim()));
    }
    let bundle = dir.join("mercury.mjs");
    if !bundle.is_file() {
        return Err("mercury.mjs is missing beside this launcher".into());
    }
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    let interactive = io::stdin().is_terminal() && io::stdout().is_terminal();
    let take = takeover(&args, interactive);
    let verifier = dir.join("verify-artifact.mjs");
    if take && verifier.is_file() {
        let _ = child(&node, &verifier, &["--launcher".into()]).status();
    }
    prepare_cache();
    let splash = dir.join("splash.mjs");
    if take
        && splash.is_file()
        && env::var("MERCURY_NO_BANNER").as_deref() != Ok("1")
        && !matches!(env::var("MERCURY_SPLASH").as_deref(), Ok("off" | "static"))
    {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        env::set_var(
            "MERCURY_LAUNCH_ID",
            format!("exe-{}-{stamp}", process::id()),
        );
        match child(&node, &splash, &[]).status().map(exit_code) {
            Ok(130) => return Ok(0),
            Ok(code @ (0 | 20)) => {
                env::set_var("MERCURY_SPLASH_HANDOFF", "1");
                if code == 0 && env::var("MERCURY_FULLSCREEN").as_deref() != Ok("0") {
                    env::set_var("MERCURY_ALT_HELD", "1");
                }
            }
            _ => heal(),
        }
    }
    let result = child(&node, &bundle, &args).status().map(exit_code);
    if io::stdout().is_terminal() && !matches!(result, Ok(0)) {
        heal();
    }
    result.map_err(|e| format!("could not start Node: {e}"))
}

fn main() {
    match launch() {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("mercury: {error}");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_policy() {
        let (major, minor, patch) = NODE_MINIMUM;
        assert!(supported_version(&format!("{major}.{minor}.{patch}")));
        assert!(!supported_version(&format!("{}.0.0", major + 1)));
        assert!(!supported_version(&format!("{major}.{minor}.{patch}-rc.1")));
        assert!(!supported_version("none"));
        if minor > 0 {
            assert!(!supported_version(&format!("{major}.{}.999", minor - 1)));
        }
    }

    #[test]
    fn splash_skip_policy() {
        assert!(takeover(&[], true));
        assert!(!takeover(&[], false));
        assert!(takeover(&["a prompt".into()], true));
        for verb in SKIP_VERBS {
            assert!(!takeover(&[verb.into()], true));
        }
        for flag in SKIP_FLAGS {
            assert!(!takeover(&["a prompt".into(), flag.into()], true));
        }
        assert!(!takeover(&["--anything".into()], true));
    }

    #[test]
    fn long_cache_paths_do_not_arm_node() {
        assert!(cache_path(Path::new("short")).is_some());
        assert!(cache_path(Path::new(&"x".repeat(201))).is_none());
        assert!(cache_path(Path::new(&format!("\\\\?\\{}", "x".repeat(201)))).is_some());
    }
}
