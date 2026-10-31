use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn native_launcher_forwards_arguments_stdio_and_exit_codes() {
    let root =
        Fixture(std::env::temp_dir().join(format!("mercury launcher 雪 {}", std::process::id())));
    fs::create_dir_all(root.0.join("vendor/node")).unwrap();
    let exe = root.0.join(if cfg!(windows) {
        "mercury.exe"
    } else {
        "mercury"
    });
    fs::copy(env!("CARGO_BIN_EXE_mercury"), &exe).unwrap();
    let stub = root.0.join("vendor/node/node.exe");
    let built = Command::new("rustc")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/node.rs"))
        .arg("-o")
        .arg(&stub)
        .status()
        .unwrap();
    assert!(built.success());
    fs::write(root.0.join("mercury.mjs"), "").unwrap();
    let policy = Command::new("node")
        .args(["-p", "process.versions.node"])
        .output()
        .unwrap();
    assert!(policy.status.success());
    let version = String::from_utf8(policy.stdout).unwrap();
    let args = [
        "run",
        "",
        "two words",
        "雪 café",
        "%NAME% ! ^ & | < > ( )",
        "a\"b",
        "C:\\trailing slash\\",
        "line one\nline two",
        "--",
        "--version",
    ];
    let command = || {
        let mut cmd = Command::new(&exe);
        cmd.current_dir(&root.0)
            .env_remove("MERCURY_NODE")
            .env_remove("MERCURY_HOME")
            .env_remove("MERCURY_CRITTER")
            .env_remove("NODE_COMPILE_CACHE")
            .env_remove("NODE_DISABLE_COMPILE_CACHE")
            .env("MERCURY_CONFIG_DIR", root.0.join("home"))
            .env("MERCURY_SPLASH", "off")
            .env("STUB_NODE_VERSION", version.trim())
            .env("STUB_NODE_EXIT", "0");
        cmd
    };
    let codes: &[i32] = if cfg!(windows) {
        &[0, 37, 211, 0xc000013a_u32 as i32]
    } else {
        &[0, 37, 211]
    };
    for &code in codes {
        let mut run = command()
            .args(args)
            .env("STUB_NODE_EXIT", code.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        run.stdin
            .take()
            .unwrap()
            .write_all(b"input kept\n")
            .unwrap();
        let output = run.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(code));
        let text = String::from_utf8(output.stdout).unwrap();
        let expected = args
            .iter()
            .map(|arg| {
                let hex = arg
                    .as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                format!("arg={hex}")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("arg="))
                .collect::<Vec<_>>(),
            expected
        );
        assert!(text.contains("stdin=input kept\n"));
        assert!(text.contains(&format!(
            "cache={}",
            root.0.join("home/compile-cache").display()
        )));
        let cwd = text
            .lines()
            .find_map(|line| line.strip_prefix("cwd="))
            .unwrap();
        assert_eq!(
            fs::canonicalize(cwd).unwrap(),
            fs::canonicalize(&root.0).unwrap()
        );
        assert_eq!(String::from_utf8(output.stderr).unwrap(), "stub stderr\n");
    }
    let override_node = root.0.join("chosen node.exe");
    fs::rename(&stub, &override_node).unwrap();
    let explicit = command()
        .env("MERCURY_NODE", &override_node)
        .output()
        .unwrap();
    assert!(explicit.status.success());
    let missing = command()
        .env("MERCURY_NODE", root.0.join("missing.exe"))
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8(missing.stderr)
        .unwrap()
        .contains("MERCURY_NODE"));
    let old = command()
        .env("MERCURY_NODE", &override_node)
        .env("STUB_NODE_VERSION", "18.0.0")
        .output()
        .unwrap();
    assert_eq!(old.status.code(), Some(1));
    let own_cache = command()
        .env("MERCURY_NODE", &override_node)
        .env("NODE_COMPILE_CACHE", "chosen-cache")
        .output()
        .unwrap();
    assert!(String::from_utf8(own_cache.stdout)
        .unwrap()
        .contains("cache=chosen-cache"));
    let disabled = command()
        .env("MERCURY_NODE", &override_node)
        .env("NODE_DISABLE_COMPILE_CACHE", "1")
        .output()
        .unwrap();
    assert!(String::from_utf8(disabled.stdout)
        .unwrap()
        .lines()
        .any(|line| line == "cache="));
    fs::remove_file(root.0.join("mercury.mjs")).unwrap();
    let absent = command()
        .env("MERCURY_NODE", &override_node)
        .output()
        .unwrap();
    assert_eq!(absent.status.code(), Some(1));
    assert!(String::from_utf8(absent.stderr)
        .unwrap()
        .contains("mercury.mjs is missing"));
}
