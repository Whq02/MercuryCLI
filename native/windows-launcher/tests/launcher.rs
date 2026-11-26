use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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
            root.0.join("home").join("compile-cache").display()
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

fn hex_args(args: &[&str]) -> Vec<String> {
    args.iter()
        .map(|arg| {
            let hex = arg
                .as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            format!("arg={hex}")
        })
        .collect()
}

fn tree_stats(dir: &Path) -> (usize, u64) {
    if !dir.exists() {
        return (0, 0);
    }
    let mut files = 0;
    let mut bytes = 0;
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let meta = entry.metadata().unwrap();
        if meta.is_dir() {
            let (f, b) = tree_stats(&entry.path());
            files += f;
            bytes += b;
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

#[test]
fn install_dry_run_cache_controls() {
    let root = Fixture(
        std::env::temp_dir().join(format!("mercury-dry-stub-{}", std::process::id())),
    );
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
    let home = root.0.join("home");
    let probe_log = root.0.join("probe.log");
    let command = || {
        let mut cmd = Command::new(&exe);
        cmd.current_dir(&root.0)
            .env_remove("MERCURY_NODE")
            .env_remove("MERCURY_HOME")
            .env_remove("MERCURY_CRITTER")
            .env_remove("NODE_COMPILE_CACHE")
            .env_remove("NODE_DISABLE_COMPILE_CACHE")
            .env("MERCURY_CONFIG_DIR", &home)
            .env("MERCURY_SPLASH", "off")
            .env("STUB_NODE_VERSION", version.trim())
            .env("STUB_NODE_EXIT", "0")
            .env("STUB_PROBE_LOG", &probe_log);
        cmd
    };

    for code in [0, 37] {
        let _ = fs::remove_file(&probe_log);
        let dry_args = ["install", "--dry-run"];
        let out = command()
            .args(dry_args)
            .env("STUB_NODE_EXIT", code.to_string())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(code));
        let text = String::from_utf8(out.stdout).unwrap();
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("arg="))
                .collect::<Vec<_>>(),
            hex_args(&dry_args)
        );
        assert!(text.lines().any(|line| line == "cache="));
        assert!(text.lines().any(|line| line == "disable=1"));
        assert_eq!(fs::read_to_string(&probe_log).unwrap(), "cache=\ndisable=1\n");
    }

    for dry_args in [
        &["install", "--json", "--dry-run"][..],
        &["install", "--dry-run", "--", "extra"][..],
    ] {
        let _ = fs::remove_file(&probe_log);
        let out = command()
            .args(dry_args)
            .env("NODE_COMPILE_CACHE", "inherited-cache")
            .output()
            .unwrap();
        assert!(out.status.success());
        let text = String::from_utf8(out.stdout).unwrap();
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("arg="))
                .collect::<Vec<_>>(),
            hex_args(dry_args)
        );
        assert!(text.lines().any(|line| line == "cache="));
        assert!(text.lines().any(|line| line == "disable=1"));
        assert_eq!(fs::read_to_string(&probe_log).unwrap(), "cache=\ndisable=1\n");
    }

    let expected_cache = format!("cache={}", home.join("compile-cache").display());
    for normal_args in [
        &["install"][..],
        &["install", "--", "--dry-run"][..],
        &["run", "--dry-run"][..],
        &["install the package with --dry-run"][..],
        &["--dry-run", "install"][..],
    ] {
        let out = command().args(normal_args).output().unwrap();
        assert!(out.status.success());
        let text = String::from_utf8(out.stdout).unwrap();
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("arg="))
                .collect::<Vec<_>>(),
            hex_args(normal_args)
        );
        assert!(text.lines().any(|line| line == expected_cache));
        assert!(text.lines().any(|line| line == "disable="));
    }

    let custom = command()
        .args(["install"])
        .env("NODE_COMPILE_CACHE", "chosen-cache")
        .output()
        .unwrap();
    let custom_text = String::from_utf8(custom.stdout).unwrap();
    assert!(custom_text.lines().any(|line| line == "cache=chosen-cache"));
    assert!(custom_text.lines().any(|line| line == "disable="));

    let opt_out = command()
        .args(["install"])
        .env("NODE_DISABLE_COMPILE_CACHE", "1")
        .output()
        .unwrap();
    let opt_out_text = String::from_utf8(opt_out.stdout).unwrap();
    assert!(opt_out_text.lines().any(|line| line == "cache="));
    assert!(opt_out_text.lines().any(|line| line == "disable=1"));
}

#[test]
fn install_dry_run_real_node_writes_no_cache() {
    let root = Fixture(
        std::env::temp_dir().join(format!("mercury-dry-real-{}", std::process::id())),
    );
    let bin = root.0.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join(if cfg!(windows) {
        "mercury.exe"
    } else {
        "mercury"
    });
    fs::copy(env!("CARGO_BIN_EXE_mercury"), &exe).unwrap();
    fs::write(
        bin.join("mercury.mjs"),
        "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.TEST_EXIT ?? '0'));\n",
    )
    .unwrap();
    let node_out = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node_out.status.success());
    let node_path = String::from_utf8(node_out.stdout).unwrap().trim().to_string();

    let run = |case: &str, args: &[&str], extra: &[(&str, Option<&str>)]| {
        let base = root.0.join(case);
        let home = base.join("home");
        let cfg = base.join("config");
        let profile = base.join("profile");
        let local = base.join("local");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cfg).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&local).unwrap();
        let mut cmd = Command::new(&exe);
        cmd.current_dir(&base)
            .args(args)
            .env_remove("MERCURY_HOME")
            .env_remove("MERCURY_CRITTER")
            .env_remove("NODE_COMPILE_CACHE")
            .env_remove("NODE_DISABLE_COMPILE_CACHE")
            .env("HOME", &home)
            .env("MERCURY_CONFIG_DIR", &cfg)
            .env("USERPROFILE", &profile)
            .env("LOCALAPPDATA", &local)
            .env("MERCURY_NODE", &node_path)
            .env("MERCURY_SPLASH", "off");
        for &(key, value) in extra {
            match value {
                Some(v) => {
                    cmd.env(key, v);
                }
                None => {
                    cmd.env_remove(key);
                }
            }
        }
        let out = cmd.output().unwrap();
        (out, base, cfg)
    };

    let (dry, dry_base, _) = run("dry-clean", &["install", "--dry-run"], &[]);
    assert_eq!(dry.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(dry.stdout).unwrap().trim(),
        "[\"install\",\"--dry-run\"]"
    );
    assert_eq!(tree_stats(&dry_base), (0, 0));

    let (dry_profile, dry_profile_base, _) = run(
        "dry-profile",
        &["install", "--dry-run"],
        &[("MERCURY_CONFIG_DIR", None)],
    );
    assert_eq!(dry_profile.status.code(), Some(0));
    assert_eq!(tree_stats(&dry_profile_base), (0, 0));

    let inherited = root.0.join("inherited-cache");
    fs::create_dir_all(&inherited).unwrap();
    let inherited_str = inherited.to_string_lossy().into_owned();
    let (dry_inherited, dry_inherited_base, _) = run(
        "dry-inherited",
        &["install", "--json", "--dry-run"],
        &[("NODE_COMPILE_CACHE", Some(&inherited_str))],
    );
    assert_eq!(dry_inherited.status.code(), Some(0));
    assert_eq!(tree_stats(&inherited), (0, 0));
    assert_eq!(tree_stats(&dry_inherited_base), (0, 0));

    let (dry_exit, dry_exit_base, _) = run(
        "dry-exit",
        &["install", "--dry-run"],
        &[("TEST_EXIT", Some("23"))],
    );
    assert_eq!(dry_exit.status.code(), Some(23));
    assert_eq!(tree_stats(&dry_exit_base), (0, 0));

    let (normal, _, normal_cfg) = run("normal-install", &["install"], &[]);
    assert_eq!(normal.status.code(), Some(0));
    let (normal_files, normal_bytes) = tree_stats(&normal_cfg.join("compile-cache"));
    assert!(normal_files >= 1 && normal_bytes > 0);

    let (after_dash, _, after_dash_cfg) =
        run("after-dash", &["install", "--", "--dry-run"], &[]);
    assert_eq!(after_dash.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(after_dash.stdout).unwrap().trim(),
        "[\"install\",\"--\",\"--dry-run\"]"
    );
    let (dash_files, dash_bytes) = tree_stats(&after_dash_cfg.join("compile-cache"));
    assert!(dash_files >= 1 && dash_bytes > 0);

    let (other_verb, _, other_verb_cfg) = run("other-verb", &["run", "--dry-run"], &[]);
    assert_eq!(other_verb.status.code(), Some(0));
    let (other_files, other_bytes) = tree_stats(&other_verb_cfg.join("compile-cache"));
    assert!(other_files >= 1 && other_bytes > 0);

    let (opt_out, opt_out_base, _) = run(
        "opt-out",
        &["install"],
        &[("NODE_DISABLE_COMPILE_CACHE", Some("1"))],
    );
    assert_eq!(opt_out.status.code(), Some(0));
    assert_eq!(tree_stats(&opt_out_base), (0, 0));

    let custom = root.0.join("custom-cache");
    fs::create_dir_all(&custom).unwrap();
    let custom_str = custom.to_string_lossy().into_owned();
    let (override_run, override_base, _) = run(
        "override",
        &["install"],
        &[("NODE_COMPILE_CACHE", Some(&custom_str))],
    );
    assert_eq!(override_run.status.code(), Some(0));
    let (custom_files, custom_bytes) = tree_stats(&custom);
    assert!(custom_files >= 1 && custom_bytes > 0);
    assert_eq!(tree_stats(&override_base), (0, 0));
}
